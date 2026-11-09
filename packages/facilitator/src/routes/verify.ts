import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { VerifyResponse } from "@ftptech/x402-canton-core";
import { runValidation, clientIp, type ValidationServices } from "./common.js";
import { validateFacilitatorRequestShape } from "./validate-body.js";
import { budgetPayer, decodeInlineClaim, isInlineCarriage, type InlineClaim } from "./inline-transfer.js";
import { settlePaymentRateKey } from "./settle.js";
import {
  createSlidingWindowLimiter,
  type SlidingWindowConfig,
} from "../rate-limit.js";
import type { FacilitatorMetrics } from "../metrics.js";
import { ScanBudgetRefusedError } from "../scan-budget.js";

export interface VerifyRouteServices extends ValidationServices {
  /** /verify budget per caller IP for VALID outcomes: `maxPerPayer` is that
   *  per-IP cap (config.verifyRateMaxPerIp), `windowMs` the window of every
   *  /verify budget. `maxGlobal` stays 0: a global /verify cap would let one IP
   *  starve verification for all. A SEPARATE limiter from /settle, so /verify
   *  never draws down the settle traffic budget. Absent → every /verify budget
   *  is off (tests, deploys that opt out). */
  verifyRateLimit?: SlidingWindowConfig;
  /** Budgets for INVALID outcomes (see the route). `maxPerIp`: per caller IP;
   *  past it the caller sheds, admitting only payers that validated through it
   *  before. `maxPerPayer`: per (caller IP, claimed payer); past it that pair is
   *  refused up front. `<= 0` disables each. Absent → both off. */
  verifyWaste?: { maxPerIp: number; maxPerPayer: number } | undefined;
  /** More budgets for VALID outcomes, so a payment that validates once cannot be
   *  replayed into the caller's whole valid cap. `maxPerPayer`: per (caller IP,
   *  proven payer). `maxPerPayment`: per (caller IP, payment), the payment keyed
   *  by its transaction hash (the canonical claim, which Rule 3 proves equal to
   *  the recomputed hash for every valid outcome). `<= 0` disables each.
   *  Absent → both off. */
  verifyValid?: { maxPerPayer: number; maxPerPayment: number } | undefined;
  /** Prometheus metrics. OPTIONAL: absent → no-op. Present → a 429 rate-limit
   *  rejection bumps ratelimit_rejected_total{scope=verify}. */
  metrics?: FacilitatorMetrics | undefined;
}

/** How long a payer that validated through a caller counts as one of its
 *  returning payers, and how many such (caller, payer) pairs are kept. */
const KNOWN_PAYER_TTL_MS = 86_400_000;
const KNOWN_PAYERS_MAX = 10_000;

/**
 * /verify is charged by OUTCOME, and junk cannot spend an honest payer's share.
 *
 * The bucket used to be one per caller IP, charged on arrival, before the body
 * was even shape-checked. The caller of /verify is the MERCHANT, and its
 * middleware forwards whatever PAYMENT-SIGNATURE a client sends after checking
 * only the `accepted` block, which anyone copies from the public 402. So about
 * two junk requests a second through a merchant kept its 120/min bucket full,
 * and every honest payer of that merchant got a 429, which the middleware
 * turns into a 502: its sales stopped (the 2026-11-07 audit's demo: 125 junk
 * verifies through one merchant, then its next honest payer refused).
 *
 * Before validation junk and payment look the same; after it they do not. So:
 *
 *   - The shape check runs FIRST and charges nothing. Garbage costs a parse
 *     and never touches a budget.
 *   - VALID outcomes are charged to the caller's own cap (`verifyRateLimit`).
 *     Only a payload that passes every rule, signature included, can fill it.
 *   - INVALID outcomes are charged twice: to the caller's waste share, and to
 *     (caller, claimed payer). The claimed payer is read from the bytes up
 *     front, bounded by the codec, so a first-time payer that keeps failing
 *     through one merchant (a stuck client, or junk quoting one party) is
 *     refused before the work and nobody else is. Not a returning payer: its
 *     public party id can be quoted by anyone, so that cap would let a few
 *     forged requests refuse it. A stuck returning payer is held only by the
 *     caller's waste share, and past it makes the caller shed (below).
 *   - VALID outcomes are also capped per (caller, proven payer) and per
 *     payment, so one payment that validated cannot be replayed into the
 *     caller's whole valid cap.
 *   - A caller past its waste share SHEDS: junk can mint a fresh claimed payer
 *     per request, so the pair cap alone bounds nothing for it. While shedding,
 *     only payers that have validated through this caller before are let in,
 *     and only up to its valid cap per window. Returning payers keep paying; a
 *     first-time payer waits for the window to drain.
 *
 * What is left, stated, at the defaults (120 valid, 120 waste per caller): a
 * first-time payer is refused once junk through its merchant passes 120 a
 * minute, the price that refused everyone before; returning payers once junk
 * also uses up the shed admissions by quoting their parties, 240 a minute; a
 * replayed VALID payment fills the valid cap, but needs a real signature to
 * exist. No class of payer is cheaper to refuse than all of them were.
 */
export async function registerVerifyRoute(
  app: FastifyInstance,
  svc: VerifyRouteServices
): Promise<void> {
  // SEPARATE instance from /settle's limiter (distinct Map + window): the
  // public /verify amplification surface is throttled independently of the
  // funded settle budget. Every key carries its own cap (allowKeys/peek), so
  // the limiter's own per-key default is never used.
  const limiter = createSlidingWindowLimiter(
    svc.verifyRateLimit ? { maxPerPayer: 0, maxGlobal: 0, windowMs: svc.verifyRateLimit.windowMs } : undefined
  );
  const on = svc.verifyRateLimit !== undefined;
  const validCap = on ? svc.verifyRateLimit!.maxPerPayer : 0;
  const wasteIpCap = on ? (svc.verifyWaste?.maxPerIp ?? 0) : 0;
  const wastePayerCap = on ? (svc.verifyWaste?.maxPerPayer ?? 0) : 0;
  const validPayerCap = on ? (svc.verifyValid?.maxPerPayer ?? 0) : 0;
  const validPaymentCap = on ? (svc.verifyValid?.maxPerPayment ?? 0) : 0;
  /** The claimed payer is read (a bounded decode) only when a budget keys on it. */
  const keysOnPayer = wasteIpCap > 0 || wastePayerCap > 0 || validPayerCap > 0;

  /** (caller IP | payer) → when a payment from that payer last validated. */
  const knownPayers = new Map<string, number>();
  const noteKnown = (key: string, now: number): void => {
    knownPayers.delete(key);
    knownPayers.set(key, now);
    while (knownPayers.size > KNOWN_PAYERS_MAX) {
      const oldest = knownPayers.keys().next().value;
      if (oldest === undefined) break;
      knownPayers.delete(oldest);
    }
  };
  const isKnown = (key: string, now: number): boolean => {
    const at = knownPayers.get(key);
    return at !== undefined && now - at < KNOWN_PAYER_TTL_MS;
  };

  const refuse = (req: FastifyRequest, reply: FastifyReply, ip: string, why: string, payer: string) => {
    req.log.warn({ ip, payer: payer || undefined, why }, "verify rate-limited");
    svc.metrics?.recordRateLimited("verify");
    return reply.code(429).send({ error: "rate_limited" });
  };

  app.post(
    "/verify",
    async (req, reply): Promise<VerifyResponse | { error: string }> => {
      const shape = validateFacilitatorRequestShape(req.body);
      if (!shape.ok) {
        return reply.code(400).send({ error: shape.error });
      }
      // Budgets BEFORE the work that costs: /verify is unauthenticated and a
      // payload that passes the local rules drives a Scan read, an ACS read and
      // a topology lookup under the facilitator's identity. The ones that need
      // no payer come first, so a refusal there costs no decode.
      const ip = clientIp(req);
      const now = Date.now();
      if (!limiter.peek(`valid:${ip}`, now, validCap)) {
        return refuse(req, reply, ip, "valid verifies over the per-caller cap", "");
      }
      // One payment through one caller, however the payment is spelled
      // (settlePaymentRateKey canonicalises the claimed hash exactly as the
      // verifier does). Per caller: anyone who saw a payment's bytes can send
      // them, and keyed on the payment alone their replays used up the
      // merchant's own budget for it.
      const payKey = on ? settlePaymentRateKey(shape.body.paymentPayload.payload) : null;
      if (payKey && !limiter.peek(`valid-pay:${ip}|${payKey}`, now, validPaymentCap)) {
        return refuse(req, reply, ip, "this payment already validated as often as it may", "");
      }
      // Decoded once: the validator below reuses this reading (Rule 2, Rule 8).
      const payload = shape.body.paymentPayload.payload;
      const claim: InlineClaim | undefined =
        on && keysOnPayer && isInlineCarriage(payload) ? decodeInlineClaim(payload) : undefined;
      const payer = claim ? budgetPayer(claim) : "";
      const pairKey = `${ip}|${payer}`;
      const known = isKnown(pairKey, now);
      if (!limiter.peek(`valid-payer:${pairKey}`, now, validPayerCap)) {
        return refuse(req, reply, ip, "this payer's valid verifies over its cap through this caller", payer);
      }
      // Not for a returning payer: anyone who knows its party can quote it, so
      // the pair cap would let them refuse it. It stays bounded by the caller's
      // waste share and, while the caller sheds, by its admissions.
      if (!known && !limiter.peek(`waste:${pairKey}`, now, wastePayerCap)) {
        return refuse(req, reply, ip, "this payer keeps failing through this caller", payer);
      }
      if (!limiter.peek(`waste:${ip}`, now, wasteIpCap)) {
        // Shedding. Only a returning payer, and only up to the valid cap.
        if (!known) {
          return refuse(req, reply, ip, "caller is shedding: payer has not validated through it before", payer);
        }
        if (!limiter.allowKeys([{ key: `shed:${ip}`, max: validCap }], now, false)) {
          return refuse(req, reply, ip, "caller is shedding: returning-payer admissions used up", payer);
        }
      }
      // Audit H3: signatureProof is accepted but NOT cryptographically verified
      // here. The wire payload omits the prepared-tx hash the proof signs, and
      // there is no payer-key (PartyToKeyMapping) fetch — so the facilitator
      // cannot verify it at this point. Sender authenticity is already enforced
      // ON-LEDGER: a TransferCommand is `signatory sender, dso`, so it cannot
      // exist without the sender's external signature. We surface an unenforced
      // proof rather than accept it silently; `invalid_exact_canton_signature`
      // stays reserved for when verification is wired (payload must carry the
      // prepared-tx hash + client must produce the proof + a payer key fetch).
      const proof = (
        shape.body.paymentPayload.payload as { signatureProof?: string }
      ).signatureProof;
      if (proof) {
        req.log.warn(
          "verify: signatureProof present but NOT cryptographically verified " +
            "(audit H3); the on-ledger signatory(sender,dso) is the enforced guarantee"
        );
      }
      let v: Awaited<ReturnType<typeof runValidation>>;
      try {
        v = await runValidation(shape.body, svc, Date.now(), { inlineClaim: claim });
      } catch (err) {
        // The shared Scan budget shed the Rule 7 lookup: nothing is known
        // about the merchant, so no verdict, and nothing is charged. 503, not
        // isValid:false, because a refusal travels to the payer as a 402 and
        // the shipped client then pays again. Express and next answer any
        // non-2xx /verify with 502 "retry the SAME payment; nothing was
        // settled", and the shipped client re-sends that same payment on a 5xx,
        // twice by default (3 s, then 6 s later), never a new one. A 5xx still
        // there after that reaches its caller as PAYMENT_UNCONFIRMED. The case
        // is kept rare: merchants we serve are never shed, recent ones are
        // seeded at boot, and a cooldown is waited out once before this.
        if (err instanceof ScanBudgetRefusedError) {
          req.log.warn({ ip, reason: err.reason }, "verify: Rule 7 lookup shed by the Scan budget");
          svc.metrics?.recordRateLimited("scan");
          return reply
            .code(503)
            .header("Retry-After", String(err.retryAfterSeconds))
            .send({ error: "scan_busy" });
        }
        throw err;
      }
      const at = Date.now();
      if (v.ok) {
        if (on) {
          // Separate charges, as for waste below. The payer here is PROVEN.
          limiter.allowKeys([{ key: `valid:${ip}`, max: validCap }], at, false);
          limiter.allowKeys([{ key: `valid-payer:${ip}|${v.payer}`, max: validPayerCap }], at, false);
          if (payKey) limiter.allowKeys([{ key: `valid-pay:${ip}|${payKey}`, max: validPaymentCap }], at, false);
          noteKnown(`${ip}|${v.payer}`, at);
        }
        return { isValid: true, payer: v.payer };
      }
      if (on) {
        // Two separate charges: a full bucket on one side must not leave the
        // other uncharged.
        limiter.allowKeys([{ key: `waste:${pairKey}`, max: wastePayerCap }], at, false);
        limiter.allowKeys([{ key: `waste:${ip}`, max: wasteIpCap }], at, false);
      }
      return {
        isValid: false,
        invalidReason: v.reason,
        payer: v.payer,
      };
    }
  );
}
