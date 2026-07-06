/**
 * x402-ENVELOPE canonical-schema invariants:
 *   - scheme "exact" is the ONLY scheme (schemeMatches is plain equality)
 *   - asset "CC" ≡ "canton-coin" ≡ "<admin>::Amulet"
 *   - selectServerRequirements matches the canonical extra shape and rejects
 *     money-field tampers
 *   - synchronizerId omittable (only enforced when both sides carry it)
 *   - resourceUrl hash accept-both stamp matching
 */
import { describe, it, expect } from "vitest";
import {
  schemeMatches,
  assetMatches,
  selectServerRequirements,
  hashResourceUrl,
  resourceUrlMatchesStamp,
  type PaymentRequirements,
} from "./index.js";

describe("schemeMatches (exact is the only scheme; plain equality)", () => {
  it("treats exact as equal only to exact", () => {
    expect(schemeMatches("exact", "exact")).toBe(true);
    expect(schemeMatches("exact", "exact-evm")).toBe(false);
  });
  it("rejects unrelated schemes", () => {
    expect(schemeMatches("exact", "exact-svm")).toBe(false);
    expect(schemeMatches("foo", "bar")).toBe(false);
  });
});

describe("assetMatches (CC ≡ canton-coin ≡ <admin>::Amulet)", () => {
  it("treats the CC symbols as equivalent", () => {
    expect(assetMatches("CC", "canton-coin")).toBe(true);
    expect(assetMatches("canton-coin", "CC")).toBe(true);
    expect(assetMatches("CC", "dso::1220::Amulet")).toBe(true);
    expect(assetMatches("dso::1220::Amulet", "canton-coin")).toBe(true);
  });
  it("matches identical non-CC tokens only by exact equality", () => {
    expect(assetMatches("issuer::1220::USDC", "issuer::1220::USDC")).toBe(true);
    expect(assetMatches("issuer::1220::USDC", "CC")).toBe(false);
    expect(assetMatches("issuer::1220::USDC", "other::1220::USDC")).toBe(false);
  });
});

describe("selectServerRequirements (canonical extra shape)", () => {
  // A server merchant config in the canonical extra shape (assetTransferMethod /
  // feePayer). scheme is "exact" (the only scheme) with an ATOMIC wire amount.
  const server = (): PaymentRequirements => ({
    scheme: "exact",
    network: "canton:devnet",
    amount: "1000000000",
    asset: "canton-coin",
    payTo: "merchant::1220m",
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: "ftp_facilitator::1220fff",
      synchronizerId: "global-domain::1220xyz",
      instrumentId: { admin: "dso::1220", id: "Amulet" },
      executeBeforeSeconds: 120,
    },
  });

  it("a client claim in the canonical shape (CC / feePayer / assetTransferMethod) matches", () => {
    const clientClaim = {
      scheme: "exact",
      network: "canton:devnet",
      amount: "1000000000",
      asset: "CC",
      payTo: "merchant::1220m",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: "ftp_facilitator::1220fff",
        // synchronizerId omitted — sourced from /supported.
        instrumentId: { admin: "dso::1220", id: "Amulet" },
      },
    };
    const s = [server()];
    expect(selectServerRequirements(s, clientClaim)).toBe(s[0]);
  });

  it("REJECTS a money-field tamper (amount)", () => {
    const s = [server()];
    const tampered = { ...server(), asset: "CC", amount: "1" };
    expect(selectServerRequirements(s, tampered)).toBeNull();
  });

  it("REJECTS a feePayer tamper (different facilitator)", () => {
    const s = [server()];
    const tampered = {
      ...server(),
      extra: { ...server().extra, feePayer: "attacker::1220evil" },
    };
    expect(selectServerRequirements(s, tampered)).toBeNull();
  });

  it("synchronizerId mismatch still rejects when BOTH sides carry it", () => {
    const s = [server()];
    const tampered = {
      ...server(),
      extra: { ...server().extra, synchronizerId: "other-domain::1220" },
    };
    expect(selectServerRequirements(s, tampered)).toBeNull();
  });
});

describe("resourceUrl hash stamp (accept-both plaintext + hash)", () => {
  const url = "https://api.example.com/data";
  it("hashResourceUrl is the lowercase-hex SHA-256 of the UTF-8 URL", () => {
    expect(hashResourceUrl(url)).toMatch(/^[0-9a-f]{64}$/);
    // deterministic
    expect(hashResourceUrl(url)).toBe(hashResourceUrl(url));
  });
  it("matches both the hashed stamp (new) and plaintext stamp (legacy)", () => {
    expect(resourceUrlMatchesStamp(hashResourceUrl(url), url)).toBe(true);
    expect(resourceUrlMatchesStamp(url, url)).toBe(true);
  });
  it("rejects a stamp for a different URL", () => {
    expect(
      resourceUrlMatchesStamp(hashResourceUrl("https://evil.example/x"), url)
    ).toBe(false);
    expect(resourceUrlMatchesStamp("https://evil.example/x", url)).toBe(false);
  });
});
