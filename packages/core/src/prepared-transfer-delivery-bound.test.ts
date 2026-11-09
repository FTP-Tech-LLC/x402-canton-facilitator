/**
 * The delivered amount is the amount the root names, and the signed transfer
 * carries the terms the caller built.
 *
 * Real MainNet bytes (agent-wallet/src/__fixtures__), edited the way a relay
 * that prepares them could edit them. Every edit keeps the byte length, so the
 * rest of the tree stays exactly as captured.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  decodePrepared,
  deliversViaAmuletPreapproval,
  extractTransfer,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "./prepared-transfer.js";

const fx = (name: string): string =>
  readFileSync(new URL(`../../agent-wallet/src/__fixtures__/${name}`, import.meta.url), "utf8").trim();

/** Replace `from` with the same-length `to` at its first occurrence after `anchor`. */
function patchAfter(b64: string, anchor: string, from: string, to: string): string {
  if (from.length !== to.length) throw new Error("patch must keep the length");
  const buf = Buffer.from(b64, "base64");
  const at = buf.indexOf(anchor);
  const i = at < 0 ? -1 : buf.indexOf(from, at);
  if (i < 0) throw new Error(`${from} not found after ${anchor}`);
  buf.write(to, i, "latin1");
  return buf.toString("base64");
}

/** Replace the last same-length occurrence of `from` before `anchor`. */
function patchBefore(b64: string, anchor: string, from: string, to: string): string {
  if (from.length !== to.length) throw new Error("patch must keep the length");
  const buf = Buffer.from(b64, "base64");
  const at = buf.indexOf(anchor);
  const i = at < 0 ? -1 : buf.lastIndexOf(from, at);
  if (i < 0) throw new Error(`${from} not found before ${anchor}`);
  buf.write(to, i, "latin1");
  return buf.toString("base64");
}

/** Replace a fixed64 timestamp (µs) everywhere it occurs. */
function patchTimestamp(b64: string, fromMicros: bigint, toMicros: bigint): string {
  const buf = Buffer.from(b64, "base64");
  const from = Buffer.alloc(8);
  from.writeBigInt64LE(fromMicros);
  const to = Buffer.alloc(8);
  to.writeBigInt64LE(toMicros);
  let n = 0;
  for (let i = buf.indexOf(from); i >= 0; i = buf.indexOf(from, i + 8)) {
    to.copy(buf, i);
    n += 1;
  }
  if (n === 0) throw new Error("timestamp not found");
  return buf.toString("base64");
}

const root = (b64: string) => {
  const d = decodePrepared(b64);
  const r = d.exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
  return { d, t: extractTransfer(r.chosenValue) };
};

// ── Canton Coin, one-step through the receiver's preapproval ────────────────
const CC = fx("mainnet-transfer-preapproval-0.1.21.b64");
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const CC_EXPECT: PreparedTransferExpectation = {
  sender: "agent::122028b084b415befd2fc4b82de4caed3dc71c588d861d4d79df8955e1f6964de00a",
  receiver: "Cantex::122090c527c437b93a66a7aa6d44fb641ff7a8386ef95430aed57e59e8e1bba45f53",
  amount: "0.0100000000",
  instrumentId: "Amulet",
  instrumentAdmin: DSO,
  // prepared 2026-08-02T09:52:06.778Z, max LET 09:54:06.707Z
  nowMs: Date.parse("2026-08-02T09:52:10.000Z"),
};
const CC_FACTORY = "Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules";

// The merchant is its own provider (receiver == provider).
const SELF = fx("mainnet-preapproval-self-provider.b64");
const SELF_EXPECT: PreparedTransferExpectation = {
  sender: "agent::1220ee6e28beea64a00657dc7ccc47f8502d21a2c29a56375456b2c61907758ec45d",
  receiver: "caf5e4e35cfd1669::12209e866b13a9428411eb9db7448726ec31cf0bcf027d0d642a0c38653ba72515a5",
  amount: "0.0001000000",
  instrumentId: "Amulet",
  instrumentAdmin: DSO,
  nowMs: Date.parse("2026-07-28T12:37:10.000Z"),
};

// ── USDCx, direct through the receiver's registry preapproval ───────────────
const USDCX = fx("mainnet-usdcx-transfer-preapproval.b64");
const USDCX_EXPECT: PreparedTransferExpectation = {
  sender: "usdcx-merchant::1220c065ad977ae4e480b6ea5bcd96d6d73025a91ad27fa60d1385010ca01cdd39f9",
  receiver: "devilXXX::1220c065ad977ae4e480b6ea5bcd96d6d73025a91ad27fa60d1385010ca01cdd39f9",
  amount: "0.0010000000",
  instrumentId: "USDCx",
  instrumentAdmin:
    "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef",
  trustedRegistryParties: new Set([
    "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e",
    "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f",
  ]),
  nowMs: 1787383310000,
};
const REGISTRY_FACTORIES = [
  "Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval",
  "Utility.Registry.App.V0.Service.AllocationFactory:AllocationFactory",
];

describe("the delivered amount is bound to the root", () => {
  it("accepts the captured payments as they are", () => {
    expect(() => assertPreparedTransferMatches(CC, CC_EXPECT)).not.toThrow();
    expect(() => assertPreparedTransferMatches(SELF, SELF_EXPECT)).not.toThrow();
    expect(() => assertPreparedTransferMatches(USDCX, USDCX_EXPECT)).not.toThrow();
  });

  it("refuses a TransferPreapproval_SendV2 that delivers more than the root names", () => {
    const inflated = patchAfter(CC, "TransferPreapproval_SendV2", "0.0100000000", "9.9900000000");
    // The edit hit the delivery and nothing else: the root still says 0.01.
    const { d, t } = root(inflated);
    expect(t.amount).toBe("0.0100000000");
    expect(deliversViaAmuletPreapproval(d, CC_EXPECT.receiver, DSO, "9.9900000000")).toBe(true);

    expect(() => assertPreparedTransferMatches(inflated, CC_EXPECT)).toThrow(PreparedTransferMismatchError);
    expect(() => assertPreparedTransferMatches(inflated, CC_EXPECT)).toThrow(/preapproval delivery/);
  });

  it("refuses the same on a merchant that is its own provider", () => {
    // Nothing foreign in this tree for the party backstop to catch: the
    // preapproval's provider is the receiver.
    const inflated = patchAfter(SELF, "TransferPreapproval_SendV2", "0.0001000000", "9.0001000000");
    expect(root(inflated).t.amount).toBe("0.0001000000");
    expect(() => assertPreparedTransferMatches(inflated, SELF_EXPECT)).toThrow(/preapproval delivery/);
  });

  it("refuses a send on a template other than the DSO's TransferPreapproval", () => {
    // Same choice name, someone else's module: the bare name in the
    // consequence list admits it on any template. The send's template_id
    // precedes its choice_id in the node.
    const lookalike = patchBefore(SELF, "TransferPreapproval_SendV2", "Splice.AmuletRules", "Attack.AmuletRules");
    const send = decodePrepared(lookalike).exercises.find((e) => e.choiceId === "TransferPreapproval_SendV2");
    expect(send?.templateQualifiedName).toBe("Attack.AmuletRules:TransferPreapproval");
    expect(() => assertPreparedTransferMatches(lookalike, SELF_EXPECT)).toThrow(/preapproval delivery/);
  });

  it("refuses a TransferRule_DirectTransfer that moves more than the root names", () => {
    const inflated = patchAfter(USDCX, "TransferRule_DirectTransfer", "0.0010000000", "9.0010000000");
    expect(root(inflated).t.amount).toBe("0.0010000000");
    expect(() => assertPreparedTransferMatches(inflated, USDCX_EXPECT)).toThrow(/delivers/);
  });
});

describe("templateQualifiedName takes one template or a list", () => {
  it("pins Canton Coin to the DSO's ExternalPartyAmuletRules", () => {
    expect(() =>
      assertPreparedTransferMatches(CC, { ...CC_EXPECT, templateQualifiedName: CC_FACTORY })
    ).not.toThrow();
    expect(() =>
      assertPreparedTransferMatches(CC, { ...CC_EXPECT, templateQualifiedName: REGISTRY_FACTORIES })
    ).toThrow(/template/);
  });

  it("admits a registry root on any listed template, and refuses one off the list", () => {
    expect(() =>
      assertPreparedTransferMatches(USDCX, { ...USDCX_EXPECT, templateQualifiedName: REGISTRY_FACTORIES })
    ).not.toThrow();
    expect(() =>
      assertPreparedTransferMatches(USDCX, { ...USDCX_EXPECT, templateQualifiedName: [CC_FACTORY] })
    ).toThrow(/template/);
  });
});

describe("meta and executeBefore are held to what the caller built", () => {
  // Captured with an empty meta map and executeBefore 09:54:06.708Z.
  const EB = Date.parse("2026-08-02T09:54:06.708Z");

  it("accepts the captured meta and deadline", () => {
    expect(() =>
      assertPreparedTransferMatches(CC, { ...CC_EXPECT, meta: {}, executeBeforeMaxMs: EB })
    ).not.toThrow();
  });

  it("refuses when an entry the caller put in meta is missing", () => {
    expect(() =>
      assertPreparedTransferMatches(CC, {
        ...CC_EXPECT,
        meta: { "splice.lfdecentralizedtrust.org/reason": "5.0000000000" },
      })
    ).toThrow(/meta/);
  });

  it("refuses a deadline later than the caller's", () => {
    expect(() =>
      assertPreparedTransferMatches(CC, { ...CC_EXPECT, executeBeforeMaxMs: EB - 1 })
    ).toThrow(/executeBefore/);
  });

  it("reads the deadline from the signed bytes: one moved to 2100 is refused", () => {
    const far = patchTimestamp(
      CC,
      BigInt(EB) * 1000n,
      BigInt(Date.parse("2100-01-01T00:00:00.000Z")) * 1000n
    );
    expect(root(far).t.executeBeforeMs).toBe(Date.parse("2100-01-01T00:00:00.000Z"));
    expect(() =>
      assertPreparedTransferMatches(far, { ...CC_EXPECT, executeBeforeMaxMs: EB + 60_000 })
    ).toThrow(/executeBefore/);
  });
});
