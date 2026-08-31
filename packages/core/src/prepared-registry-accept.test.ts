/**
 * verify-before-sign for the CLAIM of a registry (CIP-56) two-step offer,
 * against a REAL MainNet prepared transaction captured off the live participant:
 * an agent accepting an inbound USDCx TransferOffer via TransferInstruction_Accept.
 *
 * Before REGISTRY_UTILITY_TWO_STEP_ACCEPT the verifier refused this honest
 * accept with "unexpected exercise TransferRule_TwoStepTransfer" — measured —
 * so an agent without a registry preapproval could receive USDCx as an offer
 * and never claim it. The choice is value-moving (the PR's own fixture: it
 * archives the sender's Holding and creates the receiver's), so it is admitted
 * only for a declared registry claim and only in the registry accept SHAPE;
 * the tests below pin every edge of that shape with byte mutations of the
 * real tree.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedAcceptMatches,
  decodePrepared,
  PreparedTransferMismatchError,
  type PreparedAcceptExpectation,
} from "./prepared-transfer.js";

const RAW = readFileSync(
  new URL("../../agent-wallet/src/__fixtures__/mainnet-usdcx-registry-accept.b64", import.meta.url),
  "utf8"
).trim();
const PARTY = "agent::12207b62889735d6f02727e1cf0d889aca5ea05b8b05d6786ee5f60eb537c7eaa143";
const USDCX_ADMIN =
  "decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef";
const OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const BRIDGE =
  "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f";
const NOW = Date.parse("2026-08-23T13:03:00Z"); // inside the offer's executeBefore window

const base: PreparedAcceptExpectation = {
  selfParty: PARTY,
  nowMs: NOW,
  instrumentAdmin: USDCX_ADMIN,
  trustedRegistryParties: new Set([OPERATOR, BRIDGE]),
};

function refusal(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PreparedTransferMismatchError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

/** Same-length mutation of `from` → `to` INSIDE the created Holding's argument
 *  bytes only (located by searching the argument bytes in the whole message),
 *  so the owner of the created holding changes while every other occurrence
 *  of the party — actAs, the offer — stays intact. */
function mutateCreatedHoldingParty(b64: string, from: string, to: string): string {
  expect(to.length).toBe(from.length);
  const buf = Buffer.from(b64, "base64");
  const decoded = decodePrepared(b64) as unknown as {
    nodes: Array<{ create?: { argument?: Uint8Array } }>;
  };
  const arg = decoded.nodes.find((n) => n.create?.argument)?.create?.argument;
  if (!arg) throw new Error("fixture has no create argument");
  const off = buf.indexOf(Buffer.from(arg));
  expect(off).toBeGreaterThanOrEqual(0);
  const fromB = Buffer.from(from, "utf8");
  let hits = 0;
  for (let i = buf.indexOf(fromB, off); i !== -1 && i < off + arg.length; i = buf.indexOf(fromB, i + 1)) {
    Buffer.from(to, "utf8").copy(buf, i);
    hits++;
  }
  expect(hits).toBeGreaterThan(0);
  return buf.toString("base64");
}

/** Same-length mutation of every `TransferOffer` identifier entity segment. */
function mutateRootTemplate(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const from = Buffer.from("TransferOffer", "utf8");
  let hits = 0;
  for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 1)) {
    Buffer.from("TransferOffeX", "utf8").copy(buf, i);
    hits++;
  }
  expect(hits).toBeGreaterThan(0);
  return buf.toString("base64");
}

describe("assertPreparedAcceptMatches — real USDCx registry offer accept", () => {
  it("accepts the honest registry accept (TransferRule_TwoStepTransfer is a consequence, not a drain)", () => {
    expect(() => assertPreparedAcceptMatches(RAW, base)).not.toThrow();
  });

  it("still refuses when the agent is not the acting party — the money barrier is intact", () => {
    expect(() =>
      assertPreparedAcceptMatches(RAW, { ...base, selfParty: "attacker::1220ffff" })
    ).toThrow(PreparedTransferMismatchError);
  });

  it("refuses the SAME bytes for a claim that did not declare a registry token — a Canton Coin claim never admits the registry node", () => {
    const { instrumentAdmin: _a, trustedRegistryParties: _t, ...ccClaim } = base;
    expect(refusal(() => assertPreparedAcceptMatches(RAW, ccClaim))).toMatch(
      /unexpected exercise\(s\) "TransferRule_TwoStepTransfer"/
    );
  });

  it("refuses when the registry's operator/bridge are not trusted — trust in the created holding's parties is explicit, never implied", () => {
    expect(
      refusal(() => assertPreparedAcceptMatches(RAW, { ...base, trustedRegistryParties: undefined }))
    ).toMatch(/creates a holding that names/);
  });

  it("refuses a created holding redirected to another party — the byte-mutated owner is caught", () => {
    const redirected = mutateCreatedHoldingParty(RAW, "agent::", "devil::");
    const msg = refusal(() => assertPreparedAcceptMatches(redirected, base));
    expect(msg).toMatch(/creates a holding that (names|does not name the agent)/);
  });

  it("refuses a registry accept not rooted on the registrar's TransferOffer — an interface choice's body is whatever implements it", () => {
    expect(refusal(() => assertPreparedAcceptMatches(mutateRootTemplate(RAW), base))).toMatch(
      /rooted on .*TransferOffeX/
    );
  });
});
