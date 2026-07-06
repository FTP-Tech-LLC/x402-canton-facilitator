/**
 * Faucet-claim store — durable per-party-once guard + rolling payout budget for
 * the agent CC faucet. The faucet gives away REAL Canton Coin, so unlike the
 * replay-protection consumed-store (which fails OPEN to never wedge a settle),
 * this store fails CLOSED: on a DB error every method throws and the route turns
 * that into a 503, so a database outage DENIES faucet claims rather than risking
 * a double payout. The faucet is a nicety (agents fall back to manual funding),
 * so denying under failure is the right trade for real money.
 *
 * Flow is RESERVE-then-pay (race-safe single-use): the route `tryClaim`s the
 * party BEFORE the on-ledger transfer, `markPaid`s the updateId after, and
 * `release`s the reservation if the transfer throws (so a failed payout can be
 * retried). `tryClaim` is a SINGLE atomic operation that, in one statement (PG)
 * or one no-await-gap check (in-memory), refuses if (a) the party already
 * claimed, OR (b) the daily-window payout sum + this amount would exceed the
 * daily budget, OR (c) the all-time payout total + this amount would exceed the
 * lifetime cap — and otherwise inserts the reservation. Folding the budget read
 * and the reservation insert into ONE atomic step closes the
 * check-then-act race two separate awaits left open: concurrent fresh-party
 * claims can no longer each pass a stale budget read and collectively overshoot
 * the ceiling. The reservation counts toward both sums, so an in-flight claim
 * already commits against the ceilings.
 *
 * (`tryReserve` + `sumSince` remain for non-atomic callers/tests, but the money
 * route uses `tryClaim`.)
 *
 * Two backends behind one async interface (mirrors consumed-store):
 *   - in-memory (default / no DATABASE_URL): single-instance, not durable.
 *   - Postgres (DATABASE_URL set): durable across restarts.
 */
import {
  createFacilitatorPool,
  poolExecutor,
  type PgExecutor,
} from "./pool.js";

/**
 * Why a `tryClaim` refused (or "ok" when it reserved). The route maps each
 * reason to the right status: `already_claimed` → 429, `daily_budget` /
 * `lifetime_cap` → 503. A bare boolean would collapse a per-party-once 429 into
 * a budget 503 (or vice-versa); the caller needs the distinction.
 */
export type FaucetClaimReason =
  | "ok"
  | "already_claimed"
  | "daily_budget"
  | "lifetime_cap";

export interface FaucetClaimStore {
  /** True iff `party` already has a reservation/claim. Non-consuming. */
  hasClaimed(party: string): Promise<boolean>;
  /**
   * ATOMIC one-shot claim guard (the money path). In a SINGLE statement (PG) or
   * one synchronous no-await-gap check (in-memory), refuse if (a) `party`
   * already claimed, OR (b) the daily-window payout sum + `amountCc` would
   * exceed `dailyBudgetCc`, OR (c) the all-time payout total + `amountCc` would
   * exceed `lifetimeCapCc` — otherwise INSERT the reservation. Returns the
   * reason (`"ok"` when reserved). Replaces the old separate `sumSince` +
   * `tryReserve`, whose two awaits left a check-then-act race open. FAILS CLOSED:
   * on a DB error it rethrows so the route 503s (never an unguarded payout).
   *
   * `lifetimeCapCc` of `"0"` (or any non-positive) DISABLES the lifetime cap.
   * The daily window is `(nowMs - windowMs, nowMs]`.
   */
  tryClaim(e: {
    party: string;
    ip: string;
    amountCc: string;
    nowMs: number;
    windowMs: number;
    dailyBudgetCc: string;
    lifetimeCapCc: string;
  }): Promise<FaucetClaimReason>;
  /**
   * Atomically reserve a one-time claim for `party`. Returns `true` if newly
   * reserved (the caller may proceed to transfer), `false` if the party already
   * claimed (or a concurrent request won the race). NOTE: unlike `tryClaim` this
   * does NOT enforce the budget/cap; the money route uses `tryClaim`. Retained
   * for non-atomic callers/tests.
   */
  tryReserve(e: {
    party: string;
    ip: string;
    amountCc: string;
    nowMs: number;
  }): Promise<boolean>;
  /** Record the on-ledger updateId after a successful transfer (best-effort). */
  markPaid(e: { party: string; updateId: string }): Promise<void>;
  /** Undo a reservation when the transfer failed, so the party can retry. */
  release(party: string): Promise<void>;
  /** Sum (CC) of reserved/paid payouts with claimed_at strictly after `sinceMs`
   *  (epoch ms) — the rolling-window budget input. */
  sumSince(sinceMs: number): Promise<number>;
}

export type { PgExecutor };

/**
 * In-memory single-instance store. Correct for one facilitator process; NOT
 * durable across restarts (a restart re-opens every party AND resets the
 * lifetime total). Acceptable only for dev / tests / no-DATABASE_URL — config.ts
 * HARD-FAILS startup if the money faucet is enabled without a database, so this
 * backend never serves a production faucet. The per-IP cap + daily budget still
 * bound a single process's spend.
 */
export function createInMemoryFaucetStore(): FaucetClaimStore {
  const claims = new Map<
    string,
    { ip: string; amountCc: string; updateId?: string; at: number }
  >();
  return {
    async hasClaimed(party) {
      return claims.has(party);
    },
    async tryClaim({
      party,
      ip,
      amountCc,
      nowMs,
      windowMs,
      dailyBudgetCc,
      lifetimeCapCc,
    }) {
      // SINGLE synchronous check-then-insert: there is NO await between the
      // guards and the Map.set, so two concurrent claims cannot both observe a
      // stale sum and both insert (Node runs this body to completion atomically).
      // Mirrors the PG WHERE-guarded INSERT exactly.
      if (claims.has(party)) return "already_claimed";
      const amt = Number(amountCc);
      const sinceMs = nowMs - windowMs;
      let daily = 0;
      let lifetime = 0;
      for (const c of claims.values()) {
        const a = Number(c.amountCc);
        lifetime += a;
        if (c.at > sinceMs) daily += a;
      }
      if (daily + amt > Number(dailyBudgetCc)) return "daily_budget";
      const cap = Number(lifetimeCapCc);
      if (cap > 0 && lifetime + amt > cap) return "lifetime_cap";
      claims.set(party, { ip, amountCc, at: nowMs });
      return "ok";
    },
    async tryReserve({ party, ip, amountCc, nowMs }) {
      if (claims.has(party)) return false;
      claims.set(party, { ip, amountCc, at: nowMs });
      return true;
    },
    async markPaid({ party, updateId }) {
      const c = claims.get(party);
      if (c) c.updateId = updateId;
    },
    async release(party) {
      claims.delete(party);
    },
    async sumSince(sinceMs) {
      let sum = 0;
      for (const c of claims.values()) {
        if (c.at > sinceMs) sum += Number(c.amountCc);
      }
      return sum;
    },
  };
}

const FAUCET_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS faucet_claims (" +
  "party text PRIMARY KEY, ip text NOT NULL, amount_cc text NOT NULL, " +
  "update_id text, claimed_at timestamptz NOT NULL DEFAULT now())";
const FAUCET_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS faucet_claims_claimed_at ON faucet_claims (claimed_at)";

/**
 * Durable Postgres-backed store. FAIL-CLOSED: every method rethrows on a DB
 * error so the route denies (503) rather than risking a double payout. Lazily
 * creates its table + index on first use.
 */
export function createPostgresFaucetStore(
  executor: PgExecutor
): FaucetClaimStore {
  let ready: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (!ready) {
      ready = executor
        .query(FAUCET_TABLE_DDL)
        .then(() => executor.query(FAUCET_INDEX_DDL))
        .then(() => undefined);
      ready.catch(() => {
        ready = null; // allow re-init on a later call
      });
    }
    return ready;
  };
  return {
    async hasClaimed(party) {
      await init();
      const r = await executor.query(
        "SELECT 1 FROM faucet_claims WHERE party = $1",
        [party]
      );
      return (r.rowCount ?? r.rows.length) > 0;
    },
    async tryClaim({
      party,
      ip,
      amountCc,
      nowMs,
      windowMs,
      dailyBudgetCc,
      lifetimeCapCc,
    }) {
      await init();
      const sinceMs = nowMs - windowMs;
      // ONE statement decides AND records the spend: the row is inserted only if
      // the party is new AND the daily-window sum + amount fits the budget AND
      // (cap disabled OR the all-time total + amount fits the cap). Because the
      // budget/cap sub-SELECTs and the INSERT are a single command, two
      // concurrent claims cannot both read a stale sum and both insert — the
      // second sees the first's committed row. rowCount=1 → reserved; 0 → some
      // guard failed (classified below for the right status code).
      const ins = await executor.query(
        "INSERT INTO faucet_claims(party, ip, amount_cc, claimed_at) " +
          "SELECT $1, $2, $3::text, to_timestamp($4 / 1000.0) " +
          "WHERE NOT EXISTS (SELECT 1 FROM faucet_claims WHERE party = $1) " +
          "AND ((SELECT COALESCE(SUM(amount_cc::numeric), 0) FROM faucet_claims " +
          "WHERE claimed_at > to_timestamp($5 / 1000.0)) + $3::numeric) <= $6::numeric " +
          "AND ($7::numeric <= 0 OR " +
          "((SELECT COALESCE(SUM(amount_cc::numeric), 0) FROM faucet_claims) " +
          "+ $3::numeric) <= $7::numeric)",
        [party, ip, amountCc, nowMs, sinceMs, dailyBudgetCc, lifetimeCapCc]
      );
      if ((ins.rowCount ?? 0) > 0) return "ok";
      // Refused — classify WHY in one read so the route can pick 429 vs 503.
      // (This read is only on the no-spend path; the INSERT above already
      // atomically prevented any payout.)
      const cls = await executor.query(
        "SELECT EXISTS(SELECT 1 FROM faucet_claims WHERE party = $1) AS claimed, " +
          "COALESCE((SELECT SUM(amount_cc::numeric) FROM faucet_claims " +
          "WHERE claimed_at > to_timestamp($2 / 1000.0)), 0)::float8 AS daily_sum, " +
          "COALESCE((SELECT SUM(amount_cc::numeric) FROM faucet_claims), 0)::float8 " +
          "AS lifetime_sum",
        [party, sinceMs]
      );
      const row = cls.rows[0] as
        | { claimed?: boolean; daily_sum?: number | string; lifetime_sum?: number | string }
        | undefined;
      const amt = Number(amountCc);
      if (row?.claimed) return "already_claimed";
      if (Number(row?.daily_sum ?? 0) + amt > Number(dailyBudgetCc)) {
        return "daily_budget";
      }
      const cap = Number(lifetimeCapCc);
      if (cap > 0 && Number(row?.lifetime_sum ?? 0) + amt > cap) {
        return "lifetime_cap";
      }
      // Ambiguous refusal (a concurrent claim changed state between the INSERT
      // and this read). Fail CLOSED with a transient 503-class reason — better
      // to over-refuse one claim than risk a double payout.
      return "daily_budget";
    },
    async tryReserve({ party, ip, amountCc, nowMs }) {
      await init();
      const r = await executor.query(
        "INSERT INTO faucet_claims(party, ip, amount_cc, claimed_at) " +
          "VALUES ($1, $2, $3, to_timestamp($4 / 1000.0)) " +
          "ON CONFLICT (party) DO NOTHING",
        [party, ip, amountCc, nowMs]
      );
      return (r.rowCount ?? 0) > 0;
    },
    async markPaid({ party, updateId }) {
      await init();
      await executor.query(
        "UPDATE faucet_claims SET update_id = $2 WHERE party = $1",
        [party, updateId]
      );
    },
    async release(party) {
      await init();
      await executor.query("DELETE FROM faucet_claims WHERE party = $1", [
        party,
      ]);
    },
    async sumSince(sinceMs) {
      await init();
      const r = await executor.query(
        "SELECT COALESCE(SUM(amount_cc::numeric), 0)::float8 AS s " +
          "FROM faucet_claims WHERE claimed_at > to_timestamp($1 / 1000.0)",
        [sinceMs]
      );
      const row = r.rows[0] as { s?: number | string } | undefined;
      return Number(row?.s ?? 0);
    },
  };
}

/**
 * Factory: durable Postgres store when a backing store is available, else
 * in-memory. Mirrors `createConsumedStore`.
 */
export function createFaucetStore(opts: {
  dbUrl?: string | undefined;
  executor?: PgExecutor | undefined;
}): FaucetClaimStore {
  if (opts.executor) return createPostgresFaucetStore(opts.executor);
  if (!opts.dbUrl) return createInMemoryFaucetStore();
  const pool = createFacilitatorPool(opts.dbUrl);
  return createPostgresFaucetStore(poolExecutor(pool));
}
