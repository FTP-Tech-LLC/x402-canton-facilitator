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
  /** Cumulative GS `total_consumed` snapshot at this round (total-traffic mode). */
  traffic_consumed: bigint | null;
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
      traffic_consumed?: bigint;
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
  ")" +
  // Additive migration for total-traffic mode: the per-round cumulative GS
  // `total_consumed` snapshot whose delta drives the weight. Run as a second
  // statement in the same param-less init query so init stays one round-trip.
  // Idempotent (ADD COLUMN IF NOT EXISTS), mirrors attribution-store.ts.
  "; ALTER TABLE marker_rounds ADD COLUMN IF NOT EXISTS traffic_consumed bigint";

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
      if (fields.traffic_consumed !== undefined) {
        sets.push(`traffic_consumed=$${i++}`);
        params.push(fields.traffic_consumed);
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
  };
}

export function createMarkerStore(
  dbUrl: string,
  opts: { executor?: PgExecutor } = {}
): MarkerStore {
  const executor = opts.executor ?? poolExecutor(createFacilitatorPool(dbUrl));
  return createPostgresMarkerStore(executor);
}
