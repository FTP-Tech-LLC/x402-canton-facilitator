/**
 * Settle idempotency for the INLINE carriage.
 *
 * WHY A DEDICATED STORE. The inline carriage keeps no server-side row for a
 * payment — the whole point of carrying the transaction in the payload — so the
 * settle updateId needs a store of its own, keyed on the prepared-tx hash.
 *
 * WHY IT MATTERS EVEN THOUGH THE LEDGER ALREADY REFUSES A REPLAY. A replayed
 * inline settle names input holdings that are already archived, so the ledger
 * rejects it and no double-spend is possible. But we learn that by SUBMITTING,
 * and every submission burns Global-Synchronizer traffic, which is the scarce
 * resource this facilitator pays for. The ledger protects the merchant's money;
 * this store protects our traffic budget, and returns the caller the same
 * answer it got the first time instead of an error about archived contracts.
 *
 * WHAT IT IS KEYED ON. The RECOMPUTED transaction hash — the digest the
 * signature verifier derived from the bytes and matched — never the client's
 * claimed hash. The claim is deliberately accepted in two spellings (bare
 * digest and `1220`-prefixed), so a caller could re-spell it into a second
 * bucket and settle the same transaction twice. The recomputed value has one
 * spelling and is provably bound to the bytes we would relay.
 *
 * FAIL-OPEN, BOTH DIRECTIONS. A database outage must never block a settle: an
 * unavailable read reports "not seen" (we relay, which is correct but costs
 * traffic) and an unavailable write reports success (the funds already moved;
 * failing the response would be worse than losing the record). This store is a
 * cost guard, not a correctness guard, and it is written to degrade rather than
 * to refuse.
 */
import {
  createFacilitatorPool,
  poolExecutor,
  type PgExecutor,
} from "./pool.js";

/**
 * What this store knows about one transaction. THREE states, not two — the
 * middle one is the whole reason this file changed.
 *
 *   null          never seen. Relaying is correct.
 *   "dispatched"  we handed this submission to the participant and did NOT see
 *                 the outcome. It may be on the ledger. We do not know.
 *   "settled"     we saw the updateId. The money moved.
 *
 * The middle state used to be unrepresentable: rows were written only AFTER the
 * funds-moved gate, so a dispatch whose answer never arrived left nothing
 * behind. The retry then found "never seen", relayed again, hit the archived
 * inputs, and got that classified as `invalid_exact_canton_input_contention` —
 * which /settle reports as "nothing moved, retryable". The caller believes it
 * and pays AGAIN with a fresh transfer. The double payment does not come from
 * settling the same bytes twice (the ledger refuses that); it comes from us
 * stating, confidently, that nothing happened when we had no idea.
 */
export type InlineSettleRecord =
  | { state: "settled"; updateId: string }
  /** Carries what a later resolve needs to go and LOOK: which submission, and
   *  the ledger offset captured just before it was sent. Both may be absent on
   *  a row written by an older build — the caller then still refuses to relay,
   *  it just cannot resolve automatically. */
  | { state: "dispatched"; submissionId?: string; beginExclusive?: number };

export interface InlineSettleStore {
  /** What we know about this transaction, or null if we have never seen it. */
  getRecord(txHashHex: string): Promise<InlineSettleRecord | null>;
  /**
   * Write the INTENT to submit, BEFORE handing anything to the participant.
   * Returns false when a record already existed (a concurrent settle won the
   * race, or this is a retry) — the caller must then read it and act on what it
   * says rather than dispatching.
   */
  recordDispatched(
    txHashHex: string,
    meta?: { submissionId?: string; beginExclusive?: number }
  ): Promise<boolean>;
  /**
   * Record `updateId` against `txHashHex`, promoting a "dispatched" row to
   * "settled". Returns false only when a DIFFERENT updateId was already
   * recorded (a concurrent settle won), in which case the caller should prefer
   * the recorded value.
   */
  recordSettled(txHashHex: string, updateId: string): Promise<boolean>;
  /**
   * Drop a "dispatched" marker because the outcome turned out to be KNOWN and
   * negative — the execute committed and moved nothing, or the participant
   * refused it outright. Never touches a settled row.
   *
   * Without this the marker is too strong: a payment that provably failed would
   * be answered 503 forever and could never be retried. The marker must mean
   * "we cannot tell", not "we once tried".
   */
  clearDispatched(txHashHex: string): Promise<void>;
  /** Delete records older than `maxAgeMs`. Returns how many were removed. */
  sweep(maxAgeMs: number): Promise<number>;
}

export interface InMemoryInlineSettleStoreOptions {
  /** Entries retained before the oldest are dropped. Bounds memory on a deploy
   *  with no database; the ledger is still the correctness backstop. */
  maxSize?: number | undefined;
  /** Injectable clock so sweep behaviour is testable without waiting. */
  now?: (() => number) | undefined;
}

export function createInMemoryInlineSettleStore(
  opts: InMemoryInlineSettleStoreOptions = {}
): InlineSettleStore {
  const maxSize = opts.maxSize ?? 100_000;
  const now = opts.now ?? (() => Date.now());
  // Insertion-ordered, which gives FIFO eviction for free.
  const rows = new Map<
    string,
    { updateId: string | null; at: number; submissionId?: string; beginExclusive?: number }
  >();
  const evict = (): void => {
    while (rows.size > maxSize) {
      const oldest = rows.keys().next().value;
      if (oldest === undefined) break;
      rows.delete(oldest);
    }
  };
  return {
    async getRecord(txHashHex) {
      const r = rows.get(txHashHex);
      if (!r) return null;
      if (r.updateId !== null) return { state: "settled", updateId: r.updateId };
      return {
        state: "dispatched",
        ...(r.submissionId !== undefined ? { submissionId: r.submissionId } : {}),
        ...(r.beginExclusive !== undefined ? { beginExclusive: r.beginExclusive } : {}),
      };
    },
    async recordDispatched(txHashHex, meta) {
      if (rows.has(txHashHex)) return false;
      rows.set(txHashHex, {
        updateId: null,
        at: now(),
        ...(meta?.submissionId !== undefined ? { submissionId: meta.submissionId } : {}),
        ...(meta?.beginExclusive !== undefined ? { beginExclusive: meta.beginExclusive } : {}),
      });
      evict();
      return true;
    },
    async recordSettled(txHashHex, updateId) {
      const existing = rows.get(txHashHex);
      // Promote our own dispatch marker; refuse to overwrite someone else's
      // recorded updateId (that one is the answer the caller should get).
      if (existing && existing.updateId !== null) return false;
      rows.set(txHashHex, { updateId, at: existing?.at ?? now() });
      evict();
      return true;
    },
    async clearDispatched(txHashHex) {
      const r = rows.get(txHashHex);
      if (r && r.updateId === null) rows.delete(txHashHex);
    },
    async sweep(maxAgeMs) {
      const cutoff = now() - maxAgeMs;
      let removed = 0;
      for (const [k, v] of rows) {
        if (v.at < cutoff) {
          rows.delete(k);
          removed++;
        }
      }
      return removed;
    },
  };
}

export function createPostgresInlineSettleStore(
  exec: PgExecutor,
  onError: (op: string, err: unknown) => void = () => {}
): InlineSettleStore {
  let ready: Promise<void> | null = null;
  const ensure = async (): Promise<void> => {
    if (!ready) {
      ready = exec
        .query(
          `CREATE TABLE IF NOT EXISTS inline_settles (
           tx_hash text PRIMARY KEY,
           update_id text,
           submission_id text,
           begin_exclusive bigint,
           settled_at timestamptz NOT NULL DEFAULT now()
         )`,
          []
        )
        // The LIVE table was created with update_id NOT NULL, and CREATE TABLE
        // IF NOT EXISTS never alters an existing one. A dispatch marker has no
        // updateId yet, so the constraint has to come off or every pre-dispatch
        // write would fail and fail-open would quietly restore the old behaviour.
        // DROP NOT NULL is a no-op when it is already nullable, so this is safe
        // to run every boot.
        .then(() =>
          exec.query(
            `ALTER TABLE inline_settles ALTER COLUMN update_id DROP NOT NULL`,
            []
          )
        )
        // Idempotent, for the same reason: the live table predates both.
        .then(() =>
          exec.query(
            `ALTER TABLE inline_settles ADD COLUMN IF NOT EXISTS submission_id text`,
            []
          )
        )
        .then(() =>
          exec.query(
            `ALTER TABLE inline_settles ADD COLUMN IF NOT EXISTS begin_exclusive bigint`,
            []
          )
        )
        .then(() => undefined);
      // Clear the memo on failure so a LATER call retries the DDL. Without this
      // one transient error — a restart, a failover, a saturated pool — leaves a
      // permanently rejected promise cached, every subsequent read and write
      // awaits that same rejection, and the fail-open catches swallow it. The
      // store then reports "never seen" for the life of the process while
      // looking healthy: every retry re-relays and burns traffic, which is
      // exactly what this file exists to prevent. Each sibling store in this
      // directory does the same reset.
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };
  return {
    async getRecord(txHashHex) {
      try {
        await ensure();
        const r = await exec.query(
          `SELECT update_id, submission_id, begin_exclusive
             FROM inline_settles WHERE tx_hash = $1`,
          [txHashHex]
        );
        const rows = r.rows as
          | Array<{
              update_id?: string | null;
              submission_id?: string | null;
              begin_exclusive?: string | number | null;
            }>
          | undefined;
        if (!rows || rows.length === 0) return null;
        const row = rows[0]!;
        const updateId = row.update_id ?? null;
        if (updateId !== null) return { state: "settled" as const, updateId };
        // pg returns bigint as a string; Number() is safe for a ledger offset
        // and NaN would be worse than absent, so it is filtered out.
        const off =
          row.begin_exclusive === null || row.begin_exclusive === undefined
            ? undefined
            : Number(row.begin_exclusive);
        return {
          state: "dispatched" as const,
          ...(row.submission_id ? { submissionId: row.submission_id } : {}),
          ...(off !== undefined && Number.isFinite(off) ? { beginExclusive: off } : {}),
        };
      } catch (err) {
        // Fail-open, and say plainly what that now costs. Before the dispatch
        // marker existed this only meant "we relay again and burn traffic". It
        // now ALSO means we cannot see that a submission is already in flight,
        // so on a dead database this endpoint degrades to exactly the old
        // behaviour. Refusing instead would take the whole money path down on a
        // DB blip, which this repo has already had to reverse once.
        onError("getRecord", err);
        return null;
      }
    },
    async recordDispatched(txHashHex, meta) {
      try {
        await ensure();
        const r = await exec.query(
          `INSERT INTO inline_settles (tx_hash, update_id, submission_id, begin_exclusive)
           VALUES ($1, NULL, $2, $3)
           ON CONFLICT (tx_hash) DO NOTHING`,
          [txHashHex, meta?.submissionId ?? null, meta?.beginExclusive ?? null]
        );
        return (r.rowCount ?? 0) > 0;
      } catch (err) {
        // Fail-OPEN here too, and deliberately: this write happens BEFORE the
        // money moves, so refusing on a DB error would turn a database blip
        // into a refusal of honest payments. We lose the marker for this one
        // request and behave as we did before.
        onError("recordDispatched", err);
        return true;
      }
    },
    async recordSettled(txHashHex, updateId) {
      try {
        await ensure();
        // Promote OUR dispatch marker (update_id IS NULL) to settled. The WHERE
        // clause is what stops this from overwriting a concurrent settle's
        // recorded updateId — that one is the answer the caller must get.
        const r = await exec.query(
          `INSERT INTO inline_settles (tx_hash, update_id) VALUES ($1, $2)
           ON CONFLICT (tx_hash) DO UPDATE SET update_id = EXCLUDED.update_id,
             settled_at = now()
           WHERE inline_settles.update_id IS NULL`,
          [txHashHex, updateId]
        );
        return (r.rowCount ?? 0) > 0;
      } catch (err) {
        // The funds already moved by the time this runs. Un-recording cannot
        // un-move them, so the settle response must not depend on this write.
        onError("recordSettled", err);
        return true;
      }
    },
    async clearDispatched(txHashHex) {
      try {
        await ensure();
        await exec.query(
          `DELETE FROM inline_settles WHERE tx_hash = $1 AND update_id IS NULL`,
          [txHashHex]
        );
      } catch (err) {
        // Leaving a stale marker costs a 503 on a retry of a payment that
        // failed anyway; it never costs money. Not worth failing the response.
        onError("clearDispatched", err);
      }
    },
    async sweep(maxAgeMs) {
      try {
        await ensure();
        const r = await exec.query(
          `DELETE FROM inline_settles
            WHERE settled_at < now() - ($1::bigint * interval '1 millisecond')`,
          [String(Math.max(0, Math.floor(maxAgeMs)))]
        );
        return r.rowCount ?? 0;
      } catch (err) {
        onError("sweep", err);
        return 0;
      }
    },
  };
}

export interface CreateInlineSettleStoreOptions {
  dbUrl?: string | undefined;
  executor?: PgExecutor | undefined;
  onError?: ((op: string, err: unknown) => void) | undefined;
}

/**
 * Postgres when a database is configured, in-memory otherwise. An in-memory
 * store is correct for a single process and simply forgets across a restart —
 * the window in which a retry would re-relay, which the ledger still refuses.
 */
export function createInlineSettleStore(
  opts: CreateInlineSettleStoreOptions = {}
): InlineSettleStore {
  const onError =
    opts.onError ??
    ((op: string, err: unknown) => {
      console.warn(
        `[inline-settle] ${op} failed; idempotency degraded for this request`,
        err
      );
    });
  if (opts.executor) return createPostgresInlineSettleStore(opts.executor, onError);
  if (opts.dbUrl) {
    return createPostgresInlineSettleStore(
      poolExecutor(createFacilitatorPool(opts.dbUrl)),
      onError
    );
  }
  return createInMemoryInlineSettleStore();
}
