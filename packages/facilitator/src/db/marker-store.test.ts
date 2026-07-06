import { describe, it, expect, vi } from "vitest";
import {
  createPostgresMarkerStore,
  createMarkerStore,
  type PgExecutor,
} from "./marker-store.js";

function makeExec(rows: Record<string, unknown>[]): PgExecutor {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

// init() runs one DDL query (CREATE TABLE). Subsequent calls are data queries.
function makeExecSeq(...responses: Record<string, unknown>[][]): PgExecutor {
  const mock = vi.fn();
  mock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // CREATE TABLE DDL
  for (const rows of responses) {
    mock.mockResolvedValueOnce({ rows, rowCount: rows.length });
  }
  return { query: mock };
}

describe("MarkerStore.init", () => {
  it("runs CREATE TABLE DDL on first call", async () => {
    const exec = makeExec([]);
    const store = createPostgresMarkerStore(exec);
    await store.init();
    const calls = (exec.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("CREATE TABLE IF NOT EXISTS marker_rounds");
  });

  it("is idempotent — DDL runs only once", async () => {
    const exec = makeExec([]);
    const store = createPostgresMarkerStore(exec);
    await store.init();
    await store.init();
    expect((exec.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe("MarkerStore.insertPending", () => {
  it("inserts with ON CONFLICT DO NOTHING", async () => {
    const exec = makeExecSeq([]);
    const store = createPostgresMarkerStore(exec);
    await store.insertPending(42);
    const calls = (exec.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toContain("ON CONFLICT (round_number) DO NOTHING");
    expect(calls[1][1]).toEqual([42]);
  });
});

describe("MarkerStore.updateStatus", () => {
  it("updates only status when no extra fields", async () => {
    const exec = makeExecSeq([]);
    const store = createPostgresMarkerStore(exec);
    await store.updateStatus(5, "emitted");
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[0]).toContain("status=$2");
    expect(call[1]).toEqual([5, "emitted"]);
  });

  it("includes update_id and weight when provided", async () => {
    const exec = makeExecSeq([]);
    const store = createPostgresMarkerStore(exec);
    await store.updateStatus(7, "emitted", {
      update_id: "tx-123",
      weight: "12.5000000000",
      traffic_bytes: 50000n,
      traffic_usd: "3.0000000000",
    });
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[0]).toContain("update_id=$");
    expect(call[0]).toContain("weight=$");
    expect(call[1]).toContain("tx-123");
    expect(call[1]).toContain("12.5000000000");
  });
});

describe("MarkerStore.isEmpty", () => {
  it("returns true when table has no rows", async () => {
    const exec = makeExecSeq([]);
    // makeExecSeq gives rowCount=0 for the data call
    const store = createPostgresMarkerStore(exec);
    expect(await store.isEmpty()).toBe(true);
  });

  it("returns false when table has at least one row", async () => {
    const exec = makeExecSeq([{ "?column?": 1 }]);
    const store = createPostgresMarkerStore(exec);
    expect(await store.isEmpty()).toBe(false);
  });
});

describe("MarkerStore.getPrevRound", () => {
  it("queries round_number < belowRound ORDER BY DESC LIMIT 1 and coerces round_number", async () => {
    // pg returns bigint columns as strings — store must coerce to number
    const exec = makeExecSeq([{ round_number: "9", status: "emitted", created_at: new Date() }]);
    const store = createPostgresMarkerStore(exec);
    const row = await store.getPrevRound(10);
    expect(row?.round_number).toBe(9); // coerced to number
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[0]).toContain("round_number < $1");
    expect(call[0]).toContain("ORDER BY round_number DESC LIMIT 1");
    expect(call[1]).toEqual([10]);
  });

  it("returns undefined when no previous round exists", async () => {
    const exec = makeExecSeq([]);
    const store = createPostgresMarkerStore(exec);
    const row = await store.getPrevRound(1);
    expect(row).toBeUndefined();
  });
});

describe("MarkerStore.expireRows", () => {
  it("sets status=expired for pending/failed rows below the cutoff", async () => {
    const exec = makeExecSeq([]);
    const store = createPostgresMarkerStore(exec);
    await store.expireRows(10);
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[0]).toContain("status='expired'");
    expect(call[0]).toContain("status IN ('pending','failed')");
    expect(call[0]).toContain("round_number < $1");
    expect(call[1]).toEqual([10]);
  });
});

describe("MarkerStore.getPendingRetry", () => {
  it("returns pending/failed rows in [minRound, maxRound) with round_number coerced to number", async () => {
    // pg returns bigint as string — verify coercion
    const rows = [
      { round_number: "8", status: "failed", created_at: new Date() },
      { round_number: "9", status: "pending", created_at: new Date() },
    ];
    const exec = makeExecSeq(rows);
    const store = createPostgresMarkerStore(exec);
    const result = await store.getPendingRetry(8, 10);
    expect(result).toHaveLength(2);
    expect(result[0]!.round_number).toBe(8);  // coerced from "8"
    expect(result[1]!.round_number).toBe(9);
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[0]).toContain("status IN ('pending','failed')");
    expect(call[0]).toContain("round_number >= $1");
    expect(call[0]).toContain("round_number < $2");
    expect(call[1]).toEqual([8, 10]);
  });
});

describe("MarkerStore.getTrafficBytesInWindow", () => {
  it("anchors rows by settled_at and counts confirmed legs at real bytes", async () => {
    const exec = makeExecSeq([{ bytes: "1500000" }]);
    const store = createPostgresMarkerStore(exec);
    const lower = new Date("2026-06-01T00:00:00Z");
    const upper = new Date("2026-06-02T00:00:00Z");
    const bytes = await store.getTrafficBytesInWindow(lower, upper);
    expect(bytes).toBe(1500000n);
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call[0]).toContain("FROM payment_burns");
    expect(call[0]).toContain("settle_status='served'");
    expect(call[0]).toContain("WHEN status='confirmed' THEN traffic_bytes");
    expect(call[0]).toContain("WHEN create_status='confirmed' THEN COALESCE(create_traffic_bytes, 0)");
    // Stable per-row anchor: settled_at, never record_time (a record_time
    // anchor lets a row estimated in one window be re-counted real in the
    // next when the verdict lands seconds after a round boundary).
    expect(call[0]).toContain("settled_at >= $1 AND settled_at < $2");
    expect(call[0]).not.toContain("record_time >=");
    expect(call[1]).toEqual([lower.toISOString(), upper.toISOString()]);
  });

  it("estimates byte-less legs from a live 24h average with cold-start fallbacks", async () => {
    const exec = makeExecSeq([{ bytes: "30248" }]);
    const store = createPostgresMarkerStore(exec);
    await store.getTrafficBytesInWindow(new Date(0), new Date(1));
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[1];
    // Live average over recent confirmed legs, never the hardcoded constant
    // alone (8552/6710 only seed a cold DB inside COALESCE).
    expect(call[0]).toContain("AVG(traffic_bytes)");
    expect(call[0]).toContain("AVG(create_traffic_bytes)");
    expect(call[0]).toContain("8552");
    expect(call[0]).toContain("6710");
    expect(call[0]).toContain("interval '24 hours'");
    // In-flight and exhausted legs count at the estimate; rejected stays out.
    expect(call[0]).toContain("WHEN status IN ('pending','failed','no_summary') THEN (SELECT send_avg FROM avg_bytes)");
    expect(call[0]).toContain("WHEN create_status IN ('pending','failed','no_summary') THEN (SELECT create_avg FROM avg_bytes)");
    expect(call[0]).not.toContain("'rejected'");
    // Rows without a create leg must not get a create estimate.
    expect(call[0]).toContain("WHEN create_update_id IS NULL THEN 0");
  });

  it("returns 0n when no rows settled in the window", async () => {
    const exec = makeExecSeq([{ bytes: "0" }]);
    const store = createPostgresMarkerStore(exec);
    const bytes = await store.getTrafficBytesInWindow(new Date(0), new Date());
    expect(bytes).toBe(0n);
  });
});

describe("createMarkerStore factory", () => {
  it("uses an injected shared executor when provided", async () => {
    const exec: PgExecutor = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    const store = createMarkerStore("postgres://ignored", { executor: exec });
    await store.init();
    const calls = (exec.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => String(c[0]).startsWith("CREATE TABLE"))).toBe(true);
  });
});
