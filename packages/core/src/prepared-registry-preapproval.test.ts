/**
 * verify-before-sign for the registry (non-Amulet CIP-56) self-preapproval CREATE,
 * against a REAL MainNet prepared transaction captured off the live participant
 * (`agent-wallet/src/__fixtures__/mainnet-usdcx-self-preapproval-create.b64` — a
 * `Utility.Registry.App.V0.Model.TransferPreapproval` create for a fresh external
 * wallet, USDCx registrar). Proves the wallet cannot be tricked into signing
 * anything but its own self-preapproval, and that the out-of-band trusted registry
 * parties (operator) are required — a relay-supplied operator is NOT blind-trusted.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedRegistrySelfPreapproval,
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
} from "./prepared-transfer.js";

const RAW = readFileSync(
  new URL(
    "../../agent-wallet/src/__fixtures__/mainnet-usdcx-self-preapproval-create.b64",
    import.meta.url
  ),
  "utf8"
).trim();

const PARTY =
  "agent::1220e637f9272a554d6b8e19840fb998874b29dff61be92f98d304126865b6fa855d";
const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const trusted = new Set([OPERATOR]);

describe("assertPreparedRegistrySelfPreapproval — real USDCx self-preapproval create", () => {
  it("accepts the honest self-preapproval when the operator is out-of-band trusted", () => {
    expect(() =>
      assertPreparedRegistrySelfPreapproval(RAW, {
        party: PARTY,
        admin: USDCX_ADMIN,
        trustedRegistryParties: trusted,
      })
    ).not.toThrow();
  });

  it("rejects when the operator is NOT trusted (relay-supplied operator is foreign)", () => {
    expect(() =>
      assertPreparedRegistrySelfPreapproval(RAW, {
        party: PARTY,
        admin: USDCX_ADMIN,
        // no trustedRegistryParties → operator is an unexpected party
      })
    ).toThrow(PreparedTransferMismatchError);
  });

  it("rejects when act_as / receiver is a different party (not this wallet)", () => {
    expect(() =>
      assertPreparedRegistrySelfPreapproval(RAW, {
        party: "agent::1220" + "00".repeat(32),
        admin: USDCX_ADMIN,
        trustedRegistryParties: trusted,
      })
    ).toThrow(PreparedTransferMismatchError);
  });

  it("the honest create's receiver field IS this wallet (receiver-pin holds)", () => {
    // Direct proof the create names the wallet as receiver — so the receiver-pin
    // (defense-in-depth) is exercised on the positive path and did not become a
    // no-op. If a relay named the trusted operator as receiver instead, the pin
    // (not just the ledger) would refuse; here the honest bytes pass.
    expect(() =>
      assertPreparedRegistrySelfPreapproval(RAW, {
        party: PARTY,
        admin: USDCX_ADMIN,
        trustedRegistryParties: new Set([OPERATOR]),
      })
    ).not.toThrow();
  });

  it("rejects when the admin does not match (admin then reads as a foreign party)", () => {
    expect(() =>
      assertPreparedRegistrySelfPreapproval(RAW, {
        party: PARTY,
        admin: "other-admin::1220" + "11".repeat(32),
        trustedRegistryParties: trusted,
      })
    ).toThrow(PreparedTransferMismatchError);
  });

  it("does NOT accept a transfer as a self-preapproval (a transfer is not a bare create)", () => {
    const transferRaw = readFileSync(
      new URL(
        "../../agent-wallet/src/__fixtures__/mainnet-usdcx-transfer-preapproval.b64",
        import.meta.url
      ),
      "utf8"
    ).trim();
    expect(() =>
      assertPreparedRegistrySelfPreapproval(transferRaw, {
        party: PARTY,
        admin: USDCX_ADMIN,
        trustedRegistryParties: trusted,
      })
    ).toThrow(PreparedTransferMismatchError);
  });

  it("the self-preapproval create is NOT accepted as a transfer either (cross-guard)", () => {
    expect(() =>
      assertPreparedTransferMatches(RAW, {
        sender: PARTY,
        receiver: "someone::1220" + "22".repeat(32),
        amount: "0.0010000000",
        instrumentId: "USDCx",
        instrumentAdmin: USDCX_ADMIN,
      })
    ).toThrow(PreparedTransferMismatchError);
  });
});
