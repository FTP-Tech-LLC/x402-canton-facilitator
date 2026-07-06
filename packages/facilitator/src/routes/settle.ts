import type { FastifyInstance } from "fastify";
import type { SettleResponse } from "@ftptech/x402-canton-core";
import { wireAmountToLedgerDecimal } from "@ftptech/x402-canton-core";
import type { ScanClient } from "@ftptech/x402-canton-ledger";
// Value import:
//   - getEventTrafficSummaryWithFallback: per-event traffic-burn attribution
//     fetch (fire-and-forget after a successful settle).
import { getEventTrafficSummaryWithFallback } from "@ftptech/x402-canton-ledger";
import {
  runValidation,
  clientIp,
  type ValidationServices,
} from "./common.js";
import {
  createSlidingWindowLimiter,
  createCircuitBreaker,
  isTrafficError,
  type SlidingWindowConfig,
  type CircuitBreakerConfig,
} from "../rate-limit.js";
import { validateFacilitatorRequestShape } from "./validate-body.js";
import type { TransferFactoryService } from "../canton/transfer-factory.js";
import type { TfStashStore } from "../db/stash-store.js";
import type { AttributionStore } from "../db/attribution-store.js";
import type { FacilitatorMetrics, SettleResult } from "../metrics.js";

/**
 * Dependencies for /settle. The ONLY settlement method handled is
 * transfer-factory ("V3", 1-tx meta-transaction): the FACILITATOR relays the
 * payer-signed TransferFactory_Transfer (ExecuteSubmission) after confirming the
 * merchant holds a live TransferPreapproval, in ONE tx (sponsored gas).
 *
 * The transfer-factory dep and the attribution deps are OPTIONAL so a deploy (or
 * a unit test) can omit them; the settle branch fails closed if its deps are
 * absent, and attribution is simply skipped when unwired.
 */
export interface SettleRouteServices extends ValidationServices {
  /** transfer-factory ("V3") settle: relay the payer-signed
   *  TransferFactory_Transfer (ExecuteSubmission) after confirming the merchant
   *  holds a live TransferPreapproval. OPTIONAL — a tf payload fails closed when
   *  it (or `tfStash`) is absent. services.ts wires it when tfEnabled. */
  transferFactory?:
    | Pick<TransferFactoryService, "preapprovalKind" | "execute">
    | undefined;
  /** transfer-factory master switch (config.tfEnabled). When false/absent a
   *  transfer-factory /settle is rejected fail-closed with
   *  invalid_exact_canton_transfer_factory_disabled BEFORE any ledger work
   *  (provably inert when off). SEPARATE from the optional deps. */
  tfEnabled?: boolean;
  /** transfer-factory idempotency record (settledUpdateId). Records the settle
   *  updateId AFTER funds move so a legit retry returns the recorded success. */
  tfStash?: Pick<TfStashStore, "recordSettled"> | undefined;
  /** /settle operational guards. Absent → disabled (tests). */
  settleRateLimit?: SlidingWindowConfig;
  settleBreaker?: CircuitBreakerConfig;
  /** Per-payment traffic-burn attribution (M2/M3/M4). OPTIONAL: absent (or its
   *  inner store undefined) → attribution is skipped. Recorded keyed by the
   *  settlement updateId. */
  attribution?: AttributionStore | undefined;
  /** SV ScanClients tried in order for the fire-and-forget traffic fetch. */
  attributionScanClients?: ScanClient[];
  /** Strict-attribution flag (see services.ts). It does NOT gate a settle whose
   *  payment is already committed: attribution is best-effort telemetry
   *  reconciled by the repair worker, so this flag does not fail any settle. */
  attributionRequired?: boolean | undefined;
  /** Prometheus metrics. OPTIONAL: absent → /settle records nothing (unit
   *  tests / a deploy that opted out of /metrics still settle normally). When
   *  present, every outcome increments settle_total{result}, 429/503 refusals
   *  bump ratelimit_rejected_total{scope=settle}/breaker_open_total, and the
   *  handler latency is observed into the settle duration histogram. */
  metrics?: FacilitatorMetrics | undefined;
}

/**
 * Pick the active OpenMiningRound deterministically (audit finding H2).
 *
 * `opensAt` (splice-amulet Round.daml) is the time after which transfers
 * may use a round. Among rounds already open (`opensAt <= now`) the
 * highest `round.number` is the current one. A missing `opensAt` is
 * treated as eligible (the validator scan-proxy / older shapes omit it);
 * if none are eligible we fall back to the highest-number round overall so
 * selection is never worse than the previous positional `[0]`. A
 * malformed `round.number` sorts last but stays usable as a last resort.
 *
 * Exported for direct unit testing.
 */
export function selectActiveOpenRound<
  T extends {
    contract: { payload: { round: { number: string }; opensAt?: string } };
  }
>(rounds: readonly T[], nowMs: number): T | undefined {
  if (rounds.length === 0) return undefined;
  const scored = rounds.map((r) => {
    let num: bigint;
    try {
      num = BigInt(r.contract.payload.round.number);
    } catch {
      num = -1n;
    }
    const opensAtMs = r.contract.payload.opensAt
      ? Date.parse(r.contract.payload.opensAt)
      : NaN;
    return { r, num, opensAtMs };
  });
  // Eligible = opensAt unknown (assume usable) OR already open.
  const eligible = scored.filter(
    (x) => !Number.isFinite(x.opensAtMs) || x.opensAtMs <= nowMs
  );
  const pool = eligible.length > 0 ? eligible : scored;
  pool.sort((a, b) => (a.num < b.num ? 1 : a.num > b.num ? -1 : 0));
  return pool[0]?.r;
}

export async function registerSettleRoute(
  app: FastifyInstance,
  svc: SettleRouteServices
): Promise<void> {
  const limiter = createSlidingWindowLimiter(svc.settleRateLimit);
  const breaker = createCircuitBreaker(svc.settleBreaker);
  const metrics = svc.metrics;
  app.post(
    "/settle",
    async (req, reply): Promise<SettleResponse | { error: string }> => {
      // Observe the settle handler latency on EVERY return path (the histogram
      // covers the transfer-factory relay execute). endTimer is
      // a no-op stub when metrics are unwired. An IIFE keeps the whole handler
      // body in this closure scope (limiter/breaker/metrics/failed) while the
      // try/finally guarantees the timer is observed regardless of return path.
      const endTimer = metrics?.settleDuration.startTimer() ?? (() => {});
      try {
        return await (async (): Promise<SettleResponse | { error: string }> => {
      const nowMs = Date.now();
      // Operational guards (settle pays GS traffic). Breaker first: when the
      // settle circuit is OPEN, refuse before doing any work.
      if (breaker.isOpen(nowMs)) {
        // breaker-OPEN means the facilitator's traffic is likely exhausted and
        // every settle is being refused (503) — this is page-worthy, so it logs
        // at ERROR (not WARN) for grepability/alerting, and bumps both the
        // dedicated breaker counter and settle_total{result=breaker_open}.
        req.log.error(
          "settle circuit breaker OPEN — refusing settle (facilitator traffic likely exhausted)"
        );
        metrics?.breakerOpenTotal.inc();
        metrics?.recordSettle("breaker_open");
        return reply
          .code(503)
          .send({ error: "facilitator_traffic_unavailable" });
      }
      const shape = validateFacilitatorRequestShape(req.body);
      if (!shape.ok) {
        // Malformed body — a 400 shape reject, recorded under validation_failed.
        req.log.info({ reason: shape.error }, "settle rejected: malformed body");
        metrics?.recordSettle("validation_failed");
        return reply.code(400).send({ error: shape.error });
      }
      const body = shape.body;

      // Rate-limit per payer AND per client IP, plus globally (after shape, so
      // malformed bodies do not consume quota). The IP key is a backstop against
      // one caller rotating the wire `payer` to mint a fresh per-payer bucket.
      // CRITICAL: the /settle caller is the MERCHANT (the merchant calls
      // /settle, not the payer), so one IP aggregates every agent paying through
      // that merchant. The IP key therefore gets its OWN, higher cap
      // (settleRateMaxPerIp) rather than the low per-payer cap — otherwise N
      // agents behind one merchant share a single payer's budget, the 11th
      // settle/min 429s, and the merchant surfaces that to the agent as a 502
      // (the observed "3+ agents → 502"). The global cap is enforced once
      // regardless of key count (allowKeys does not double-spend it). The wire
      // `payer` keys the per-payer rate-limit bucket.
      const payerKey = `payer:${
        body.paymentPayload?.payload?.payer ?? "unknown"
      }`;
      const ipKey = `ip:${clientIp(req)}`;
      const ipCap = svc.settleRateLimit?.maxPerIp ?? 0;
      if (!limiter.allowKeys([payerKey, { key: ipKey, max: ipCap }], nowMs)) {
        req.log.warn(
          { payer: payerKey, ip: ipKey },
          "settle rate-limited"
        );
        metrics?.recordRateLimited("settle");
        metrics?.recordSettle("rate_limited");
        return reply.code(429).send({ error: "rate_limited" });
      }

      // 1. Re-verify (defense in depth).
      const v = await runValidation(body, svc, Date.now());
      if (!v.ok) {
        // A validation reject was previously SILENT — a whole class of rejects
        // (counter_not_ready, merchant_not_registered, transfer_command_not_found,
        // amount/nonce/expiry, already_settled) returned to the client with zero
        // server signal. Log one line with the discriminated reason + payer +
        // method so merchant-misconfig and dead-zone rejects are visible; the
        // metric collapses them to validation_failed (the precise reason is in
        // the log).
        req.log.warn(
          {
            reason: v.reason,
            payer: v.payer,
            method: body.paymentPayload?.payload?.assetTransferMethod,
          },
          "settle validation failed"
        );
        return failed(v.reason);
      }

      // 1b. transfer-factory ("V3", 1-tx meta-transaction) path: the facilitator
      //     RELAYS the payer-signed TransferFactory_Transfer (ExecuteSubmission)
      //     and pays the GS traffic; with the merchant's TransferPreapproval it
      //     completes in ONE tx, funds direct to the merchant. Shape: master gate
      //     → idempotency → preapproval gate → execute → funds-moved gate →
      //     attribution. Signs nothing: the prepared tx + payer signature come
      //     from the relay stash.
      if (v.method === "transfer-factory") {
        // 0. MASTER ENABLE-GATE — OFF unless config.tfEnabled. Reject BEFORE any
        //    ledger work so a deploy with TF OFF is provably inert.
        if (!svc.tfEnabled) {
          req.log.warn(
            { payer: v.payer, merchant: v.merchant },
            "/settle: transfer-factory payload but the TF path is disabled (CANTON_X402_TF_ENABLED!=true) — rejecting fail-closed"
          );
          return failed("invalid_exact_canton_transfer_factory_disabled");
        }
        const tfSvc = svc.transferFactory;
        const tfStash = svc.tfStash;
        if (!tfSvc || !tfStash) {
          req.log.warn(
            { payer: v.payer },
            "/settle: transfer-factory payload but the TransferFactoryService/stash is not wired"
          );
          return failed("unexpected_canton_ledger_error");
        }
        const row = v.stash;
        const merchant = v.merchant;

        // 1. IDEMPOTENCY (legit retry): if this ref already settled, return the
        //    recorded success WITHOUT re-executing. The payer's funds moved
        //    exactly once (the ledger rejects a respend of the archived
        //    holdings); a lost settle response must never make the client re-pay.
        if (row.settledUpdateId) {
          req.log.info(
            { payer: v.payer, merchant, updateId: row.settledUpdateId },
            "/settle: transfer-factory ref already settled — returning the recorded success (idempotent)"
          );
          metrics?.recordSettle("ok");
          return {
            success: true,
            payer: v.payer,
            transaction: row.settledUpdateId,
            network: svc.network,
          };
        }

        // 2. PREAPPROVAL GATE (brief invariant I2). Without a live merchant
        //    TransferPreapproval the transfer would resolve to a two-step Pending
        //    and never settle in one round-trip — refuse BEFORE relaying (never a
        //    silent half-settled state). "unknown" (validator Scan flavor / a
        //    resolve error) fails closed on the money path: we cannot guarantee
        //    the 1-tx completion, so we do not relay.
        const kind = await tfSvc
          .preapprovalKind({
            merchant,
            admin: row.instrumentAdmin,
            id: row.instrumentId,
          })
          .catch(() => "unknown" as const);
        if (kind !== "yes") {
          req.log.warn(
            { payer: v.payer, merchant, preapprovalKind: kind },
            "/settle: transfer-factory refused — merchant has no live TransferPreapproval (or it could not be resolved); would resolve to a 2-step Pending"
          );
          return failed("invalid_exact_canton_preapproval_missing");
        }

        // 3. Parse the payer signing bundle the relay stashed at pay/commit.
        let bundle: {
          hashingSchemeVersion:
            | "HASHING_SCHEME_VERSION_V1"
            | "HASHING_SCHEME_VERSION_V2";
          partySignatures: {
            signatures: Array<{
              party: string;
              signatures: Array<Record<string, unknown>>;
            }>;
          };
        };
        try {
          bundle = JSON.parse(row.signature ?? "");
        } catch {
          req.log.warn(
            { payer: v.payer, ref: row.ref },
            "/settle: transfer-factory stash signature bundle is malformed"
          );
          return failed("invalid_exact_canton_submission_not_found");
        }

        // 4. RELAY (ExecuteSubmission) — the facilitator submits the payer's
        //    signed tx on its own participant and pays the GS traffic. A throw is
        //    a settle failure (client re-prepares fresh holdings, T5); a traffic
        //    error trips the breaker.
        let execRes: Awaited<ReturnType<typeof tfSvc.execute>>;
        try {
          execRes = await tfSvc.execute({
            payer: v.payer,
            preparedTransaction: row.preparedTx,
            hashingSchemeVersion: bundle.hashingSchemeVersion,
            partySignatures: bundle.partySignatures,
            submissionId: row.ref,
          });
        } catch (err) {
          req.log.warn(
            { err, payer: v.payer, merchant, ref: row.ref },
            "/settle: transfer-factory ExecuteSubmission failed (no funds moved — the tx rolled back; a respend of the pinned holdings would also fail, so the client re-signs with fresh holdings)"
          );
          if (isTrafficError(err)) breaker.recordTrafficFailure(Date.now());
          return failed("invalid_exact_canton_execute_failed");
        }

        // 5. FUNDS-MOVED GATE. A committed-but-zero-funds execute counts against
        //    the breaker exactly like the v1/direct paths.
        if (!execRes.transferred) {
          req.log.warn(
            { payer: v.payer, merchant, updateId: execRes.updateId },
            "/settle: transfer-factory committed but did not move funds — refusing success"
          );
          breaker.recordBurn(Date.now());
          metrics?.recordSendOutcome("committed_zero_funds_burn");
          return failed("invalid_exact_canton_execute_failed");
        }
        if (execRes.confirmInconclusive) {
          req.log.warn(
            { payer: v.payer, merchant, updateId: execRes.updateId },
            "/settle: transfer-factory funds-moved read was inconclusive; trusting the committed execute (preapproval gate already excluded the Pending case)"
          );
        }
        breaker.recordSuccess(Date.now());

        // 6. Record the settle updateId for idempotency (best-effort — funds
        //    already moved; a store failure must not fail the settle response).
        await tfStash
          .recordSettled(row.ref, execRes.updateId)
          .catch(() => undefined);

        // 7. Attribution — keyed by the ONE relay updateId. ONE GS-billed tx
        //    (no create-leg).
        if (svc.attribution) {
          const attrStore = svc.attribution;
          const updateId = execRes.updateId;
          try {
            await attrStore.record({
              updateId,
              payerParty: v.payer,
              merchantParty: merchant,
              amountAtomic: body.paymentRequirements.amount,
              network: svc.network,
            });
            await attrStore.markServed(updateId);
          } catch (err) {
            req.log.warn(
              { err, updateId },
              "attribution_record_failed (transfer-factory; fail-open, execute already committed)"
            );
          }
          const scanClients = svc.attributionScanClients ?? [];
          void (async () => {
            const summary = await getEventTrafficSummaryWithFallback(
              scanClients,
              updateId
            );
            if (summary !== null) {
              await attrStore.updateTrafficSummary(updateId, summary);
            }
          })().catch(() => {});
        }

        let tfLoggedAmount: string;
        try {
          tfLoggedAmount = wireAmountToLedgerDecimal(
            body.paymentRequirements.scheme,
            body.paymentRequirements.amount
          );
        } catch {
          tfLoggedAmount = body.paymentRequirements.amount;
        }
        req.log.info(
          {
            payer: v.payer,
            merchant,
            amount: tfLoggedAmount,
            updateId: execRes.updateId,
          },
          "/settle: transfer-factory relayed to the merchant (one transaction, sponsored gas, no escrow)"
        );
        metrics?.recordSettle("ok");
        return {
          success: true,
          payer: v.payer,
          transaction: execRes.updateId,
          network: svc.network,
        };
      }

      // Defensive: unreachable once every method is handled above.
      return failed("unexpected_canton_ledger_error");
        })();
      } finally {
        endTimer();
      }
    }
  );

  function failed(
    reason: ReturnType<typeof runValidation> extends Promise<infer T>
      ? T extends { ok: false; reason: infer R }
        ? R
        : never
      : never
  ): SettleResponse {
    // Single recorder for every `failed()` return so settle_total{result} is
    // attributed without sprinkling .inc() across the handler. The breaker /
    // rate-limit / malformed-body refusals return via reply.send() (not
    // failed()) and are counted at their own sites, so there is no double-count.
    metrics?.recordSettle(classifySettleFailure(reason));
    return { success: false, errorReason: reason, transaction: "" };
  }
}

/**
 * Map a failed-settle reason (CantonErrorCode) onto the coarse
 * settle_total{result} label. The precise reason is always in the log line; the
 * metric only needs the operationally-distinct buckets:
 *   - counter_not_ready  → first-payment (no TransferCommandCounter yet)
 *   - already_settled    → replay guard rejected a re-settle
 *   - ledger_error       → unexpected_canton_ledger_error (Send/scan failure)
 *   - validation_failed  → every other discriminated reject (amount/nonce/
 *                          expiry/merchant_not_registered/…)
 */
export function classifySettleFailure(reason: string): SettleResult {
  if (reason === "invalid_exact_canton_counter_not_ready") {
    return "counter_not_ready";
  }
  if (reason === "invalid_exact_canton_payment_already_settled") {
    return "already_settled";
  }
  if (reason === "unexpected_canton_ledger_error") {
    return "ledger_error";
  }
  return "validation_failed";
}
