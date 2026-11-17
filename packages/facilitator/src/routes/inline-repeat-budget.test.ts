import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FacilitatorRequest } from "@ftptech/x402-canton-core";
import type * as Ledger from "@ftptech/x402-canton-ledger";

const hashOptions: unknown[] = [];
vi.mock("@ftptech/x402-canton-ledger", async (importOriginal) => {
  const real = await importOriginal<typeof Ledger>();
  return {
    ...real,
    recomputeHash: (b64: string, opts?: Parameters<typeof real.recomputeHash>[1]) => {
      hashOptions.push(opts);
      return real.recomputeHash(b64, opts);
    },
  };
});

const { inlineRepeatOf } = await import("./inline-transfer.js");
const { encodeInlinePaymentPayload } = await import("@ftptech/x402-canton-core");

const FIXTURES = fileURLToPath(new URL("../../../agent-wallet/src/__fixtures__/", import.meta.url));
const RAW = Buffer.from(
  readFileSync(FIXTURES + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim(),
  "base64"
);
const META = JSON.parse(readFileSync(FIXTURES + "mainnet-0.1.21.json", "utf8")).transfer as {
  receiver: string;
  instrumentId: { admin: string; id: string };
};
const FACILITATOR = "ftp_facilitator::1220" + "f".repeat(64);

const body = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: "canton:mainnet",
    resource: { url: "https://api.example.com/x" },
    accepted: {},
    payload: encodeInlinePaymentPayload({
      preparedTransactionBytes: RAW,
      preparedTxHash: "1220" + "ab".repeat(32),
      signatureB64: Buffer.alloc(64, 7).toString("base64"),
    }),
  },
  paymentRequirements: {
    scheme: "exact",
    network: "canton:mainnet",
    amount: "100000000",
    asset: "CC",
    payTo: META.receiver,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: FACILITATOR,
      instrumentId: META.instrumentId,
      executeBeforeSeconds: 60,
    },
  },
} as unknown as FacilitatorRequest;

describe("a settle repeat is hashed within the payment step budget", () => {
  it("passes the payer proof's budget to the hasher, and still finds an honest repeat", async () => {
    const r = await inlineRepeatOf(body, { facilitatorParty: FACILITATOR });
    expect(r).not.toBeNull();
    expect(hashOptions).toContainEqual({ maxSteps: 10_000 });
  });
});
