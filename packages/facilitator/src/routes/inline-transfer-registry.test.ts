/**
 * Facilitator inline arm for a NON-Amulet CIP-56 registry token (USDCx), against a
 * REAL MainNet USDCx `TransferFactory_Transfer` captured off the live participant
 * (`agent-wallet/src/__fixtures__/mainnet-usdcx-transfer-preapproval.b64`). Proves
 * the `registryTrustedParties` deps threading end-to-end: the shared foreign-party
 * backstop (which runs on the facilitator's /verify+/settle too) admits the
 * registry operator + bridge operator ONLY when the trusted set is supplied for
 * that admin, and the money pins still bite.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeInlinePaymentPayload,
  type FacilitatorRequest,
} from "@ftptech/x402-canton-core";
import { validateInlineTransferPath } from "./inline-transfer.js";

const FIXTURES = fileURLToPath(
  new URL("../../../agent-wallet/src/__fixtures__/", import.meta.url)
);
const RAW = Buffer.from(
  readFileSync(FIXTURES + "mainnet-usdcx-transfer-preapproval.b64", "utf8").trim(),
  "base64"
);

const SENDER =
  "usdcx-merchant::1220c065ad977ae4e480b6ea5bcd96d6d73025a91ad27fa60d1385010ca01cdd39f9";
const RECEIVER =
  "devilXXX::1220c065ad977ae4e480b6ea5bcd96d6d73025a91ad27fa60d1385010ca01cdd39f9";
const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const BRIDGE =
  "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f";
const FACILITATOR =
  "ftp_facilitator::1220ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
// 0.001 USDCx at 10 decimals → atomic units.
const ATOMIC = "10000000";
// Inside the captured transfer's LET window (min 1787383303708ms).
const NOW_MS = 1787383310000;

function request(extraOver: Record<string, unknown> = {}): FacilitatorRequest {
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
        preparedTxHash: "1220" + "ab".repeat(32),
        signatureB64: Buffer.alloc(64, 7).toString("base64"),
      }) as never,
    },
    paymentRequirements: {
      scheme: "exact",
      network: "canton:mainnet",
      amount: ATOMIC,
      asset: "USDCx",
      payTo: RECEIVER,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: FACILITATOR,
        instrumentId: { admin: USDCX_ADMIN, id: "USDCx" },
        executeBeforeSeconds: 60,
        ...extraOver,
      },
    } as never,
  } as FacilitatorRequest;
}

const TOKEN_REGISTRIES = { [USDCX_ADMIN]: "https://reg.example" };
const TRUSTED = { [USDCX_ADMIN]: [OPERATOR, BRIDGE] };

// No live preapproval probe: Rule 7 for a registry token is answered structurally
// from the signed bytes (the real USDCx fixture carries the
// `TransferRule_DirectTransfer` delivery consequence). Stateless → idempotent.
const baseDeps = {
  facilitatorParty: FACILITATOR,
  nowMs: NOW_MS,
  verifySignature: async () => ({ verified: true }),
  tokenRegistries: TOKEN_REGISTRIES,
};

afterEach(() => vi.restoreAllMocks());

describe("facilitator inline arm — registry token backstop wiring (real USDCx bytes)", () => {
  it("accepts the USDCx transfer when registryTrustedParties admits operator+bridge", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...baseDeps,
      registryTrustedParties: TRUSTED,
    });
    expect(r.ok).toBe(true);
    expect(r.payer).toBe(SENDER);
  });

  it("rejects it (foreign registry parties) when no trusted set is supplied", async () => {
    const r = await validateInlineTransferPath(request(), baseDeps);
    expect(r.ok).toBe(false);
    // Fails at the structural/backstop stage, NOT at Rule 7 preapproval.
    expect(r.reason).not.toBe("invalid_exact_canton_preapproval_missing");
  });

  it("rejects when the trusted set omits the bridge (no blanket allow)", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...baseDeps,
      registryTrustedParties: { [USDCX_ADMIN]: [OPERATOR] },
    });
    expect(r.ok).toBe(false);
  });

  it("keeps the money barrier: a wrong required amount fails even with the trusted set", async () => {
    const r = await validateInlineTransferPath(request({}), {
      ...baseDeps,
      registryTrustedParties: TRUSTED,
    });
    expect(r.ok).toBe(true); // sanity: correct amount passes
    const bad = await validateInlineTransferPath(
      { ...request(), paymentRequirements: { ...request().paymentRequirements, amount: "99999999999" } } as FacilitatorRequest,
      { ...baseDeps, registryTrustedParties: TRUSTED }
    );
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("invalid_exact_canton_amount_mismatch");
  });
});
