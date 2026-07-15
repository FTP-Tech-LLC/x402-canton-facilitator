import { describe, it, expect } from "vitest";
import { runValidation, clientIp, type ValidationServices } from "./common.js";
import type { FastifyRequest } from "fastify";
import type {
  FacilitatorRequest,
  PaymentRequirements,
} from "@ftptech/x402-canton-core";

/**
 * runValidation orchestration guards that are method-agnostic (they fire in
 * runValidation BEFORE the per-method dispatch): the network guard and the
 * discriminator/accept-both extra-shape cross-check. The transfer-factory
 * per-method validation rules are covered in tf-settle.test.ts.
 */

const FACILITATOR = "ftp_facilitator::1220fff";
const NOW = new Date("2026-06-05T00:00:00Z").getTime();

const TF_MERCHANT = "merchant::1220tf";
const TF_DSO = "dso::1220tf";
const TF_AMOUNT_ATOMIC = "10000000000000000000";

// A well-formed transfer-factory wire body. The network guard and the
// discriminator cross-check both run ahead of any TF dep/ACS read, so these
// method-agnostic guards can be exercised with the TF deps left unwired.
function tfBody(): FacilitatorRequest {
  const reqs: PaymentRequirements = {
    scheme: "exact",
    network: "canton:devnet",
    amount: TF_AMOUNT_ATOMIC,
    asset: "CC",
    payTo: TF_MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: FACILITATOR,
      synchronizerId: "global-domain::1220",
      instrumentId: { admin: TF_DSO, id: "Amulet" },
      executeBeforeSeconds: 120,
    },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "canton:devnet",
      resource: { url: "https://api.example.com/data" },
      accepted: reqs,
      payload: {
        assetTransferMethod: "transfer-factory",
        submissionRef: "REF",
      },
    },
    paymentRequirements: reqs,
  };
}

describe("clientIp (security: req.ip is the sole, non-forgeable source)", () => {
  const mk = (
    ip: string | undefined,
    xff?: string | string[]
  ): FastifyRequest =>
    ({
      ip,
      headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    }) as unknown as FastifyRequest;

  it("returns req.ip directly for a real (non-loopback) client address", () => {
    // The proxy-fronted prod path: the trustProxy policy already resolved
    // req.ip to the real client, so we use it as-is.
    expect(clientIp(mk("203.0.113.5", "9.9.9.9"))).toBe("203.0.113.5");
  });

  it("IGNORES the X-Forwarded-For header entirely, even when req.ip is loopback", () => {
    // Adversarial-review HIGH fix: the raw XFF header is attacker-controlled, so
    // clientIp() must NOT read it — otherwise a caller mints a fresh rate-limit
    // bucket per request by rotating the header. req.ip is the single source of
    // truth (governed by the trustProxy policy in server.ts).
    expect(clientIp(mk("127.0.0.1", "70.0.0.1, 10.0.0.1"))).toBe("127.0.0.1");
    expect(clientIp(mk("::1", "70.0.0.2"))).toBe("::1");
    expect(clientIp(mk("127.0.0.1", ["80.0.0.1", "80.0.0.2"]))).toBe("127.0.0.1");
    expect(clientIp(mk("203.0.113.5", "1.1.1.1"))).toBe("203.0.113.5");
  });

  it("a rotated X-Forwarded-For yields the SAME key for a fixed req.ip", () => {
    // The crux: two requests from the same socket peer but different forged XFF
    // values must map to the same key so the limiter still bites.
    const a = clientIp(mk("127.0.0.1", "1.2.3.4"));
    const b = clientIp(mk("127.0.0.1", "5.6.7.8"));
    expect(a).toBe(b);
  });

  it("returns the loopback ip unchanged when no forwarded header is present", () => {
    expect(clientIp(mk("127.0.0.1"))).toBe("127.0.0.1");
  });

  it("never returns undefined — yields 'unknown' only when req.ip is empty", () => {
    expect(clientIp(mk(undefined))).toBe("unknown");
    expect(clientIp(mk(""))).toBe("unknown");
    // Even with an XFF header present, an empty req.ip must NOT fall through to
    // the forgeable header.
    expect(clientIp(mk("", "6.6.6.6"))).toBe("unknown");
  });
});

describe("runValidation — method-agnostic guards (network + discriminator)", () => {
  it("rejects a cross-network claim before any per-method work (network guard)", async () => {
    // The body claims devnet; the facilitator is configured for mainnet. The
    // network guard is the first check in runValidation and fires before the
    // per-method dispatch (no TF deps are consulted).
    const deps = {
      facilitatorParty: FACILITATOR,
      network: "canton:mainnet",
    } as unknown as ValidationServices;
    const out = await runValidation(tfBody(), deps, NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unexpected_canton_ledger_error");
  });

  it("rejects a discriminator mismatch between payload + requirements (operator misconfig)", async () => {
    // payload.assetTransferMethod must match requirements.extra.assetTransferMethod;
    // a mismatch is merchant-side misconfiguration and is rejected before dispatch.
    const body = tfBody();
    // payload says something OTHER than the requirements' "transfer-factory".
    (
      body.paymentPayload.payload as { assetTransferMethod: string }
    ).assetTransferMethod = "some-other-method";
    const deps = {
      facilitatorParty: FACILITATOR,
      network: "canton:devnet",
    } as unknown as ValidationServices;
    const out = await runValidation(body, deps, NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unexpected_canton_ledger_error");
  });
});
