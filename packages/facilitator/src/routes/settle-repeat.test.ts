/**
 * Repeats of a settled payment, unknown outcomes and refusal bodies, against
 * the scheme (specs/scheme_exact_canton.md, "Settlement" and the
 * SettlementResponse shape), on real MainNet bytes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FacilitatorRequest } from "@ftptech/x402-canton-core";
import { encodeInlinePaymentPayload, decodePrepared } from "@ftptech/x402-canton-core";
import { recomputeHash } from "@ftptech/x402-canton-ledger";
import { registerSettleRoute, type SettleRouteServices } from "./settle.js";
import { createInMemoryInlineSettleStore } from "../db/inline-settle-store.js";
import { SubmissionOutcomeUnknownError } from "../canton/transfer-factory.js";

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
const UPDATE_ID = "1220-settled-once";
let HASH = "";
let T0 = 0;

beforeAll(async () => {
  HASH = Buffer.from(await recomputeHash(RAW.toString("base64")), "base64").toString("hex");
  T0 = Number((decodePrepared(RAW.toString("base64")).preparationTime ?? 0n) / 1000n) + 1000;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function body(over: { payTo?: string; amount?: string; claim?: string } = {}): FacilitatorRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "canton:mainnet",
      resource: { url: "https://api.example.com/x" },
      accepted: {} as never,
      payload: encodeInlinePaymentPayload({
        preparedTransactionBytes: RAW,
        preparedTxHash: over.claim ?? "1220" + HASH,
        signatureB64: Buffer.alloc(64, 7).toString("base64"),
      }) as never,
    },
    paymentRequirements: {
      scheme: "exact",
      network: "canton:mainnet",
      amount: over.amount ?? ATOMIC,
      asset: "CC",
      payTo: over.payTo ?? META.receiver,
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

function harness(over: Partial<SettleRouteServices> = {}, execute?: () => Promise<unknown>) {
  let executes = 0;
  const svc = {
    network: "canton:mainnet",
    facilitatorParty: FACILITATOR,
    tfEnabled: true,
    inline: {
      verifySignature: async () => ({ verified: true, preparedTxHashHex: HASH }),
      fetchPreapproval: async () => ({
        receiver: META.receiver,
        dso: META.instrumentId.admin,
        expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
      }),
    },
    transferFactory: {
      preapprovalKind: async () => "receiver" as never,
      ledgerEnd: async () => 11,
      execute: async () => {
        executes += 1;
        if (execute) return execute();
        return { updateId: UPDATE_ID, transferred: true, confirmInconclusive: false };
      },
    },
    inlineSettles: createInMemoryInlineSettleStore(),
    attribution: { record: async () => {}, markServed: async () => {}, updateTrafficSummary: async () => {} },
    attributionScanClients: [],
    ...over,
  } as unknown as SettleRouteServices;
  return { svc, executes: () => executes };
}

async function settle(svc: SettleRouteServices, b = body()) {
  const app = Fastify();
  await registerSettleRoute(app, svc);
  const res = await app.inject({ method: "POST", url: "/settle", payload: b });
  await app.close();
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

describe("a repeat of a settled payment", () => {
  it("spec (default): refused with its updateId and the network, and not relayed again", async () => {
    const h = harness();
    expect((await settle(h.svc)).json).toMatchObject({ success: true, transaction: UPDATE_ID });
    const repeat = await settle(h.svc);
    expect(repeat.status).toBe(200);
    expect(repeat.json).toEqual({
      success: false,
      errorReason: "invalid_exact_canton_payment_already_settled",
      transaction: UPDATE_ID,
      network: "canton:mainnet",
      payer: META.sender,
    });
    expect(h.executes()).toBe(1);
  });

  it("legacy: answered with the recorded success, as before", async () => {
    const h = harness({ settleAnswers: "legacy" });
    await settle(h.svc);
    expect((await settle(h.svc)).json).toMatchObject({ success: true, transaction: UPDATE_ID, network: "canton:mainnet" });
    expect(h.executes()).toBe(1);
  });

  it("spec: after its deadline passed, refused with its updateId, not 'expired'", async () => {
    const h = harness();
    await settle(h.svc);
    vi.setSystemTime(T0 + 86_400_000);
    expect((await settle(h.svc)).json).toMatchObject({
      success: false,
      errorReason: "invalid_exact_canton_payment_already_settled",
      transaction: UPDATE_ID,
    });
    expect(h.executes()).toBe(1);
  });

  it("legacy: after its deadline passed, 'expired' as before, never the recorded success", async () => {
    // A merchant that keeps no record of its own would serve every success.
    const h = harness({ settleAnswers: "legacy" });
    await settle(h.svc);
    vi.setSystemTime(T0 + 600_000);
    const late = await settle(h.svc);
    expect(late.json).toMatchObject({ success: false, errorReason: "invalid_exact_canton_expired" });
    expect(h.executes()).toBe(1);
  });

  it("spec: concurrent duplicates get one success; the others a refusal with the updateId, or pending", async () => {
    // A duplicate that loses the race for the mark waits for the relay and is
    // refused with its updateId; one that meets the mark first is told the
    // outcome is pending, and its retry meets the record.
    const h = harness({ settleDispatchMark: "enforce" }, async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { updateId: UPDATE_ID, transferred: true, confirmInconclusive: false };
    });
    const answers = await Promise.all(Array.from({ length: 5 }, () => settle(h.svc)));
    expect(answers.filter((a) => a.json.success === true)).toHaveLength(1);
    for (const a of answers.filter((x) => x.json.success !== true)) {
      expect(["invalid_exact_canton_payment_already_settled", "settlement_pending"]).toContain(a.json.errorReason);
    }
    expect((await settle(h.svc)).json).toMatchObject({
      errorReason: "invalid_exact_canton_payment_already_settled",
      transaction: UPDATE_ID,
    });
    expect(h.executes()).toBe(1);
  });

  it.each([
    ["spec", { success: false, errorReason: "invalid_exact_canton_payment_already_settled", transaction: UPDATE_ID }],
    ["legacy", { success: true, transaction: UPDATE_ID }],
  ] as const)("%s: a duplicate the participant refuses as in flight is answered from the relay's record", async (mode, expected) => {
    let calls = 0;
    const h = harness({ settleAnswers: mode }, async () => {
      calls += 1;
      if (calls > 1) throw new Error("409 SUBMISSION_ALREADY_IN_FLIGHT");
      await new Promise((r) => setTimeout(r, 200));
      return { updateId: UPDATE_ID, transferred: true, confirmInconclusive: false };
    });
    const first = settle(h.svc);
    await new Promise((r) => setTimeout(r, 50));
    const duplicate = await settle(h.svc);
    expect((await first).json).toMatchObject({ success: true, transaction: UPDATE_ID });
    expect(duplicate.json).toMatchObject(expected);
  });

  it("repeated at another merchant's route, it is not answered from the record", async () => {
    // The record is keyed on the bytes alone; the answer must still be about
    // THIS route's payment, or another merchant's middleware would claim the
    // updateId and serve unpaid.
    const h = harness();
    await settle(h.svc);
    const other = await settle(h.svc, body({ payTo: "other_merchant::1220" + "ee".repeat(32) }));
    expect(other.json.success).toBe(false);
    expect(other.json.errorReason).not.toBe("invalid_exact_canton_payment_already_settled");
    expect(other.json.transaction).toBe("");
    expect(h.executes()).toBe(1);
  });
});

describe("refusals and unknown outcomes", () => {
  it("a refusal carries the network, and no payer it has not proven", async () => {
    const h = harness();
    const r = await settle(h.svc, body({ amount: "999999999" }));
    expect(r.json).toMatchObject({ success: false, transaction: "", network: "canton:mainnet" });
    expect(r.json).not.toHaveProperty("payer");
  });

  it("spec: an unknown outcome is 503 settlement_pending with the prepared transaction's hash, and is not relayed twice", async () => {
    const h = harness({ settleDispatchMark: "enforce" }, async () => {
      throw new SubmissionOutcomeUnknownError(new Error("no completion"));
    });
    for (let i = 0; i < 2; i++) {
      const r = await settle(h.svc);
      expect(r.status).toBe(503);
      expect(r.json).toEqual({
        success: false,
        errorReason: "settlement_pending",
        transaction: HASH,
        network: "canton:mainnet",
        payer: META.sender,
      });
    }
    expect(h.executes()).toBe(1);
  });

  it.each(["off", "observe"] as const)(
    "spec with the mark %s: an unknown outcome is never settlement_pending, since a retry would relay again",
    async (mark) => {
      const h = harness({ settleDispatchMark: mark }, async () => {
        throw new SubmissionOutcomeUnknownError(new Error("no completion"));
      });
      const r = await settle(h.svc);
      expect(r.json.success).toBe(false);
      expect(r.json.errorReason).not.toBe("settlement_pending");
      expect(r.json.network).toBe("canton:mainnet");
    }
  );

  it("spec: when the mark failed to write, an unknown outcome keeps its old answer, since nothing guards a retry", async () => {
    const inner = createInMemoryInlineSettleStore();
    const store = { ...inner, recordDispatched: async () => "unrecorded" as const };
    const h = harness({ settleDispatchMark: "enforce", inlineSettles: store as never }, async () => {
      throw new SubmissionOutcomeUnknownError(new Error("no completion"));
    });
    const r = await settle(h.svc);
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(false);
    expect(r.json.errorReason).not.toBe("settlement_pending");
    expect(r.json.network).toBe("canton:mainnet");
  });

  it("spec: repeats that resolve one dispatched payment together get one success", async () => {
    const h = harness({ settleDispatchMark: "enforce" }, async () => {
      throw new SubmissionOutcomeUnknownError(new Error("no completion"));
    });
    expect((await settle(h.svc)).json.errorReason).toBe("settlement_pending");
    (h.svc.transferFactory as unknown as Record<string, unknown>).resolveDispatched = async () => ({
      state: "settled",
      transferred: true,
      updateId: UPDATE_ID,
    });
    const answers = await Promise.all(Array.from({ length: 3 }, () => settle(h.svc)));
    expect(answers.filter((a) => a.json.success === true)).toHaveLength(1);
    expect(answers.filter((a) => a.json.errorReason === "invalid_exact_canton_payment_already_settled")).toHaveLength(2);
    expect(h.executes()).toBe(1);
  });

  it("observe: the early answer adds no count to a repeat of a dispatched payment", async () => {
    const labels: string[] = [];
    const metrics = new Proxy(
      {},
      {
        get: (_t, name) =>
          name === "settleDuration"
            ? { startTimer: () => () => {} }
            : (...args: unknown[]) => {
                if (name === "recordSettle") labels.push(String(args[0]));
              },
      }
    );
    let calls = 0;
    const h = harness({ settleDispatchMark: "observe", metrics } as never, async () => {
      calls += 1;
      if (calls === 1) throw new SubmissionOutcomeUnknownError(new Error("no completion"));
      return { updateId: UPDATE_ID, transferred: true, confirmInconclusive: false };
    });
    await settle(h.svc);
    labels.length = 0;
    expect((await settle(h.svc)).json).toMatchObject({ success: true, transaction: UPDATE_ID });
    // As before the early answer: once for the record it meets, once for the
    // mark it finds already written. The early answer adds none in observe.
    expect(labels).toEqual(["outcome_unknown_observed", "outcome_unknown_observed", "ok"]);
  });

  it("legacy: an unknown outcome is still 503 settle_outcome_unknown", async () => {
    const h = harness({ settleAnswers: "legacy", settleDispatchMark: "enforce" }, async () => {
      throw new SubmissionOutcomeUnknownError(new Error("no completion"));
    });
    await settle(h.svc);
    const r = await settle(h.svc);
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: "settle_outcome_unknown" });
  });
});
