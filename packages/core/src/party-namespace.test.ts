import { describe, it, expect } from "vitest";
import { partyNamespace } from "./prepared-transfer.js";

// partyNamespace underpins the same-namespace registry-infra admission in the
// foreign-party backstop: two parties are treated as co-controlled ONLY when this
// returns byte-equal namespaces. The namespace is the trailing `::`-segment — the
// fixed-length multihash fingerprint of the controlling key, which a relay cannot
// forge. These tests lock the parse invariants the safety argument depends on.
describe("partyNamespace", () => {
  it("returns the fingerprint after the LAST '::' (the real key-bound namespace)", () => {
    expect(partyNamespace("rails-cethMain-1::12200350ab")).toBe("12200350ab");
    expect(partyNamespace("auth0_007c6643::12205bcc")).toBe("12205bcc");
  });

  it("takes the TERMINAL segment even if a hint contains '::' — never a middle segment", () => {
    // The fingerprint is always the last segment; a first-'::' parse would leak
    // the hint tail and could over- or under-match.
    expect(partyNamespace("a::b::FP")).toBe("FP");
    expect(partyNamespace("weird::hint::12200350ab")).toBe("12200350ab");
  });

  it("is undefined for a malformed id — fail-closed (admits nothing)", () => {
    expect(partyNamespace("noseparator")).toBeUndefined();
    expect(partyNamespace("hint::")).toBeUndefined(); // empty namespace
    expect(partyNamespace("")).toBeUndefined();
  });

  it("two ids match ONLY when their terminal fingerprints are byte-equal", () => {
    const admin = "cbtc-network::1220adminFP";
    // A party genuinely under the admin's namespace matches.
    expect(partyNamespace("auth0_x::1220adminFP") === partyNamespace(admin)).toBe(true);
    // An attacker cannot pick the terminal fingerprint: adminFP as a PREFIX or a
    // different fingerprint does not match.
    expect(partyNamespace("1220adminFP::1220attackerFP") === partyNamespace(admin)).toBe(false);
    expect(partyNamespace("evil::1220attackerFP") === partyNamespace(admin)).toBe(false);
  });
});
