/**
 * Single-use payment store — replay protection for settled CIP-56 payments
 * (audit M2; the gap confirmed live on DevNet 2026-06-02: a settled
 * `updateId` re-verified as valid).
 *
 * A completed `TransferFactory_Transfer` is a *historical* Scan record that
 * can be re-read indefinitely. Unlike the v1 `TransferCommand` path — where
 * native on-ledger contract archival makes a second `Send` fail with
 * `CONTRACT_NOT_FOUND` — the CIP-56 completed path has no on-ledger
 * single-use guard, so without a consumed-set the same `updateId` could be
 * re-presented to `/settle` (or `/verify`) to unlock a resource again. This
 * store records each settled payment id so it settles exactly once.
 *
 * Two backends behind one async interface:
 *   - in-memory (default): correct for a single facilitator instance, NOT
 *     durable across restarts, FIFO-bounded. Used in tests and when no
 *     `DATABASE_URL` is configured.
 *   - Postgres (when `DATABASE_URL` is set): durable across restarts; the
 *     `ops/devnet/docker-compose.yml` already provisions the DB.
 */
import {
  createFacilitatorPool,
  poolExecutor,
  type PgExecutor,
} from "./pool.js";

export interface ConsumedPaymentStore {
  /** True iff `key` was already recorded as settled. Non-consuming. */
  has(key: string): Promise<boolean>;
  /**
   * Atomically record `key` as settled. Returns `true` if it was newly
   * recorded, `false` if it was already present (i.e. a replay attempt).
   */
  markSettled(key: string): Promise<boolean>;
}

export interface InMemoryConsumedStoreOptions {
  /**
   * Maximum entries retained before FIFO eviction (bounds memory). Evicted
   * (very old) keys are no longer replay-protected; set high enough that
   * eviction only ever touches payments far older than any live resource
   * price window. Default 1,000,000.
   */
  maxSize?: number | undefined;
}

/**
 * In-memory single-instance store. Correct for one facilitator process;
 * NOT durable across restarts. A `Set` preserves insertion order, giving
 * cheap FIFO eviction.
 */
export function createInMemoryConsumedStore(
  opts: InMemoryConsumedStoreOptions = {}
): ConsumedPaymentStore {
  const maxSize = opts.maxSize ?? 1_000_000;
  const seen = new Set<string>();
  return {
    async has(key: string): Promise<boolean> {
      return seen.has(key);
    },
    async markSettled(key: string): Promise<boolean> {
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > maxSize) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
  };
}

/**
 * Minimal SQL executor surface (a `pg.Pool` satisfies it). Injectable so the
 * Postgres store's logic is unit-testable without a live database. Re-exported
 * from the shared pool module so consumed-store and attribution-store agree on
 * one type. (Kept as a named export here for backward compatibility with
 * existing imports.)
 */
export type { PgExecutor };

const CONSUMED_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS consumed_payments " +
  "(key text PRIMARY KEY, settled_at timestamptz NOT NULL DEFAULT now())";

/**
 * Durable Postgres-backed store. Survives restarts (closes the in-memory
 * restart window). Lazily creates its table on first use.
 *
 * Fail-open on DB errors: a transient database problem must not break money
 * finalization (`/settle`) or validation (`/verify`). On error we log and
 * treat the key as not-yet-seen / newly-settled. Replay protection is thus
 * best-effort during a DB outage — an acceptable trade vs. wedging settles.
 */
export function createPostgresConsumedStore(
  executor: PgExecutor,
  opts: { onError?: (op: string, err: unknown) => void } = {}
): ConsumedPaymentStore {
  const onError =
    opts.onError ??
    ((op, err) =>
      console.warn(
        `[consumed-store] postgres ${op} failed (fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`
      ));
  let ready: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (!ready) {
      ready = executor.query(CONSUMED_TABLE_DDL).then(() => undefined);
      ready.catch(() => {
        ready = null; // allow re-init on a later call
      });
    }
    return ready;
  };
  return {
    async has(key: string): Promise<boolean> {
      try {
        await init();
        const r = await executor.query(
          "SELECT 1 FROM consumed_payments WHERE key = $1",
          [key]
        );
        return (r.rowCount ?? r.rows.length) > 0;
      } catch (err) {
        onError("has", err);
        return false;
      }
    },
    async markSettled(key: string): Promise<boolean> {
      try {
        await init();
        const r = await executor.query(
          "INSERT INTO consumed_payments(key) VALUES ($1) ON CONFLICT (key) DO NOTHING",
          [key]
        );
        // rowCount === 1 → newly inserted; 0 → already present (replay).
        return (r.rowCount ?? 0) > 0;
      } catch (err) {
        onError("markSettled", err);
        return true;
      }
    },
  };
}

/**
 * Factory: durable Postgres store when a backing store is available, else
 * in-memory. Kept synchronous (a `pg.Pool` connects lazily) so the service
 * composition root stays synchronous.
 *
 * Backing-store resolution (first match wins):
 *   1. `executor` — a shared `PgExecutor` (the composition root passes ONE
 *      hardened pool shared with the attribution store; preferred in prod).
 *   2. `dbUrl` — builds a private hardened pool (timeouts + bounded `max`) for
 *      this store. Used when only this store needs Postgres.
 *   3. neither → in-memory (tests / no DATABASE_URL).
 */
export function createConsumedStore(opts: {
  dbUrl?: string | undefined;
  maxSize?: number | undefined;
  /** Shared executor (e.g. from a single facilitator-wide pool). Takes
   *  precedence over `dbUrl` so both stores can share one pool. */
  executor?: PgExecutor | undefined;
}): ConsumedPaymentStore {
  if (opts.executor) {
    return createPostgresConsumedStore(opts.executor);
  }
  if (!opts.dbUrl) {
    return createInMemoryConsumedStore({ maxSize: opts.maxSize });
  }
  // No shared pool provided — build a private hardened one (still far better
  // than the old defaults-only `new Pool`).
  const pool = createFacilitatorPool(opts.dbUrl);
  return createPostgresConsumedStore(poolExecutor(pool));
}
