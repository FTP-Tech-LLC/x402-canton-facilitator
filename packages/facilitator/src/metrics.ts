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
  | "breaker_open";

/** The two rate-limited endpoints, labelled on `ratelimit_rejected_total{scope=...}`. */
export type RateLimitScope = "verify" | "settle";

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
  /** Convenience: record one settle outcome (increments settle_total{result}). */
  recordSettle(result: SettleResult): void;
  /** Convenience: record a 429 rejection for `scope`. */
  recordRateLimited(scope: RateLimitScope): void;
  /** Convenience: record one v1 Send GS-traffic outcome (avoided OR incurred
   *  burn — see {@link SendOutcome}). */
  recordSendOutcome(outcome: SendOutcome): void;
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

  const sendOutcomeTotal = new Counter({
    name: "x402_facilitator_send_outcome_total",
    help: "v1 Send GS-traffic outcomes by outcome: nonce cost-gate burns avoided (skipped_nonce_consumed/retry_aborted_nonce) and committed-but-zero-funds burns incurred (committed_zero_funds_burn)",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });

  return {
    registry,
    settleTotal,
    breakerOpenTotal,
    rateLimitRejectedTotal,
    settleDuration,
    sendOutcomeTotal,
    recordSettle(result: SettleResult): void {
      settleTotal.inc({ result });
    },
    recordRateLimited(scope: RateLimitScope): void {
      rateLimitRejectedTotal.inc({ scope });
    },
    recordSendOutcome(outcome: SendOutcome): void {
      sendOutcomeTotal.inc({ outcome });
    },
  };
}
