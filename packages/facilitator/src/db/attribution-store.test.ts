import { describe, it, expect, vi } from "vitest";
import {
  createPostgresAttributionStore,
  createAttributionStore,
  type PgExecutor,
} from "./attribution-store.js";

function makeExec(rows: Record<string, unknown>[]): PgExecutor {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) };
}

// Stub that returns DDL success then the given rows for subsequent calls.
// init() runs two DDL queries (CREATE TABLE + ALTER TABLE), so we mock both.
function makeExecSeq(...responses: Record<string, unknown>[][]): PgExecutor {
  const mock = vi.fn();
  mock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // CREATE TABLE DDL
  mock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ALTER TABLE DDL
  for (const rows of responses) {
    mock.mockResolvedValueOnce({ rows, rowCount: rows.length });
  }
  return { query: mock };
}

describe("AttributionStore.getTotals", () => {
  const statsRow = {
    pending_count: "1", failed_count: "0",
    rejected_count: "0", no_summary_count: "0", attempted_count: "2",
    create_pending_count: "0", create_failed_count: "0",
  };

  it("totalPayments counts only served rows", async () => {
    const exec = makeExecSeq(
      [{ total: "3" }],         // totalPayments (served)
      [{ bytes: "0" }],         // confirmedBytes
      [{ bytes: "0" }],         // eligibleBytes
      [statsRow],               // stats
      [{ bytes: "0" }],         // createConfirmedBytes
    );
    const store = createPostgresAttributionStore(exec);
    const t = await store.getTotals({ excludedParticipants: [], excludedParties: [] });
    expect(t.totalPayments).toBe(3);
    expect(t.attemptedCount).toBe(2);
    const calls = (exec.query as ReturnType<typeof vi.fn>).mock.calls;
    // totalPayments query must include settle_status='served' (call[2] — after 2 DDL)
    expect(calls[2][0]).toContain("settle_status='served'");
  });

  it("pendingCount only counts served rows", async () => {
    const exec = makeExecSeq(
      [{ total: "5" }],
      [{ bytes: "0" }],
      [{ bytes: "0" }],
      [{ ...statsRow, pending_count: "2", failed_count: "1", attempted_count: "1" }],
      [{ bytes: "0" }],
    );
    const store = createPostgresAttributionStore(exec);
    const t = await store.getTotals({ excludedParticipants: [], excludedParties: [] });
    expect(t.pendingCount).toBe(2);
    expect(t.failedCount).toBe(1);
    // stats query is call[5] (2 DDL + totalPayments + confirmedBytes + eligibleBytes + stats)
    const statsQuery = (exec.query as ReturnType<typeof vi.fn>).mock.calls[5][0] as string;
    expect(statsQuery).toContain("status='pending'    AND settle_status='served'");
    expect(statsQuery).toContain("status='failed'     AND settle_status='served'");
  });

  it("eligibleBytes excludes NULL submitting_participant_uid", async () => {
    const exec = makeExecSeq(
      [{ total: "1" }],
      [{ bytes: "5000" }],
      [{ bytes: "0" }],   // eligible = 0 (NULL participant excluded)
      [statsRow],
      [{ bytes: "0" }],
    );
    const store = createPostgresAttributionStore(exec);
    const t = await store.getTotals({ excludedParticipants: ["PAR::ftp::123"], excludedParties: [] });
    // eligibleBytes query is call[4] (2 DDL + totalPayments + confirmedBytes + eligibleBytes)
    const eligibleQuery = (exec.query as ReturnType<typeof vi.fn>).mock.calls[4][0] as string;
    expect(eligibleQuery).toContain("submitting_participant_uid IS NOT NULL");
    expect(t.eligibleBytes).toBe(0n);
  });

  it("eligibleBytes includes row when excludedParticipants is empty", async () => {
    const exec = makeExecSeq(
      [{ total: "1" }],
      [{ bytes: "3384" }],
      [{ bytes: "3384" }],
      [statsRow],
      [{ bytes: "0" }],
    );
    const store = createPostgresAttributionStore(exec);
    const t = await store.getTotals({ excludedParticipants: [], excludedParties: [] });
    expect(t.confirmedBytes).toBe(3384n);
    expect(t.eligibleBytes).toBe(3384n);
  });
});

describe("AttributionStore.updateTrafficSummary", () => {
  const baseResult = {
    updateId: "uid1",
    recordTime: "2026-06-05T10:00:00Z",
    verdictResult: "VERDICT_RESULT_ACCEPTED",
    submittingParticipantUid: "PAR::sv::123",
    submittingParties: ["party::123"],
    totalTrafficCost: 3384,
  };

  // Helper: mock 2 DDL calls + 1 data call
  function makeUpdateExec(): PgExecutor {
    const mock = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE DDL
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE DDL
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    return { query: mock };
  }

  it("confirmed on accepted + valid cost", async () => {
    const exec = makeUpdateExec();
    const store = createPostgresAttributionStore(exec);
    await store.updateTrafficSummary("uid1", baseResult);
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("status='confirmed'");
    expect(call[1]).toContain(3384);
  });

  it("no_summary on accepted + null cost", async () => {
    const exec = makeUpdateExec();
    const store = createPostgresAttributionStore(exec);
    await store.updateTrafficSummary("uid1", { ...baseResult, totalTrafficCost: null });
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("status='no_summary'");
  });

  it("rejected on non-ACCEPTED verdict", async () => {
    const exec = makeUpdateExec();
    const store = createPostgresAttributionStore(exec);
    await store.updateTrafficSummary("uid1", { ...baseResult, verdictResult: "VERDICT_RESULT_REJECTED" });
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("status='rejected'");
  });

  it("failed on updateId mismatch, no throw", async () => {
    const exec = makeUpdateExec();
    const store = createPostgresAttributionStore(exec);
    await expect(
      store.updateTrafficSummary("uid1", { ...baseResult, updateId: "different" })
    ).resolves.toBeUndefined();
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("status='failed'");
  });

  it("failed on negative cost, no throw", async () => {
    const exec = makeUpdateExec();
    const store = createPostgresAttributionStore(exec);
    await expect(
      store.updateTrafficSummary("uid1", { ...baseResult, totalTrafficCost: -1 })
    ).resolves.toBeUndefined();
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("status='failed'");
  });
});

describe("AttributionStore.updateCreateTrafficSummary", () => {
  const baseResult = {
    updateId: "create-uid-1",
    recordTime: "2026-06-06T10:00:00Z",
    verdictResult: "VERDICT_RESULT_ACCEPTED",
    submittingParticipantUid: "PAR::sv::123",
    submittingParties: ["party::123"],
    totalTrafficCost: 1500,
  };

  function makeCreateExec(storedCid = "create-uid-1"): PgExecutor {
    const mock = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // CREATE TABLE DDL
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // ALTER TABLE DDL
      .mockResolvedValueOnce({ rows: [{ create_update_id: storedCid }], rowCount: 1 }) // SELECT cid guard
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    return { query: mock };
  }

  it("confirmed on accepted + valid cost", async () => {
    const exec = makeCreateExec();
    const store = createPostgresAttributionStore(exec);
    await store.updateCreateTrafficSummary("send-uid-1", baseResult);
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[3];
    expect(call[0]).toContain("create_status='confirmed'");
    expect(call[1]).toContain(1500);
  });

  it("no_summary on accepted + null cost", async () => {
    const exec = makeCreateExec();
    const store = createPostgresAttributionStore(exec);
    await store.updateCreateTrafficSummary("send-uid-1", { ...baseResult, totalTrafficCost: null });
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[3];
    expect(call[0]).toContain("create_status='no_summary'");
  });

  it("rejected on non-ACCEPTED verdict", async () => {
    const exec = makeCreateExec();
    const store = createPostgresAttributionStore(exec);
    await store.updateCreateTrafficSummary("send-uid-1", { ...baseResult, verdictResult: "VERDICT_RESULT_REJECTED" });
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[3];
    expect(call[0]).toContain("create_status='rejected'");
  });

  it("failed + no throw on createUpdateId mismatch", async () => {
    const exec = makeCreateExec("create-uid-OTHER");
    const store = createPostgresAttributionStore(exec);
    await expect(
      store.updateCreateTrafficSummary("send-uid-1", baseResult)
    ).resolves.toBeUndefined();
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[3];
    expect(call[0]).toContain("create_status='failed'");
  });

  it("failed on negative cost", async () => {
    const exec = makeCreateExec();
    const store = createPostgresAttributionStore(exec);
    await store.updateCreateTrafficSummary("send-uid-1", { ...baseResult, totalTrafficCost: -1 });
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[3];
    expect(call[0]).toContain("create_status='failed'");
  });
});

describe("AttributionStore.setCreateUpdateId", () => {
  it("sets create_update_id and create_status='pending' idempotently", async () => {
    const exec: PgExecutor = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };
    const store = createPostgresAttributionStore(exec);
    await store.setCreateUpdateId("send-uid-1", "create-uid-1");
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("create_update_id=$2");
    expect(call[0]).toContain("create_status='pending'");
    expect(call[0]).toContain("create_update_id IS NULL");
    expect(call[1]).toEqual(["send-uid-1", "create-uid-1"]);
  });
});

describe("AttributionStore.getPendingCreate", () => {
  it("returns only pending create rows with attempts < max", async () => {
    const exec = makeExecSeq(
      [
        { update_id: "send-1", create_update_id: "create-1" },
        { update_id: "send-2", create_update_id: "create-2" },
      ]
    );
    const store = createPostgresAttributionStore(exec);
    const rows = await store.getPendingCreate(50, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ updateId: "send-1", createUpdateId: "create-1" });
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("create_status='pending'");
    expect(call[0]).toContain("create_fetch_attempts < $2");
    expect(call[0]).toContain("create_update_id IS NOT NULL");
  });
});

describe("AttributionStore.incrementCreateFetchAttempts", () => {
  it("increments attempts and flips to failed at max", async () => {
    const exec: PgExecutor = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };
    const store = createPostgresAttributionStore(exec);
    await store.incrementCreateFetchAttempts("send-uid-1", 10);
    const call = (exec.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(call[0]).toContain("create_fetch_attempts = create_fetch_attempts + 1");
    expect(call[0]).toContain("create_status = CASE");
    expect(call[0]).toContain("'failed'");
  });
});

describe("createAttributionStore factory", () => {
  it("uses an injected shared executor (no private pool) when provided", async () => {
    // WS2: the composition root passes the shared facilitator pool's executor
    // so attribution + consumed share one hardened pool. With a mock executor
    // no real DB connection is attempted even though a dbUrl is given.
    const exec: PgExecutor = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    const store = createAttributionStore("postgres://ignored", { executor: exec });
    await store.record({
      updateId: "u1",
      payerParty: "p",
      merchantParty: "m",
      amountAtomic: "1",
      network: "canton:devnet",
    });
    const calls = (exec.query as ReturnType<typeof vi.fn>).mock.calls;
    // DDL init + the INSERT both went through the injected executor.
    expect(calls.some((c) => String(c[0]).startsWith("CREATE TABLE"))).toBe(true);
    expect(calls.some((c) => String(c[0]).startsWith("INSERT"))).toBe(true);
  });
});
