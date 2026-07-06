/**
 * Deterministic OFFLINE SIMULATION of the MainNet paid-marker worker.
 *
 * Drives the real {@link processAllRounds} / {@link processRound} against an
 * in-memory mock Scan (getCurrentOpenRoundNumber / getFeaturedAppRight /
 * getAmuletRules), a stateful in-memory MarkerStore that mirrors the Postgres
 * semantics the worker relies on (insert-once stable window anchor, prev-round
 * lookup, pending/failed retry slice, expiry, ON CONFLICT idempotency), and a
 * mock CantonClient whose only job is emitX402RoundMarker (here: capture the
 * deterministic commandId the worker would submit).
 *
 * Covers the real MainNet rounds+markers scenarios:
 *   (i)    normal round advance -> emits with weight = bytes-over-free * mult
 *   (ii)   no paid-overage traffic -> skipped (no emission)
 *   (iii)  round gap (prevRound != target-1) -> seeded, no emission (FA Rule 5)
 *   (iv)   multi-round catch-up via getPendingRetry
 *   (v)    crash recovery (failed/pending current row retried)
 *   (vi)   stale row expiry
 *   (vii)  idempotent commandId x402-round-marker-{round}
 *   (viii) a TWO-LEG ESCROW round: window bytes include BOTH the settle leg and
 *          the forward leg, and the emitted weight reflects both (proves Task 1's
 *          forward-leg attribution flows through getTrafficBytesInWindow).
 */
import { describe, it, expect, vi } from "vitest";
import {
  processAllRounds,
  processRound,
  type PaidMarkerWorkerServices,
} from "./paid-marker-worker.js";
import type { MarkerRoundRow, MarkerStore } from "../db/marker-store.js";

// Mirror the worker's own constants so the math in assertions is self-checking.
const FREE_BYTES_PER_ROUND = 100_000;
const TRAFFIC_PRICE_USD_PER_MB = 60;

const SYNC = "global-domain::sim";
const FA_RIGHT = "00fa-right-cid";
const FTP = "ftp::sim";

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * A stateful in-memory MarkerStore that reproduces the SQL contracts
 * processRound/processAllRounds depend on. Rows are keyed by round_number; the
 * window for a round is [prevRow.created_at, thisRow.created_at), and created_at
 * is locked in once at insertPending (the real INSERT ... ON CONFLICT DO NOTHING
 * stable anchor). `bytesByRound` lets a test inject the bytes the worker's
 * getTrafficBytesInWindow query would return for a given target round's window.
 */
class FakeMarkerStore implements MarkerStore {
  rows = new Map<number, MarkerRoundRow>();
  /** Bytes the window-sum returns, keyed by the target round being processed. */
  bytesByRound = new Map<number, bigint>();
  /** Records every (lowerBound, upperBound, returnedBytes) the worker asked for. */
  windowCalls: Array<{ lo: Date; hi: Date; bytes: bigint }> = [];
  private seq = 0;

  setBytes(round: number, bytes: bigint): void {
    this.bytesByRound.set(round, bytes);
  }

  // The window-sum is driven off the row whose created_at == upperBound: that is
  // the round currently being processed, so we look the injected bytes up by it.
  private roundForUpper(upperBound: Date): number | undefined {
    for (const [n, r] of this.rows) {
      if (r.created_at.getTime() === upperBound.getTime()) return n;
    }
    return undefined;
  }

  async init(): Promise<void> {}

  async isEmpty(): Promise<boolean> {
    return this.rows.size === 0;
  }

  async getRow(roundNumber: number): Promise<MarkerRoundRow | undefined> {
    const r = this.rows.get(roundNumber);
    return r ? { ...r } : undefined;
  }

  async insertPending(roundNumber: number): Promise<void> {
    // ON CONFLICT DO NOTHING: never overwrite an existing row (stable anchor).
    if (this.rows.has(roundNumber)) return;
    // Monotonic created_at so prevRound ordering + window bounds are stable and
    // distinct per row (real rows differ by wall-clock insert time).
    const created_at = new Date(1_700_000_000_000 + this.seq++ * 1000);
    this.rows.set(roundNumber, {
      round_number: roundNumber,
      status: "pending",
      traffic_bytes: null,
      traffic_usd: null,
      weight: null,
      update_id: null,
      error_message: null,
      created_at,
      updated_at: created_at,
    });
  }

  async updateStatus(
    roundNumber: number,
    status: string,
    fields: {
      traffic_bytes?: bigint;
      traffic_usd?: string;
      weight?: string;
      update_id?: string;
      error_message?: string;
    } = {}
  ): Promise<void> {
    const r = this.rows.get(roundNumber);
    if (!r) return;
    r.status = status;
    if (fields.traffic_bytes !== undefined) r.traffic_bytes = fields.traffic_bytes;
    if (fields.traffic_usd !== undefined) r.traffic_usd = fields.traffic_usd;
    if (fields.weight !== undefined) r.weight = fields.weight;
    if (fields.update_id !== undefined) r.update_id = fields.update_id;
    if (fields.error_message !== undefined) r.error_message = fields.error_message;
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

  async getPendingRetry(
    minRound: number,
    maxRound: number
  ): Promise<MarkerRoundRow[]> {
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
      if (
        (r.status === "pending" || r.status === "failed") &&
        r.round_number < belowRound
      ) {
        r.status = "expired";
        r.updated_at = new Date();
      }
    }
  }

  async getTrafficBytesInWindow(
    lowerBound: Date,
    upperBound: Date
  ): Promise<bigint> {
    const round = this.roundForUpper(upperBound);
    const bytes =
      (round !== undefined ? this.bytesByRound.get(round) : undefined) ?? 0n;
    this.windowCalls.push({ lo: lowerBound, hi: upperBound, bytes });
    return bytes;
  }
}

/** A mock Scan exposing only what the worker reads. */
function makeScan(currentRound: number) {
  return {
    getCurrentOpenRoundNumber: vi.fn(async () => currentRound),
    getFeaturedAppRight: vi.fn(async () => FA_RIGHT),
    getAmuletRules: vi.fn(async () => ({
      amulet_rules: { domain_id: SYNC },
    })),
  };
}

/** A mock CantonClient: emitX402RoundMarker resolves with a per-round updateId,
 *  and (so scenario (vii) can assert it) records the deterministic commandId the
 *  worker submits. */
function makeClient(opts: { emitThrows?: boolean } = {}) {
  const commandIds: string[] = [];
  const submitAndWaitForTransaction = vi.fn(
    async (req: { commandId: string }) => {
      commandIds.push(req.commandId);
      if (opts.emitThrows) throw new Error("ledger unavailable");
      return { updateId: `upd-${req.commandId}`, offset: 0 };
    }
  );
  return { client: { submitAndWaitForTransaction }, commandIds };
}

function makeServices(opts: {
  store: FakeMarkerStore;
  scanRound: number;
  multiplier?: number;
  emitThrows?: boolean;
}): {
  services: PaidMarkerWorkerServices;
  scan: ReturnType<typeof makeScan>;
  client: ReturnType<typeof makeClient>;
} {
  const scan = makeScan(opts.scanRound);
  const client = makeClient({ emitThrows: opts.emitThrows ?? false });
  const services = {
    markerStore: opts.store,
    client: client.client,
    scan,
    markerFtpParty: FTP,
    markerUserId: "ftp-user",
    markerWeightMultiplier: opts.multiplier ?? 1.35,
  } as unknown as PaidMarkerWorkerServices;
  return { services, scan, client };
}

/** Expected USD weight for a window with `totalBytes` raw bytes. */
function expectedWeight(totalBytes: number, multiplier: number): number {
  const eligible = Math.max(0, totalBytes - FREE_BYTES_PER_ROUND);
  return (eligible / 1_000_000) * TRAFFIC_PRICE_USD_PER_MB * multiplier;
}

describe("paid-marker-worker simulation — MainNet rounds + markers", () => {
  it("(i) normal round advance: emits with weight = (bytes - free) * multiplier", async () => {
    const store = new FakeMarkerStore();
    // Seed a checkpoint for the previous round so the current round is NOT a gap
    // and NOT the first-ever run.
    await store.insertPending(99);
    await store.updateStatus(99, "seeded");

    const multiplier = 1.35;
    const totalBytes = 1_100_000; // 1.0 MB over the 0.1 MB free allowance
    store.setBytes(100, BigInt(totalBytes));

    const { services, client } = makeServices({
      store,
      scanRound: 100,
      multiplier,
    });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    const want = expectedWeight(totalBytes, multiplier);
    expect(row?.weight).toBe(want.toFixed(10));
    expect(row?.traffic_bytes).toBe(BigInt(totalBytes));
    expect(row?.update_id).toBe("upd-x402-round-marker-100");
    // Exactly one marker emitted.
    expect(client.client.submitAndWaitForTransaction).toHaveBeenCalledTimes(1);
    // The window ran over [prev(99).created_at, this(100).created_at).
    expect(store.windowCalls).toHaveLength(1);
  });

  it("(ii) no paid-overage traffic (bytes <= free) -> skipped, no emission", async () => {
    const store = new FakeMarkerStore();
    await store.insertPending(99);
    await store.updateStatus(99, "seeded");
    // At or below the free allowance => eligible 0 => weight 0 => skip.
    store.setBytes(100, BigInt(FREE_BYTES_PER_ROUND));

    const { services, client } = makeServices({ store, scanRound: 100 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("skipped");
    expect(row?.traffic_usd).toBe("0");
    expect(client.client.submitAndWaitForTransaction).not.toHaveBeenCalled();
  });

  it("(iii) round gap (prevRound != target-1) -> seeded checkpoint, no emission (FA Rule 5)", async () => {
    const store = new FakeMarkerStore();
    // Last checkpoint is round 90, but the current open round is 100 — a 10-round
    // gap. Emitting would fold >1 round of bytes into one marker, so the worker
    // must SEED, not emit.
    await store.insertPending(90);
    await store.updateStatus(90, "emitted");
    store.setBytes(100, 5_000_000n); // plenty of bytes — must still NOT emit

    const { services, client } = makeServices({ store, scanRound: 100 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("seeded");
    expect(client.client.submitAndWaitForTransaction).not.toHaveBeenCalled();
  });

  it("(iii-first) first-ever run (empty store) -> seeds initial checkpoint, no emission", async () => {
    const store = new FakeMarkerStore();
    const { services, client } = makeServices({ store, scanRound: 100 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("seeded");
    expect(client.client.submitAndWaitForTransaction).not.toHaveBeenCalled();
  });

  it("(iv) multi-round catch-up: a recent failed row is retried via getPendingRetry", async () => {
    const store = new FakeMarkerStore();
    // Round 98 seeded (anchor), round 99 previously FAILED to emit, current=100.
    await store.insertPending(98);
    await store.updateStatus(98, "seeded");
    await store.insertPending(99);
    await store.updateStatus(99, "failed", { error_message: "prev tick error" });
    // Current round 100 already emitted (so the current-round branch is a no-op
    // and we isolate the catch-up of the recent failed 99).
    await store.insertPending(100);
    await store.updateStatus(100, "emitted");

    store.setBytes(99, 600_000n); // 0.5 MB over free => should emit on retry

    const { services, client } = makeServices({ store, scanRound: 100 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    // 99 is exactly 1 round back (currentRound 100 == 99 + 1) so it is retried,
    // not expired, and now emits.
    const r99 = await store.getRow(99);
    expect(r99?.status).toBe("emitted");
    expect(r99?.update_id).toBe("upd-x402-round-marker-99");
    expect(client.commandIds).toContain("x402-round-marker-99");
    // 100 was already emitted; it is NOT re-submitted.
    expect(client.commandIds).not.toContain("x402-round-marker-100");
  });

  it("(v) crash recovery: a pending current-round row is re-processed and emits", async () => {
    const store = new FakeMarkerStore();
    await store.insertPending(99);
    await store.updateStatus(99, "seeded");
    // Simulate a crash mid-round: the current round 100 row exists but is still
    // 'pending' (the previous tick inserted it then died before emitting).
    await store.insertPending(100);
    expect((await store.getRow(100))?.status).toBe("pending");

    store.setBytes(100, 700_000n);

    const { services, client } = makeServices({ store, scanRound: 100 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    expect(client.commandIds).toContain("x402-round-marker-100");
  });

  it("(vi) stale row expiry: pending/failed rows > 1 round old are expired, not emitted", async () => {
    const store = new FakeMarkerStore();
    // Rounds 95 (pending) and 96 (failed) are stale (> 1 round below current 100).
    await store.insertPending(95);
    await store.insertPending(96);
    await store.updateStatus(96, "failed", { error_message: "old" });
    // Anchor + current so the tick has a clean current round to seed/emit.
    await store.insertPending(99);
    await store.updateStatus(99, "seeded");
    store.setBytes(100, 500_000n);

    const { services, client } = makeServices({ store, scanRound: 100 });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    // Both stale rows expired by expireRows(currentRound-1=99): round_number < 99.
    expect((await store.getRow(95))?.status).toBe("expired");
    expect((await store.getRow(96))?.status).toBe("expired");
    // The stale rows never produced a marker.
    expect(client.commandIds).not.toContain("x402-round-marker-95");
    expect(client.commandIds).not.toContain("x402-round-marker-96");
  });

  it("(vii) idempotent commandId x402-round-marker-{round}; emit-failure marks the row failed for a clean retry", async () => {
    // First tick: emit THROWS -> the round row is marked 'failed' (current round,
    // not >1 behind), and the worker submitted the deterministic commandId.
    const store = new FakeMarkerStore();
    await store.insertPending(99);
    await store.updateStatus(99, "seeded");
    store.setBytes(100, 800_000n);

    const failing = makeServices({ store, scanRound: 100, emitThrows: true });
    await processAllRounds(failing.services, FA_RIGHT, SYNC, silentLog);

    const failedRow = await store.getRow(100);
    expect(failedRow?.status).toBe("failed");
    expect(failing.client.commandIds).toEqual(["x402-round-marker-100"]);

    // Second tick (same round, same store): emit SUCCEEDS this time. The retry
    // re-uses the SAME deterministic commandId — Canton-side dedup makes a second
    // submit for an already-emitted round a no-op, so re-emitting is safe.
    const ok = makeServices({ store, scanRound: 100 });
    await processAllRounds(ok.services, FA_RIGHT, SYNC, silentLog);

    const okRow = await store.getRow(100);
    expect(okRow?.status).toBe("emitted");
    // Same idempotency key on the retry submit.
    expect(ok.client.commandIds).toEqual(["x402-round-marker-100"]);
    expect(okRow?.update_id).toBe("upd-x402-round-marker-100");
  });

  it("(viii) TWO-LEG ESCROW round: window bytes include settle + forward, and the emitted weight reflects BOTH (proves Task 1)", async () => {
    // An escrow payment burns GS traffic TWICE per payment: the X402Escrow_Settle
    // leg AND the facilitator->merchant forward leg. Task 1 attributes the forward
    // into the SAME payment row's create_* columns, so getTrafficBytesInWindow
    // (which sums status bytes + create_status bytes per row) returns settle +
    // forward for the escrow row. Here we inject the COMBINED bytes the window sum
    // would return and assert the marker weight reflects both legs — and that it
    // is strictly greater than a settle-only (one-leg) weight, which is the exact
    // under-earning the fix closes.
    const SETTLE_BYTES = 8552; // observed mainnet X402Escrow_Settle leg
    const FORWARD_BYTES = 8552; // the forward TransferPreapproval_Send leg
    const multiplier = 1.35;

    const store = new FakeMarkerStore();
    await store.insertPending(99);
    await store.updateStatus(99, "seeded");

    // Push the round's overage above the free allowance so it emits: model 8
    // escrow payments in the window, each contributing settle + forward bytes.
    const PAYMENTS = 8;
    const twoLegTotal = PAYMENTS * (SETTLE_BYTES + FORWARD_BYTES); // 136_832
    store.setBytes(100, BigInt(twoLegTotal));

    const { services, client } = makeServices({
      store,
      scanRound: 100,
      multiplier,
    });
    await processAllRounds(services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("emitted");
    expect(client.client.submitAndWaitForTransaction).toHaveBeenCalledTimes(1);

    // The emitted weight reflects BOTH legs of every escrow payment.
    const wantTwoLeg = expectedWeight(twoLegTotal, multiplier);
    expect(row?.weight).toBe(wantTwoLeg.toFixed(10));
    expect(row?.traffic_bytes).toBe(BigInt(twoLegTotal));

    // REGRESSION ANCHOR: had the forward leg gone unattributed (the original
    // bug), the same round would have summed ONLY the settle bytes, yielding a
    // strictly smaller weight — i.e. the facilitator would under-earn. Assert the
    // two-leg weight is materially larger than the settle-only weight.
    const settleOnlyTotal = PAYMENTS * SETTLE_BYTES; // 68_416
    const wantSettleOnly = expectedWeight(settleOnlyTotal, multiplier);
    expect(wantTwoLeg).toBeGreaterThan(wantSettleOnly);
    // Settle-only would actually fall UNDER the free allowance here (68_416 <
    // 100_000) and emit nothing — so without the forward attribution this whole
    // round would have been skipped despite real GS burn. The fix turns a
    // would-be-skipped round into a correctly-weighted emission.
    expect(settleOnlyTotal).toBeLessThan(FREE_BYTES_PER_ROUND);
    expect(wantSettleOnly).toBe(0);
    expect(twoLegTotal).toBeGreaterThan(FREE_BYTES_PER_ROUND);
  });

  it("processRound directly: gap path seeds (covers the exported unit in isolation)", async () => {
    // Drive processRound directly (the task names both entrypoints). prevRow is
    // round 80 while target is 100 — a gap — so it seeds without emitting.
    const store = new FakeMarkerStore();
    await store.insertPending(80);
    await store.updateStatus(80, "emitted");
    store.setBytes(100, 9_000_000n);

    const { services, client } = makeServices({ store, scanRound: 100 });
    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    expect((await store.getRow(100))?.status).toBe("seeded");
    expect(client.client.submitAndWaitForTransaction).not.toHaveBeenCalled();
  });
});
