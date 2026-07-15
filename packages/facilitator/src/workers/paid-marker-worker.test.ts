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
 * Weight = Δ total_consumed / 1e6 * $60/MB * multiplier, clamped to
 * maxWeightPerRound. Covers: normal advance, first-run seed, round gap, negative
 * delta (counter reset), zero delta (no new traffic), over-cap clamp, Scan outage
 * skip, and emit failure.
 */
import { describe, it, expect, vi } from "vitest";
import {
  processAllRounds,
  processRound,
  type PaidMarkerWorkerServices,
} from "./paid-marker-worker.js";
import type { MarkerRoundRow, MarkerStore } from "../db/marker-store.js";

// Mirror the worker's own constants so the assertions are self-checking.
const TRAFFIC_PRICE_USD_PER_MB = 60;

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
      created_at,
      updated_at: created_at,
    });
  }

  async updateStatus(
    roundNumber: number,
    status: string,
    fields: {
      traffic_bytes?: bigint;
      traffic_consumed?: bigint;
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
    if (fields.traffic_consumed !== undefined) r.traffic_consumed = fields.traffic_consumed;
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

function makeClient(opts: { emitThrows?: boolean } = {}) {
  const commandIds: string[] = [];
  const submitAndWaitForTransaction = vi.fn(async (req: { commandId: string }) => {
    commandIds.push(req.commandId);
    if (opts.emitThrows) throw new Error("ledger unavailable");
    return { updateId: `upd-${req.commandId}`, offset: 0 };
  });
  return { client: { submitAndWaitForTransaction }, commandIds };
}

function makeServices(opts: {
  store: FakeMarkerStore;
  scanRound: number;
  multiplier?: number;
  maxWeight?: number;
  emitThrows?: boolean;
}) {
  const { scan, state } = makeScan(opts.scanRound);
  const client = makeClient({ emitThrows: opts.emitThrows ?? false });
  const services = {
    markerStore: opts.store,
    client: client.client,
    scan,
    markerFtpParty: FTP,
    markerUserId: "ftp-user",
    markerWeightMultiplier: opts.multiplier ?? 1.15,
    facilitatorMemberId: MEMBER,
    maxWeightPerRound: opts.maxWeight ?? 1000,
  } as unknown as PaidMarkerWorkerServices;
  return { services, scan, client, traffic: state };
}

/** Expected USD weight for a round whose consumed grew by `deltaBytes`. */
function expectedWeight(deltaBytes: number, multiplier: number): number {
  return (Math.max(0, deltaBytes) / 1_000_000) * TRAFFIC_PRICE_USD_PER_MB * multiplier;
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

  it("zero delta (no new traffic): skipped, no emit", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic, client } = makeServices({ store, scanRound: 100 });
    traffic.consumed = 1_000_000; // delta 0 — nothing to mark this round

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("skipped");
    expect(client.commandIds).toHaveLength(0);
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

  it("emit failure: marks failed (currentRound == target)", async () => {
    const store = new FakeMarkerStore();
    await seedPrev(store, 99, 1_000_000n);
    const { services, traffic } = makeServices({ store, scanRound: 100, emitThrows: true });
    traffic.consumed = 1_000_000 + 600_000;

    await processRound(100, 100, services, FA_RIGHT, SYNC, silentLog);

    const row = await store.getRow(100);
    expect(row?.status).toBe("failed");
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
