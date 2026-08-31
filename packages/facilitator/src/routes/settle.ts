import type { FastifyInstance, FastifyReply } from "fastify";
import type { SettleResponse } from "@ftptech/x402-canton-core";
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
  provesNothingCommitted,
  isSubmissionAlreadyInFlight,
  type SlidingWindowConfig,
  type CircuitBreakerConfig,
} from "../rate-limit.js";
import { validateFacilitatorRequestShape } from "./validate-body.js";
import { createHash } from "node:crypto";

/**
 * Rate-limit bucket for ONE payment, whichever carriage brought it.
 *
 * The bucket must be per-payment: too coarse and honest merchants throttle each
 * other, too fine (or attacker-varied) and it bounds nothing. Returns `null`
 * when no payment identity can be derived, so the caller can fall back to the
 * IP bucket rather than pooling those requests under a shared constant.
 *
 * The inline key is derived from `preparedTxHash`, NOT from the transaction
 * text. Decoding here is out of the question — it runs before validation, so a
 * decompression bomb would land in the very code meant to bound abuse — but
 * hashing the base64 text was wrong for a subtler reason: gzip is not
 * canonical. Re-compressing the SAME transaction yields different bytes, so an
 * honest retry landed in a fresh bucket and the per-payment limit bounded
 * nothing it was meant to bound.
 *
 * `preparedTxHash` is client-supplied and unverified at this point, and that is
 * acceptable: an attacker who varies it only splits their OWN buckets while
 * still sitting inside the per-IP one, whereas an honest client retrying the
 * same payment now keys consistently.
 *
 * The hash is CANONICALISED before keying, and that is load-bearing. An earlier
 * version of this comment claimed "the decoder pins the field to canonical hex,
 * so one payment has exactly one spelling of it" — it does not. The decoder
 * accepts any even-length lower-case hex up to 128 chars, and the payer-proof
 * verifier deliberately treats the bare 64-char digest and the 68-char
 * `1220`-prefixed multihash as THE SAME hash. So one payment had two valid
 * spellings, each opening its own bucket with its own quota, and the per-payment
 * cap bounded half of what it claimed. `canonicalTxHashHex` is the verifier's
 * own rule, imported rather than re-implemented, so the two cannot drift apart
 * again.
 */
export function settlePaymentRateKey(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (typeof p["preparedTransaction"] === "string" && p["preparedTransaction"]) {
    const h = p["preparedTxHash"];
    if (typeof h === "string" && h.length > 0) {
      // Unparseable spellings still get a bucket — keyed on the raw string, so
      // junk cannot collapse into the honest payment's bucket and evict it.
      const canonical = canonicalTxHashHex(h) ?? h;
      return `tx:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
    }
    // A carriage with no hash at all cannot be keyed per payment; the caller
    // falls back to the IP bucket rather than pooling these under a constant.
    return null;
  }
  return null;
}
import { canonicalTxHashHex } from "../canton/payer-proof.js";
import { SubmissionOutcomeUnknownError } from "../canton/transfer-factory.js";
import type { TransferFactoryService } from "../canton/transfer-factory.js";
import {
  isInputContentionError,
  isInsufficientFundsError,
} from "../canton/ledger-errors.js";
import type { InlineSettleStore } from "../db/inline-settle-store.js";
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
   *  it is absent. services.ts wires it when tfEnabled. */
  transferFactory?:
    | (Pick<TransferFactoryService, "preapprovalKind" | "execute"> &
        Partial<Pick<TransferFactoryService, "resolveDispatched" | "ledgerEnd">>)
    | undefined;
  /**
   * Rollout stage for the unknown-outcome guard (config.settleDispatchMarkMode).
   *
   *   off      nothing written, nothing read — byte-identical to the build
   *            that ran before this guard existed. THE DEFAULT.
   *   observe  the mark is written, and meeting an unresolved one is counted
   *            and logged — then the request proceeds exactly as it does today.
   *            No resolve call, so no added ledger read and no added latency:
   *            this mode answers "how often does this actually happen", which
   *            nobody currently knows, and answers nothing else.
   *   enforce  an unresolved mark is resolved, and stays 503 if it cannot be.
   */
  settleDispatchMark?: "off" | "observe" | "enforce" | undefined;
  /** transfer-factory master switch (config.tfEnabled). When false/absent a
   *  transfer-factory /settle is rejected fail-closed with
   *  invalid_exact_canton_transfer_factory_disabled BEFORE any ledger work
   *  (provably inert when off). SEPARATE from the optional deps. */
  tfEnabled?: boolean;
  /** INLINE settle idempotency (db/inline-settle-store.ts). Keyed on the
   *  recomputed transaction hash. OPTIONAL: absent → a retry re-relays, which
   *  the ledger still refuses, so the cost is traffic rather than money. */
  inlineSettles?:
    | Pick<
        InlineSettleStore,
        "getRecord" | "recordDispatched" | "recordSettled" | "clearDispatched"
      >
    | undefined;
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
  /** Rollout stage for the unknown-outcome guard; see SettleRouteServices. */
  const markMode = svc.settleDispatchMark ?? "off";
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

      // Rate-limit per payment AND per client IP, plus globally (after shape, so
      // malformed bodies do not consume quota). The wire `payer` claim is gone,
      // so this bucket keys on the payment identity derived from the inline
      // payload (the canonicalised preparedTxHash): it bounds a caller HAMMERING
      // a single payment. Per-payer VOLUME is charged by its own bucket further
      // down, where the decoded and signature-checked payer is a fact rather than
      // a claim (search "PER-PAYER VOLUME").
      //
      // CRITICAL: the /settle caller is the MERCHANT (the merchant calls
      // /settle, not the payer), so one IP aggregates every agent paying through
      // that merchant. The IP key therefore gets its OWN, higher cap
      // (settleRateMaxPerIp) rather than the low per-key cap — otherwise N
      // agents behind one merchant share a single bucket, the 11th settle/min
      // 429s, and the merchant surfaces that to the agent as a 502 (the observed
      // "3+ agents → 502"). The global cap is enforced once regardless of key
      // count (allowKeys does not double-spend it). The IP key is unchanged.
      const refKey = settlePaymentRateKey(body.paymentPayload?.payload);
      const ipKey = `ip:${clientIp(req)}`;
      const ipCap = svc.settleRateLimit?.maxPerIp ?? 0;
      // A payload we cannot key falls back to the IP bucket ALONE rather than
      // to a shared constant, so an unkeyable request cannot pool with others
      // into one bucket and 429 unrelated merchants — a denial of service handed
      // to the caller for free.
      // ADMISSION ONLY — the global budget is deliberately NOT charged here.
      // Anything that arrives pays the per-payment and per-IP caps, which is
      // what they are for. The global cap is the budget for submissions that
      // burn Global Synchronizer traffic, and it is charged just before the
      // submit that spends it (search chargeGlobal below). Spending it on
      // arrival meant well-formed nonsense — bodies that pass shape validation
      // and are then refused by the real checks — drained the same budget as
      // real payments, so two IPs could deny settlement to every merchant.
      if (
        !limiter.allowKeys(
          refKey ? [refKey, { key: ipKey, max: ipCap }] : [{ key: ipKey, max: ipCap }],
          nowMs,
          false
        )
      ) {
        req.log.warn(
          { ref: refKey ?? "unkeyed", ip: ipKey },
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
      //     attribution. Signs nothing: the prepared tx + payer signature arrive
      //     inline in the payment payload.
      if (v.method === "transfer-factory-inline") {
        // INLINE relay. Everything the scheme requires was already proven in
        // validation — amount, receiver, instrument, proven payer, preapproval,
        // memo, inputs, and the payer's signature over these exact bytes. What
        // is left is to submit them.
        if (!svc.tfEnabled) {
          return failed("invalid_exact_canton_transfer_factory_disabled");
        }
        const tfSvc = svc.transferFactory;
        if (!tfSvc) {
          req.log.warn(
            { payer: v.payer },
            "/settle: inline payload but the TransferFactoryService is not wired"
          );
          return failed("unexpected_canton_ledger_error");
        }

        // IDEMPOTENCY. The ledger already makes a replay harmless — the signed
        // transfer names specific input holdings, so a second submission finds
        // them archived and is rejected. But we only learn that BY SUBMITTING,
        // and every submission burns Global-Synchronizer traffic. So a retry of
        // a settle we already completed returns the recorded answer instead of
        // paying to be told "already spent".
        //
        // Keyed on the RECOMPUTED hash the verifier proved against the bytes,
        // never on the client's claimed hash: the claim is accepted in two
        // spellings, so a caller could re-spell it into a fresh bucket and make
        // us relay the same transaction twice.
        const idemKey = v.preparedTxHashHex;
        if (idemKey && svc.inlineSettles) {
          const record =
            markMode === "off"
              ? await svc.inlineSettles.getRecord(idemKey).then((r) =>
                  // With the mark off, a dispatched row from a previous
                  // enforce/observe run must read as "never seen", or turning
                  // the flag back off would not actually restore the old
                  // behaviour. Settled records still answer, as they always did.
                  r?.state === "settled" ? r : null
                )
              : await svc.inlineSettles.getRecord(idemKey);
          if (record?.state === "settled") {
            req.log.info(
              { payer: v.payer, merchant: v.merchant, updateId: record.updateId },
              "/settle: inline retry answered from the idempotency record (no relay, no traffic burned)"
            );
            metrics?.recordSettle("ok");
            return {
              success: true,
              payer: v.payer,
              transaction: record.updateId,
              network: svc.network,
            };
          }
          if (record?.state === "dispatched" && markMode === "observe") {
            // Measurement only. Counted and named, then straight on to the
            // normal path — the caller sees exactly what it sees today.
            metrics?.recordSettle("outcome_unknown_observed");
            req.log.warn(
              { payer: v.payer, merchant: v.merchant, idemKey },
              "/settle: [observe] this transaction was already dispatched with no recorded " +
                "outcome — enforce would answer 503 here; proceeding as today"
            );
          } else if (record?.state === "dispatched") {
            // GO AND LOOK BEFORE SAYING "I DO NOT KNOW".
            //
            // The mark carries the submissionId and the ledger offset from just
            // before the submit, so the completion for it is a READ away — no
            // second submission, no traffic. Resolving turns the honest-but-
            // useless 503 into the real answer, which is what the payer and the
            // merchant actually need.
            // `resolveDispatched` is optional on the service on purpose: an
            // older wiring, or a test double, may not have it. Missing it means
            // we cannot resolve — which is "unknown", not a crash. Without this
            // the enforce path threw a TypeError and the caller got a 500,
            // turning a careful "I do not know" into an opaque server error.
            const resolved =
              typeof tfSvc.resolveDispatched === "function" &&
              record.submissionId !== undefined &&
              record.beginExclusive !== undefined
                ? await tfSvc.resolveDispatched({
                    payer: v.payer,
                    submissionId: record.submissionId,
                    beginExclusive: record.beginExclusive,
                    instrumentAdmin: v.instrumentAdmin,
                  })
                : { state: "unknown" as const };
            if (resolved.state === "settled" && resolved.transferred) {
              req.log.info(
                { payer: v.payer, merchant: v.merchant, updateId: resolved.updateId },
                "/settle: resolved a previously unknown inline outcome — it had settled; recording and answering success"
              );
              if (idemKey && svc.inlineSettles) {
                await svc.inlineSettles.recordSettled(idemKey, resolved.updateId);
              }
              metrics?.recordSettle("ok");
              return {
                success: true,
                payer: v.payer,
                transaction: resolved.updateId,
                network: svc.network,
              };
            }
            if (resolved.state === "rejected") {
              // The participant refused it: nothing moved, and the payer is
              // free to try again. Clear the mark so they can.
              req.log.info(
                { payer: v.payer, merchant: v.merchant, reason: resolved.message },
                "/settle: resolved a previously unknown inline outcome — the participant had rejected it; nothing moved"
              );
              if (idemKey && svc.inlineSettles) {
                await svc.inlineSettles.clearDispatched(idemKey);
              }
              return failed("invalid_exact_canton_execute_failed");
            }
            // WE ALREADY HANDED THIS TO THE PARTICIPANT AND NEVER SAW THE
            // ANSWER. Relaying again is the one thing we must not do: the
            // submission names input holdings that may already be archived, so
            // the second attempt comes back as `input_contention` — which this
            // route reports as "nothing moved, retryable", and the caller acts
            // on that by minting a FRESH transfer. One purchase, two payments,
            // the second recorded nowhere.
            //
            // The truth is that we do not know, and 503 is how this route says
            // that (see `inconclusive`): the shipped middlewares refuse to turn
            // a non-2xx settle into a 402, so the caller retries the SAME
            // envelope instead of paying again.
            req.log.error(
              { payer: v.payer, merchant: v.merchant, idemKey },
              "/settle: this transaction was already dispatched and its outcome was never " +
                "recorded — refusing to relay it a second time; answering 503 (may be settled on-ledger)"
            );
            return inconclusive(reply);
          }
        }

        // `signedBy` is the payer's own NAMESPACE fingerprint, and deliberately
        // not the identifier the key lookup reports.
        //
        // Canton names a key by its Fingerprint: hex, computed over the
        // serialized SigningPublicKey proto. A JWKS `kid` is something else
        // entirely — an RFC 7638 JWK thumbprint, base64url over sorted JWK
        // JSON — built for JWT key selection, with no mapping back to a
        // Fingerprint. Feeding a thumbprint here yields a syntactically valid
        // identifier that names no key the participant knows, so the relayed
        // signature is rejected at execute and reads like a signature failure.
        //
        // An external party lives in the namespace of its signing key, so for
        // the single-key case this IS that key's fingerprint. For a party that
        // published a second key and signed with it, we cannot name the right
        // key from any source available today; the submission then fails at the
        // participant, which is the correct fail-closed outcome rather than a
        // confident wrong answer.
        const signedBy = v.payer.split("::")[1] ?? "";
        // A party that published more than one protocol signing key may have
        // signed with one we cannot name, and the participant will then reject
        // a perfectly good signature. That rejection is indistinguishable from
        // a forged one in the logs, so say it here, once, while we still know.
        if ((v.publishedProtocolKeys ?? 1) > 1) {
          req.log.warn(
            { payer: v.payer, keys: v.publishedProtocolKeys },
            "/settle: payer publishes multiple protocol signing keys; signedBy can only name the namespace key — a rejection here is a key-selection mismatch, not a bad signature"
          );
        }

        // PER-PAYER VOLUME, charged here because here is the first place the
        // payer is a fact rather than a claim.
        //
        // An inline payment is not bounded by any prepare-time cap: the payer
        // prepares the transaction and hands us the finished bytes, so nothing
        // was counted upstream. The residual gates are per-PAYMENT (which a
        // payer varies for free — every new payment is a new bucket) and per-IP
        // (which is the MERCHANT's IP, deliberately capped high enough to front
        // many agents). One payer could therefore drive our traffic spend without
        // limit through an honest busy merchant.
        //
        // Placed after the idempotency check on purpose: a retry answered from
        // the record burns no traffic, so it must not burn the payer's budget
        // either. And placed here rather than at admission because only the
        // decoded, signature-checked `act_as` is unforgeable — the wire has no
        // payer field to key on, which is exactly why this cap could not live
        // up there.
        const payerCap = svc.settleRateLimit?.maxPerPayer ?? 0;
        if (
          payerCap > 0 &&
          !limiter.allowKeys(
            [{ key: `payer:${v.payer}`, max: payerCap }],
            Date.now(),
            false
          )
        ) {
          req.log.warn(
            { payer: v.payer, merchant: v.merchant },
            "settle refused: inline per-payer volume cap"
          );
          metrics?.recordRateLimited("settle");
          metrics?.recordSettle("rate_limited");
          return reply.code(429).send({ error: "rate_limited" });
        }

        // CHARGE THE GLOBAL BUDGET, here and not at admission: this is the
        // line past which we spend Global Synchronizer traffic, so this is
        // where the budget for spending it belongs.
        if (!limiter.allowKeys([], Date.now())) {
          req.log.warn({ payer: v.payer }, "settle refused: global traffic budget exhausted");
          metrics?.recordRateLimited("settle");
          metrics?.recordSettle("rate_limited");
          return reply.code(429).send({ error: "rate_limited" });
        }
        // WRITE THE INTENT BEFORE THE SUBMISSION LEAVES.
        //
        // Everything past this line can commit on the ledger whether or not we
        // observe it: /execute is asynchronous, and the completion poll gives
        // up after ~12s, which under load is shorter than sequencing. The row
        // written here is what lets the NEXT request know that a submission for
        // these bytes is already out there, instead of concluding "never seen"
        // and relaying again.
        //
        // Fail-open by design (see the store): if the write fails we proceed
        // unguarded rather than refuse an honest payment over a database blip.
        const inlineSubmissionId = `x402-inline-${refKey ?? "unkeyed"}`;
        // Captured BEFORE the mark is written, so the row can never point at a
        // window that starts after the submission it describes.
        //
        // Skipped entirely when the guard is off. The offset exists only to
        // resolve a mark, and off writes no mark — so reading it would add a
        // ledger round-trip to the money path that the build in production
        // does not make. `off` has to mean identical latency too, not just an
        // identical response body.
        let inlineBegin: number | undefined;
        if (markMode !== "off") {
          try {
            inlineBegin =
              typeof tfSvc.ledgerEnd === "function" ? await tfSvc.ledgerEnd() : undefined;
          } catch {
            // Not fatal: without it the mark still blocks a second relay, it
            // just cannot be resolved automatically. Refusing the payment
            // because a read failed would be the worse trade.
            inlineBegin = undefined;
          }
        }
        if (idemKey && svc.inlineSettles && markMode !== "off") {
          await svc.inlineSettles.recordDispatched(idemKey, {
            submissionId: inlineSubmissionId,
            ...(inlineBegin !== undefined ? { beginExclusive: inlineBegin } : {}),
          });
        }
        let ex;
        try {
          ex = await tfSvc.execute({
            payer: v.payer,
            preparedTransaction: v.preparedTransaction,
            hashingSchemeVersion: v.hashingSchemeVersion,
            partySignatures: {
              signatures: [
                {
                  party: v.payer,
                  signatures: [
                    {
                      format: "SIGNATURE_FORMAT_CONCAT",
                      signature: v.signatureB64,
                      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
                      signedBy,
                    },
                  ],
                },
              ],
            },
            submissionId: inlineSubmissionId,
            ...(inlineBegin !== undefined ? { beginExclusive: inlineBegin } : {}),
            instrumentAdmin: v.instrumentAdmin,
          });
        } catch (e) {
          // The participant is already executing this exact submission, because
          // an identical /settle is in flight beside us. That is Canton's own
          // dedup working — the reason a duplicate settle cannot double-spend —
          // and reporting it as a failure would be the one answer guaranteed to
          // cause harm: a caller told "your payment failed" while it succeeds
          // may pay again. So wait for the sibling to record its result and
          // answer with it, exactly as a sequential retry would be answered.
          if (isSubmissionAlreadyInFlight(e) && idemKey && svc.inlineSettles) {
            for (let i = 0; i < 12; i++) {
              await new Promise((r) => setTimeout(r, 500));
              const sib = await svc.inlineSettles.getRecord(idemKey);
              const settled = sib?.state === "settled" ? sib.updateId : null;
              if (settled) {
                req.log.info(
                  { payer: v.payer, merchant: v.merchant, updateId: settled },
                  "/settle: concurrent duplicate answered from the sibling's record (participant deduped; no second submit)"
                );
                metrics?.recordSettle("ok");
                return {
                  success: true,
                  payer: v.payer,
                  transaction: settled,
                  network: svc.network,
                };
              }
            }
            // The sibling has not finished within the window. Report something
            // the caller should RETRY rather than something that reads as
            // "this payment is void" — the submission is still in flight and
            // paying again would be the wrong response.
            req.log.warn(
              { payer: v.payer, merchant: v.merchant },
              "/settle: concurrent duplicate still in flight after waiting; outcome UNKNOWN, answering 503"
            );
            return inconclusive(reply);
          }
          // ONLY "the participant never answered" is unknown. An HTTP_ERROR
          // means it DID answer and the body says what it decided — a traffic
          // ABORTED there is a definite rejection and must keep its existing
          // classification. The dangerous case is the client-side abort: a 45s
          // timeout on a submit the participant may already have sequenced.
          // (The message-level /ABORTED/i in isTrafficError collides with the
          // abort text, which is why the code, not the message, decides here.)
          // GATE THE INTERCEPTION, NOT ITS ANSWER.
          //
          // An earlier cut gated only what `inconclusive()` RETURNED, which
          // looked equivalent and was not. The pre-guard answer is not one
          // string. THIS arm answered
          //   failed(transient ? unexpected_canton_ledger_error
          //                    : invalid_exact_canton_execute_failed)
          // while the legacy arm answered the second unconditionally, so a
          // single return cannot reproduce both — and the one it did return is
          // the more dangerous of the pair. `invalid_exact_canton_execute_failed`
          // is the only reason in the shipped client's STOP_ON_FIRST, which
          // never re-pays; `unexpected_canton_ledger_error` sits in
          // STOP_IF_REPEATED, which permits exactly one re-pay. Substituting the
          // second where production returns the first opens a double payment in
          // a case where production is safe today — under the OFF stage, the one
          // that promised to change nothing.
          //
          // So off and observe do not answer from here at all: they fall through
          // to the classification below, which IS the pre-guard code. Identical
          // by construction rather than by my reading of it.
          if (markMode !== "off" && answerNeverArrived(e)) {
            if (markMode === "observe") {
              // Counted and named, then straight on. The breaker is NOT fed
              // here — the fall-through feeds it, and feeding it twice would
              // make one failure look like two to the traffic guard.
              metrics?.recordSettle("outcome_unknown_observed");
              req.log.warn(
                { payer: v.payer, merchant: v.merchant, err: e },
                "/settle: [observe] inline submit threw without proving nothing committed — " +
                  "enforce would answer 503 here; proceeding as today"
              );
            } else {
              if (isTrafficError(e)) breaker.recordTrafficFailure(Date.now());
              req.log.error(
                { payer: v.payer, merchant: v.merchant, err: e },
                "/settle: inline submit threw without proving nothing committed; outcome UNKNOWN, answering 503"
              );
              return inconclusive(reply);
            }
          }
          const transient = isTrafficError(e);
          // Feed the breaker. Without this the traffic-exhaustion protection
          // built for the legacy path could never open on the ONLY new money
          // path — it would watch an endpoint nobody uses.
          if (transient) breaker.recordTrafficFailure(Date.now());
          req.log.error(
            { payer: v.payer, merchant: v.merchant, err: e },
            "/settle: inline relay failed"
          );
          // No recordSettle here: `failed()` is the single recorder, and it
          // derives the same label from the reason. Counting in both places
          // made one request increment x402_facilitator_settle_total twice,
          // so every inline failure read as two — the legacy arm below never
          // does this, and a metric that disagrees with the legacy arm is
          // worse than no metric.
          // Rejections we can prove moved nothing: the client may safely re-pay
          // over fresh holdings. Literally the same rule the legacy arm applies
          // — see definiteExecuteFailureCode, which exists because this arm once
          // carried only half of it.
          const definite = transient ? null : definiteExecuteFailureCode(e);
          if (definite) {
            // KNOWN outcome, and negative: the participant refused this and
            // proved nothing committed. Drop the dispatch mark so an honest
            // re-pay is not met with a permanent 503 — the mark must mean
            // "we cannot tell", never "we once tried".
            if (idemKey && svc.inlineSettles) {
              await svc.inlineSettles.clearDispatched(idemKey);
            }
            if (definite === "invalid_exact_canton_input_contention") {
              req.log.info(
                { payer: v.payer, merchant: v.merchant },
                "/settle: input holdings were consumed by another submission — nothing moved, retryable"
              );
            }
            return failed(definite);
          }
          return failed(
            transient
              ? "unexpected_canton_ledger_error"
              : "invalid_exact_canton_execute_failed"
          );
        }

        if (!ex.transferred) {
          // A committed submit that moved no funds is a BURN: we paid traffic
          // for nothing, which is exactly what the breaker counts.
          breaker.recordBurn(Date.now());
          // KNOWN outcome: it committed and moved nothing, and re-running it
          // never will. Drop the dispatch mark so this hash is not answered 503
          // forever — the mark is for "we cannot tell", not for "it failed".
          if (idemKey && svc.inlineSettles) {
            await svc.inlineSettles.clearDispatched(idemKey);
          }
          // The submit committed but the funds did not provably move. Reported
          // as a failed settle rather than a success with an updateId: a
          // merchant must never release a resource on this.
          req.log.error(
            { payer: v.payer, merchant: v.merchant, updateId: ex.updateId },
            "/settle: inline relay committed but funds did not provably move"
          );
          // Same burn outcome the legacy arm records, under the same label, so
          // the two carriages are comparable on one dashboard. `failed()` still
          // owns the settle_total counter.
          metrics?.recordSendOutcome("committed_zero_funds_burn");
          return failed("invalid_exact_canton_execute_failed");
        }

        // MEASURE THE HEURISTIC THE GATE USED TO RELY ON.
        //
        // For a registry token the funds-moved verdict now comes from the token
        // standard's own result tag; the old signal inferred it from the ABSENCE
        // of a created event matched by TEMPLATE NAME. Nobody could say how
        // often that guess was wrong, because nothing compared it with an
        // answer. These two lines are that comparison, on live traffic.
        //
        // A stream of `disagreed` means the name-based signal was
        // mis-classifying real settlements and the tag is now catching them. A
        // stream of `unreadable` means the opposite problem: the positive proof
        // is not reaching us at all and the verdict is still the old guess.
        // Silence means the heuristic happened to be right. All three are
        // worth knowing, and none of them was observable before.
        if (ex.registrySignalDisagreement) {
          req.log.warn(
            {
              payer: v.payer,
              merchant: v.merchant,
              updateId: ex.updateId,
              tagSaid: ex.registrySignalDisagreement.tagSaid,
              nameSaid: ex.registrySignalDisagreement.nameSaid,
            },
            "/settle: registry funds-moved signals DISAGREED — the standard's result tag decided; the old template-name signal would have said otherwise"
          );
        }
        if (ex.registryTagUnreadable) {
          req.log.warn(
            { payer: v.payer, merchant: v.merchant, updateId: ex.updateId },
            "/settle: registry transfer result tag was unreadable — fell back to the template-name signal, so this verdict carries no positive proof"
          );
        }
        req.log.info(
          {
            payer: v.payer,
            merchant: v.merchant,
            updateId: ex.updateId,
            confirmInconclusive: ex.confirmInconclusive,
          },
          "/settle: inline transfer relayed"
        );
        // Success is recorded only AFTER the funds-moved gate, so a commit that
        // moved nothing can never look like a healthy settle to the breaker.
        breaker.recordSuccess(Date.now());

        // Record for idempotency. Best-effort by construction: the funds have
        // already moved, so a store failure must never turn a completed payment
        // into an error response.
        if (idemKey && svc.inlineSettles) {
          await svc.inlineSettles
            .recordSettled(idemKey, ex.updateId)
            .catch(() => undefined);
        }

        // Attribution — same shape and same fail-open semantics as the legacy
        // arm. Without this the inline path burns traffic that no report can
        // account for, and the repair worker has nothing to reconcile.
        if (svc.attribution) {
          const attrStore = svc.attribution;
          const updateId = ex.updateId;
          try {
            await attrStore.record({
              updateId,
              payerParty: v.payer,
              merchantParty: v.merchant,
              amountAtomic: body.paymentRequirements.amount,
              network: svc.network,
            });
          } catch (err) {
            req.log.warn(
              { err, updateId },
              "attribution_record_failed (inline; fail-open, execute already committed)"
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

        metrics?.recordSettle("ok");
        return {
          success: true,
          payer: v.payer,
          transaction: ex.updateId,
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

  /**
   * Did the participant fail to ANSWER at all? Only then is the outcome of a
   * submit genuinely unknown. `TIMEOUT` (our own 45s abort) and
   * `TRANSPORT_ERROR` (socket died) mean the request may have been sequenced
   * and only the reply was lost. Any HTTP status — including 5xx — means it
   * answered, and the existing classification of that answer stands.
   */
  function answerNeverArrived(err: unknown): boolean {
    // The submit is TWO ledger calls, not one. This predicate only ever knew
    // about the first: TIMEOUT / TRANSPORT_ERROR are what the request() wrapper
    // raises when the participant never answered the /execute POST.
    //
    // The second call is the completion poll that runs whenever /execute
    // answers without an updateId — which is its documented normal behaviour.
    // Its give-up error carries a code this predicate did not know, so an
    // accepted-and-possibly-committing submission was reported to the merchant
    // as a definite payment rejection. TransferFactoryService now names that
    // state, and it belongs here.
    if (err instanceof SubmissionOutcomeUnknownError) return true;
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "TIMEOUT" || code === "TRANSPORT_ERROR") return true;

    // An HTTP_ERROR used to end the question: "it DID answer and the body says
    // what it decided". True of the PARTICIPANT — but the participant is not
    // the only thing that can produce one. A 502/504 from the socat/nginx
    // bridge in front of it is the proxy saying it has no answer, and we were
    // reading that as the participant's refusal and telling the merchant the
    // payment was rejected.
    //
    // So the question is not the status class, it is whether a VERDICT came
    // back. Two shapes prove one did:
    //   - a definite 4xx (provesNothingCommitted, the same helper the faucet
    //     money path uses): the participant processed the request and refused;
    //   - a sequencer/traffic ABORTED body. Measured in this repo's own
    //     fixtures, that verdict arrives as HTTP 500/503 — so a status-only
    //     rule would have flipped every honest traffic rejection into an
    //     unknown outcome, which is why the body has to decide here.
    // Anything else with no verdict in it is exactly what it looks like: no
    // answer.
    if (code !== "HTTP_ERROR") return false;
    if (provesNothingCommitted(err)) return false;
    return !isTrafficError(err);
  }

  /**
   * The outcome is UNKNOWN — we cannot say the payment failed, and saying so is
   * the one answer that costs the payer money.
   *
   * `failed()` returns {success:false}, which the shipped middlewares turn into
   * HTTP 402 (express/src/index.ts, next/src/index.ts). The paying client reads
   * that as "rejected" and re-pays: fetch.ts STOP_ON_FIRST does not contain
   * `unexpected_canton_ledger_error`, and STOP_IF_REPEATED only bites on the
   * SECOND consecutive occurrence — so the first one falls through to a fresh
   * createPaymentPayload. That re-pay is a NEW signed transfer with a new
   * commandId over the payer's remaining holdings, so neither Canton's changeId
   * dedup nor our hash-keyed idempotency catches it. The payer pays twice for
   * one purchase and the second payment exists in no record.
   *
   * So an unknown outcome must not travel as an x402 rejection at all. Answer
   * 503 instead: the middlewares below refuse to turn a non-2xx settle into a
   * 402, so the caller gets a transport error it can retry with the SAME
   * envelope, never a signal to mint a new payment.
   */
  function inconclusive(
    reply: FastifyReply
  ): { error: string } | SettleResponse {
    // WHAT THIS HELPER MAY AND MAY NOT SPEAK FOR.
    //
    // Reachable from four places, and they do NOT share a pre-guard answer:
    //   * the two sibling-wait timeouts (inline and legacy). Production
    //     answered failed("unexpected_canton_ledger_error") at both — verified
    //     against the deployed source — so returning that under off/observe is
    //     the pre-guard answer verbatim, which is why this helper is allowed to
    //     answer for them.
    //   * the two unresolved-mark refusals. Marks are neither written nor read
    //     under off, so those are enforce-only and have no pre-guard answer to
    //     preserve.
    //
    // The two execute-throw sites do NOT call this under off or observe. They
    // fall through to their own classification instead, because THEIR pre-guard
    // answers differ from this one and from each other. An earlier cut routed
    // them here and silently moved an error class from the client regime that
    // never re-pays into the one that permits a re-pay. See the comment at
    // those sites.
    if (markMode === "off") {
      return failed("unexpected_canton_ledger_error");
    }
    if (markMode === "observe") {
      // Counted, then answered exactly as `off` answers it.
      metrics?.recordSettle("outcome_unknown_observed");
      return failed("unexpected_canton_ledger_error");
    }
    metrics?.recordSettle("outcome_unknown");
    void reply.code(503).header("Retry-After", "3");
    return { error: "settle_outcome_unknown" };
  }

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
 * The named code for an execute rejection we can prove moved nothing, or null
 * when the failure is not one we can name.
 *
 * ONE copy on purpose. Both carriages relay through the same `tfSvc.execute`
 * and therefore see the same error shapes, but the rule used to live twice —
 * and the two copies disagreed. The legacy arm named both cases; the inline arm
 * carried only the contention half, under a comment claiming it made "the same
 * distinction the legacy arm makes". So an `ITR_InsufficientFunds` on the
 * inline carriage — the live MainNet money path — fell through to
 * `invalid_exact_canton_execute_failed`, the one reason the client treats as
 * ambiguous and refuses to retry (fetch.ts STOP_ON_FIRST). Nothing had moved,
 * provably, and the payer was told the payment might already have settled.
 *
 * Both arms now ask this function, so a third carriage cannot inherit half the
 * rule. Order matters: insufficient-funds is checked first because a rejection
 * naming both is about the amount, not about a contended input.
 */
type DefiniteExecuteFailure =
  | "invalid_exact_canton_insufficient_balance"
  | "invalid_exact_canton_input_contention";

function definiteExecuteFailureCode(err: unknown): DefiniteExecuteFailure | null {
  if (isInsufficientFundsError(err)) {
    return "invalid_exact_canton_insufficient_balance";
  }
  if (isInputContentionError(err)) return "invalid_exact_canton_input_contention";
  return null;
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
