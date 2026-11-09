/**
 * Prometheus metrics for the facilitator (observability foundation).
 *
 * The money-path /settle endpoint is public and, on the v1
 * (external-party-amulet-rules) method, spends the facilitator party's Global
 * Synchronizer traffic on every settle. Before this module the only
 * quantitative signal was /attribution (accounting, not operations): there was
 * no success/fail rate, no 503/429/counter_not_ready counter, and no latency —
 * a blind spot on a live money-path. These metrics are the foundation every
 * alert hangs off (settle outcome rate, breaker trips, rate-limit rejections,
 * settle latency).
 *
 * Design:
 *   - A DEDICATED `Registry` (not prom-client's global default registry) so the
 *     facilitator's metrics are self-contained and route tests can build an
 *     isolated `FacilitatorMetrics` per test without cross-contamination.
 *   - `createMetrics()` returns a small typed surface (counters + histogram +
 *     the registry). server.ts builds ONE instance, threads it into /settle,
 *     /verify, and the GET /metrics route. Tests build their own.
 *   - Default Node process metrics (event-loop lag, heap, GC, …) are collected
 *     onto the same registry so /metrics is useful out of the box.
 */
import {
  Registry,
  Counter,
  Histogram,
  collectDefaultMetrics,
  type Counter as CounterT,
  type Histogram as HistogramT,
} from "prom-client";

/**
 * The discrete /settle outcomes labelled on `settle_total{result=...}`.
 *
 * `ok` is a settled payment; everything else is a distinct failure class so an
 * operator can tell a budget-exhausted breaker trip apart from a
 * merchant-misconfig reject apart from a first-payment counter_not_ready in the
 * aggregate. `rate_limited` / `breaker_open` are the pre-validation refusals
 * (429 / 503); `validation_failed` collapses the runValidation reject classes
 * (each also logged with its precise reason — see settle.ts); `ledger_error`
 * is an unexpected_canton_ledger_error from the settle Send or scan fetch.
 */
export type SettleResult =
  | "ok"
  | "validation_failed"
  | "ledger_error"
  | "counter_not_ready"
  | "already_settled"
  | "rate_limited"
  | "breaker_open"
  // The submit may or may not have committed. Its own label because an
  // operator must never see this folded into ordinary ledger errors.
  | "outcome_unknown"
  /** The same state, met while the guard is in `observe`: counted so the
   *  rollout decision is made on a number rather than a guess, while the
   *  response stays what it is today. */
  | "outcome_unknown_observed"
  /** Answered 503: the shared Scan budget shed the Rule 7 lookup of a merchant
   *  we do not serve yet (scan-budget.ts). Not a rate limit on the caller. */
  | "scan_busy";

/** What a 429 (or a shed) was refused by, labelled on
 *  `ratelimit_rejected_total{scope=...}`: the two public endpoints, the relay's
 *  facilitator-wide submission arm and breaker (`relay_submit`), and outbound
 *  SV Scan reads shed by the shared Scan budget (`scan`). */
export type RateLimitScope = "verify" | "settle" | "relay_submit" | "scan";

/** Outcomes of a v1 TransferCommand_Send relative to the ~8KB / ~$0.50 of GS
 *  traffic each Send costs. Two are burns AVOIDED (a doomed Send the cost-gate
 *  PREVENTED) and one is a burn INCURRED (a Send that committed and was billed
 *  but moved no CC) — distinguished by the `outcome` label so an operator can
 *  alert on each separately:
 *   - `skipped_nonce_consumed` — AVOIDED: the pre-submit gate found the signed
 *     nonce already behind the counter and returned without submitting.
 *   - `retry_aborted_nonce` — AVOIDED: the stale-contracts retry found, after a
 *     refresh, that the command nonce is now behind the counter and aborted
 *     instead of resubmitting a doomed Send.
 *   - `committed_zero_funds_burn` — INCURRED: a Send that COMMITTED (and was
 *     billed GS traffic) but moved ZERO CC (transferred=false AND Scan did not
 *     confirm success). This is the gas-burn DoS signal — a self-owned,
 *     deliberately-unsettleable command burning facilitator gas. Rising here is
 *     BAD (money lost), unlike the two avoided-burn outcomes. */
export type SendOutcome =
  | "skipped_nonce_consumed"
  | "retry_aborted_nonce"
  | "committed_zero_funds_burn";

/**
 * Outcome of the payer signing-key read that gates every inline payment.
 *
 * The distinction is the whole point: `unavailable` is OUR topology reader
 * failing to answer, `no_key` is topology answering that this payer publishes
 * nothing usable. Both refuse the payment — correctly — but only one of them
 * is our outage, and on the wire they are the same refusal.
 */
export type InlineKeyLookupOutcome = "ok" | "unavailable" | "no_key";

/**
 * Why the payer-proof hash recompute failed, labelled on
 * `inline_hash_recompute_failed_total{kind=...}`. `graph`: the bytes carry a
 * node graph the hasher refuses (a cycle, a shared child, over a limit), so
 * someone sent bad bytes. `budget`: the bytes take more hashing steps than a
 * payment needs; a real payment here means the budget is too tight. `error`:
 * anything else, meaning our hasher could not encode the input. All refuse the
 * payment as `signature_invalid`.
 */
export type InlineHashRecomputeFailure = "graph" | "budget" | "error";

/**
 * Which side a relay-route failure is attributed to, labelled on
 * `relay_error_total{kind=...}`.
 *
 * The relay money-path routes (pay/prepare, preapproval/self|registry/*) all
 * fail through one helper (`relayError` in routes/wallet.ts), which already
 * separates a caller-attributed refusal (a stranger party we cannot read — the
 * caller's question answered, 404) from OUR outage (a real dependency/ledger
 * failure — 502, logged level 50). `server` is the alertable one: it is the
 * class that took CC payments down when Scan started 403ing while /settle
 * (registry) still looked healthy — the blind spot this counter closes.
 */
export type RelayErrorKind = "server" | "client";

export interface FacilitatorMetrics {
  /** The registry to serialize on GET /metrics. */
  registry: Registry;
  /** settle_total{result} — every /settle outcome, one of {@link SettleResult}. */
  settleTotal: CounterT<"result">;
  /** breaker_open_total — count of /settle calls REFUSED because the traffic
   *  circuit breaker was OPEN (page-worthy: facilitator traffic likely
   *  exhausted). */
  breakerOpenTotal: CounterT<string>;
  /** ratelimit_rejected_total{scope} — 429s, split by the verify/settle scope. */
  rateLimitRejectedTotal: CounterT<"scope">;
  /** settle_duration_seconds — wall-clock latency of /settle handling,
   *  observed for the work the handler actually did (see settle.ts). */
  settleDuration: HistogramT<string>;
  /** send_outcome_total{outcome} — v1 Send GS-traffic outcomes. The avoided-burn
   *  outcomes (skipped_nonce_consumed/retry_aborted_nonce) rising = the cost-gate
   *  is saving money; committed_zero_funds_burn rising = the gas-burn DoS is
   *  active (money lost). See {@link SendOutcome}. */
  sendOutcomeTotal: CounterT<"outcome">;
  /** See {@link FacilitatorMetrics.recordInlineKeyLookup}. */
  inlineKeyLookupTotal: CounterT<"outcome">;
  /** inline_hash_recompute_failed_total{kind}. See {@link InlineHashRecomputeFailure}. */
  inlineHashRecomputeFailedTotal: CounterT<"kind">;
  /** relay_error_total{route,kind} — failures of the wallet-relay money-path
   *  routes (pay/prepare, preapproval self/registry prepare+commit), which are
   *  NOT covered by settle_total. `kind=server` is our outage (alert on it);
   *  `kind=client` is a caller-attributed refusal. See {@link RelayErrorKind}. */
  relayErrorTotal: CounterT<"route" | "kind">;
  /** wallet_read_proof_total{result,reason}: the signed-read check on the relay's
   *  per-party GETs. result: absent | valid | invalid | expired | wrong_host |
   *  unverifiable; reason, for unverifiable only: budget | breaker | backoff |
   *  error (none otherwise). Not counted in mode off or for trusted keys. */
  walletReadProofTotal: CounterT<"result" | "reason">;
  /** Convenience: record one settle outcome (increments settle_total{result}). */
  recordSettle(result: SettleResult): void;
  /** Convenience: record a 429 rejection for `scope`. */
  recordRateLimited(scope: RateLimitScope): void;
  /** Convenience: record one v1 Send GS-traffic outcome (avoided OR incurred
   *  burn — see {@link SendOutcome}). */
  recordSendOutcome(outcome: SendOutcome): void;
  /** inline_key_lookup_total{outcome} — the payer signing-key read behind
   *  EVERY inline payment.
   *
   *  Exists because a failed lookup and a forged signature are the same thing
   *  on the wire: both refuse with `invalid_exact_canton_signature_invalid`.
   *  Without this counter, the topology reader going down looks exactly like
   *  an attack, and the operator debugs the wrong system. `unavailable`
   *  climbing means OUR dependency is down; `no_key` climbing means payers are
   *  arriving without a published protocol signing key. */
  recordInlineKeyLookup(outcome: InlineKeyLookupOutcome): void;
  /** Convenience: record one failed payer-proof hash recompute. */
  recordInlineHashRecomputeFailed(kind: InlineHashRecomputeFailure): void;
  /** Convenience: record one wallet-relay route failure (increments
   *  relay_error_total{route,kind}). */
  recordRelayError(route: string, kind: RelayErrorKind): void;
  /** scan_cooldown_total{host}: a Scan host answered 429 and the shared Scan
   *  budget started holding best-effort reads to it back (scan-budget.ts).
   *  Counted when a cooldown STARTS, not each time a 429 extends it. */
  scanCooldownTotal: CounterT<"host">;
  recordScanCooldown(host: string): void;
  /** Convenience: record one relay-read proof check. */
  recordWalletReadProof(
    result: "absent" | "valid" | "invalid" | "expired" | "wrong_host" | "unverifiable",
    reason?: "budget" | "breaker" | "backoff" | "error"
  ): void;
}

/**
 * Build an isolated metrics surface on its own Registry.
 *
 * `collectDefault` (default true) registers the standard Node process metrics
 * onto the same registry. Tests pass `collectDefault: false` so they do not
 * spin up the default-metrics interval timer.
 */
export function createMetrics(opts?: {
  collectDefault?: boolean;
}): FacilitatorMetrics {
  const registry = new Registry();

  if (opts?.collectDefault !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const settleTotal = new Counter({
    name: "x402_facilitator_settle_total",
    help: "Total /settle outcomes by result",
    labelNames: ["result"] as const,
    registers: [registry],
  });

  const breakerOpenTotal = new Counter({
    name: "x402_facilitator_breaker_open_total",
    help: "Count of /settle calls refused because the traffic circuit breaker was OPEN",
    registers: [registry],
  });

  const rateLimitRejectedTotal = new Counter({
    name: "x402_facilitator_ratelimit_rejected_total",
    help: "Total requests rejected (429) by a rate limiter, by endpoint scope",
    labelNames: ["scope"] as const,
    registers: [registry],
  });

  const settleDuration = new Histogram({
    name: "x402_facilitator_settle_duration_seconds",
    help: "Latency of /settle request handling in seconds",
    // Settle latency spans a cheap cip56 ack (sub-second) to a v1 Send with
    // stale-counter retries (several seconds). Buckets cover that range.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });

  const inlineKeyLookupTotal = new Counter({
    name: "x402_facilitator_inline_key_lookup_total",
    help: "payer signing-key lookups against the topology reader, by outcome: ok, unavailable (our reader could not answer), no_key (the party publishes none)",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });

  const inlineHashRecomputeFailedTotal = new Counter({
    name: "x402_facilitator_inline_hash_recompute_failed_total",
    help: "payer-proof hash recomputes that threw, by kind: graph (the bytes carry a node graph the hasher refuses), budget (more hashing steps than a payment needs), error (our hasher could not encode the input); all refuse as signature_invalid",
    labelNames: ["kind"] as const,
    registers: [registry],
  });

  const sendOutcomeTotal = new Counter({
    name: "x402_facilitator_send_outcome_total",
    help: "v1 Send GS-traffic outcomes by outcome: nonce cost-gate burns avoided (skipped_nonce_consumed/retry_aborted_nonce) and committed-but-zero-funds burns incurred (committed_zero_funds_burn)",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });

  const relayErrorTotal = new Counter({
    name: "x402_facilitator_relay_error_total",
    help: "Wallet-relay money-path route failures by route + kind (server = our outage, alertable; client = caller-attributed refusal). Covers pay/prepare + preapproval routes not seen by settle_total",
    labelNames: ["route", "kind"] as const,
    registers: [registry],
  });

  const scanCooldownTotal = new Counter({
    name: "x402_facilitator_scan_cooldown_total",
    help: "Times a Scan host answered 429 and best-effort Scan reads to it were held back for the cooldown, by host",
    labelNames: ["host"] as const,
    registers: [registry],
  });

  const walletReadProofTotal = new Counter({
    name: "x402_facilitator_wallet_read_proof_total",
    help: "Relay per-party reads by proof result (absent, valid, invalid, expired, wrong_host, unverifiable) and, for unverifiable, reason (budget, breaker, backoff, error); trusted-key requests are exempt and not counted",
    labelNames: ["result", "reason"] as const,
    registers: [registry],
  });

  return {
    registry,
    settleTotal,
    scanCooldownTotal,
    breakerOpenTotal,
    rateLimitRejectedTotal,
    settleDuration,
    sendOutcomeTotal,
    inlineKeyLookupTotal,
    inlineHashRecomputeFailedTotal,
    relayErrorTotal,
    walletReadProofTotal,
    recordSettle(result: SettleResult): void {
      settleTotal.inc({ result });
    },
    recordRateLimited(scope: RateLimitScope): void {
      rateLimitRejectedTotal.inc({ scope });
    },
    recordSendOutcome(outcome: SendOutcome): void {
      sendOutcomeTotal.inc({ outcome });
    },
    recordInlineKeyLookup(outcome: InlineKeyLookupOutcome): void {
      inlineKeyLookupTotal.inc({ outcome });
    },
    recordInlineHashRecomputeFailed(kind: InlineHashRecomputeFailure): void {
      inlineHashRecomputeFailedTotal.inc({ kind });
    },
    recordRelayError(route: string, kind: RelayErrorKind): void {
      relayErrorTotal.inc({ route, kind });
    },
    recordScanCooldown(host: string): void {
      scanCooldownTotal.inc({ host });
    },
    recordWalletReadProof(result, reason): void {
      // reason is set only for unverifiable: budget (our lookup budget), breaker
      // (lookups paused after the reader failed) or error (the lookup failed).
      walletReadProofTotal.inc({ result, reason: reason ?? "none" });
    },
  };
}
