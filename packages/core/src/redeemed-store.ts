/**
 * ONE PAYMENT, ONE DELIVERY.
 *
 * The facilitator answers a repeated /settle of the same signed transaction
 * with the recorded success and the ORIGINAL updateId. That is correct for the
 * payer — it is what stops a retry from charging twice — but on its own it is
 * exactly wrong for the merchant, because nothing in the protocol binds a
 * settle to one delivery: the facilitator never sees which resource is being
 * bought (it receives no resource URL), and the merchant's requirements are
 * static per route.
 *
 * So a payer who buys once can replay the identical PAYMENT-SIGNATURE header
 * forever and be served every time. Each replay re-validates (the bytes are
 * genuinely signed and still unexpired) and each settle short-circuits to the
 * recorded success, so the middleware sees `success: true` and delivers. The
 * only trace is a stream of responses carrying an identical `transaction`
 * updateId that nobody looks at. The window closes only when the transfer's
 * own executeBefore passes — payer-chosen, ten minutes in the shipped wallet.
 *
 * The binding has to live where the delivery decision is made, which is here.
 * A settle updateId is unique per payment and already returned on every
 * success, so it is the natural redemption ticket: remember it, and refuse the
 * second delivery.
 *
 * Refusing with 402 rather than an error is deliberate — "this payment was
 * already redeemed, pay again for another" is precisely the x402 semantics,
 * and it leaves an honest client able to buy a second unit by paying for it.
 */

export interface RedeemedStore {
  /**
   * Claim this updateId for a delivery. `true` on the FIRST claim, `false`
   * every time after — the caller must not deliver on `false`.
   *
   * Implementations must be atomic: two concurrent claims of the same id must
   * not both return `true`, or a replay races its way to a second delivery.
   */
  claim(updateId: string): boolean | Promise<boolean>;

  /**
   * Give a claimed ticket back, because the delivery it was claimed for never
   * happened at all.
   *
   * The middleware claims BEFORE running the merchant's handler — it has to,
   * or two concurrent replays both pass the check and both get served. But a
   * handler that then throws produced nothing: the payer paid on-ledger, got a
   * 500, and without this would be refused `payment_already_redeemed` on every
   * retry of that same payment. Paid, unserved, and unable to ever be served.
   *
   * OPTIONAL on purpose. Merchants implement this interface themselves (Redis,
   * a table) against the published package, so a required method would break
   * every existing implementation at the type level. A store that omits it
   * keeps the old behaviour, which is safe — merely worse for that payer.
   *
   * Callers must only release when NOTHING was delivered. Releasing after a
   * partial write reopens the replay window this store exists to close.
   */
  release?(updateId: string): void | Promise<void>;
}

export interface InMemoryRedeemedOptions {
  /**
   * How long a redeemed id is remembered. It must outlive the window in which
   * the payment can still be settled — a payment that can no longer settle can
   * no longer be replayed either.
   *
   * That window is the transfer's executeBefore — but NOT the ten minutes the
   * shipped wallet happens to use, which is what an earlier version of this
   * comment sized itself against. On the inline carriage the PAYER chooses it.
   * While the deadline holds, a replayed settle is answered from the
   * facilitator's own recorded success — no submission, no traffic, straight
   * back `{success:true}` with the original updateId — so a payer who signed a
   * 24-hour deadline stayed replayable for 24 hours.
   *
   * A one-hour ticket therefore meant the merchant forgot 23 h before the
   * payment stopped being spendable: at t+1h the same header was re-sent,
   * claim() re-admitted it, and the resource went out again. Roughly 23 free
   * deliveries per payment, and a merchant restart reset the counter.
   *
   * The facilitator now caps that deadline too (its own
   * CANTON_X402_TF_MAX_EXECUTE_BEFORE_S, 600 s by default), so the window is
   * short again — but this store belongs to the MERCHANT, who cannot see that
   * config and may face a facilitator with a laxer one. It keeps its own
   * generous margin instead of trusting someone else's setting: 26 h, which
   * also covers the facilitator's 24 h settle-record retention.
   *
   * Note the ceiling below still applies: a merchant serving more than
   * `maxSize` payments inside the window evicts the oldest, which is the honest
   * bound on a single-process store.
   */
  ttlMs?: number;
  /** Hard entry cap so a burst cannot grow this without bound. Default 50k. */
  maxSize?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Single-process default. A merchant running several instances behind a load
 * balancer needs a SHARED store instead (Redis, a table) — with this one, each
 * instance would happily serve the same replay once, so N instances mean N
 * deliveries. That is still bounded and vastly better than unbounded, but say
 * so plainly rather than let an operator assume otherwise.
 */
export function createInMemoryRedeemedStore(
  opts: InMemoryRedeemedOptions = {}
): RedeemedStore {
  const ttlMs = opts.ttlMs ?? 26 * 60 * 60_000;
  const maxSize = opts.maxSize ?? 50_000;
  const now = opts.now ?? Date.now;
  // Insertion-ordered, so the oldest key is always the first one out.
  const seen = new Map<string, number>();

  return {
    claim(updateId: string): boolean {
      const t = now();
      const prev = seen.get(updateId);
      if (prev !== undefined && t - prev < ttlMs) return false;
      // Expired (or new): drop the stale entry so re-inserting restores
      // insertion order, otherwise an old key would keep its old eviction slot.
      if (prev !== undefined) seen.delete(updateId);

      // Evict expired entries oldest-first; stop at the first live one, since
      // insertion order makes everything after it live too.
      for (const [k, ts] of seen) {
        if (t - ts < ttlMs) break;
        seen.delete(k);
      }
      seen.set(updateId, t);
      // Backstop for the case where nothing has expired yet.
      while (seen.size > maxSize) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      return true;
    },
    release(updateId: string): void {
      // Deleting rather than back-dating: a re-claim must restore insertion
      // order too, and `claim` already re-inserts on a fresh key.
      seen.delete(updateId);
    },
  };
}
