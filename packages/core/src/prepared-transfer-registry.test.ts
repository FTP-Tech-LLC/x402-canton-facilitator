/**
 * Foreign-party backstop + consequence whitelist for NON-Amulet CIP-56 registry
 * tokens, exercised against a REAL MainNet USDCx `TransferFactory_Transfer`
 * captured off the live participant (interactive-submission/prepare):
 * `packages/agent-wallet/src/__fixtures__/mainnet-usdcx-transfer-preapproval.b64`
 * (usdcx-merchant → devilXXX, 0.001 USDCx, registrar = decentralized-usdc-
 * interchain-rep, resolved `direct`). Its signed tree carries the DA Registry
 * Utility operator and the xReserve Bridge-Operator as signatories/observers, plus
 * a `TransferRule_DirectTransfer` consequence — the exact shapes an Amulet fixture
 * cannot cover. This pins that:
 *   - the registry `TransferRule_DirectTransfer` consequence is whitelisted,
 *   - the operator + bridge are admitted ONLY when passed as trustedRegistryParties,
 *   - an incompletely-trusted set still fails (no blanket allow), and
 *   - the money barrier (sender/receiver/amount/instrument pins) is untouched.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "./prepared-transfer.js";

const RAW = readFileSync(
  new URL(
    "../../agent-wallet/src/__fixtures__/mainnet-usdcx-transfer-preapproval.b64",
    import.meta.url
  ),
  "utf8"
).trim();

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

// A wall-clock inside the captured transfer's ledger-effective window
// (minLedgerEffectiveTime 1787383303708ms .. maxLedgerEffectiveTime
// 1787383424708ms), so the timing sanity check never masks the party checks.
const NOW_MS = 1787383310000;

const base: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: RECEIVER,
  amount: "0.0010000000",
  instrumentId: "USDCx",
  instrumentAdmin: USDCX_ADMIN,
  requireInputHoldings: true,
  nowMs: NOW_MS,
};

const TRUSTED = new Set([OPERATOR, BRIDGE]);

describe("registry-utility transfer — foreign-party backstop + consequence whitelist", () => {
  it("admits the honest USDCx transfer when operator+bridge are trusted", () => {
    expect(() =>
      assertPreparedTransferMatches(RAW, {
        ...base,
        trustedRegistryParties: TRUSTED,
      })
    ).not.toThrow();
  });

  it("rejects it with NO trusted set (registry infra parties are foreign)", () => {
    expect(() => assertPreparedTransferMatches(RAW, base)).toThrow(
      PreparedTransferMismatchError
    );
  });

  it("rejects when the trusted set is incomplete (bridge missing) — not a blanket allow", () => {
    expect(() =>
      assertPreparedTransferMatches(RAW, {
        ...base,
        trustedRegistryParties: new Set([OPERATOR]),
      })
    ).toThrow(/Bridge-Operator/);
  });

  it("keeps the money barrier: a tampered receiver still fails even with the full trusted set", () => {
    expect(() =>
      assertPreparedTransferMatches(RAW, {
        ...base,
        receiver: OPERATOR,
        trustedRegistryParties: TRUSTED,
      })
    ).toThrow(/receiver/);
  });

  it("keeps the money barrier: a tampered amount still fails even with the full trusted set", () => {
    expect(() =>
      assertPreparedTransferMatches(RAW, {
        ...base,
        amount: "9.9990000000",
        trustedRegistryParties: TRUSTED,
      })
    ).toThrow(/amount/);
  });

  it("does not admit a trusted party smuggled into the sender/receiver position", () => {
    // Even listed as trusted, the operator cannot be the receiver: the field pin
    // fires first, so a relay cannot redirect funds to registry infra.
    expect(() =>
      assertPreparedTransferMatches(RAW, {
        ...base,
        receiver: OPERATOR,
        trustedRegistryParties: TRUSTED,
      })
    ).toThrow(PreparedTransferMismatchError);
  });
});
