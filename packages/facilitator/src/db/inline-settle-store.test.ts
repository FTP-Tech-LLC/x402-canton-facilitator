import { describe, it, expect } from "vitest";
import {
  createInMemoryInlineSettleStore,
  createPostgresInlineSettleStore,
  createInlineSettleStore,
} from "./inline-settle-store.js";

describe("inline settle store — in memory", () => {
  it("records once and returns what it recorded", async () => {
    const s = createInMemoryInlineSettleStore();
    expect(await s.getRecord("aa")).toBeNull();
    expect(await s.recordSettled("aa", "update-1")).toBe(true);
    expect(await s.getRecord("aa")).toEqual({ state: "settled", updateId: "update-1" });
  });

  it("reports the second writer as the loser, and keeps the FIRST answer", async () => {
    // Two concurrent settles of one payment: whoever recorded first is the
    // truth. Overwriting would hand the second caller an updateId for a relay
    // that may not have moved the funds it thinks it did.
    const s = createInMemoryInlineSettleStore();
    await s.recordSettled("aa", "update-1");
    expect(await s.recordSettled("aa", "update-2")).toBe(false);
    expect(await s.getRecord("aa")).toEqual({ state: "settled", updateId: "update-1" });
  });

  it("bounds memory by dropping the oldest entries", async () => {
    const s = createInMemoryInlineSettleStore({ maxSize: 2 });
    await s.recordSettled("a", "1");
    await s.recordSettled("b", "2");
    await s.recordSettled("c", "3");
    expect(await s.getRecord("a")).toBeNull();
    expect(await s.getRecord("c")).toEqual({ state: "settled", updateId: "3" });
  });

  it("sweeps only what is older than the retention window", async () => {
    let now = 1_000_000;
    const s = createInMemoryInlineSettleStore({ now: () => now });
    await s.recordSettled("old", "1");
    now += 10_000;
    await s.recordSettled("new", "2");
    now += 1;
    expect(await s.sweep(5_000)).toBe(1);
    expect(await s.getRecord("old")).toBeNull();
    expect(await s.getRecord("new")).toEqual({ state: "settled", updateId: "2" });
  });
});

describe("inline settle store — postgres, and what it does when the DB is down", () => {
  function execThrows() {
    return {
      query: async () => {
        throw new Error("database unreachable");
      },
    };
  }

  it("FAILS OPEN on read: an unreadable store means relay again, never refuse", async () => {
    // Costing traffic is recoverable. Refusing a settle because a cost-guard is
    // unavailable would turn a degraded cache into a payment outage.
    const s = createPostgresInlineSettleStore(execThrows());
    expect(await s.getRecord("aa")).toBeNull();
  });

  it("FAILS OPEN on write: the funds already moved, so the response must not depend on it", async () => {
    const s = createPostgresInlineSettleStore(execThrows());
    expect(await s.recordSettled("aa", "u")).toBe(true);
  });

  it("reports a duplicate insert as not-newly-recorded", async () => {
    const calls: string[] = [];
    const s = createPostgresInlineSettleStore({
      query: async (sql: string) => {
        calls.push(sql.trim().split(/\s+/)[0]!);
        return { rows: [], rowCount: sql.includes("INSERT") ? 0 : 0 };
      },
    });
    expect(await s.recordSettled("aa", "u")).toBe(false);
    // The table is created lazily on first use, not at construction: a store
    // that is never touched must not talk to the database at all.
    expect(calls[0]).toBe("CREATE");
  });

  it("RECOVERS after a transient failure instead of latching off forever", async () => {
    // The defect this catches: the lazy CREATE TABLE promise is memoised. If it
    // is memoised while REJECTED and never cleared, every later read and write
    // awaits that same rejection, the fail-open catches swallow it, and the
    // store silently reports "never seen" for the whole process lifetime — so
    // every retry re-relays and burns traffic while the store looks healthy.
    // One restart or failover at the wrong moment is enough to trigger it.
    let failNext = true;
    const seen: string[] = [];
    const s = createPostgresInlineSettleStore({
      query: async (sql: string) => {
        if (sql.includes("CREATE") && failNext) {
          failNext = false;
          throw new Error("database restarting");
        }
        seen.push(sql.trim().split(/\s+/)[0]!);
        return { rows: [{ update_id: "u" }], rowCount: 1 };
      },
    });
    // First call rides out the outage, fail-open.
    expect(await s.getRecord("aa")).toBeNull();
    // The database is healthy again — so must the store be.
    expect(await s.getRecord("aa")).toEqual({ state: "settled", updateId: "u" });
    expect(seen).toContain("SELECT");
  });

  it("falls back to memory when nothing is configured", async () => {
    const s = createInlineSettleStore();
    await s.recordSettled("aa", "u");
    expect(await s.getRecord("aa")).toEqual({ state: "settled", updateId: "u" });
  });
});

/**
 * THE MIDDLE STATE. Everything here is about the one thing the store could not
 * previously say: "we dispatched this and never saw the answer."
 */
describe("the dispatch marker — in memory", () => {
  it("a dispatched-but-unresolved transaction reads as dispatched, not as unseen", async () => {
    const s = createInMemoryInlineSettleStore();
    expect(await s.recordDispatched("aa")).toBe(true);
    expect(await s.getRecord("aa")).toEqual({ state: "dispatched" });
  });

  it("carries the submissionId and offset a later resolve needs", async () => {
    const s = createInMemoryInlineSettleStore();
    await s.recordDispatched("aa", { submissionId: "sub-1", beginExclusive: 7 });
    expect(await s.getRecord("aa")).toEqual({
      state: "dispatched",
      submissionId: "sub-1",
      beginExclusive: 7,
    });
  });

  it("recordSettled promotes our own marker", async () => {
    const s = createInMemoryInlineSettleStore();
    await s.recordDispatched("aa");
    expect(await s.recordSettled("aa", "u1")).toBe(true);
    expect(await s.getRecord("aa")).toEqual({ state: "settled", updateId: "u1" });
  });

  it("a second dispatch of the same transaction is refused", async () => {
    // This is the interlock: whoever wrote the marker owns the submission, and
    // everyone else must read the record rather than relay again.
    const s = createInMemoryInlineSettleStore();
    expect(await s.recordDispatched("aa")).toBe(true);
    expect(await s.recordDispatched("aa")).toBe(false);
  });

  it("a marker never overwrites a settled record", async () => {
    const s = createInMemoryInlineSettleStore();
    await s.recordSettled("aa", "u1");
    expect(await s.recordDispatched("aa")).toBe(false);
    expect(await s.getRecord("aa")).toEqual({ state: "settled", updateId: "u1" });
  });

  it("a settled record is not overwritten by a LATER, different updateId", async () => {
    // Unchanged contract, restated because recordSettled now upserts. The
    // ON CONFLICT ... WHERE update_id IS NULL clause is what preserves it; drop
    // the WHERE and this is the test that notices.
    const s = createInMemoryInlineSettleStore();
    await s.recordSettled("aa", "u1");
    expect(await s.recordSettled("aa", "u2")).toBe(false);
    expect(await s.getRecord("aa")).toEqual({ state: "settled", updateId: "u1" });
  });
});

describe("the dispatch marker — Postgres SQL shape", () => {
  /** Records the SQL so the promote/refuse clauses are pinned, not assumed. */
  function spy(rows: Array<Record<string, unknown>> = [], rowCount = 1) {
    const sql: string[] = [];
    const params: unknown[][] = [];
    return {
      sql,
      params,
      exec: {
        async query(q: string, p?: unknown[]) {
          sql.push(q.replace(/\s+/g, " ").trim());
          params.push(p ?? []);
          return { rows, rowCount };
        },
      },
    };
  }

  it("boots by dropping the legacy NOT NULL on update_id", async () => {
    // The LIVE table was created with update_id NOT NULL and CREATE TABLE IF NOT
    // EXISTS never alters it, so without this every marker write would fail and
    // fail-open would silently restore the old behaviour.
    const { sql, exec } = spy();
    const s = createPostgresInlineSettleStore(exec);
    await s.recordDispatched("aa");
    expect(sql.some((q) => /ALTER COLUMN update_id DROP NOT NULL/.test(q))).toBe(true);
  });

  it("writes the marker with a NULL update_id and does not clobber on conflict", async () => {
    const { sql, params, exec } = spy();
    const s = createPostgresInlineSettleStore(exec);
    await s.recordDispatched("aa");
    const insert = sql.find((q) => q.startsWith("INSERT INTO inline_settles"))!;
    expect(insert).toMatch(/VALUES \(\$1, NULL, \$2, \$3\)/);
    expect(insert).toMatch(/ON CONFLICT \(tx_hash\) DO NOTHING/);
    expect(params.at(-1)).toEqual(["aa", null, null]);
  });

  it("stores the submissionId and offset a later resolve needs", async () => {
    const { params, exec } = spy();
    const s = createPostgresInlineSettleStore(exec);
    await s.recordDispatched("aa", { submissionId: "x402-inline-k", beginExclusive: 42 });
    expect(params.at(-1)).toEqual(["aa", "x402-inline-k", 42]);
  });

  it("reads them back, coercing the bigint pg hands over as a string", async () => {
    const s = createPostgresInlineSettleStore(
      spy([{ update_id: null, submission_id: "x402-inline-k", begin_exclusive: "42" }]).exec
    );
    expect(await s.getRecord("aa")).toEqual({
      state: "dispatched",
      submissionId: "x402-inline-k",
      beginExclusive: 42,
    });
  });

  it("an old row with no offset is still 'dispatched' — just not auto-resolvable", async () => {
    // Rows written before these columns existed. Refusing to relay is still
    // correct; only the automatic resolve is unavailable.
    const s = createPostgresInlineSettleStore(
      spy([{ update_id: null, submission_id: null, begin_exclusive: null }]).exec
    );
    expect(await s.getRecord("aa")).toEqual({ state: "dispatched" });
  });

  it("recordSettled promotes ONLY a row whose update_id is still NULL", async () => {
    const { sql, exec } = spy();
    const s = createPostgresInlineSettleStore(exec);
    await s.recordSettled("aa", "u1");
    const upsert = sql.find((q) => /DO UPDATE/.test(q))!;
    expect(upsert).toMatch(/WHERE inline_settles\.update_id IS NULL/);
  });

  it("reads a NULL update_id as dispatched, a present one as settled", async () => {
    const dispatched = createPostgresInlineSettleStore(
      spy([{ update_id: null }]).exec
    );
    expect(await dispatched.getRecord("aa")).toEqual({ state: "dispatched" });
    const settled = createPostgresInlineSettleStore(spy([{ update_id: "u1" }]).exec);
    expect(await settled.getRecord("aa")).toEqual({ state: "settled", updateId: "u1" });
    const missing = createPostgresInlineSettleStore(spy([], 0).exec);
    expect(await missing.getRecord("aa")).toBeNull();
  });

  it("a write error still fails OPEN — a DB blip must not refuse honest payments", async () => {
    // Deliberate and worth stating: the marker is a protection, not a
    // precondition. Refusing to dispatch because we could not write a row would
    // turn a database blip into a payment outage, which is a bigger failure
    // than the one being guarded against.
    const s = createPostgresInlineSettleStore({
      async query() {
        throw new Error("db down");
      },
    });
    expect(await s.recordDispatched("aa")).toBe(true);
    expect(await s.getRecord("aa")).toBeNull();
  });
});
