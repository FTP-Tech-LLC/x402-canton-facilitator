/**
 * Amulet self-preapproval verify-before-sign, against two REAL MainNet captures
 * (never signed): one without fee inputs, one where the merchant pays the fee
 * from its own Amulet. Tampered variants edit THOSE bytes with equal-length
 * replacements, so the protobuf framing stays valid and the decoder reads them.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedAmuletSelfPreapproval,
  PreparedTransferMismatchError,
} from "./prepared-transfer.js";

const fixture = (n: string): string =>
  readFileSync(new URL(`../../agent-wallet/src/__fixtures__/${n}`, import.meta.url), "utf8").trim();

const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const NO_FEE = {
  b64: fixture("mainnet-self-preapproval-create.b64"),
  party: "agent::122090a6c2579860921db36f24890b137a3a0e4875a0446687ff449cd29f3ad33106",
  expires: "2026-11-10T00:00:00Z",
};
const WITH_FEE = {
  b64: fixture("mainnet-self-preapproval-create-with-fee.b64"),
  party: "merchant-ctai::12200333d09cb1df4552e9b20bba0fddd13db8117b99e79ef94e935dda7b8afc397b",
  expires: "2027-04-01T00:00:00Z",
};

/** Replace EVERY occurrence of `from` with the equal-length `to`. */
function swapAll(b64: string, from: string, to: string): string {
  expect(to.length).toBe(from.length);
  const buf = Buffer.from(b64, "base64");
  const needle = Buffer.from(from, "utf8");
  let hits = 0;
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) {
    Buffer.from(to, "utf8").copy(buf, i);
    hits++;
  }
  expect(hits).toBeGreaterThan(0);
  return buf.toString("base64");
}
const refuse = (b64: string, party: string, re: RegExp, dso = DSO) => {
  expect(() => assertPreparedAmuletSelfPreapproval(b64, { party, dso })).toThrow(PreparedTransferMismatchError);
  expect(() => assertPreparedAmuletSelfPreapproval(b64, { party, dso })).toThrow(re);
};

describe("assertPreparedAmuletSelfPreapproval", () => {
  for (const c of [NO_FEE, WITH_FEE]) {
    it(`passes the honest MainNet capture (${c === NO_FEE ? "no fee inputs" : "fee paid from the merchant's Amulet"})`, () => {
      expect(() =>
        assertPreparedAmuletSelfPreapproval(c.b64, { party: c.party, dso: DSO, expectedExpiresAt: c.expires })
      ).not.toThrow();
    });
  }

  it("refuses when the DSO it is given is not the one in the bytes (the DSO is pinned, not learned)", () => {
    const other = "DSO::1220" + "0".repeat(DSO.length - 9);
    refuse(WITH_FEE.b64, WITH_FEE.party, /unexpected part(y|ies)/, other);
  });

  it("refuses a party that is neither the merchant nor the DSO anywhere in the tree", () => {
    const attacker = "EVL::1220" + "e".repeat(DSO.length - 9);
    refuse(swapAll(WITH_FEE.b64, DSO, attacker), WITH_FEE.party, /unexpected part(y|ies)/);
  });

  it("refuses the same choice name on another template (a look-alike package)", () => {
    // Module name changed everywhere: the root now runs on Splice.AmuletRulez:AmuletRules.
    refuse(swapAll(NO_FEE.b64, "Splice.AmuletRules", "Splice.AmuletRulez"), NO_FEE.party, /template/);
  });

  it("refuses a create outside the honest set", () => {
    refuse(
      swapAll(WITH_FEE.b64, "ValidatorRewardCoupon", "ValidatorRewardCoupoX"),
      WITH_FEE.party,
      /creates "Splice.Amulet:ValidatorRewardCoupoX"/
    );
  });

  it("refuses a consequence exercise outside the pinned set", () => {
    refuse(
      swapAll(WITH_FEE.b64, "OpenMiningRound_Fetch", "OpenMiningRound_FetcX"),
      WITH_FEE.party,
      /unexpected exercise/
    );
  });

  it("refuses an expiry other than the one the relay stated", () => {
    expect(() =>
      assertPreparedAmuletSelfPreapproval(WITH_FEE.b64, {
        party: WITH_FEE.party,
        dso: DSO,
        expectedExpiresAt: "2037-04-01T00:00:00Z",
      })
    ).toThrow(/expiresAt/);
  });

  it("refuses when signed for a different merchant (act_as)", () => {
    refuse(WITH_FEE.b64, "someone-else::1220aa", /acts as/);
  });
});
