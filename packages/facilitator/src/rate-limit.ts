/**
 * In-memory operational guards for the facilitator's /settle route.
 *
 * v1 settlement makes the facilitator submit `TransferCommand_Send` and pay the
 * Global Synchronizer traffic fee, so /settle is a cost + griefing surface. Two
 * guards (the plan's "funded budget + /settle rate-limit are mandatory before
 * mainnet"):
 *
 *   - SlidingWindowLimiter caps the settle RATE — per payer party AND globally —
 *     so a funded traffic budget drains predictably and one payer cannot
 *     monopolise it.
 *   - CircuitBreaker stops hammering the ledger once Sends start failing for
 *     traffic reasons and surfaces the condition to the operator (HTTP 503),
 *     instead of burning more budget on doomed submissions.
 *
 * Both are PROCESS-LOCAL (no shared store) — adequate for a single-instance
 * facilitator. A multi-instance deploy needs a shared limiter (e.g. Redis);
 * documented so it is a conscious choice, not a silent gap.
 */

export interface SlidingWindowConfig {
  /** Max settles per window for one payer party. `<= 0` disables this cap. */
  maxPerPayer: number;
  /** Max settles per window across all payers. `<= 0` disables this cap. */
  maxGlobal: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Max settles per window for one client IP, used as the SECOND per-key cap
   * on /settle. The limiter itself does NOT read this field — it is consumed by
   * the caller, which passes `{ key: ipKey, max: maxPerIp }` to
   * {@link SlidingWindowLimiter.allowKeys}. It exists here so the per-IP cap
   * travels with the rest of the rate config. Distinct from `maxPerPayer`
   * because on /settle the caller IP is the MERCHANT (the merchant calls
   * /settle, not the payer), so one IP legitimately aggregates many payers; it
   * must be capped higher than a single payer. `<= 0` disables the IP cap.
   */
  maxPerIp?: number;
}

export interface SlidingWindowLimiter {
  /**
   * Test + record one settle attempt for `key` at `now` (epoch ms). Returns
   * true if allowed (under BOTH the per-key and global caps), false if it
   * should be rate-limited. A rejected attempt is NOT recorded (so a blocked
   * caller cannot push the window forward and starve everyone else).
   */
  allow(key: string, now: number): boolean;
  /**
   * Like {@link allow} but tests + records the attempt against SEVERAL per-key
   * buckets at once (e.g. payer party AND client IP on /settle). The attempt is
   * allowed only when the global cap AND every per-key bucket has room, and the
   * global counter is incremented exactly ONCE (not once per key). On rejection
   * nothing is recorded. Duplicate keys are de-duplicated so one logical key is
   * never counted twice. This is what closes the "rotate the wire `payer` to
   * evade the per-payer cap" hole: the caller's IP stays a fixed second key.
   *
   * Each entry may be a bare string (capped at the limiter's `maxPerPayer`) or
   * `{ key, max }` to give that key its OWN cap. The per-key cap matters on
   * /settle: the payer key uses the low per-payer cap, while the client-IP key
   * (which is the MERCHANT's IP — the merchant calls /settle, so it aggregates
   * every agent paying through it) needs a much higher `maxPerIp`, otherwise a
   * single merchant fronting N agents is throttled to one payer's budget. A
   * `max <= 0` entry is not capped (its bucket is skipped).
   */
  allowKeys(
    keys: readonly (string | { key: string; max: number })[],
    now: number
  ): boolean;
  /** Number of live per-key buckets. Introspection hook for tests/metrics. */
  _size(): number;
  /**
   * Force the aged-out-bucket eviction sweep at `now`. Introspection hook so
   * tests can assert eviction deterministically without driving real time.
   */
  _sweep(now: number): void;
}

export function createSlidingWindowLimiter(
  cfg?: SlidingWindowConfig
): SlidingWindowLimiter {
  const maxPerPayer = cfg?.maxPerPayer ?? 0;
  const maxGlobal = cfg?.maxGlobal ?? 0;
  const windowMs = cfg?.windowMs ?? 60_000;
  const perKey = new Map<string, number[]>();
  const globalHits: number[] = [];
  // Timestamp of the last full sweep. The sweep evicts per-key buckets whose
  // timestamps have all aged out, so the Map cannot grow without bound when
  // many distinct keys (e.g. spoofed IPs on /verify) each hit once and never
  // return — those one-shot buckets are never re-queried, so per-call pruning
  // alone never reclaims them. Sweeping at most once per window keeps the cost
  // amortised O(1) per request while bounding the Map to keys seen within
  // roughly the last two windows.
  let lastSweepAt = -Infinity;

  const prune = (arr: number[], now: number): void => {
    const cutoff = now - windowMs;
    let removeCount = 0;
    for (const t of arr) {
      if (t <= cutoff) removeCount++;
      else break;
    }
    if (removeCount > 0) arr.splice(0, removeCount);
  };

  // Drop every per-key bucket that is empty after pruning. Called at most once
  // per window from allow(); also exposed for deterministic unit testing.
  const sweep = (now: number): void => {
    for (const [k, arr] of perKey) {
      prune(arr, now);
      if (arr.length === 0) perKey.delete(k);
    }
    lastSweepAt = now;
  };

  const allowKeys = (
    keys: readonly (string | { key: string; max: number })[],
    now: number
  ): boolean => {
    // Normalize: a bare string is capped at maxPerPayer; an object carries its
    // own cap (e.g. the IP key on /settle uses the higher per-IP cap).
    const entries = keys.map((k) =>
      typeof k === "string" ? { key: k, max: maxPerPayer } : k
    );
    const anyKeyCapped = entries.some((e) => e.max > 0);

    // Fully disabled (no per-key cap in play, no global) → no bookkeeping, no
    // unbounded Map growth.
    if (!anyKeyCapped && maxGlobal <= 0) return true;

    // Amortised eviction of aged-out per-key buckets (bounds Map growth).
    if (anyKeyCapped && now - lastSweepAt >= windowMs) sweep(now);

    // Global cap is checked ONCE regardless of how many per-key buckets the
    // attempt touches, so a multi-key call does not double-spend the budget.
    if (maxGlobal > 0) {
      prune(globalHits, now);
      if (globalHits.length >= maxGlobal) return false;
    }

    // Resolve every distinct per-key bucket and confirm ALL have room before
    // recording into ANY of them — a rejected attempt must leave every bucket
    // untouched so it cannot push any window forward.
    const buckets: number[][] = [];
    const seen = new Set<string>();
    for (const { key, max } of entries) {
      if (max <= 0) continue; // this key is not capped → skip its bucket
      if (seen.has(key)) continue; // de-dup: never count one key twice
      seen.add(key);
      let arr = perKey.get(key);
      if (!arr) {
        arr = [];
        perKey.set(key, arr);
      }
      prune(arr, now);
      if (arr.length >= max) return false; // this key is over its own cap
      buckets.push(arr);
    }

    // Global + every per-key bucket has room — record the hit.
    if (maxGlobal > 0) globalHits.push(now);
    for (const arr of buckets) arr.push(now);
    // Buckets created above always receive a push, so they are non-empty on
    // return; freshly-created-but-unpushed buckets cannot occur here (we return
    // before creating later buckets if an earlier key is over cap, and any
    // bucket that was created and then left empty is reclaimed by the next
    // per-window sweep).
    return true;
  };

  return {
    allow(key: string, now: number): boolean {
      return allowKeys([key], now);
    },
    allowKeys,
    _size(): number {
      return perKey.size;
    },
    _sweep(now: number): void {
      sweep(now);
    },
  };
}

export interface CircuitBreakerConfig {
  /** Failures (within `windowMs`) that trip the breaker OPEN. `<= 0` disables
   *  the breaker entirely (both the count arm AND the rate arm). Historically
   *  this was a CONSECUTIVE-failure count; it is now the count of failures still
   *  inside the sliding window, which a single success DECAYS rather than zeroes
   *  (see {@link CircuitBreaker.recordSuccess}). With back-to-back failures the
   *  behaviour is identical to the old consecutive count. */
  threshold: number;
  /** How long the breaker stays OPEN before allowing a settle again, in ms. */
  cooldownMs: number;
  /** Sliding-window length (ms) over which both failures and successes are
   *  counted for the COUNT arm (decaying threshold) and the RATE arm. Failures
   *  older than this age out, so a slow drip across windows cannot accumulate.
   *  Optional; defaults to 60s. */
  windowMs?: number;
  /** RATE arm: trip when the windowed failure FRACTION reaches this value (0..1)
   *  AND at least {@link minSamples} failures are in the window. This is the
   *  paced-attacker fix: an attacker who interleaves one cheap success after
   *  every billed-but-zero-funds burn keeps the COUNT arm decayed near zero, but
   *  a sustained ~50% failure fraction still trips the RATE arm. Optional;
   *  defaults to 0.5. A value `<= 0` disables the rate arm (count arm only). */
  failureRate?: number;
  /** RATE arm guard: minimum windowed failures before the rate arm can trip, so
   *  a single early failure at 100% fraction does not trip it. Optional;
   *  defaults to 10. */
  minSamples?: number;
}

export interface CircuitBreaker {
  /** True if the breaker is OPEN at `now` — settles should be refused. */
  isOpen(now: number): boolean;
  /** Record a settle Send that failed for a traffic reason (see isTrafficError). */
  recordTrafficFailure(now: number): void;
  /** Record a settle Send that COMMITTED but moved ZERO funds — the facilitator
   *  was billed Global-Synchronizer gas for nothing. Counts AGAINST the breaker
   *  exactly like a traffic failure (both arms), so a self-owned deliberately-
   *  unsettleable command cannot burn gas indefinitely. Same window/decay
   *  semantics as {@link recordTrafficFailure}. */
  recordBurn(now: number): void;
  /** Record a successful settle Send. DECAYS the windowed failure count (drops
   *  the oldest failure) rather than fully resetting it, and contributes one
   *  success sample to the rate-arm denominator. `now` is optional for backward
   *  compatibility (the success path historically called this with no args);
   *  when omitted the success still decays the count but adds no dated sample. */
  recordSuccess(now?: number): void;
}

export function createCircuitBreaker(
  cfg?: CircuitBreakerConfig
): CircuitBreaker {
  const threshold = cfg?.threshold ?? 0;
  const cooldownMs = cfg?.cooldownMs ?? 60_000;
  const windowMs = cfg?.windowMs ?? 60_000;
  const failureRate = cfg?.failureRate ?? 0.5;
  const minSamples = cfg?.minSamples ?? 10;
  // TWO independent accountings, deliberately decoupled so success decay cannot
  // blind the rate arm:
  //   COUNT arm — `decayCount`: a small integer that a failure increments and a
  //     success DECREMENTS (decay, floored at 0). Back-to-back failures make it
  //     behave exactly like the old consecutive count; a single success no
  //     longer fully resets it.
  //   RATE arm — true sliding-window timestamps of failures and successes
  //     (NOT mutated by decay), so failures / (failures + successes) reflects
  //     the real recent failure fraction. This is what catches a paced attacker
  //     who pairs one cheap success with every billed-but-zero-funds burn: the
  //     COUNT arm decays toward zero, but the true fraction stays ~50%.
  let decayCount = 0;
  const failures: number[] = []; // sorted-ascending, pruned to windowMs
  const successes: number[] = []; // sorted-ascending, pruned to windowMs
  let openUntil = 0;

  const prune = (arr: number[], now: number): void => {
    const cutoff = now - windowMs;
    let removeCount = 0;
    for (const t of arr) {
      if (t <= cutoff) removeCount++;
      else break;
    }
    if (removeCount > 0) arr.splice(0, removeCount);
  };

  // A failure (traffic reject OR committed-zero-funds burn) feeds BOTH arms.
  const recordFailure = (now: number): void => {
    if (threshold <= 0) return;
    prune(failures, now);
    prune(successes, now);
    failures.push(now);
    decayCount++;
    // COUNT arm: the decaying failure count reaches the threshold (back-to-back
    // failures reproduce the old consecutive behaviour exactly).
    const countTrip = decayCount >= threshold;
    // RATE arm: a sustained failure fraction over the true window trips even
    // when each burn is paired with a success that decays the count arm.
    const total = failures.length + successes.length;
    const rateTrip =
      failureRate > 0 &&
      failures.length >= minSamples &&
      total > 0 &&
      failures.length / total >= failureRate;
    if (countTrip || rateTrip) openUntil = now + cooldownMs;
  };

  return {
    isOpen(now: number): boolean {
      if (threshold <= 0) return false;
      return openUntil > now;
    },
    recordTrafficFailure(now: number): void {
      recordFailure(now);
    },
    recordBurn(now: number): void {
      recordFailure(now);
    },
    recordSuccess(now?: number): void {
      if (threshold <= 0) return;
      // DECAY the count arm (not a full reset): one success forgives at most one
      // failure, so a real burst still needs as many successes as failures to
      // fully decay. With ≤1 residual failure this lands at 0 — the same as the
      // old reset for the common honest case.
      if (decayCount > 0) decayCount--;
      // Feed the rate arm's denominator with a TRUE success sample (only when
      // dated; the legacy no-arg success just decays the count above). Crucially
      // this does NOT remove anything from `failures`, so the measured fraction
      // stays honest under a paced 1:1 burn/success attack.
      if (typeof now === "number") {
        prune(failures, now);
        prune(successes, now);
        successes.push(now);
      }
      // Deliberately do NOT clear `openUntil` here: letting a single success
      // force-close an OPEN breaker mid-cooldown is the same hole the decay
      // closes. The cooldown elapses on its own (isOpen returns false once
      // `now >= openUntil`).
    },
  };
}

/**
 * Classify whether a settle Send error is traffic / sequencer related, so the
 * breaker trips only on budget-relevant failures — not on validation or
 * one-off transient errors. Conservative substring/keyword match against the
 * Canton error body (which surfaces sequencer traffic exhaustion as ABORTED /
 * traffic-related messages).
 */
export function isTrafficError(err: unknown): boolean {
  const body =
    (err as { responseBody?: string })?.responseBody ??
    (err instanceof Error ? err.message : String(err ?? ""));
  return /traffic|sequencer|ABORTED|OUT_OF_QUOTA|insufficient.*(traffic|balance)/i.test(
    body
  );
}
