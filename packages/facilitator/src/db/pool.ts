/**
 * Shared Postgres pool for the facilitator's two stores (consumed-payments
 * replay guard + traffic-burn attribution).
 *
 * Why this exists (audit HIGH): both stores previously did
 * `new Pool({ connectionString })` on pg defaults — no statement_timeout, no
 * connection-acquire timeout, and the default `max: 10`. Two such pools meant
 * up to 20 connections, and a single hung query would pin a connection
 * indefinitely; the /settle fail-open path only triggers AFTER a settle, never
 * on a query that simply never returns, and once all 10 connections are in
 * flight `pool.query` waits forever for one to free up. That turns a slow DB
 * into a wedged money path.
 *
 * This module builds ONE hardened pool shared by both stores:
 *   - `statement_timeout` (server-side): Postgres aborts a query that runs too
 *     long, so a stuck query surfaces as an error the fail-open handlers
 *     already catch — not an infinite await.
 *   - `query_timeout` (client-side): the pg client rejects if the server never
 *     answers (e.g. a dead TCP connection that never RSTs), covering the case
 *     `statement_timeout` cannot (no server to enforce it).
 *   - `connectionTimeoutMillis`: acquiring a connection (new TCP + auth, or
 *     waiting for a free pooled one) fails fast instead of hanging.
 *   - `max`: a deliberate cap. One shared pool replaces the previous two, so
 *     total connections are bounded by this single number.
 *
 * All timeouts are overridable; the defaults are tuned for the
 * low-write/low-read facilitator workload (small INSERT/SELECT by primary key).
 */
import { Pool, type PoolConfig } from "pg";

/** Minimal SQL executor surface a `pg.Pool` satisfies. The single canonical
 *  definition; the stores re-export this as their own `PgExecutor` alias. */
export interface PgExecutor {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  /**
   * Run several statements on ONE connection inside a transaction.
   *
   * Needed wherever a guard cannot be expressed as a single statement. Under
   * READ COMMITTED a statement's snapshot is fixed when the statement begins,
   * so a sub-SELECT inside an INSERT cannot see a sibling's uncommitted row —
   * which means "one big INSERT ... WHERE (SELECT SUM(...)) <= budget" reads a
   * stale total under concurrency and both claims can pass. Only a row lock, or
   * serialising the claimants, actually decides.
   *
   * OPTIONAL because the in-memory and test executors have no connection to
   * hold. Callers must say what they do without it rather than assume it.
   */
  transaction?<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>;
}

export interface FacilitatorPoolOptions {
  /** Server-side per-statement timeout (ms). `0`/false disables (NOT
   *  recommended). Default 5000. */
  statementTimeoutMs?: number;
  /** Client-side query timeout (ms): reject if the server never responds.
   *  Default 5000. */
  queryTimeoutMs?: number;
  /** Max time to wait to acquire a connection (ms). Default 2000. */
  connectionTimeoutMs?: number;
  /** Idle connection reaping (ms). Default 30000. */
  idleTimeoutMs?: number;
  /** Max pool size (total connections for BOTH stores, since the pool is
   *  shared). Default 10. */
  max?: number;
  /** `application_name` for easier DB-side attribution. Default
   *  "canton-x402-facilitator". */
  applicationName?: string;
}

export const DEFAULT_POOL_OPTIONS: Required<
  Omit<FacilitatorPoolOptions, "applicationName">
> & { applicationName: string } = {
  statementTimeoutMs: 5_000,
  queryTimeoutMs: 5_000,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 30_000,
  max: 10,
  applicationName: "canton-x402-facilitator",
};

/**
 * Build a single hardened `pg.Pool`. Lazily connects (pg connects on first
 * query), so this stays synchronous and the composition root remains
 * synchronous.
 */
export function createFacilitatorPool(
  dbUrl: string,
  opts: FacilitatorPoolOptions = {}
): Pool {
  const o = { ...DEFAULT_POOL_OPTIONS, ...opts };
  const config: PoolConfig = {
    connectionString: dbUrl,
    statement_timeout: o.statementTimeoutMs,
    query_timeout: o.queryTimeoutMs,
    connectionTimeoutMillis: o.connectionTimeoutMs,
    idleTimeoutMillis: o.idleTimeoutMs,
    max: o.max,
    application_name: o.applicationName,
  };
  const pool = new Pool(config);
  // A pool-level 'error' (an idle client dropped by the server) is emitted on
  // the Pool EventEmitter; without a listener Node treats it as an unhandled
  // 'error' and crashes the process. Swallow-and-log: the next query just
  // re-acquires a fresh connection.
  pool.on("error", (err) => {
    console.warn(
      `[db-pool] idle client error (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });
  return pool;
}

/** Adapt a `pg.Pool` to the {@link PgExecutor} surface the stores consume. */
export function poolExecutor(pool: Pool): PgExecutor {
  return {
    query: (sql, params) => pool.query(sql, params as unknown[] | undefined),
    async transaction<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Every statement inside gets its own snapshot taken when it starts, so
        // a statement issued AFTER a lock was acquired sees everything the
        // previous holder committed. That is the property the callers need.
        const tx: PgExecutor = {
          query: (sql, params) => client.query(sql, params as unknown[] | undefined),
        };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
