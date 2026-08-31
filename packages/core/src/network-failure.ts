/**
 * Did a fetch rejection happen BEFORE the request could reach the server?
 *
 * On the money path this is not a detail. A merchant's /settle call that fails
 * has two very different meanings:
 *
 *   - the connection was never established → the request does not exist, the
 *     facilitator never saw it, and nothing can have been submitted to the
 *     ledger. Provably a no-op, freely retryable.
 *   - the connection WAS established and then something went wrong mid-flight →
 *     the facilitator may have received it and may already have relayed the
 *     submission. Genuinely unknown; a re-pay from here can be a second payment.
 *
 * Collapsing the first into the second turns an ordinary, self-healing outage —
 * a facilitator redeploy, a wrong URL, a dead bridge — into per-payer manual
 * reconciliation of a payment that was never sent. Collapsing the second into
 * the first is worse: it invites the double payment.
 *
 * Node's fetch reports the real cause in the `cause` chain, and the split is
 * clean at that level:
 *
 *   NEVER SENT   ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ENETUNREACH, EHOSTUNREACH,
 *                UND_ERR_CONNECT_TIMEOUT  — no socket, no bytes.
 *   MAYBE SENT   ECONNRESET, EPIPE, ETIMEDOUT, UND_ERR_SOCKET,
 *                UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT — a socket
 *                existed; the request may have been delivered.
 *
 * FAIL SAFE: anything unrecognised — including a bare `TypeError: fetch failed`
 * with no cause, and an AbortError, which can fire at any point including long
 * after the request was delivered — returns false, i.e. "we cannot prove it was
 * never sent". The claim this function makes is only ever the SAFE one.
 *
 * Lives in core because the express and next middlewares are twins and must not
 * grow two copies of this rule.
 */

/** Codes that can only occur before a socket carried any request bytes. */
const NEVER_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * True only when the error PROVES the request never left this process.
 * False for everything else, including anything unrecognised.
 */
export function connectionNeverEstablished(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { code?: unknown; name?: unknown; cause?: unknown };
    // An abort can land at any moment, including after delivery — it is never
    // proof of a no-op, and it must not be read as one just because it is
    // nested under a "fetch failed" wrapper.
    if (e.name === "AbortError" || e.code === "ABORT_ERR") return false;
    if (typeof e.code === "string" && NEVER_CONNECTED.has(e.code)) return true;
    cur = e.cause;
  }
  return false;
}
