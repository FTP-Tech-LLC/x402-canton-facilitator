/**
 * verify-before-sign for the RECLAIM of a wallet's own registry offer that the
 * receiver never took (TransferInstruction_Withdraw), against two REAL MainNet
 * prepared transactions captured off the live participant: a hosted wallet's
 * eXAG and cETH sells that Cantex left in TransferPendingReceiverAcceptance
 * past executeBefore. Prepared only — never signed or submitted.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedAcceptMatches,
  assertPreparedWithdrawMatches,
  decodePrepared,
  PreparedTransferMismatchError,
  type PreparedWithdrawExpectation,
} from "./prepared-transfer.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../agent-wallet/src/__fixtures__/${name}`, import.meta.url), "utf8").trim();
const EXAG = fixture("mainnet-registry-withdraw-exag.b64");
const CETH = fixture("mainnet-registry-withdraw-ceth.b64");
const ACCEPT = fixture("mainnet-usdcx-registry-accept.b64");

const PARTY = "agent::1220caaddc91c71d90c976750c28700c9739bdca5e047d95b0136e4325973902d9ed";
const OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const EXAG_ADMIN = "ember-silver::1220ad9c097ae75192b4716854fa413aa8582c86a62b16714663cdab55e025cc79c4";
const CETH_ADMIN = "rails-cethMain-1::12200350ba6e96e3b701c3048b5aa013a8c1c08833e8ebf54339cff581055c29003a";
const EXAG_OFFER =
  "00d7d056db9011460c223d07d68b68cad7d2eb77ae6737956c86feb726f6a8ab3dca121220e4f3874f47123a15bbe67bae259fc0edd0cd1a80dfac4f69c10c695397feec6a";
const CETH_OFFER =
  "001dc92a240d45e3b344bcab344a25cdf1431eeb834934abb21b3db1e246f0e660ca12122005a3011fcf0d1c86aef00c16ef59090d100ca8e250515cdb40f3d16ce1fe7063";
const NOW = Date.parse("2026-10-24T16:25:50Z"); // just after both captures

const exag: PreparedWithdrawExpectation = {
  selfParty: PARTY,
  instructionCid: EXAG_OFFER,
  instrumentAdmin: EXAG_ADMIN,
  trustedRegistryParties: new Set([OPERATOR]),
  onlyIfExpiredAt: NOW,
  nowMs: NOW,
};
const ceth: PreparedWithdrawExpectation = {
  ...exag,
  instructionCid: CETH_OFFER,
  instrumentAdmin: CETH_ADMIN,
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

/** Same-length mutation of `from` → `to` inside the created Holding's argument
 *  bytes only, so the returned holding names someone else while actAs and the
 *  offer stay intact. */
function mutateReturnedHolding(b64: string, from: string, to: string): string {
  expect(to.length).toBe(from.length);
  const buf = Buffer.from(b64, "base64");
  const arg = (decodePrepared(b64) as unknown as { nodes: Array<{ create?: { argument?: Uint8Array } }> }).nodes.find(
    (n) => n.create?.argument
  )?.create?.argument;
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

describe("assertPreparedWithdrawMatches — the agent withdrawing its own registry offer", () => {
  it("passes the measured eXAG and cETH withdraws", () => {
    expect(() => assertPreparedWithdrawMatches(EXAG, exag)).not.toThrow();
    expect(() => assertPreparedWithdrawMatches(CETH, ceth)).not.toThrow();
  });

  it("refuses a withdraw aimed at another offer than the one asked about", () => {
    expect(refusal(() => assertPreparedWithdrawMatches(EXAG, { ...exag, instructionCid: CETH_OFFER }))).toMatch(
      /withdraw targets .* not the offer/
    );
  });

  it("refuses when the returned holding is owned by someone other than the agent", () => {
    const attacker = "agent::1220" + "f".repeat(64);
    const tampered = mutateReturnedHolding(EXAG, PARTY, attacker);
    expect(refusal(() => assertPreparedWithdrawMatches(tampered, exag))).toMatch(
      /holding owned by .*agent::1220f+.*not the agent/
    );
  });

  it("refuses an offer the expected registrar did not sign", () => {
    // The eXAG offer is signed by its own registrar, not cETH's: a look-alike
    // contract a relay pointed the withdraw at would fail exactly here.
    expect(
      refusal(() => assertPreparedWithdrawMatches(EXAG, { ...exag, instrumentAdmin: CETH_ADMIN }))
    ).toMatch(/not signed by the registrar/);
  });

  it("refuses an offer whose signed executeBefore has not passed — the receiver could still accept", () => {
    expect(
      refusal(() => assertPreparedWithdrawMatches(EXAG, { ...exag, onlyIfExpiredAt: Date.parse("2026-10-24T15:35:00Z") }))
    ).toMatch(/executeBefore 2026-10-24T15:41:23\.741Z has not passed/);
  });

  it("refuses an offer the agent did not send", () => {
    const other = "agent::1220" + "a".repeat(64);
    expect(refusal(() => assertPreparedWithdrawMatches(EXAG, { ...exag, selfParty: other }))).toMatch(
      /sent by .* not by the agent/
    );
  });

  it("refuses a withdraw rooted on a template other than the registrar's TransferOffer", () => {
    const buf = Buffer.from(EXAG, "base64");
    const from = Buffer.from("TransferOffer", "utf8");
    let hits = 0;
    for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 1)) {
      Buffer.from("TransferOffeX", "utf8").copy(buf, i);
      hits++;
    }
    expect(hits).toBeGreaterThan(0);
    expect(refusal(() => assertPreparedWithdrawMatches(buf.toString("base64"), exag))).toMatch(/withdraw is rooted on/);
  });

  it("refuses a returned holding naming an operator the wallet does not trust for that registrar", () => {
    expect(refusal(() => assertPreparedWithdrawMatches(EXAG, { ...exag, trustedRegistryParties: new Set() }))).toMatch(
      /auth0_007c6643538f2eadd3e573dd05b9/
    );
  });

  it("refuses a stale preparation", () => {
    expect(() =>
      assertPreparedWithdrawMatches(EXAG, { ...exag, nowMs: NOW + 24 * 3600 * 1000 })
    ).toThrow(PreparedTransferMismatchError);
  });

  it("the accept arm refuses a withdraw, and the withdraw arm refuses an accept", () => {
    expect(
      refusal(() => assertPreparedAcceptMatches(EXAG, { selfParty: PARTY, nowMs: NOW, instrumentAdmin: EXAG_ADMIN }))
    ).toMatch(/no TransferInstruction_Accept exercise/);
    expect(refusal(() => assertPreparedWithdrawMatches(ACCEPT, exag))).toMatch(
      /no TransferInstruction_Withdraw exercise/
    );
  });
});
