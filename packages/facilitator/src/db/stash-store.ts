/**
 * transfer-factory ("V3") stash store — the relay-side home of a payer-signed
 * `TransferFactory_Transfer` between sign-time and settle-time.
 *
 * Why it exists: a prepared Canton tx plus its disclosed contracts is hundreds
 * of KB and cannot travel in an X-PAYMENT header (~8–16 KB server limits), so
 * the client prepares AND signs via the relay (`pay/prepare` + `pay/commit`)
 * and the x402 payload carries only a small `submissionRef`. `/verify`
 * compares the fields RECORDED HERE AT BUILD TIME (the relay built the tx
 * itself — it is not decoding client-supplied bytes) against the server's
 * PaymentRequirements; `/settle` loads the stash and relays the signed tx.
 *
 * The same row doubles as the settle idempotency record: `settledUpdateId`
 * is written after funds move, so a LEGIT retry of an already-settled ref
 * returns the recorded success instead of failing (the ledger itself rejects
 * the actual respend — the success-record is delivery idempotency, not the
 * replay guard).
 *
 * Two backends behind one async interface (house pattern: consumed-store):
 *   - in-memory: single-instance, not restart-durable; tests / no DATABASE_URL.
 *   - Postgres: durable; lazily creates its table.
 *
 * Failure semantics are fail-CLOSED (unlike consumed-store): if the store is
 * unreachable there is nothing to relay, so ops throw/return-null honestly and
 * the payment fails without moving funds. The one exception is
 * `recordSettled` AFTER funds moved — that logs loudly and swallows, because
 * un-recording cannot un-move the funds.
 */
import { randomUUID } from "node:crypto";
import {
  createFacilitatorPool,
  poolExecutor,
  type PgExecutor,
} from "./pool.js";

export interface TfStashRecord {
  ref: string;
  payer: string;
  receiver: string;
  /** Ledger Daml Decimal amount exactly as built into the transfer. */
  amount: string;
  instrumentAdmin: string;
  instrumentId: string;
  /** Merchant-required memo (PaymentRequirements.extra.memo) stamped into the
   *  transfer's `x402.memo` meta at prepare time; validation compares it against
   *  the merchant's required memo. Absent when the merchant set none. */
  memo?: string;
  /** Absolute executeBefore (ISO-8601) built into the transfer. */
  executeBefore: string;
  /** Hex hash of the prepared tx — what the payer signs. */
  txHash: string;
  /** Base64 prepared-transaction protobuf (relay-built). */
  preparedTx: string;
  /** Base64 Ed25519 signature over txHash; present after `pay/commit`. */
  signature?: string;
  /** Settle updateId; present once funds moved (delivery idempotency). */
  settledUpdateId?: string;
}

export type AttachSignatureResult =
  | "ok"
  | "not_found"
  | "already_signed"
  | "expired";

export interface TfStashStore {
  /** Insert a freshly prepared (unsigned) stash row. Generates the ref. */
  create(rec: Omit<TfStashRecord, "ref" | "signature" | "settledUpdateId">): Promise<string>;
  get(ref: string): Promise<TfStashRecord | null>;
  /** Attach the payer's signature exactly once, only before executeBefore. */
  attachSignature(ref: string, signature: string): Promise<AttachSignatureResult>;
  /**
   * Record the settle updateId. Returns `true` if newly recorded, `false`
   * if the row already carried one (caller should return the EXISTING
   * success — read it back via `get`).
   */
  recordSettled(ref: string, updateId: string): Promise<boolean>;
  /**
   * Delete rows that can never settle or whose idempotency window closed:
   * unsettled rows past `executeBefore + unsettledGraceMs`, settled rows past
   * `executeBefore + settledRetentionMs`. Returns the number deleted.
   */
  sweep(now: Date, unsettledGraceMs: number, settledRetentionMs: number): Promise<number>;
  /** Live (unsettled, unexpired) rows for one payer — the per-payer cap input. */
  livePayerCount(payer: string, now: Date): Promise<number>;
}

export interface InMemoryTfStashOptions {
  /** Total row cap (bounds memory); oldest-first eviction. Default 10,000. */
  maxSize?: number | undefined;
}

export function createInMemoryTfStashStore(
  opts: InMemoryTfStashOptions = {}
): TfStashStore {
  const maxSize = opts.maxSize ?? 10_000;
  const rows = new Map<string, TfStashRecord>();
  return {
    async create(rec) {
      const ref = randomUUID();
      rows.set(ref, { ...rec, ref });
      if (rows.size > maxSize) {
        const oldest = rows.keys().next().value;
        if (oldest !== undefined) rows.delete(oldest);
      }
      return ref;
    },
    async get(ref) {
      return rows.get(ref) ?? null;
    },
    async attachSignature(ref, signature) {
      const row = rows.get(ref);
      if (!row) return "not_found";
      if (row.signature !== undefined) return "already_signed";
      if (new Date(row.executeBefore).getTime() <= Date.now()) return "expired";
      rows.set(ref, { ...row, signature });
      return "ok";
    },
    async recordSettled(ref, updateId) {
      const row = rows.get(ref);
      if (!row) return false;
      if (row.settledUpdateId !== undefined) return false;
      rows.set(ref, { ...row, settledUpdateId: updateId });
      return true;
    },
    async sweep(now, unsettledGraceMs, settledRetentionMs) {
      let n = 0;
      for (const [ref, row] of rows) {
        const eb = new Date(row.executeBefore).getTime();
        const cutoff =
          row.settledUpdateId !== undefined
            ? eb + settledRetentionMs
            : eb + unsettledGraceMs;
        if (now.getTime() > cutoff) {
          rows.delete(ref);
          n++;
        }
      }
      return n;
    },
    async livePayerCount(payer, now) {
      let n = 0;
      for (const row of rows.values()) {
        if (
          row.payer === payer &&
          row.settledUpdateId === undefined &&
          new Date(row.executeBefore).getTime() > now.getTime()
        )
          n++;
      }
      return n;
    },
  };
}

const STASH_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS tf_stash (" +
  "ref text PRIMARY KEY, " +
  "payer text NOT NULL, " +
  "receiver text NOT NULL, " +
  "amount text NOT NULL, " +
  "instrument_admin text NOT NULL, " +
  "instrument_id text NOT NULL, " +
  "execute_before timestamptz NOT NULL, " +
  "tx_hash text NOT NULL, " +
  "prepared_tx text NOT NULL, " +
  "memo text, " +
  "signature text, " +
  "settled_update_id text, " +
  "created_at timestamptz NOT NULL DEFAULT now())";
const STASH_PAYER_IDX_DDL =
  "CREATE INDEX IF NOT EXISTS tf_stash_payer_idx ON tf_stash(payer)";
// The LIVE prod table predates the memo column; CREATE TABLE IF NOT EXISTS never
// alters an existing table, so ALSO run an idempotent ADD COLUMN on init.
const STASH_MEMO_COL_DDL =
  "ALTER TABLE tf_stash ADD COLUMN IF NOT EXISTS memo text";

interface StashRow {
  ref: string;
  payer: string;
  receiver: string;
  amount: string;
  instrument_admin: string;
  instrument_id: string;
  execute_before: string | Date;
  tx_hash: string;
  prepared_tx: string;
  memo: string | null;
  signature: string | null;
  settled_update_id: string | null;
}

function rowToRecord(r: StashRow): TfStashRecord {
  return {
    ref: r.ref,
    payer: r.payer,
    receiver: r.receiver,
    amount: r.amount,
    instrumentAdmin: r.instrument_admin,
    instrumentId: r.instrument_id,
    executeBefore:
      r.execute_before instanceof Date
        ? r.execute_before.toISOString()
        : new Date(r.execute_before).toISOString(),
    txHash: r.tx_hash,
    preparedTx: r.prepared_tx,
    ...(r.memo !== null && r.memo !== undefined ? { memo: r.memo } : {}),
    ...(r.signature !== null ? { signature: r.signature } : {}),
    ...(r.settled_update_id !== null
      ? { settledUpdateId: r.settled_update_id }
      : {}),
  };
}

export function createPostgresTfStashStore(executor: PgExecutor): TfStashStore {
  let ready: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (!ready) {
      ready = executor
        .query(STASH_TABLE_DDL)
        .then(() => executor.query(STASH_MEMO_COL_DDL))
        .then(() => executor.query(STASH_PAYER_IDX_DDL))
        .then(() => undefined);
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };
  return {
    async create(rec) {
      await init();
      const ref = randomUUID();
      await executor.query(
        "INSERT INTO tf_stash(ref, payer, receiver, amount, instrument_admin, instrument_id, execute_before, tx_hash, prepared_tx, memo) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          ref,
          rec.payer,
          rec.receiver,
          rec.amount,
          rec.instrumentAdmin,
          rec.instrumentId,
          rec.executeBefore,
          rec.txHash,
          rec.preparedTx,
          rec.memo ?? null,
        ]
      );
      return ref;
    },
    async get(ref) {
      await init();
      const r = await executor.query(
        "SELECT ref, payer, receiver, amount, instrument_admin, instrument_id, execute_before, tx_hash, prepared_tx, memo, signature, settled_update_id " +
          "FROM tf_stash WHERE ref = $1",
        [ref]
      );
      const row = (r.rows as StashRow[])[0];
      return row ? rowToRecord(row) : null;
    },
    async attachSignature(ref, signature) {
      await init();
      // Single guarded UPDATE: only unsigned + unexpired rows take the
      // signature; disambiguate the failure mode with a follow-up read.
      const upd = await executor.query(
        "UPDATE tf_stash SET signature = $2 WHERE ref = $1 AND signature IS NULL AND execute_before > now()",
        [ref, signature]
      );
      if ((upd.rowCount ?? 0) > 0) return "ok";
      const r = await executor.query(
        "SELECT signature, execute_before FROM tf_stash WHERE ref = $1",
        [ref]
      );
      const row = (r.rows as StashRow[])[0];
      if (!row) return "not_found";
      if (row.signature !== null) return "already_signed";
      return "expired";
    },
    async recordSettled(ref, updateId) {
      try {
        await init();
        const upd = await executor.query(
          "UPDATE tf_stash SET settled_update_id = $2 WHERE ref = $1 AND settled_update_id IS NULL",
          [ref, updateId]
        );
        return (upd.rowCount ?? 0) > 0;
      } catch (err) {
        // Funds already moved — a store failure here must not fail the settle
        // response. Log loudly; the idempotency window degrades for this ref.
        console.error(
          `[tf-stash] recordSettled failed AFTER funds moved (ref=${ref}, updateId=${updateId}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return true;
      }
    },
    async sweep(now, unsettledGraceMs, settledRetentionMs) {
      await init();
      const r = await executor.query(
        "DELETE FROM tf_stash WHERE " +
          "(settled_update_id IS NULL AND execute_before < $1) OR " +
          "(settled_update_id IS NOT NULL AND execute_before < $2)",
        [
          new Date(now.getTime() - unsettledGraceMs).toISOString(),
          new Date(now.getTime() - settledRetentionMs).toISOString(),
        ]
      );
      return r.rowCount ?? 0;
    },
    async livePayerCount(payer, now) {
      await init();
      const r = await executor.query(
        "SELECT count(*)::int AS n FROM tf_stash WHERE payer = $1 AND settled_update_id IS NULL AND execute_before > $2",
        [payer, now.toISOString()]
      );
      const row = (r.rows as Array<{ n: number }>)[0];
      return row?.n ?? 0;
    },
  };
}

/** Factory mirroring `createConsumedStore` backend resolution. */
export function createTfStashStore(opts: {
  dbUrl?: string | undefined;
  maxSize?: number | undefined;
  executor?: PgExecutor | undefined;
}): TfStashStore {
  if (opts.executor) return createPostgresTfStashStore(opts.executor);
  if (!opts.dbUrl) return createInMemoryTfStashStore({ maxSize: opts.maxSize });
  const pool = createFacilitatorPool(opts.dbUrl);
  return createPostgresTfStashStore(poolExecutor(pool));
}
