import type { FastifyInstance } from "fastify";
import type { VerifyResponse } from "@ftptech/x402-canton-core";
import { runValidation, clientIp, type ValidationServices } from "./common.js";
import { validateFacilitatorRequestShape } from "./validate-body.js";
import {
  createSlidingWindowLimiter,
  type SlidingWindowConfig,
} from "../rate-limit.js";
import type { FacilitatorMetrics } from "../metrics.js";

export interface VerifyRouteServices extends ValidationServices {
  /** Rate limit for the PUBLIC /verify endpoint, keyed by client IP. A SEPARATE
   *  limiter instance from /settle so /verify throttling never draws down the
   *  settle traffic budget. Absent → disabled (tests / cip56-only deploys that
   *  opt out). Per-IP only: `maxPerPayer` is the per-IP cap, `maxGlobal` is left
   *  0 (a global /verify cap would let one IP starve verification for all). */
  verifyRateLimit?: SlidingWindowConfig;
  /** Prometheus metrics. OPTIONAL: absent → no-op. Present → a 429 rate-limit
   *  rejection bumps ratelimit_rejected_total{scope=verify}. */
  metrics?: FacilitatorMetrics | undefined;
}

export async function registerVerifyRoute(
  app: FastifyInstance,
  svc: VerifyRouteServices
): Promise<void> {
  // SEPARATE instance from /settle's limiter (distinct Map + window): the
  // public /verify amplification surface is throttled independently of the
  // funded settle budget.
  const limiter = createSlidingWindowLimiter(svc.verifyRateLimit);
  app.post(
    "/verify",
    async (req, reply): Promise<VerifyResponse | { error: string }> => {
      // Rate-limit BEFORE any work: /verify is unauthenticated and each call
      // drives Scan/ACS reads under the facilitator identity (read
      // amplification + arbitrary cid/updateId probing). Keyed by client IP.
      const ip = clientIp(req);
      if (!limiter.allow(ip, Date.now())) {
        req.log.warn({ ip }, "verify rate-limited");
        svc.metrics?.recordRateLimited("verify");
        return reply.code(429).send({ error: "rate_limited" });
      }
      const shape = validateFacilitatorRequestShape(req.body);
      if (!shape.ok) {
        return reply.code(400).send({ error: shape.error });
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
      const v = await runValidation(shape.body, svc, Date.now());
      if (v.ok) {
        return { isValid: true, payer: v.payer };
      }
      return {
        isValid: false,
        invalidReason: v.reason,
        payer: v.payer,
      };
    }
  );
}
