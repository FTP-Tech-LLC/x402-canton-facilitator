import type { TrafficSummaryResult } from "@ftptech/x402-canton-ledger";
import {
  createFacilitatorPool,
  poolExecutor,
  type PgExecutor,
} from "./pool.js";

export interface AttributionStore {
  record(entry: {
    updateId: string;
    payerParty: string;
    merchantParty: string;
    amountAtomic: string;
    network: string;
  }): Promise<void>;

  markServed(updateId: string): Promise<void>;

  getAttempted(limit: number): Promise<Array<{ updateId: string }>>;

  updateTrafficSummary(
    updateId: string,
    result: TrafficSummaryResult
  ): Promise<void>;

  incrementFetchAttempts(updateId: string, maxAttempts: number): Promise<void>;

  getPending(
    limit: number,
    maxAttempts: number
  ): Promise<Array<{ updateId: string }>>;

  /** Record the createUpdateId when it arrives in /settle (v1 relay path). */
  setCreateUpdateId(sendUpdateId: string, createUpdateId: string): Promise<void>;

  /** Update create traffic after Scan fetch. */
  updateCreateTrafficSummary(
    sendUpdateId: string,
    result: TrafficSummaryResult
  ): Promise<void>;

  incrementCreateFetchAttempts(
    sendUpdateId: string,
    maxAttempts: number
  ): Promise<void>;

  /** Rows with create_status='pending' and create_fetch_attempts < maxAttempts. */
  getPendingCreate(
    limit: number,
    maxAttempts: number
  ): Promise<Array<{ updateId: string; createUpdateId: string }>>;

  getTotals(opts: {
    excludedParticipants: string[];
    excludedParties: string[];
  }): Promise<{
    totalPayments: number;
    confirmedBytes: bigint;
    eligibleBytes: bigint;
    pendingCount: number;
    failedCount: number;
    rejectedCount: number;
    noSummaryCount: number;
    attemptedCount: number;
    createConfirmedBytes: bigint;
    createPendingCount: number;
    createFailedCount: number;
  }>;
}

/** Re-exported from the shared pool module so both stores agree on one type
 *  (kept as a named export for backward-compatible imports). */
export type { PgExecutor };

const VERDICT_ACCEPTED = "VERDICT_RESULT_ACCEPTED";

const DDL =
  "CREATE TABLE IF NOT EXISTS payment_burns (" +
  "  update_id                  text PRIMARY KEY," +
  "  settled_at                 timestamptz NOT NULL DEFAULT now()," +
  "  payer_party                text NOT NULL," +
  "  merchant_party             text NOT NULL," +
  "  amount_atomic              text NOT NULL," +
  "  network                    text NOT NULL," +
  "  settle_status              text NOT NULL DEFAULT 'attempted'," +
  "  status                     text NOT NULL DEFAULT 'pending'," +
  "  submitting_participant_uid text," +
  "  submitting_parties         jsonb NOT NULL DEFAULT '[]'," +
  "  record_time                timestamptz," +
  "  verdict_result             text," +
  "  traffic_bytes              bigint," +
  "  traffic_fetched_at         timestamptz," +
  "  fetch_attempts             integer NOT NULL DEFAULT 0" +
  ")";

// Idempotent migration for create-tracking columns (v1 relay path).
const DDL_CREATE_COLS =
  "ALTER TABLE payment_burns ADD COLUMN IF NOT EXISTS create_update_id      text;" +
  "ALTER TABLE payment_burns ADD COLUMN IF NOT EXISTS create_traffic_bytes  bigint;" +
  "ALTER TABLE payment_burns ADD COLUMN IF NOT EXISTS create_status         text;" +
  "ALTER TABLE payment_burns ADD COLUMN IF NOT EXISTS create_fetch_attempts integer NOT NULL DEFAULT 0";

export function createPostgresAttributionStore(
  executor: PgExecutor,
  opts: { onError?: (op: string, err: unknown) => void } = {}
): AttributionStore {
  const onWarn = opts.onError ?? ((op, err) =>
    console.warn(`[attribution-store] ${op}:`, err instanceof Error ? err.message : String(err))
  );
  let ready: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (!ready) {
      ready = executor.query(DDL)
        .then(() => executor.query(DDL_CREATE_COLS))
        .then(() => undefined);
      ready.catch(() => { ready = null; });
    }
    return ready;
  };

  return {
    async record(entry) {
      await init();
      await executor.query(
        "INSERT INTO payment_burns" +
          "(update_id, payer_party, merchant_party, amount_atomic, network)" +
          " VALUES ($1,$2,$3,$4,$5) ON CONFLICT (update_id) DO NOTHING",
        [entry.updateId, entry.payerParty, entry.merchantParty, entry.amountAtomic, entry.network]
      );
    },

    async markServed(updateId) {
      await init();
      await executor.query(
        "UPDATE payment_burns SET settle_status='served'" +
          " WHERE update_id=$1 AND settle_status='attempted'",
        [updateId]
      );
    },

    async getAttempted(limit) {
      await init();
      const r = await executor.query(
        "SELECT update_id FROM payment_burns" +
          " WHERE settle_status='attempted' ORDER BY settled_at ASC LIMIT $1",
        [limit]
      );
      return (r.rows as Array<{ update_id: string }>).map((row) => ({ updateId: row.update_id }));
    },

    async updateTrafficSummary(updateId, result) {
      await init();

      if (result.updateId !== updateId) {
        onWarn("updateId_mismatch", { stored: updateId, received: result.updateId });
        await executor.query(
          "UPDATE payment_burns SET status='failed' WHERE update_id=$1 AND status='pending'",
          [updateId]
        );
        return;
      }

      const cost = result.totalTrafficCost;
      const accepted = result.verdictResult === VERDICT_ACCEPTED;

      if (!accepted) {
        await executor.query(
          "UPDATE payment_burns SET status='rejected'," +
            " verdict_result=$2, submitting_participant_uid=$3," +
            " submitting_parties=$4::jsonb, record_time=$5, traffic_fetched_at=now()" +
            " WHERE update_id=$1",
          [updateId, result.verdictResult, result.submittingParticipantUid, JSON.stringify(result.submittingParties), result.recordTime]
        );
        return;
      }

      if (cost === null) {
        await executor.query(
          "UPDATE payment_burns SET status='no_summary'," +
            " verdict_result=$2, submitting_participant_uid=$3," +
            " submitting_parties=$4::jsonb, record_time=$5, traffic_fetched_at=now()" +
            " WHERE update_id=$1",
          [updateId, result.verdictResult, result.submittingParticipantUid, JSON.stringify(result.submittingParties), result.recordTime]
        );
        return;
      }

      if (!Number.isSafeInteger(cost) || cost < 0) {
        onWarn("invalid_traffic_cost", { updateId, cost });
        await executor.query(
          "UPDATE payment_burns SET status='failed' WHERE update_id=$1 AND status='pending'",
          [updateId]
        );
        return;
      }

      await executor.query(
        "UPDATE payment_burns SET status='confirmed', traffic_bytes=$2," +
          " verdict_result=$3, submitting_participant_uid=$4," +
          " submitting_parties=$5::jsonb, record_time=$6, traffic_fetched_at=now()" +
          " WHERE update_id=$1",
        [updateId, cost, result.verdictResult, result.submittingParticipantUid, JSON.stringify(result.submittingParties), result.recordTime]
      );
    },

    async incrementFetchAttempts(updateId, maxAttempts) {
      await init();
      await executor.query(
        "UPDATE payment_burns" +
          " SET fetch_attempts = fetch_attempts + 1," +
          "     status = CASE WHEN fetch_attempts + 1 >= $2 THEN 'failed' ELSE status END" +
          " WHERE update_id=$1 AND status='pending'",
        [updateId, maxAttempts]
      );
    },

    async setCreateUpdateId(sendUpdateId, createUpdateId) {
      await init();
      await executor.query(
        "UPDATE payment_burns SET create_update_id=$2, create_status='pending'" +
          " WHERE update_id=$1 AND create_update_id IS NULL",
        [sendUpdateId, createUpdateId]
      );
    },

    async updateCreateTrafficSummary(sendUpdateId, result) {
      await init();

      // Guard: Scan echoes back the updateId it queried — if it doesn't match
      // the stored createUpdateId we asked about, something is misrouted.
      // Read create_update_id from the row to cross-check.
      const cidRow = await executor.query(
        "SELECT create_update_id FROM payment_burns WHERE update_id=$1",
        [sendUpdateId]
      );
      const storedCid = (cidRow.rows[0] as { create_update_id: string | null } | undefined)
        ?.create_update_id;
      if (storedCid && result.updateId !== storedCid) {
        onWarn("create_updateId_mismatch", { sendUpdateId, stored: storedCid, received: result.updateId });
        await executor.query(
          "UPDATE payment_burns SET create_status='failed' WHERE update_id=$1 AND create_status='pending'",
          [sendUpdateId]
        );
        return;
      }

      const cost = result.totalTrafficCost;
      const accepted = result.verdictResult === VERDICT_ACCEPTED;

      if (!accepted) {
        await executor.query(
          "UPDATE payment_burns SET create_status='rejected'" +
            " WHERE update_id=$1",
          [sendUpdateId]
        );
        return;
      }
      if (cost === null) {
        await executor.query(
          "UPDATE payment_burns SET create_status='no_summary'" +
            " WHERE update_id=$1",
          [sendUpdateId]
        );
        return;
      }
      if (!Number.isSafeInteger(cost) || cost < 0) {
        onWarn("invalid_create_traffic_cost", { sendUpdateId, cost });
        await executor.query(
          "UPDATE payment_burns SET create_status='failed'" +
            " WHERE update_id=$1 AND create_status='pending'",
          [sendUpdateId]
        );
        return;
      }
      await executor.query(
        "UPDATE payment_burns SET create_status='confirmed', create_traffic_bytes=$2" +
          " WHERE update_id=$1",
        [sendUpdateId, cost]
      );
    },

    async incrementCreateFetchAttempts(sendUpdateId, maxAttempts) {
      await init();
      await executor.query(
        "UPDATE payment_burns" +
          " SET create_fetch_attempts = create_fetch_attempts + 1," +
          "     create_status = CASE WHEN create_fetch_attempts + 1 >= $2 THEN 'failed' ELSE create_status END" +
          " WHERE update_id=$1 AND create_status='pending'",
        [sendUpdateId, maxAttempts]
      );
    },

    async getPendingCreate(limit, maxAttempts) {
      await init();
      const r = await executor.query(
        "SELECT update_id, create_update_id FROM payment_burns" +
          " WHERE create_status='pending' AND create_fetch_attempts < $2" +
          " AND create_update_id IS NOT NULL" +
          " ORDER BY settled_at ASC LIMIT $1",
        [limit, maxAttempts]
      );
      return (r.rows as Array<{ update_id: string; create_update_id: string }>).map(
        (row) => ({ updateId: row.update_id, createUpdateId: row.create_update_id })
      );
    },

    async getPending(limit, maxAttempts) {
      await init();
      const r = await executor.query(
        "SELECT update_id FROM payment_burns" +
          " WHERE settle_status='served' AND status='pending' AND fetch_attempts < $2" +
          " ORDER BY settled_at ASC LIMIT $1",
        [limit, maxAttempts]
      );
      return (r.rows as Array<{ update_id: string }>).map((row) => ({ updateId: row.update_id }));
    },

    async getTotals({ excludedParticipants, excludedParties }) {
      await init();

      const countRow = await executor.query(
        "SELECT COUNT(*) AS total FROM payment_burns WHERE settle_status='served'"
      );
      const totalPayments = Number((countRow.rows[0] as { total: string }).total);

      const confirmedRow = await executor.query(
        "SELECT COALESCE(SUM(traffic_bytes), 0) AS bytes FROM payment_burns" +
          " WHERE status='confirmed' AND settle_status='served'"
      );
      const confirmedBytes = BigInt((confirmedRow.rows[0] as { bytes: string }).bytes);

      const eligibleRow = await executor.query(
        "SELECT COALESCE(SUM(traffic_bytes + COALESCE(create_traffic_bytes, 0)), 0) AS bytes FROM payment_burns" +
          " WHERE status='confirmed' AND settle_status='served'" +
          " AND submitting_participant_uid IS NOT NULL" +
          " AND (cardinality($1::text[]) = 0 OR submitting_participant_uid != ALL($1::text[]))" +
          " AND (cardinality($2::text[]) = 0 OR NOT EXISTS (" +
          "   SELECT 1 FROM jsonb_array_elements_text(submitting_parties) p WHERE p = ANY($2::text[])" +
          " ))",
        [excludedParticipants, excludedParties]
      );
      const eligibleBytes = BigInt((eligibleRow.rows[0] as { bytes: string }).bytes);

      const statsRow = await executor.query(
        "SELECT" +
          " COUNT(*) FILTER (WHERE status='pending'    AND settle_status='served') AS pending_count," +
          " COUNT(*) FILTER (WHERE status='failed'     AND settle_status='served') AS failed_count," +
          " COUNT(*) FILTER (WHERE status='rejected'   AND settle_status='served') AS rejected_count," +
          " COUNT(*) FILTER (WHERE status='no_summary' AND settle_status='served') AS no_summary_count," +
          " COUNT(*) FILTER (WHERE settle_status='attempted') AS attempted_count," +
          " COUNT(*) FILTER (WHERE create_status='pending' AND settle_status='served') AS create_pending_count," +
          " COUNT(*) FILTER (WHERE create_status='failed'  AND settle_status='served') AS create_failed_count" +
          " FROM payment_burns"
      );
      const s = statsRow.rows[0] as {
        pending_count: string; failed_count: string;
        rejected_count: string; no_summary_count: string; attempted_count: string;
        create_pending_count: string; create_failed_count: string;
      };

      const createConfirmedRow = await executor.query(
        "SELECT COALESCE(SUM(create_traffic_bytes), 0) AS bytes FROM payment_burns" +
          " WHERE create_status='confirmed' AND settle_status='served'"
      );
      const createConfirmedBytes = BigInt(
        (createConfirmedRow.rows[0] as { bytes: string }).bytes
      );

      return {
        totalPayments,
        confirmedBytes,
        eligibleBytes,
        pendingCount: Number(s.pending_count),
        failedCount: Number(s.failed_count),
        rejectedCount: Number(s.rejected_count),
        noSummaryCount: Number(s.no_summary_count),
        attemptedCount: Number(s.attempted_count),
        createConfirmedBytes,
        createPendingCount: Number(s.create_pending_count),
        createFailedCount: Number(s.create_failed_count),
      };
    },
  };
}

/**
 * Factory: a durable Postgres attribution store.
 *
 * Pass `opts.executor` (the shared facilitator pool's executor) to share ONE
 * hardened pool with the consumed store — the prod path. When omitted, a
 * private hardened pool is built from `dbUrl` (timeouts + bounded `max`)
 * instead of the old defaults-only `new Pool`.
 */
export function createAttributionStore(
  dbUrl: string,
  opts: {
    onError?: (op: string, err: unknown) => void;
    executor?: PgExecutor | undefined;
  } = {}
): AttributionStore {
  const executor = opts.executor ?? poolExecutor(createFacilitatorPool(dbUrl));
  const storeOpts = opts.onError ? { onError: opts.onError } : {};
  return createPostgresAttributionStore(executor, storeOpts);
}
