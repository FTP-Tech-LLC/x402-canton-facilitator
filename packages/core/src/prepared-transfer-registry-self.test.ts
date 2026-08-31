import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "./prepared-transfer.js";

// Two REAL MainNet USDCx prepared self-transfers (sender == receiver, the
// `merge` shape), captured on 2026-08-23 from the agent wallet holding
// 0.01 + 0.005 USDCx. Both exercise `AllocationFactory_TransferInternal` — the
// registry's internal-delivery node, which is also the delivery node of the
// two-step (pending TransferOffer) shape. These tests pin that the node is
// admitted ONLY as a self-transfer whose creates are all registry Holdings.
const fx = (n: string): string =>
  readFileSync(new URL(`../../agent-wallet/src/__fixtures__/${n}`, import.meta.url), "utf8").trim();
/** 2 inputs, amount = their full sum → tree creates ONE Holding. */
const FULL = fx("mainnet-usdcx-registry-self-merge-full.b64");
/** 2 inputs, amount = 1 atomic → tree creates TWO Holdings (1 atomic + change). */
const ATOMIC = fx("mainnet-usdcx-registry-self-merge.b64");

const AGENT = "agent::12207b62889735d6f02727e1cf0d889aca5ea05b8b05d6786ee5f60eb537c7eaa143";
const FOREIGN = "devilXXX::1220c065ad977ae4e480b6ea5bcd96d6d73025a91ad27fa60d1385010ca01cdd39f9";
const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const BRIDGE =
  "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f";
/** preparationTime of the fixtures + 30s (inside their ledger-effective window). */
const NOW_MS = 1787491198000;

const base: PreparedTransferExpectation = {
  sender: AGENT,
  receiver: AGENT,
  amount: "0.0150000000",
  instrumentId: "USDCx",
  instrumentAdmin: USDCX_ADMIN,
  requireInputHoldings: true,
  nowMs: NOW_MS,
  trustedRegistryParties: new Set([OPERATOR, BRIDGE]),
};

/** Same-length byte mutation of the ENTITY segment of every
 *  `Utility.Registry.Holding.V0.Holding:Holding` identifier (the bytes
 *  `Holding` + 2 + `Holding`), so the tree's creates no longer carry the
 *  registry Holding template while every length prefix stays valid. Only the
 *  entity is touched: the same word also occurs as a Daml record label
 *  (`inputHoldingCids`) and in the HoldingV1 interface id, and rewriting those
 *  would break decoding before the create pin is ever reached. */
function mutateHoldingTemplates(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const from = Buffer.from("Holding", "utf8");
  const to = Buffer.from("Hoiding", "utf8");
  let hits = 0;
  for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 1)) {
    if (i >= 9 && buf.subarray(i - 9, i - 2).equals(from)) {
      to.copy(buf, i);
      hits++;
    }
  }
  expect(hits).toBeGreaterThan(0);
  return buf.toString("base64");
}

describe("registry-utility SELF-transfer (merge) — AllocationFactory_TransferInternal is self-gated", () => {
  it("accepts the honest full-amount self-merge (2 inputs → 1 Holding)", () => {
    expect(() => assertPreparedTransferMatches(FULL, base)).not.toThrow();
  });

  it("accepts the 1-atomic self-transfer too (2 inputs → 1 atomic + change, both the owner's)", () => {
    expect(() =>
      assertPreparedTransferMatches(ATOMIC, { ...base, amount: "0.0000000001" })
    ).not.toThrow();
  });

  it("refuses the SAME bytes when the intended receiver is foreign — the rule is never consulted for a real transfer", () => {
    // This is the two-step-shape guard: a tree carrying the internal-delivery
    // node with a foreign receiver is refused at the consequence whitelist,
    // exactly as before this rule existed.
    let err: unknown;
    try {
      assertPreparedTransferMatches(FULL, { ...base, receiver: FOREIGN });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    expect((err as Error).message).toMatch(
      /unexpected exercise\(s\) "AllocationFactory_TransferInternal"/
    );
  });

  it("refuses a self-transfer whose create is not the registry Holding template — the create pin is load-bearing", () => {
    let err: unknown;
    try {
      assertPreparedTransferMatches(mutateHoldingTemplates(FULL), base);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    expect((err as Error).message).toMatch(/registry transfer creates .* — refusing to sign/);
  });
});
