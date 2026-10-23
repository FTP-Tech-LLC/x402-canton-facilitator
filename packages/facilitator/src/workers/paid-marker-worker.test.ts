/**
 * Deterministic OFFLINE SIMULATION of the total-traffic marker worker.
 *
 * Drives the real {@link processAllRounds} / {@link processRound} against an
 * in-memory mock Scan (getCurrentOpenRoundNumber / getFeaturedAppRight /
 * getAmuletRules / getTrafficStatus), a stateful in-memory MarkerStore mirroring
 * the Postgres semantics (insert-once, prev-round lookup, traffic_consumed
 * snapshot, pending/failed retry, expiry, idempotency), and a mock CantonClient
 * whose only job is emitX402RoundMarker.
 *
 * Weight = (Δ total_consumed + free base) / 1e6 * $60/MB * multiplier, clamped to
 * maxWeightPerRound. Covers: normal advance, first-run seed, round gap, negative
 * delta (counter reset), zero delta (emits the free base), over-cap clamp, Scan
 * outage skip, and emit failure.
 */
import { describe, it, expect, vi } from "vitest";
import {
  classifySubmitFailure,
  processAllRounds,
  processRound,
  startPaidMarkerWorker,
  type PaidMarkerWorkerServices,
} from "./paid-marker-worker.js";
import type { MarkerRoundFields, MarkerRoundRow, MarkerStore } from "../db/marker-store.js";
import { CantonError, type CommandCompletion } from "@ftptech/x402-canton-ledger";

// Mirror the worker's own constants so the assertions are self-checking.
const TRAFFIC_PRICE_USD_PER_MB = 60;
/** The free-base grant is a config knob, not a constant. Prod runs the default
 *  0 (claim only the purchased delta); this is the non-zero value the two
 *  grant-specific tests below use to prove the knob is actually wired. */
const GRANT_BYTES = 100_000;

const SYNC = "global-domain::sim";
const FA_RIGHT = "00fa-right-cid";
const FTP = "ftp::sim";
const MEMBER = `PAR::${FTP}`;

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Stateful in-memory MarkerStore reproducing the SQL contracts the worker uses. */
class FakeMarkerStore implements MarkerStore {
  rows = new Map<number, MarkerRoundRow>();
  private seq = 0;

  async init(): Promise<void> {}

  async isEmpty(): Promise<boolean> {
    return this.rows.size === 0;
  }

  async getRow(roundNumber: number): Promise<MarkerRoundRow | undefined> {
    const r = this.rows.get(roundNumber);
    return r ? { ...r } : undefined;
  }

  async insertPending(roundNumber: number): Promise<void> {
    if (this.rows.has(roundNumber)) return; // ON CONFLICT DO NOTHING
    const created_at = new Date(1_700_000_000_000 + this.seq++ * 1000);
    this.rows.set(roundNumber, {
      round_number: roundNumber,
      status: "pending",
      traffic_bytes: null,
      traffic_consumed: null,
      traffic_usd: null,
      weight: null,
      update_id: null,
      error_message: null,
      submission_id: null,
      dedup_offset: null,
      submitted_at: null,
      created_at,
      updated_at: created_at,
    });
  }

  async updateStatus(
    roundNumber: number,
    status: string,
    fields: MarkerRoundFields = {}
  ): Promise<void> {
    const r = this.rows.get(roundNumber);
    if (!r) return;
    r.status = status;
    if (fields.traffic_bytes !== undefined) r.traffic_bytes = fields.traffic_bytes;
    if (fields.traffic_consumed !== undefined) r.traffic_consumed = fields.traffic_consumed;
    if (fields.traffic_usd !== undefined) r.traffic_usd = fields.traffic_usd;
    if (fields.weight !== undefined) r.weight = fields.weight;
    if (fields.update_id !== undefined) r.update_id = fields.update_id;
    if (fields.error_message !== undefined) r.error_message = fields.error_message;
    if (fields.submission_id !== undefined) r.submission_id = fields.submission_id;
    if (fields.dedup_offset !== undefined) r.dedup_offset = fields.dedup_offset;
    if (fields.submitted) r.submitted_at = new Date();
    r.updated_at = new Date();
  }

  async getPrevRound(belowRound: number): Promise<MarkerRoundRow | undefined> {
    let best: MarkerRoundRow | undefined;
    for (const r of this.rows.values()) {
      if (r.round_number < belowRound) {
        if (!best || r.round_number > best.round_number) best = r;
      }
    }
    return best ? { ...best } : undefined;
  }

  async getPendingRetry(minRound: number, maxRound: number): Promise<MarkerRoundRow[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          (r.status === "pending" || r.status === "failed") &&
          r.round_number >= minRound &&
          r.round_number < maxRound
      )
      .sort((a, b) => a.round_number - b.round_number)
      .map((r) => ({ ...r }));
  }

  async expireRows(belowRound: number): Promise<void> {
    for (const r of this.rows.values()) {
      if ((r.status === "pending" || r.status === "failed") && r.round_number < belowRound) {
        r.status = "expired";
        r.updated_at = new Date();
      }
    }
  }

  async getUnknown(minRound: number): Promise<MarkerRoundRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "unknown" && r.round_number >= minRound)
      .sort((a, b) => a.round_number - b.round_number)
      .map((r) => ({ ...r }));
  }

  async expireUnknown(belowRound: number, reason: string): Promise<MarkerRoundRow[]> {
    const out: MarkerRoundRow[] = [];
    for (const r of this.rows.values()) {
      if (r.status === "unknown" && r.round_number < belowRound) {
        r.status = "expired";
        r.error_message = reason;
        out.push({ ...r });
      }
    }
    return out;
  }
}

/** Mock Scan. `state.consumed` is mutable so a test can advance it between ticks;
 *  set it to `null` to make getTrafficStatus throw (simulate a Scan outage). */
function makeScan(initialRound: number) {
  const state = { round: initialRound, consumed: 0 as number | null };
  const scan = {
    getCurrentOpenRoundNumber: vi.fn(async () => state.round),
    getFeaturedAppRight: vi.fn(async () => FA_RIGHT),
    getAmuletRules: vi.fn(async () => ({ amulet_rules: { domain_id: SYNC } })),
    getTrafficStatus: vi.fn(async () => {
      if (state.consumed === null) throw new Error("scan down");
      return {
        traffic_status: {
          actual: { total_consumed: state.consumed, total_limit: state.consumed + 1 },
          target: { total_purchased: state.consumed + 1 },
        },
      };
    }),
  };
  return { scan, state };
}

type SubmittedMarker = {
  commandId: string;
  submissionId?: string;
  deduplicationPeriod?: { DeduplicationOffset: { value: number } };
  actAs: string[];
  commands: Array<{
    ExerciseCommand: { choiceArgument: { beneficiaries: Array<{ beneficiary: string }> } };
  }>;
};

/**
 * Mock participant. `emitThrows` makes every submit fail with that error (true =
 * a bare transport error, i.e. outcome unknown). `commitsAnyway` models the
 * 2026-10-17 incident: the submit fails, but the command commits and its
 * accepted completion shows up on the stream. `completions` is that stream.
 */
function makeClient(opts: { emitThrows?: boolean | Error; commitsAnyway?: boolean } = {}) {
  const commandIds: string[] = [];
  const requests: SubmittedMarker[] = [];
  const completions: Array<CommandCompletion & { commandId: string }> = [];
  const ledger = { end: 5000 };
  const submitAndWaitForTransaction = vi.fn(async (req: SubmittedMarker) => {
    commandIds.push(req.commandId);
    requests.push(req);
    if (opts.emitThrows) {
      if (opts.commitsAnyway) {
        ledger.end += 1;
        completions.push({
          commandId: req.commandId,
          submissionId: req.submissionId!,
          updateId: `upd-${req.commandId}-${completions.length}`,
          offset: ledger.end,
        });
      }
      throw opts.emitThrows === true ? new Error("ledger unavailable") : opts.emitThrows;
    }
    return { updateId: `upd-${req.commandId}`, offset: 0 };
  });
  const getLedgerEnd = vi.fn(async () => ({ offset: ledger.end }));
  const findCommandCompletions = vi.fn(
    async (_u: string, _p: string, commandId: string, beginExclusive: number) =>
      completions
        .filter((c) => c.commandId === commandId && (c.offset ?? 0) > beginExclusive)
        .map(({ commandId: _c, ...rest }) => rest)
  );
  return {
    client: { submitAndWaitForTransaction, getLedgerEnd, findCommandCompletions },
    commandIds,
    requests,
    completions,
    ledger,
  };
}

function makeServices(opts: {
  store: FakeMarkerStore;
  scanRound: number;
  multiplier?: number;
  maxWeight?: number;
  freeBytes?: number;
  emitThrows?: boolean | Error;
  commitsAnyway?: boolean;
  beneficiary?: string;
}) {
  const { scan, state } = makeScan(opts.scanRound);
  const client = makeClient({
    emitThrows: opts.emitThrows ?? false,
    commitsAnyway: opts.commitsAnyway ?? false,
  });
  const services = {
    markerStore: opts.store,
    client: client.client,
    scan,
    markerFtpParty: FTP,
    markerUserId: "ftp-user",
    ...(opts.beneficiary ? { markerBeneficiary: opts.beneficiary } : {}),
    markerWeightMultiplier: opts.multiplier ?? 1.15,
    facilitatorMemberId: MEMBER,
    maxWeightPerRound: opts.maxWeight ?? 1000,
    // Default 0 mirrors the production default: weight == purchased delta.
    freeBytesPerRound: opts.freeBytes ?? 0,
  } as unknown as PaidMarkerWorkerServices;
  return { services, scan, client, traffic: state };
}

/** A definite refusal by the participant: nothing committed. */
function rejected400(): CantonError {
  return new CantonError(
    "POST /v2/commands/submit-and-wait-for-transaction returned HTTP 400",
    "HTTP_ERROR",
    400,
    JSON.stringify({ code: "DAML_FAILURE", cause: "Weight >= 1.0 was not met" })
  );
}

/** A JSON Ledger API error with a Canton id in its body. */
function cantonHttpError(status: number, id: string): CantonError {
  return new CantonError(
    `POST /v2/commands/submit-and-wait-for-transaction returned HTTP ${status}`,
    "HTTP_ERROR",
    status,
    JSON.stringify({ code: id, cause: id })
  );
}

/** Expected USD weight for a round whose consumed grew by `deltaBytes`, under a
 *  free-base grant of `freeBytes` (0 = the production default). */
function expectedWeight(deltaBytes: number, multiplier: number, freeBytes = 0): number {
  return ((Math.max(0, deltaBytes) + freeBytes) / 1_000_000) * TRAFFIC_PRICE_USD_PER_MB * multiplier;
}

/** Seed round `n` with a prior consumed snapshot so `n+1` can delta off it. */
async function seedPrev(store: FakeMarkerStore, round: number, consumed: bigint) {
  await store.insertPending(round);
  await store.updateStatus(round, "seeded", { traffic_consumed: consumed });
}

describe("marker worker — total-traffic weight (processRound)", () => {
  it("normal advance: emits weight = delta * multiplier", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100, multiplier: 1.15 });
    traffic.consumed = 1_000_000 + 600_000; // delta = 600k

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    expect(Number(row?.weight)).toBeCloseTo(expectedWeight(600_000, 1.15), 6);
    expect(Number(row?.traffic_consumed)).toBe(1_600_000);
    expect(row?.update_id).toBe("upd-x402-round-marker-100");
    expect(client.commandIds).toEqual(["x402-round-marker-100"]);
  });

  it("the reward goes to the configured beneficiary; unset, to the marker party", async () => {
    const VALIDATOR = "FTP-validator-2::1220" + "da".repeat(32);
    for (const [beneficiary, expected] of [[VALIDATOR, VALIDATOR], [undefined, FTP]] as const) {
      const store = new FakeMarkerStore();
      await seedPrev(store, 99, 1_000_000n);
      const { services, traffic, client } = makeServices({
        store,
        scanRound: 100,
        ...(beneficiary ? { beneficiary } : {}),
      });
      traffic.consumed = 1_600_000;

      await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

      const req = client.requests[0]!;
      // Always submitted by the marker party, which holds the FeaturedAppRight.
      expect(req.actAs).toEqual([FTP]);
      expect(req.commands[0]!.ExerciseCommand.choiceArgument.beneficiaries).toEqual([
        { beneficiary: expected, weight: "1.0000000000" },
      ]);
    }
  });

  it("first run (prev has no snapshot): seeds forward, no emit", async () => {
    const store = new FakeMarkerStore();
    await store.insertPending(99);
    await store.updateStatus(99, "seeded"); // no traffic_consumed
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = 5_000_000;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("seeded");
    expect(Number(row?.traffic_consumed)).toBe(5_000_000);
    expect(client.commandIds).toHaveLength(0);
  });

  it("round gap (prevRound != target-1): seeds snapshot, no emit (FA Rule 5)", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 90, 1_000_000n); // gap: 90 vs target 100
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = 9_000_000;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("seeded");
    expect(Number(row?.traffic_consumed)).toBe(9_000_000);
    expect(client.commandIds).toHaveLength(0);
  });

  it("negative delta (counter reset): skipped, no emit", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 5_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = 4_000_000; // decreased

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("skipped");
    expect(Number(row?.traffic_consumed)).toBe(4_000_000);
    expect(client.commandIds).toHaveLength(0);
  });

  it("zero delta at the default (no free-base grant): skips, emits nothing", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = 1_000_000; // delta 0 and no grant => nothing to mark

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("skipped");
    expect(Number(row?.weight ?? 0)).toBe(0);
    expect(client.commandIds).toHaveLength(0);
  });

  it("zero delta WITH a free-base grant: emits the grant alone", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({
      store,
      scanRound: 100,
      freeBytes: GRANT_BYTES,
    });
    traffic.consumed = 1_000_000; // delta 0 — only the grant is marked

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    expect(Number(row?.weight)).toBeCloseTo(expectedWeight(0, 1.15, GRANT_BYTES), 6);
    expect(client.commandIds).toEqual(["x402-round-marker-100"]);
  });

  it("non-zero delta: the grant is ADDED to the purchased delta, not replacing it", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic } = makeServices({
      store,
      scanRound: 100,
      freeBytes: GRANT_BYTES,
    });
    traffic.consumed = 1_600_000; // delta 600_000

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(Number(row?.weight)).toBeCloseTo(expectedWeight(600_000, 1.15, GRANT_BYTES), 6);
    // traffic_bytes stays the REAL purchased delta — the grant only prices weight.
    expect(Number(row?.traffic_bytes)).toBe(600_000);
  });

  it("weight over the cap: clamps to maxWeightPerRound", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic } = makeServices({
      store,
      scanRound: 100,
      multiplier: 1.15,
      maxWeight: 1000,
    });
    traffic.consumed = 1_000_000 + 100_000_000; // raw weight ≈ $6900 » cap

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    expect(Number(row?.weight)).toBeCloseTo(1000, 6);
  });

  it("Scan outage: getTrafficStatus throws → round left pending, no emit", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = null; // getTrafficStatus throws

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("pending"); // untouched → retried next tick
    expect(client.commandIds).toHaveLength(0);
  });

  it("a definite rejection marks failed (currentRound == target)", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic } = makeServices({ store, scanRound: 100, emitThrows: rejected400() });
    traffic.consumed = 1_000_000 + 600_000;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toContain("HTTP 400");
  });

  it("a transport error is NOT a failure: the outcome is unknown", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic } = makeServices({ store, scanRound: 100, emitThrows: true });
    traffic.consumed = 1_000_000 + 600_000;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("unknown");
    expect(row?.error_message).toContain("ledger unavailable");
  });
});

describe("marker worker — processAllRounds", () => {
  it("first tick seeds the snapshot; next tick emits the delta", async () => {
    const store = new FakeMarkerStore();
    const { services, traffic, client } = makeServices({ store, scanRound: 100, multiplier: 1.15 });

    // First-ever tick (empty store): seeds round 100 WITH the snapshot, no emit.
    traffic.consumed = 1_000_000;
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);
    expect((await store.getRow(100))?.status).toBe("seeded");
    expect(Number((await store.getRow(100))?.traffic_consumed)).toBe(1_000_000);
    expect(client.commandIds).toHaveLength(0);

    // Next tick: round advances, consumed grows → emit the delta.
    traffic.round = 101;
    traffic.consumed = 1_000_000 + 600_000;
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);
    const row = await store.getRow(101);
    expect(row?.status).toBe("emitted");
    expect(Number(row?.weight)).toBeCloseTo(expectedWeight(600_000, 1.15), 6);
    expect(client.commandIds).toEqual(["x402-round-marker-101"]);
  });
});

describe("a retried round prices from its own snapshot, not from now", () => {
  it("round N+1 emits, then N is retried — the two windows must not overlap", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n); // round 99 snapshot = 1.0 MB

    // Round 100 runs, its emit FAILS. The failure path still records the
    // snapshot it read (1.6 MB), which is the whole point: that number is the
    // right edge of round 100's window and it is a historical fact.
    const a = makeServices({ store, scanRound: 100, emitThrows: rejected400() });
    a.traffic.consumed = 1_600_000;
    await processRound(100, 100, a.services, FA_RIGHT, SYNC, silentLog);
    const failed = await store.getRow(100);
    expect(failed?.status).toBe("failed");

    // The next round runs and legitimately claims 1.6 MB -> 2.2 MB.
    const b = makeServices({ store, scanRound: 101 });
    b.traffic.consumed = 2_200_000;
    await processRound(101, 101, b.services, FA_RIGHT, SYNC, silentLog);
    const r101 = await store.getRow(101);
    const w101 = Number(r101?.weight);

    // Now round 100 is retried — processAllRounds does exactly this ordering:
    // current round first, THEN pending rows up to 3 back.
    const c = makeServices({ store, scanRound: 101 });
    c.traffic.consumed = 2_200_000; // the same live value
    await processRound(100, 101, c.services, FA_RIGHT, SYNC, silentLog);
    const r100 = await store.getRow(100);
    const w100 = Number(r100?.weight);

    // Round 100's true share is 1.0 -> 1.6 MB. Priced off a LIVE read it becomes
    // 1.0 -> 2.2 MB, which swallows the 0.6 MB round 101 just claimed.
    const truth = expectedWeight(600_000, 1.15);
    expect(w100).toBeCloseTo(truth, 6);
    // ...and the two together claim exactly the bytes that were spent.
    expect(w100 + w101).toBeCloseTo(expectedWeight(1_200_000, 1.15), 6);
  });

  it("a FIRST attempt still reads live — the rule is 'reuse a recorded snapshot', not 'never read'", async () => {
    // The discriminator. Never reading live would freeze the worker at whatever
    // it first saw; the rule is only that a round's right edge is fixed once it
    // has been observed.
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const a = makeServices({ store, scanRound: 100 });
    a.traffic.consumed = 1_600_000;
    await processRound(100, 100, a.services, FA_RIGHT, SYNC, silentLog);
    expect(a.scan.getTrafficStatus).toHaveBeenCalledTimes(1);
    expect(Number((await store.getRow(100))?.weight)).toBeCloseTo(
      expectedWeight(600_000, 1.15),
      6
    );
  });
});

describe("a Scan wobble at boot must not end marker emission for the process", () => {
  it("first resolution fails, the next tick retries it and the worker runs", async () => {
    // Both startup reads go to Scan. Scan sheds (503/429) often enough that this
    // repo carries a bounded retry and an SV failover for it; an outage that
    // outlasts that budget at the instant the process starts used to disable
    // markers permanently, and the process starts on every deploy.
    vi.useFakeTimers();
    try {
      const store = new FakeMarkerStore();
      await seedPrev(store, 99, 1_000_000n);
      const { services, scan, traffic, client } = makeServices({
        store,
        scanRound: 100,
        multiplier: 1.15,
      });
      traffic.consumed = 1_600_000;
      scan.getFeaturedAppRight
        .mockRejectedValueOnce(new Error("Scan 503 local_rate_limited"))
        .mockResolvedValue(FA_RIGHT);

      startPaidMarkerWorker(services, { log: silentLog });

      // Tick 1: the resolution throws, nothing is processed.
      await vi.advanceTimersByTimeAsync(0);
      expect(scan.getCurrentOpenRoundNumber).not.toHaveBeenCalled();
      expect(await store.getRow(100)).toBeUndefined();

      // Tick 2, 60s later: Scan is back, so the worker resolves and emits.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scan.getFeaturedAppRight).toHaveBeenCalledTimes(2);
      const row = await store.getRow(100);
      expect(row?.status).toBe("emitted");
      expect(Number(row?.weight)).toBeCloseTo(expectedWeight(600_000, 1.15), 6);
      expect(client.commandIds).toEqual(["x402-round-marker-100"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resolution that SUCCEEDS is cached — it is not re-read every tick", async () => {
    // The discriminator. Moving the reads inside the loop must not turn two
    // one-off startup reads into two Scan calls per minute forever.
    vi.useFakeTimers();
    try {
      const store = new FakeMarkerStore();
      await seedPrev(store, 99, 1_000_000n);
      const { services, scan, traffic } = makeServices({ store, scanRound: 100 });
      traffic.consumed = 1_600_000;

      startPaidMarkerWorker(services, { log: silentLog });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000 * 4);

      expect(scan.getFeaturedAppRight).toHaveBeenCalledTimes(1);
      expect(scan.getAmuletRules).toHaveBeenCalledTimes(1);
      expect(scan.getCurrentOpenRoundNumber.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the ledger refuses a weight below 1.0, so we must not send one", () => {
  // Diagnosed from production, not imagined. The participant's own words on
  // rejection:
  //   "The requirement 'Weight >= 1.0' was not met."
  // Before this guard the worker submitted anyway, got HTTP 400, retried once a
  // minute until the round moved on, and recorded `expired`. On the live table
  // 5,822 rounds have emitted and the smallest weight among them is 1.0000620 —
  // never once below the floor — while 207 rounds died that way.

  // Multiplier pinned to 1 so the arithmetic is readable: weight = bytes/1e6 * 60.
  // The floor of 1.0 therefore sits at ~16,667 bytes — 12,000 prices to 0.72
  // (under) and 30,000 to 1.80 (over).
  const UNDER = 12_000;
  const OVER = 30_000;

  it("a round under the floor is skipped and NOTHING is submitted", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100, multiplier: 1 });
    traffic.consumed = 1_000_000 + UNDER;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("skipped");
    // The point of the guard: no doomed submit, so no 400 and no retry storm.
    expect(client.commandIds).toHaveLength(0);
  });

  it("and its bytes are CARRIED, not discarded — the next round claims them", async () => {
    // The half that is easy to get wrong. Marking the round skipped while also
    // advancing the checkpoint would silently throw away real purchased
    // traffic; the payer paid for it and it would never be claimed.
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100, multiplier: 1 });
    traffic.consumed = 1_000_000 + UNDER;
    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    // The skipped round left the edge where round 99 put it.
    expect(Number((await store.getRow(100))?.traffic_consumed)).toBe(1_000_000);

    // Next round adds a little more; together they clear the floor and the
    // marker is priced on the WHOLE accumulated delta, once.
    traffic.consumed = 1_000_000 + UNDER + OVER;
    await processRound(101, 101, services, FA_RIGHT, SYNC, silentLog);

    const r101 = await store.getRow(101);
    expect(r101?.status).toBe("emitted");
    expect(Number(r101?.weight)).toBeCloseTo(expectedWeight(UNDER + OVER, 1), 6);
    expect(client.commandIds).toEqual(["x402-round-marker-101"]);
  });

  it("a round at or above the floor still emits — the guard is a floor, not a filter", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100, multiplier: 1 });
    traffic.consumed = 1_000_000 + OVER;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    expect((await store.getRow(100))?.status).toBe("emitted");
    expect(client.commandIds).toEqual(["x402-round-marker-100"]);
  });
});

/**
 * The 2026-10-17 MainNet incident, replayed: submit-and-wait answered 503 while
 * the marker went on to commit, the worker resubmitted every minute, and the
 * participant let the repeats through — 24 extra markers. Every test here fails
 * on the pre-fix worker.
 */
describe("a lost answer is not a failure: at most one marker per round", () => {
  const lost503 = () =>
    new CantonError(
      "POST /v2/commands/submit-and-wait-for-transaction returned HTTP 503",
      "HTTP_ERROR",
      503,
      "upstream request timeout"
    );

  it("503 that committed anyway: ticks for the rest of the round submit nothing more", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client, scan } = makeServices({
      store,
      scanRound: 100,
      emitThrows: lost503(),
      commitsAnyway: true,
    });
    traffic.consumed = 1_600_000;

    // Ten ticks inside round 100 — the incident retried once a minute.
    for (let i = 0; i < 10; i++) await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    expect(client.commandIds).toEqual(["x402-round-marker-100"]);
    expect(client.completions).toHaveLength(1);
    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    expect(row?.update_id).toBe(client.completions[0]!.updateId);
    expect(Number(row?.weight)).toBeCloseTo(expectedWeight(600_000, 1.15), 6);
    expect(scan.getTrafficStatus).toHaveBeenCalledTimes(1);
  });

  it("the attempt is written down BEFORE the submit, with its submissionId and dedup offset", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = 1_600_000;
    let seenAtSubmit: MarkerRoundRow | undefined;
    const real = client.client.submitAndWaitForTransaction;
    client.client.submitAndWaitForTransaction = vi.fn(async (req: SubmittedMarker) => {
      seenAtSubmit = await store.getRow(100);
      return real(req);
    }) as typeof real;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    expect(seenAtSubmit?.status).toBe("unknown");
    expect(seenAtSubmit?.submission_id).toBe(client.requests[0]!.submissionId);
    expect(Number(seenAtSubmit?.dedup_offset)).toBe(5000);
    expect(seenAtSubmit?.submitted_at).toBeInstanceOf(Date);
    expect(client.requests[0]!.deduplicationPeriod).toEqual({ DeduplicationOffset: { value: 5000 } });
  });

  it("a crash after the submit (row left unknown) is never resubmitted blind", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    await store.insertPending(100);
    await store.updateStatus(100, "unknown", {
      traffic_consumed: 1_600_000n,
      traffic_usd: "41.4",
      submission_id: "sub-before-crash",
      dedup_offset: 4000n,
      submitted: true,
    });
    const { services, client } = makeServices({ store, scanRound: 100 });

    for (let i = 0; i < 5; i++) await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    expect(client.commandIds).toHaveLength(0);
    expect((await store.getRow(100))?.status).toBe("unknown");
  });

  it("a lost attempt that is PROVED rejected is retried once, same dedup offset, new submissionId", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const a = makeServices({ store, scanRound: 100, emitThrows: lost503() });
    a.traffic.consumed = 1_600_000;
    await processRound(100, 100, a.services, FA_RIGHT, SYNC, silentLog);
    const first = a.client.requests[0]!;

    // The participant later reports that attempt as never sequenced.
    a.client.completions.push({
      commandId: "x402-round-marker-100",
      submissionId: first.submissionId!,
      offset: 5001,
      rejection: "NOT_SEQUENCED_TIMEOUT",
    });
    // Same participant, now healthy.
    const b = makeServices({ store, scanRound: 100 });
    b.client.client.findCommandCompletions = a.client.client.findCommandCompletions;
    await processAllRounds(b.services, FA_RIGHT, SYNC, silentLog);

    expect(b.client.requests).toHaveLength(1);
    const second = b.client.requests[0]!;
    expect(second.submissionId).not.toBe(first.submissionId);
    expect(second.deduplicationPeriod).toEqual(first.deduplicationPeriod);
    expect((await store.getRow(100))?.status).toBe("emitted");
  });

  it("an unknown attempt that never resolves expires after the window and is never resubmitted", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100, emitThrows: lost503() });
    traffic.consumed = 1_600_000;
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    for (let r = 101; r <= 113; r++) {
      traffic.round = r;
      traffic.consumed = 1_600_000 + (r - 100) * 50_000;
      await processAllRounds(services, FA_RIGHT, SYNC, silentLog);
    }

    const row = await store.getRow(100);
    expect(row?.status).toBe("expired");
    expect(row?.error_message).toContain("not resubmitted");
    expect(client.commandIds.filter((c) => c === "x402-round-marker-100")).toHaveLength(1);
  });

  it("409 DUPLICATE_COMMAND means an earlier attempt WAS accepted: resolved to emitted, not retried", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({
      store,
      scanRound: 100,
      emitThrows: cantonHttpError(409, "DUPLICATE_COMMAND"),
    });
    traffic.consumed = 1_600_000;
    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);
    expect((await store.getRow(100))?.status).toBe("unknown");

    client.completions.push({ commandId: "x402-round-marker-100", submissionId: "earlier", updateId: "upd-earlier", offset: 5002 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    expect(row?.update_id).toBe("upd-earlier");
    expect(client.commandIds).toHaveLength(1);
  });

  it("two accepted completions for one round are reported as duplicates", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100, emitThrows: lost503() });
    traffic.consumed = 1_600_000;
    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);
    client.completions.push(
      { commandId: "x402-round-marker-100", submissionId: "a", updateId: "u1", offset: 5001 },
      { commandId: "x402-round-marker-100", submissionId: "b", updateId: "u2", offset: 5002 }
    );
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await processAllRounds(services, FA_RIGHT, SYNC, log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ round: 100, count: 2 }),
      expect.stringContaining("DUPLICATE")
    );
    expect((await store.getRow(100))?.status).toBe("emitted");
  });

  it("ledger-end unreadable: nothing is submitted and the round keeps its right edge", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    client.client.getLedgerEnd = vi.fn(async () => {
      throw new Error("participant down");
    });
    traffic.consumed = 1_600_000;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(client.commandIds).toHaveLength(0);
    expect(row?.status).toBe("pending");
    expect(Number(row?.traffic_consumed)).toBe(1_600_000);
  });

  it("a legacy failed round (pre-fix worker, no submissionId) is expired, never retried", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    await store.insertPending(100);
    await store.updateStatus(100, "failed", {
      traffic_consumed: 1_600_000n,
      traffic_usd: "41.4",
      error_message: "POST /v2/commands/submit-and-wait-for-transaction returned HTTP 503",
    });
    const { services, client } = makeServices({ store, scanRound: 100 });

    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    expect(client.commandIds).toHaveLength(0);
    const row = await store.getRow(100);
    expect(row?.status).toBe("expired");
    expect(row?.error_message).toContain("not retried");
  });

  it("a completion read that FAILS leaves the row unknown and says so", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100, emitThrows: lost503() });
    traffic.consumed = 1_600_000;
    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);
    client.client.findCommandCompletions = vi.fn(async () => {
      throw new CantonError("POST /v2/commands/completions returned HTTP 403", "HTTP_ERROR", 403);
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await processAllRounds(services, FA_RIGHT, SYNC, log);

    expect((await store.getRow(100))?.status).toBe("unknown");
    expect(client.commandIds).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ round: 100 }), expect.stringContaining("completion read failed"));
  });

  it("giving up on an unknown round is logged as an error", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic } = makeServices({ store, scanRound: 100, emitThrows: lost503() });
    traffic.consumed = 1_600_000;
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    traffic.round = 113;
    traffic.consumed = 2_000_000;

    await processAllRounds(services, FA_RIGHT, SYNC, log);

    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ round: 100 }), expect.stringContaining("gave up"));
  });

  it("emitted but the DB write failed: the row stays unknown and reconcile records it", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = 1_600_000;
    const realUpdate = store.updateStatus.bind(store);
    store.updateStatus = vi.fn(async (r: number, st: string, f?: MarkerRoundFields) => {
      if (st === "emitted") throw new Error("db down");
      return realUpdate(r, st, f);
    }) as typeof store.updateStatus;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await processRound(100, 100, services, FA_RIGHT, SYNC, log);

    expect((await store.getRow(100))?.status).toBe("unknown");
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ updateId: "upd-x402-round-marker-100" }), expect.stringContaining("recording it failed"));
    store.updateStatus = realUpdate;
    client.completions.push({ commandId: "x402-round-marker-100", submissionId: client.requests[0]!.submissionId!, updateId: "upd-x402-round-marker-100", offset: 5001 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);
    expect((await store.getRow(100))?.status).toBe("emitted");
    expect(client.commandIds).toHaveLength(1);
  });
});

describe("classifySubmitFailure", () => {
  it.each([
    ["DUPLICATE_COMMAND (409)", cantonHttpError(409, "DUPLICATE_COMMAND"), "duplicate"],
    ["SUBMISSION_ALREADY_IN_FLIGHT (409)", cantonHttpError(409, "SUBMISSION_ALREADY_IN_FLIGHT"), "unknown"],
    ["MEDIATOR_SAYS_TX_TIMED_OUT (409)", cantonHttpError(409, "MEDIATOR_SAYS_TX_TIMED_OUT"), "rejected"],
    ["NOT_SEQUENCED_TIMEOUT (409)", cantonHttpError(409, "NOT_SEQUENCED_TIMEOUT"), "rejected"],
    ["DAML_FAILURE (400)", rejected400(), "rejected"],
    ["REQUEST_TIME_OUT (504)", cantonHttpError(504, "REQUEST_TIME_OUT"), "unknown"],
    ["503 from the ingress", new CantonError("x", "HTTP_ERROR", 503, "upstream request timeout"), "unknown"],
    ["408", cantonHttpError(408, "REQUEST_TIMEOUT"), "unknown"],
    ["429 PARTICIPANT_BACKPRESSURE (refused before registration)", cantonHttpError(429, "PARTICIPANT_BACKPRESSURE"), "rejected"],
    ["503 SERVICE_NOT_RUNNING (refused before registration)", cantonHttpError(503, "SERVICE_NOT_RUNNING"), "rejected"],
    ["429 without an id", new CantonError("x", "HTTP_ERROR", 429, "slow down"), "unknown"],
    ["409 whose id could not be read", new CantonError("x", "HTTP_ERROR", 409, "conflict"), "unknown"],
    ["409 with a body cut by the 1 KiB cap", new CantonError("x", "HTTP_ERROR", 409, '{"code":"DUPLICATE_COMMAND","cause":"' + "x".repeat(2000)), "duplicate"],
    ["client timeout", new CantonError("aborted", "TIMEOUT"), "unknown"],
    ["network error", new Error("ECONNRESET"), "unknown"],
  ])("%s → %s", (_name, err, expected) => {
    expect(classifySubmitFailure(err)).toBe(expected);
  });
});
