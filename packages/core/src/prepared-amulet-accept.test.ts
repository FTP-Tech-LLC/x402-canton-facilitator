/**
 * verify-before-sign for the CLAIM of a Canton Coin transfer instruction, held
 * to the DSO: when the wallet knows its network's DSO, the accepted instruction
 * must be an AmuletTransferInstruction signed by the DSO that names the agent
 * as receiver, and the agent must get an Amulet the DSO signs. Against the real
 * MainNet accept captured live (agent-wallet/src/__fixtures__/
 * mainnet-accept-eventlog-0.1.21.b64): the faucet paying an agent 0.27 CC.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedAcceptMatches,
  decodePrepared,
  PreparedTransferMismatchError,
  type PreparedAcceptExpectation,
} from "./prepared-transfer.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../agent-wallet/src/__fixtures__/${name}`, import.meta.url), "utf8").trim();
const RAW = fixture("mainnet-accept-eventlog-0.1.21.b64");
const META = JSON.parse(fixture("mainnet-0.1.21.json")) as {
  accept: { party: string };
  transfer: { instrumentId: { admin: string } };
};
const PARTY = META.accept.party;
const DSO = META.transfer.instrumentId.admin;
const decoded = decodePrepared(RAW);
const NOW = Number(decoded.minLedgerEffectiveTime ?? decoded.preparationTime ?? 0n) / 1000 + 1000;

const base: PreparedAcceptExpectation = { selfParty: PARTY, nowMs: NOW, dsoParty: DSO };

function refusal(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PreparedTransferMismatchError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("assertPreparedAcceptMatches — Canton Coin claim held to the DSO", () => {
  it("passes the real MainNet accept, with and without the DSO", () => {
    expect(DSO.startsWith("DSO::1220")).toBe(true);
    expect(() => assertPreparedAcceptMatches(RAW, base)).not.toThrow();
    expect(() => assertPreparedAcceptMatches(RAW, { selfParty: PARTY, nowMs: NOW })).not.toThrow();
  });

  it("refuses an instruction the expected DSO did not sign", () => {
    const other = "DSO::1220" + "c".repeat(64);
    expect(refusal(() => assertPreparedAcceptMatches(RAW, { ...base, dsoParty: other }))).toMatch(
      /the instruction is not signed by the DSO/
    );
  });

  it("refuses an instruction that pays someone other than the agent", () => {
    const other = "agent::1220" + "b".repeat(64);
    expect(refusal(() => assertPreparedAcceptMatches(RAW, { ...base, selfParty: other }))).toMatch(
      /the instruction pays .* not the agent/
    );
  });
});
