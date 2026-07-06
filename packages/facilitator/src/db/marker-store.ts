import {
  createFacilitatorPool,
  poolExecutor,
  type PgExecutor,
} from "./pool.js";

export type { PgExecutor };

export interface MarkerRoundRow {
  round_number: number;
  status: string;
  traffic_bytes: bigint | null;
  traffic_usd: string | null;
  weight: string | null;
  update_id: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MarkerStore {
  /** Idempotent table creation. Called lazily before first use. */
  init(): Promise<void>;

  /** True when the marker_rounds table contains zero rows. Used for first-run detection. */
  isEmpty(): Promise<boolean>;

  getRow(roundNumber: number): Promise<MarkerRoundRow | undefined>;

  /** INSERT … ON CONFLICT DO NOTHING — idempotent; locks in created_at as upperBound. */
  insertPending(roundNumber: number): Promise<void>;

  updateStatus(
    roundNumber: number,
    status: string,
    fields?: {
      traffic_bytes?: bigint;
      traffic_usd?: string;
      weight?: string;
      update_id?: string;
      error_message?: string;
    }
  ): Promise<void>;

  /** Highest round_number strictly below belowRound. */
  getPrevRound(belowRound: number): Promise<MarkerRoundRow | undefined>;

  /** pending/failed rows with round_number in [minRound, maxRound). */
  getPendingRetry(
    minRound: number,
    maxRound: number
  ): Promise<MarkerRoundRow[]>;

  /** Mark pending/failed rows with round_number < belowRound as expired. */
  expireRows(belowRound: number): Promise<void>;

  /**
   * Sum payment traffic bytes settled within a time window.
   * Reads payment_burns (same DB). Used to compute the round's USD weight.
   * Confirmed legs count real Scan bytes; legs still byte-less at round
   * close (pending/failed/no_summary) count at a live 24h average so the
   * round never under-emits for rows in flight — nothing is persisted.
   */
  getTrafficBytesInWindow(
    lowerBound: Date,
    upperBound: Date
  ): Promise<bigint>;
}

const DDL =
  "CREATE TABLE IF NOT EXISTS marker_rounds (" +
  "  round_number   bigint PRIMARY KEY," +
  "  status         text NOT NULL DEFAULT 'pending'," +
  "  traffic_bytes  bigint," +
  "  traffic_usd    text," +
  "  weight         text," +
  "  update_id      text," +
  "  error_message  text," +
  "  created_at     timestamptz NOT NULL DEFAULT now()," +
  "  updated_at     timestamptz NOT NULL DEFAULT now()" +
  ")";

export function createPostgresMarkerStore(executor: PgExecutor): MarkerStore {
  let ready: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (!ready) {
      ready = executor.query(DDL).then(() => undefined);
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };

  return {
    init,

    async isEmpty() {
      await init();
      const r = await executor.query(
        "SELECT 1 FROM marker_rounds LIMIT 1"
      );
      return r.rowCount === 0;
    },

    async getRow(roundNumber) {
      await init();
      const r = await executor.query(
        "SELECT * FROM marker_rounds WHERE round_number=$1",
        [roundNumber]
      );
      const raw = r.rows[0] as (MarkerRoundRow & { round_number: string }) | undefined;
      return raw ? { ...raw, round_number: Number(raw.round_number) } : undefined;
    },

    async insertPending(roundNumber) {
      await init();
      await executor.query(
        "INSERT INTO marker_rounds (round_number, status)" +
          " VALUES ($1, 'pending') ON CONFLICT (round_number) DO NOTHING",
        [roundNumber]
      );
    },

    async updateStatus(roundNumber, status, fields = {}) {
      await init();
      const sets: string[] = ["status=$2", "updated_at=now()"];
      const params: unknown[] = [roundNumber, status];
      let i = 3;
      if (fields.traffic_bytes !== undefined) {
        sets.push(`traffic_bytes=$${i++}`);
        params.push(fields.traffic_bytes);
      }
      if (fields.traffic_usd !== undefined) {
        sets.push(`traffic_usd=$${i++}`);
        params.push(fields.traffic_usd);
      }
      if (fields.weight !== undefined) {
        sets.push(`weight=$${i++}`);
        params.push(fields.weight);
      }
      if (fields.update_id !== undefined) {
        sets.push(`update_id=$${i++}`);
        params.push(fields.update_id);
      }
      if (fields.error_message !== undefined) {
        sets.push(`error_message=$${i++}`);
        params.push(fields.error_message);
      }
      await executor.query(
        `UPDATE marker_rounds SET ${sets.join(", ")} WHERE round_number=$1`,
        params
      );
    },

    async getPrevRound(belowRound) {
      await init();
      const r = await executor.query(
        "SELECT * FROM marker_rounds WHERE round_number < $1" +
          " ORDER BY round_number DESC LIMIT 1",
        [belowRound]
      );
      const raw = r.rows[0] as (MarkerRoundRow & { round_number: string }) | undefined;
      return raw ? { ...raw, round_number: Number(raw.round_number) } : undefined;
    },

    async getPendingRetry(minRound, maxRound) {
      await init();
      const r = await executor.query(
        "SELECT * FROM marker_rounds" +
          " WHERE status IN ('pending','failed')" +
          " AND round_number >= $1 AND round_number < $2" +
          " ORDER BY round_number ASC",
        [minRound, maxRound]
      );
      return (r.rows as (MarkerRoundRow & { round_number: string })[]).map(
        (raw) => ({ ...raw, round_number: Number(raw.round_number) })
      );
    },

    async expireRows(belowRound) {
      await init();
      await executor.query(
        "UPDATE marker_rounds SET status='expired', updated_at=now()" +
          " WHERE status IN ('pending','failed') AND round_number < $1",
        [belowRound]
      );
    },

    async getTrafficBytesInWindow(lowerBound, upperBound) {
      await init();
      // Rows are anchored to their window by settled_at (set once at insert),
      // not record_time: a stable anchor puts every payment in exactly one
      // round, whereas record_time lands seconds later and can straddle a
      // round boundary — double-counting a row estimated in one window and
      // confirmed into the next.
      //
      // Confirmed legs count their real Scan bytes. Legs still byte-less at
      // round close (pending — Scan lag; failed — attempts exhausted;
      // no_summary — accepted verdict without a cost) settled successfully,
      // so their traffic WAS burned: they count at the live average of the
      // last 24h of confirmed legs, falling back to observed mainnet
      // baselines (8552 send / 6710 create) on a cold DB. Nothing synthetic
      // is persisted — payment_burns stays honest and the retry worker still
      // fills real bytes later; the estimate exists only in this window sum,
      // so a round never under-emits for rows in flight at close. Rejected
      // legs stay excluded.
      const r = await executor.query(
        "WITH avg_bytes AS (" +
          " SELECT" +
          "  GREATEST(COALESCE(AVG(traffic_bytes) FILTER (WHERE status='confirmed' AND traffic_bytes IS NOT NULL), 8552), 1) AS send_avg," +
          "  GREATEST(COALESCE(AVG(create_traffic_bytes) FILTER (WHERE create_status='confirmed' AND create_traffic_bytes IS NOT NULL), 6710), 1) AS create_avg" +
          " FROM payment_burns" +
          " WHERE settle_status='served' AND settled_at >= $1::timestamptz - interval '24 hours'" +
          ")" +
          " SELECT COALESCE(SUM(" +
          "  CASE" +
          "   WHEN status='confirmed' THEN traffic_bytes" +
          "   WHEN status IN ('pending','failed','no_summary') THEN (SELECT send_avg FROM avg_bytes)" +
          "   ELSE 0 END" +
          "  +" +
          "  CASE" +
          "   WHEN create_update_id IS NULL THEN 0" +
          "   WHEN create_status='confirmed' THEN COALESCE(create_traffic_bytes, 0)" +
          "   WHEN create_status IN ('pending','failed','no_summary') THEN (SELECT create_avg FROM avg_bytes)" +
          "   ELSE 0 END" +
          " ), 0)::bigint AS bytes" +
          " FROM payment_burns" +
          " WHERE settle_status='served'" +
          " AND settled_at >= $1 AND settled_at < $2",
        [lowerBound.toISOString(), upperBound.toISOString()]
      );
      return BigInt((r.rows[0] as { bytes: string }).bytes);
    },
  };
}

export function createMarkerStore(
  dbUrl: string,
  opts: { executor?: PgExecutor } = {}
): MarkerStore {
  const executor = opts.executor ?? poolExecutor(createFacilitatorPool(dbUrl));
  return createPostgresMarkerStore(executor);
}
