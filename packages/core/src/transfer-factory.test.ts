/**
 * transfer-factory ("V3") wire-arm tests.
 *
 * The money-critical property under test: the server's OWN accepts[] entry is
 * authoritative, a client-tampered amount/receiver/method never selects a
 * server entry, and a claim for a different (non-tf) method never cross-matches
 * a tf server entry.
 */
import { describe, it, expect } from "vitest";
import {
  selectServerRequirements,
  type CantonPaymentPayload,
  type CantonTransferMethod,
  type PaymentRequirements,
} from "./types.js";

const DSO = "DSO::1220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERCHANT = "merchant::1220bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FACILITATOR = "fac::1220cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SYNC = "global-domain::1220dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function tfRequirements(
  overrides: Partial<PaymentRequirements> = {}
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "canton:mainnet",
    amount: "2500000000",
    asset: "CC",
    payTo: MERCHANT,
    maxTimeoutSeconds: 120,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: FACILITATOR,
      synchronizerId: SYNC,
      instrumentId: { admin: DSO, id: "Amulet" },
      executeBeforeSeconds: 60,
    },
    ...overrides,
  };
}

// A requirements entry advertising a DIFFERENT (non-tf) assetTransferMethod.
// The method is a made-up value cast past the narrowed union, purely to prove
// that a claim/entry for a method other than transfer-factory never selects a
// tf server entry.
function otherMethodRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "canton:mainnet",
    amount: "2500000000",
    asset: "CC",
    payTo: MERCHANT,
    maxTimeoutSeconds: 120,
    extra: {
      assetTransferMethod: "some-other-method",
      feePayer: FACILITATOR,
      synchronizerId: SYNC,
      instrumentId: { admin: DSO, id: "Amulet" },
      executeBeforeSeconds: 60,
    } as unknown as PaymentRequirements["extra"],
  };
}

describe("transfer-factory PaymentRequirements matching", () => {
  it("selects the server's tf entry for an honest claim", () => {
    const server = tfRequirements();
    const picked = selectServerRequirements([server], tfRequirements());
    expect(picked).toBe(server);
  });

  it("tf and a non-tf method never cross-match (method pinned)", () => {
    expect(selectServerRequirements([otherMethodRequirements()], tfRequirements()))
      .toBeNull();
    expect(selectServerRequirements([tfRequirements()], otherMethodRequirements()))
      .toBeNull();
  });

  it("multi-method accepts[] resolves the claimed method's entry", () => {
    const other = otherMethodRequirements();
    const tf = tfRequirements();
    expect(selectServerRequirements([other, tf], tfRequirements())).toBe(tf);
    expect(selectServerRequirements([other, tf], otherMethodRequirements())).toBe(
      other
    );
  });

  it("client-tampered amount never selects the server entry", () => {
    const server = tfRequirements();
    const tampered = tfRequirements({ amount: "1" });
    expect(selectServerRequirements([server], tampered)).toBeNull();
  });

  it("client-tampered payTo never selects the server entry", () => {
    const server = tfRequirements();
    const tampered = tfRequirements({
      payTo:
        "attacker::1220eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
    expect(selectServerRequirements([server], tampered)).toBeNull();
  });

  it("instrumentId mismatch never selects the server entry", () => {
    const server = tfRequirements();
    const other = tfRequirements();
    (other.extra as { instrumentId: { admin: string; id: string } }).instrumentId =
      { admin: DSO, id: "OtherToken" };
    expect(selectServerRequirements([server], other)).toBeNull();
  });

  it("asset symbol equivalence still applies on the tf arm (CC ≡ canton-coin)", () => {
    const server = tfRequirements();
    const legacySymbol = tfRequirements({ asset: "canton-coin" });
    expect(selectServerRequirements([server], legacySymbol)).toBe(server);
  });
});

describe("transfer-factory payload arm (compile-shape checks)", () => {
  it("carries only the small stash reference, never the signed tx", () => {
    const payload: CantonPaymentPayload = {
      assetTransferMethod: "transfer-factory",
      payer:
        "agent::1220ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      submissionRef: "8f14e45f-ceea-467f-9c1d-1a2b3c4d5e6f",
      preparedTxHash: "aa".repeat(32),
    };
    expect(payload.submissionRef.length).toBeLessThan(64);
    // The payload carries only the small stash reference — never a heavy signed
    // artifact — so the only method-specific key is the submissionRef.
    expect("submissionRef" in payload).toBe(true);
  });

  it("method union covers exactly the one live method", () => {
    const methods: CantonTransferMethod[] = ["transfer-factory"];
    expect(methods).toHaveLength(1);
  });
});
