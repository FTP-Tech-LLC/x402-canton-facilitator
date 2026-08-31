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
    now: number,
    /**
     * Whether this attempt spends the GLOBAL budget. Default true.
     *
     * It exists because the two caps answer different questions. The per-key
     * caps are admission control — cheap, and rightly charged to anything that
     * arrives. The global cap is a budget for the scarce thing: submissions
     * that burn Global Synchronizer traffic. Charging it at admission meant a
     * stream of well-formed nonsense — bodies that pass shape validation and
     * are then refused by the real checks, costing us a decode and nothing
     * else — consumed the same budget as real payments, and could exhaust it
     * for every honest merchant on the facilitator. Two IPs sending junk were
     * enough.
     *
     * So: pass false at admission, and charge the global budget again with
     * `allowKeys([], now)` immediately before the submit that actually spends.
     */
    chargeGlobal?: boolean
  ): boolean;
  /**
   * Is `key` still under `max` — WITHOUT recording an attempt?
   *
   * Exists for budgets that are spent on an OUTCOME rather than on arrival:
   * the caller has to ask "is this key already over" before doing the work,
   * and then charge only if the work turned out to be waste. `allow` cannot
   * express that — it tests and records in one step, so using it as the
   * pre-check would charge the honest case too.
   *
   * `max <= 0` means uncapped and always answers true. Concurrent peeks can
   * both pass and both then charge, overshooting the budget by the number of
   * in-flight requests; that is deliberate. This is a budget, not an
   * invariant, and paying for a lock to make it exact would cost more than the
   * overshoot.
   */
  peek(key: string, now: number, max: number): boolean;
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
    now: number,
    chargeGlobal = true
  ): boolean => {
    // Normalize: a bare string is capped at maxPerPayer; an object carries its
    // own cap (e.g. the IP key on /settle uses the higher per-IP cap).
    const entries = keys.map((k) =>
      typeof k === "string" ? { key: k, max: maxPerPayer } : k
    );
    const anyKeyCapped = entries.some((e) => e.max > 0);

    // Fully disabled (no per-key cap in play, no global) → no bookkeeping, no
    // unbounded Map growth.
    const globalInPlay = chargeGlobal && maxGlobal > 0;
    if (!anyKeyCapped && !globalInPlay) return true;

    // Amortised eviction of aged-out per-key buckets (bounds Map growth).
    if (anyKeyCapped && now - lastSweepAt >= windowMs) sweep(now);

    // Global cap is checked ONCE regardless of how many per-key buckets the
    // attempt touches, so a multi-key call does not double-spend the budget.
    if (globalInPlay) {
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
    if (globalInPlay) globalHits.push(now);
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
    peek(key: string, now: number, max: number): boolean {
      if (max <= 0) return true;
      const arr = perKey.get(key);
      if (!arr) return true;
      prune(arr, now);
      return arr.length < max;
    },
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
  //   COUNT arm — `countArm`: failure timestamps that a success forgives one of
  //     (oldest first) AND that age out of the window. Back-to-back failures
  //     make it behave exactly like the old consecutive count; a single success
  //     no longer fully resets it.
  //
  //     It is a windowed ARRAY rather than an integer because an integer was
  //     both of those things and neither: `prune` only ever touched the rate
  //     arm's arrays, so a failure from an hour ago still counted toward a
  //     "60-second" window, and — worse — the count stayed at or above the
  //     threshold after a trip. Once the cooldown elapsed, ONE further failure
  //     re-opened the breaker immediately, forever. A protection that latches
  //     open on a single event after its first trip is not a protection; it is
  //     an outage waiting for its trigger.
  //   RATE arm — true sliding-window timestamps of failures and successes
  //     (NOT mutated by decay), so failures / (failures + successes) reflects
  //     the real recent failure fraction. This is what catches a paced attacker
  //     who pairs one cheap success with every billed-but-zero-funds burn: the
  //     COUNT arm decays toward zero, but the true fraction stays ~50%.
  const countArm: number[] = []; // sorted-ascending, pruned to windowMs
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
    prune(countArm, now);
    failures.push(now);
    countArm.push(now);
    // COUNT arm: the decaying, windowed failure count reaches the threshold
    // (back-to-back failures reproduce the old consecutive behaviour exactly).
    const countTrip = countArm.length >= threshold;
    // RATE arm: a sustained failure fraction over the true window trips even
    // when each burn is paired with a success that decays the count arm.
    const total = failures.length + successes.length;
    const rateTrip =
      failureRate > 0 &&
      failures.length >= minSamples &&
      total > 0 &&
      failures.length / total >= failureRate;
    if (countTrip || rateTrip) {
      openUntil = now + cooldownMs;
      // Spend the evidence that tripped it. Otherwise the arm stays at the
      // threshold through the whole cooldown and the very next failure trips it
      // again — the breaker would never actually re-close under any load at
      // all. After a trip it takes a fresh `threshold` failures to re-open.
      countArm.length = 0;
    }
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
      // Forgive the OLDEST outstanding failure. Same decay as before, now on a
      // value that is also windowed.
      if (countArm.length > 0) countArm.shift();
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

/**
 * The participant is already processing this EXACT submission.
 *
 * Canton dedupes by changeId — (user, commandId, actAs) — and a prepared
 * transaction carries its commandId in the signed bytes, so two concurrent
 * settles of one payment are the same submission by construction. The second
 * one gets 409 SUBMISSION_ALREADY_IN_FLIGHT.
 *
 * This is the participant's idempotency working, and it is why a duplicate
 * settle never double-spends. But it is NOT a failure: treating it as one
 * tells the caller their payment did not go through while it is going through,
 * and a caller who believes that may pay a second time. Canton labels it
 * category 2 with `retryInfo`, i.e. retry and you will get the answer.
 *
 * Measured, not assumed: this exact 409 was produced on MainNet by firing two
 * identical /settle calls at once, in a live stress run written for the
 * purpose. An adversarial review had dismissed the scenario as impossible.
 */
/**
 * Did this failure PROVE that nothing was committed on the ledger?
 *
 * Only a participant that answered with a definite client-side rejection did:
 * it processed the request and refused it, so no contract changed. A timeout,
 * a dropped connection or a 5xx proves nothing — the submit may well have
 * committed and only the answer was lost.
 *
 * The distinction matters wherever a failure triggers a rollback of our own
 * bookkeeping. Releasing a one-shot reservation on an ambiguous failure is how
 * a single payout becomes two: the party claims again, real CC leaves twice,
 * and the budget never sees the first one. Callers must treat `false` as "I do
 * not know" and keep the reservation.
 *
 * 408 and 429 are excluded from the definite set on purpose — they are the two
 * 4xx codes that mean "try again", not "refused".
 */
export function provesNothingCommitted(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown };
  if (e?.code !== "HTTP_ERROR") return false; // TIMEOUT / network / unknown
  const s = typeof e.status === "number" ? e.status : 0;
  if (s === 408 || s === 429) return false;
  return s >= 400 && s < 500;
}

export function isSubmissionAlreadyInFlight(err: unknown): boolean {
  const body =
    (err as { responseBody?: string })?.responseBody ??
    (err instanceof Error ? err.message : String(err ?? ""));
  return /SUBMISSION_ALREADY_IN_FLIGHT|already in-flight/i.test(body);
}
