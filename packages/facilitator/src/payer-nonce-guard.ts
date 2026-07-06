/**
 * In-process burn guard for the v1 (external-party-amulet-rules) settle path.
 *
 * A `TransferCommand_Send` is billed Global Synchronizer traffic (~8KB / ~$0.50)
 * the moment it COMMITS — even when it commits a `TransferCommandResultFailure`
 * that moves ZERO CC. The dominant waste under rapid-fire from one payer is a
 * Send whose signed nonce is already consumed by the on-ledger
 * `TransferCommandCounter`: it commits "Expected nonce N is smaller than current
 * counter M", is billed, and moves nothing.
 *
 * settle.ts already has a pre-submit COST GATE that re-reads the counter from
 * Scan and refuses a strictly-behind nonce. But Scan is eventually-consistent
 * and the gate's read is async, which leaves two windows the gate alone cannot
 * see on a single-instance facilitator:
 *
 *   (a) CONCURRENT same-nonce — two /settle requests for the SAME (payer, nonce)
 *       both read the counter (each sees the nonce as still-fresh) before either
 *       commits, so both submit and one burns. {@link reserve} closes this: it
 *       is a SYNCHRONOUS check-and-set, and because Node is single-threaded with
 *       no `await` between the check and the set, the second racer is refused
 *       before it can reach the submit.
 *   (b) SEQUENTIAL Scan-lag — a Send commits and advances the counter, but the
 *       DSO-signatory counter in Scan has not caught up yet, so the NEXT
 *       /settle's cost-gate re-reads a stale (behind) `nextNonce` and would
 *       submit a doomed Send. {@link markCommitted} / {@link committedHighWater}
 *       close this: the highest nonce THIS process has committed per payer is
 *       lag-free and authoritative for our own submissions.
 *
 * Both checks only ever PREVENT a Send we can prove is doomed; the on-ledger
 * nonce check stays the final authority, so the guard is fail-safe by
 * construction. It is SINGLE-INSTANCE only (the facilitator runs one process); a
 * future multi-instance deploy would replace it with a shared store (e.g. the
 * counter row in Postgres or Redis) — noted at the call site.
 *
 * Reservations are TTL-expired rather than explicitly released, which keeps the
 * call site purely additive (no try/finally around the 200-line settle body): a
 * legitimate re-pay always signs a FRESH nonce, so a lingering reservation on an
 * old nonce can never reject real traffic — it only ever blocks a re-submit of
 * the exact same (payer, nonce), which is precisely the doomed case.
 */
export class PayerNonceGuard {
  /** payer -> (nonce -> reservation-expiry-ms). In-flight Sends; TTL-expired. */
  private readonly inFlight = new Map<string, Map<bigint, number>>();
  /** payer -> highest nonce this process has COMMITTED (lag-free consumed mark). */
  private readonly highWater = new Map<string, bigint>();

  /**
   * @param reservationTtlMs how long a reservation blocks a same-nonce duplicate
   *   before it self-expires. Must comfortably exceed the longest settle
   *   (Send + stale-retries); 30s is well above the few-second worst case.
   * @param maxPayers backstop cap on tracked payers (LRU-ish eviction) so a
   *   long-lived process cannot grow these maps unbounded.
   */
  constructor(
    private readonly reservationTtlMs = 30_000,
    private readonly maxPayers = 10_000
  ) {}

  /**
   * Reserve (payer, nonce) for an in-flight Send. Returns `false` iff an
   * UNEXPIRED reservation for the same (payer, nonce) already exists — i.e. a
   * concurrent duplicate the caller must NOT submit. Synchronous and atomic
   * between awaits.
   */
  reserve(payer: string, nonce: bigint, nowMs: number): boolean {
    let nonces = this.inFlight.get(payer);
    if (nonces) {
      const expiry = nonces.get(nonce);
      if (expiry !== undefined && expiry > nowMs) return false; // live duplicate
      // Drop this payer's expired reservations so the map cannot accrete.
      for (const [n, exp] of nonces) if (exp <= nowMs) nonces.delete(n);
    } else {
      nonces = new Map();
      this.inFlight.set(payer, nonces);
      this.evictInFlight();
    }
    nonces.set(nonce, nowMs + this.reservationTtlMs);
    return true;
  }

  /**
   * Release a reservation taken by {@link reserve} when the attempt finished
   * WITHOUT committing a Send (gate reject, precondition failure, submit
   * abort). The nonce was NOT consumed on-ledger, so the SAME (payer, nonce)
   * is the legitimate next attempt — without this release the retry is blocked
   * by its own dead reservation until the TTL runs out. No-op if absent.
   */
  release(payer: string, nonce: bigint): void {
    const nonces = this.inFlight.get(payer);
    if (!nonces) return;
    nonces.delete(nonce);
    if (nonces.size === 0) this.inFlight.delete(payer);
  }

  /** Highest nonce THIS process has committed for `payer` (lag-free), or null. */
  committedHighWater(payer: string): bigint | null {
    return this.highWater.get(payer) ?? null;
  }

  /**
   * Record that a Send for (payer, nonce) COMMITTED on-ledger. A committed Send
   * consumes its nonce even when it moved zero CC, so any later Send at or below
   * this nonce for the same payer is provably doomed. Idempotent / monotonic:
   * only advances the high-water.
   */
  markCommitted(payer: string, nonce: bigint): void {
    const current = this.highWater.get(payer);
    if (current !== undefined && nonce <= current) return;
    // Re-insert as the newest key (Map preserves insertion order) so eviction
    // drops the least-recently-advanced payer.
    this.highWater.delete(payer);
    this.highWater.set(payer, nonce);
    if (this.highWater.size > this.maxPayers) {
      const oldest = this.highWater.keys().next().value;
      if (oldest !== undefined) this.highWater.delete(oldest);
    }
  }

  /** Evict the oldest tracked payer when the in-flight map exceeds the cap. */
  private evictInFlight(): void {
    if (this.inFlight.size <= this.maxPayers) return;
    const oldest = this.inFlight.keys().next().value;
    if (oldest !== undefined) this.inFlight.delete(oldest);
  }
}
