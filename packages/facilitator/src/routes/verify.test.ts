/**
 * POST /verify — the budgets in front of the validation, driven through the
 * real route and the real inline validator over a captured MainNet transfer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FacilitatorRequest } from "@ftptech/x402-canton-core";
import { encodeInlinePaymentPayload, decodePrepared } from "@ftptech/x402-canton-core";
import { registerVerifyRoute, type VerifyRouteServices } from "./verify.js";
import { ScanBudgetRefusedError } from "../scan-budget.js";

const FIXTURES = fileURLToPath(new URL("../../../agent-wallet/src/__fixtures__/", import.meta.url));
const RAW = Buffer.from(
  readFileSync(FIXTURES + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim(),
  "base64"
);
const META = JSON.parse(readFileSync(FIXTURES + "mainnet-0.1.21.json", "utf8")).transfer as {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
};
const FACILITATOR = "ftp_facilitator::1220" + "ff".repeat(32);
const ATOMIC = "100000000"; // 0.01 CC
const HONEST_SIG = Buffer.alloc(64, 7).toString("base64");
const FORGED_SIG = Buffer.alloc(64, 9).toString("base64");

function body(payloadOver: Record<string, unknown> = {}, signatureB64 = HONEST_SIG): FacilitatorRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "canton:mainnet",
      resource: { url: "https://api.example.com/x" },
      accepted: {} as never,
      payload: {
        ...encodeInlinePaymentPayload({
          preparedTransactionBytes: RAW,
          preparedTxHash: "1220" + "ab".repeat(32),
          signatureB64,
        }),
        ...payloadOver,
      } as never,
    },
    paymentRequirements: {
      scheme: "exact",
      network: "canton:mainnet",
      amount: ATOMIC,
      asset: "CC",
      payTo: META.receiver,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: FACILITATOR,
        instrumentId: META.instrumentId,
        executeBeforeSeconds: 60,
      },
    } as never,
  } as FacilitatorRequest;
}

beforeEach(() => {
  const prepUs = decodePrepared(RAW.toString("base64")).preparationTime;
  // Only Date: faking the timer queue stalls fastify's inject.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number((prepUs ?? 0n) / 1000n) + 1000);
});
afterEach(() => vi.useRealTimers());

function services(over: Partial<VerifyRouteServices> = {}): VerifyRouteServices {
  return {
    network: "canton:mainnet",
    facilitatorParty: FACILITATOR,
    tfEnabled: true,
    inline: {
      // The payer's key only verifies the honest signature.
      verifySignature: async ({ signatureB64 }: { signatureB64: string }) => ({
        verified: signatureB64 === HONEST_SIG,
        preparedTxHashHex: "cd".repeat(32),
      }),
      fetchPreapproval: async () => ({
        receiver: META.receiver,
        dso: META.instrumentId.admin,
        expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
      }),
    },
    ...over,
  } as unknown as VerifyRouteServices;
}

async function app(svc: VerifyRouteServices) {
  const a = Fastify();
  await registerVerifyRoute(a, svc);
  return a;
}
const MERCHANT_IP = "203.0.113.10";
const verify = (a: Awaited<ReturnType<typeof app>>, payload: unknown, remoteAddress = MERCHANT_IP) =>
  a.inject({ method: "POST", url: "/verify", remoteAddress, payload: payload as never });

describe("/verify when the shared Scan budget sheds the Rule 7 lookup", () => {
  it("answers 503 scan_busy with Retry-After, not isValid:false preapproval_missing", async () => {
    // The merchant turns a verdict into a 402 the payer reads as final; a 503
    // makes the shipped middlewares answer "retry the SAME payment".
    const a = await app(
      services({
        inline: {
          verifySignature: async () => ({ verified: true }),
          fetchPreapproval: async () => {
            throw new ScanBudgetRefusedError("cooldown", 1_500);
          },
        },
      } as never)
    );
    const r = await verify(a, body());
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "scan_busy" });
    expect(r.headers["retry-after"]).toBe("2");
    await a.close();
  });

  it("an honest verify is untouched", async () => {
    const a = await app(services());
    const r = await verify(a, body());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ isValid: true, payer: META.sender });
    await a.close();
  });
});

describe("/verify junk through a merchant must not stop its honest payments", () => {
  /** The caps in force: VALID verifies per caller, invalid ones per caller and
   *  per (caller, claimed payer). Small numbers, same shape as production. */
  const caps = (
    o: {
      valid?: number;
      validPayer?: number;
      validPayment?: number;
      wasteIp?: number;
      wastePayer?: number;
      windowMs?: number;
    } = {}
  ) => ({
    verifyRateLimit: { maxPerPayer: o.valid ?? 5, maxGlobal: 0, windowMs: o.windowMs ?? 60_000 },
    verifyValid: { maxPerPayer: o.validPayer ?? 0, maxPerPayment: o.validPayment ?? 0 },
    verifyWaste: { maxPerIp: o.wasteIp ?? 3, maxPerPayer: o.wastePayer ?? 2 },
  });
  /** A different payment by the same payer: the stub verifier accepts any
   *  claimed hash, so a new hash stands in for a new transaction. */
  const payment = (n: number) => body({ preparedTxHash: "1220" + n.toString(16).padStart(2, "0").repeat(32) });
  /** Junk anyone can build from a public 402: garbage where the payload goes. */
  const garbage = () => ({ ...body(), paymentPayload: { ...body().paymentPayload, payload: { x: 1 } } });
  /** Well-formed, decodes to no payer: the legacy carriage, refused as missing_proof. */
  const payerless = () =>
    ({
      ...body(),
      paymentPayload: { ...body().paymentPayload, payload: { assetTransferMethod: "transfer-factory", submissionRef: "x" } },
    }) as unknown as FacilitatorRequest;

  it("malformed bodies are refused before any budget is charged", async () => {
    const a = await app(services(caps({ valid: 2, wasteIp: 2, wastePayer: 2 })));
    for (let i = 0; i < 20; i++) expect((await verify(a, garbage())).statusCode).toBe(400);
    const honest = await verify(a, body());
    expect(honest.statusCode).toBe(200);
    expect(honest.json()).toMatchObject({ isValid: true });
    await a.close();
  });

  it("invalid outcomes are charged to the claimed payer, so one payer's failures refuse no one else", async () => {
    const a = await app(services(caps({ valid: 120, wasteIp: 100, wastePayer: 2 })));
    for (let i = 0; i < 2; i++) expect((await verify(a, payerless())).json()).toMatchObject({ isValid: false });
    const third = await verify(a, payerless());
    expect(third.statusCode).toBe(429);
    // The honest payer through the same merchant is a different budget.
    const honest = await verify(a, body());
    expect(honest.json()).toMatchObject({ isValid: true, payer: META.sender });
    await a.close();
  });

  it("junk in a returning payer's name cannot use up that payer's own budget", async () => {
    // Party ids are public and the claim is unproven until Rule 3, so a pair
    // cap that refused a payer who has validated here would let anyone refuse
    // that payer at this merchant for a handful of forged requests a minute.
    const a = await app(services(caps({ valid: 10, wasteIp: 100, wastePayer: 2 })));
    expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    for (let i = 0; i < 4; i++) {
      expect((await verify(a, body({}, FORGED_SIG))).json()).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_canton_signature_invalid",
      });
    }
    expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    await a.close();
  });

  it("a verify, valid or not, never marks its merchant as served", async () => {
    // Anyone with a wallet can produce a valid verify for any merchant that has
    // a preapproval, so only a SETTLED payment (/settle) may promote one.
    const noteServedMerchant = vi.fn();
    const a = await app(services({ ...caps(), noteServedMerchant } as never));
    await verify(a, body({}, FORGED_SIG));
    expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    expect(noteServedMerchant).not.toHaveBeenCalled();
    await a.close();
  });

  it("one valid payment replayed stops at its own cap", async () => {
    // A valid payment can be replayed to /verify without end; before this cap
    // 120 replays of one payment filled the merchant's whole valid budget.
    const a = await app(services(caps({ valid: 120, validPayment: 3, validPayer: 90 })));
    for (let i = 0; i < 3; i++) expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    expect((await verify(a, body())).statusCode).toBe(429);
    // The same payer's next payment is a new budget.
    expect((await verify(a, payment(1))).json()).toMatchObject({ isValid: true });
    // Re-spelling the hash (bare digest vs 1220 multihash) is the same payment.
    expect((await verify(a, body({ preparedTxHash: "ab".repeat(32) }))).statusCode).toBe(429);
    await a.close();
  });

  it("a third party replaying a payment from its own address does not use up the merchant's budget for it", async () => {
    // Anyone who saw the payment's bytes can send them; keyed on the payment
    // alone, ten replays from elsewhere refused the merchant's own verify.
    const a = await app(services(caps({ valid: 120, validPayment: 3, validPayer: 90 })));
    for (let i = 0; i < 3; i++) expect((await verify(a, payment(7), "198.51.100.66")).json()).toMatchObject({ isValid: true });
    expect((await verify(a, payment(7), "198.51.100.66")).statusCode).toBe(429);
    expect((await verify(a, payment(7))).json()).toMatchObject({ isValid: true });
    await a.close();
  });

  it("one payer's valid verifies through a merchant stop below the merchant's cap", async () => {
    const a = await app(services(caps({ valid: 120, validPayment: 10, validPayer: 2 })));
    expect((await verify(a, payment(1))).json()).toMatchObject({ isValid: true });
    expect((await verify(a, payment(2))).json()).toMatchObject({ isValid: true });
    expect((await verify(a, payment(3))).statusCode).toBe(429);
    // Another merchant's caller is a different pair.
    expect((await verify(a, payment(4), "203.0.113.11")).json()).toMatchObject({ isValid: true });
    await a.close();
  });

  it("past its waste share a caller only admits payers that validated through it before", async () => {
    const a = await app(services(caps({ valid: 10, wasteIp: 3, wastePayer: 100 })));
    expect((await verify(a, body())).json()).toMatchObject({ isValid: true }); // a returning payer
    for (let i = 0; i < 3; i++) expect((await verify(a, payerless())).statusCode).toBe(200);
    // The caller has now wasted its share: junk is refused up front...
    expect((await verify(a, payerless())).statusCode).toBe(429);
    // ...and the payer that has paid through this merchant goes on paying.
    for (let i = 0; i < 3; i++) expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    // Another merchant's caller is a different budget.
    expect((await verify(a, payerless(), "203.0.113.11")).statusCode).toBe(200);
    await a.close();
  });

  it("a payer the caller has not seen waits for the window to drain", async () => {
    const a = await app(services(caps({ valid: 10, wasteIp: 3, wastePayer: 100, windowMs: 1_000 })));
    for (let i = 0; i < 3; i++) await verify(a, payerless());
    expect((await verify(a, body())).statusCode).toBe(429);
    vi.setSystemTime(Date.now() + 1_100);
    expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    await a.close();
  });

  it("valid verifies keep their own cap per caller", async () => {
    const a = await app(services(caps({ valid: 2, wasteIp: 3, wastePayer: 2 })));
    expect((await verify(a, body())).statusCode).toBe(200);
    expect((await verify(a, body())).statusCode).toBe(200);
    expect((await verify(a, body())).statusCode).toBe(429);
    // Before the work a payment cannot be told from junk, so a caller at its
    // valid cap waits; only a payload that validated could have put it there.
    expect((await verify(a, payerless())).statusCode).toBe(429);
    expect((await verify(a, body(), "203.0.113.11")).json()).toMatchObject({ isValid: true });
    await a.close();
  });

  it("forged signatures in a returning payer's name are bounded too, while the caller is shedding", async () => {
    // Junk can claim a returning payer (party ids are public). It is held by
    // that payer's own waste cap and, while shedding, by the caller's share of
    // admissions, so it cannot become a bulk amplifier.
    const a = await app(services(caps({ valid: 3, wasteIp: 1, wastePayer: 100 })));
    expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    expect((await verify(a, payerless())).statusCode).toBe(200); // now shedding
    const forged = () => body({}, FORGED_SIG);
    for (let i = 0; i < 3; i++) expect((await verify(a, forged())).json()).toMatchObject({ isValid: false });
    expect((await verify(a, forged())).statusCode).toBe(429);
    await a.close();
  });

  it("a shed Rule 7 lookup charges nothing", async () => {
    let shed = true;
    const a = await app(
      services({
        ...caps({ valid: 1, wasteIp: 1, wastePayer: 1 }),
        inline: {
          verifySignature: async () => ({ verified: true }),
          fetchPreapproval: async () => {
            if (shed) throw new ScanBudgetRefusedError("budget", 1_000);
            return {
              receiver: META.receiver,
              dso: META.instrumentId.admin,
              expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
            };
          },
        },
      } as never)
    );
    for (let i = 0; i < 5; i++) expect((await verify(a, body())).statusCode).toBe(503);
    shed = false;
    expect((await verify(a, body())).json()).toMatchObject({ isValid: true });
    await a.close();
  });
});
