/**
 * Type-level tests for the discriminated unions in `types.ts`.
 *
 * These don't exercise runtime behavior (the types have no runtime
 * shape) — they pin the contract so a future change that breaks
 * downstream consumers fails compile here, not at first
 * facilitator/client touch.
 */
import { describe, it, expect } from "vitest";
import {
  selectServerRequirements,
  assertAssetInstrumentConsistency,
} from "./types.js";
import type {
  CantonErrorCode,
  CantonPaymentPayload,
  CantonPaymentRequirementsExtra,
  CantonTransferMethod,
  FacilitatorRequest,
  PaymentRequirements,
} from "./types.js";

describe("type unions", () => {
  it("CantonTransferMethod is the single canonical method", () => {
    const methods: CantonTransferMethod[] = ["transfer-factory"];
    expect(methods).toHaveLength(1);
  });

  it("CantonPaymentRequirementsExtra (transfer-factory, V3)", () => {
    const tf: CantonPaymentRequirementsExtra = {
      assetTransferMethod: "transfer-factory",
      feePayer: "ftp_facilitator::1220",
      synchronizerId: "global-domain::1220",
      instrumentId: { admin: "dso::1220", id: "Amulet" },
      executeBeforeSeconds: 120,
    };
    expect(tf.assetTransferMethod).toBe("transfer-factory");
    expect(tf.feePayer).toBe("ftp_facilitator::1220");
  });

  it("CantonPaymentPayload (transfer-factory) carries submissionRef + optional preparedTxHash", () => {
    const tf: CantonPaymentPayload = {
      assetTransferMethod: "transfer-factory",
      payer: "agent::1220",
      submissionRef: "sub-ref-abc",
      preparedTxHash: "aa".repeat(32),
    };
    expect(tf.assetTransferMethod).toBe("transfer-factory");
    expect(tf.submissionRef).toBe("sub-ref-abc");
    expect(tf.preparedTxHash).toBe("aa".repeat(32));
  });

  it("CantonPaymentPayload (transfer-factory) accepts a bare submissionRef", () => {
    const bare: CantonPaymentPayload = {
      assetTransferMethod: "transfer-factory",
      payer: "agent::1220",
      submissionRef: "sub-ref-bare",
    };
    expect(bare.assetTransferMethod).toBe("transfer-factory");
    expect(bare.submissionRef).toBe("sub-ref-bare");
  });

  it("PaymentRequirements with asset='canton-coin' resolves CC via instrumentId", () => {
    const reqs: PaymentRequirements = {
      scheme: "exact",
      network: "canton:devnet",
      amount: "1000000000",
      asset: "canton-coin",
      payTo: "merchant::1220",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: "ftp_facilitator::1220",
        synchronizerId: "global-domain::1220",
        instrumentId: { admin: "dso::1220", id: "Amulet" },
        executeBeforeSeconds: 120,
      },
    };
    expect(reqs.asset).toBe("canton-coin");
  });

  it("CantonErrorCode includes the transfer-factory reason codes", () => {
    const codes: CantonErrorCode[] = [
      "invalid_exact_canton_submission_not_found",
      "invalid_exact_canton_preapproval_missing",
      "invalid_exact_canton_transfer_factory_disabled",
      "invalid_exact_canton_execute_failed",
    ];
    expect(codes).toHaveLength(4);
  });

  it("CantonErrorCode includes the holding_locked code", () => {
    const code: CantonErrorCode = "invalid_exact_canton_holding_locked";
    expect(code).toBe("invalid_exact_canton_holding_locked");
  });

  it("FacilitatorRequest with a transfer-factory payload is well-formed", () => {
    const req: FacilitatorRequest = {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        scheme: "exact",
        network: "canton:mainnet",
        resource: { url: "https://api.example.com/data" },
        accepted: {
          scheme: "exact",
          network: "canton:mainnet",
          amount: "1000000000",
          asset: "CC",
          payTo: "merchant::1220",
          maxTimeoutSeconds: 60,
          extra: {
            assetTransferMethod: "transfer-factory",
            feePayer: "ftp_facilitator::1220",
            synchronizerId: "global-domain::1220",
            instrumentId: { admin: "dso::1220", id: "Amulet" },
            executeBeforeSeconds: 120,
          },
        },
        payload: {
          assetTransferMethod: "transfer-factory",
          payer: "agent::1220",
          submissionRef: "sub-ref-abc",
        },
      },
      paymentRequirements: {
        scheme: "exact",
        network: "canton:mainnet",
        amount: "1000000000",
        asset: "CC",
        payTo: "merchant::1220",
        maxTimeoutSeconds: 60,
        extra: {
          assetTransferMethod: "transfer-factory",
          feePayer: "ftp_facilitator::1220",
          synchronizerId: "global-domain::1220",
          instrumentId: { admin: "dso::1220", id: "Amulet" },
          executeBeforeSeconds: 120,
        },
      },
    };
    expect(req.x402Version).toBe(2);
  });
});

describe("selectServerRequirements (SEC-1: pin requirements to server config)", () => {
  const ccReq = (): PaymentRequirements => ({
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
  const usdcReq = (): PaymentRequirements => ({
    scheme: "exact",
    network: "canton:devnet",
    amount: "1000000000000",
    asset: "issuer::1220::USDC",
    payTo: "merchant::1220m",
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: "ftp_facilitator::1220fff",
      synchronizerId: "global-domain::1220xyz",
      instrumentId: { admin: "issuer::1220", id: "USDC" },
      executeBeforeSeconds: 120,
    },
  });

  it("returns the server entry on an exact match (authoritative copy)", () => {
    const server = [ccReq()];
    expect(selectServerRequirements(server, ccReq())).toBe(server[0]);
  });
  it("returns null when the client lowers the amount", () => {
    expect(selectServerRequirements([ccReq()], { ...ccReq(), amount: "1" })).toBeNull();
  });
  it("returns null when the client redirects payTo", () => {
    expect(
      selectServerRequirements([ccReq()], { ...ccReq(), payTo: "attacker::1220evil" })
    ).toBeNull();
  });
  it("returns null when the client swaps the asset", () => {
    expect(
      selectServerRequirements([ccReq()], { ...ccReq(), asset: "other-coin" })
    ).toBeNull();
  });
  it("returns null when extra.feePayer is tampered", () => {
    expect(
      selectServerRequirements([ccReq()], {
        ...ccReq(),
        extra: { ...ccReq().extra, feePayer: "evil::1220" },
      })
    ).toBeNull();
  });
  it("returns null for non-object client claims", () => {
    expect(selectServerRequirements([ccReq()], null)).toBeNull();
    expect(selectServerRequirements([ccReq()], "nope")).toBeNull();
    expect(selectServerRequirements([ccReq()], 7)).toBeNull();
    expect(selectServerRequirements([ccReq()], undefined)).toBeNull();
  });
  it("returns null when instrumentId.admin differs", () => {
    expect(
      selectServerRequirements([usdcReq()], {
        ...usdcReq(),
        extra: { ...usdcReq().extra, instrumentId: { admin: "evil::1220", id: "USDC" } },
      })
    ).toBeNull();
  });
  it("returns null when instrumentId.id differs", () => {
    expect(
      selectServerRequirements([usdcReq()], {
        ...usdcReq(),
        extra: { ...usdcReq().extra, instrumentId: { admin: "issuer::1220", id: "FAKE" } },
      })
    ).toBeNull();
  });
  it("matches the correct entry when several are offered", () => {
    const server = [ccReq(), usdcReq()];
    expect(selectServerRequirements(server, usdcReq())).toBe(server[1]);
    expect(selectServerRequirements(server, ccReq())).toBe(server[0]);
  });
  it("returns null when accepts is empty", () => {
    expect(selectServerRequirements([], ccReq())).toBeNull();
  });

  // FEATURE A — unit-by-scheme amount matching (atomic, scheme "exact" only).
  describe("unit-by-scheme amount matching", () => {
    // A server entry under scheme "exact": amount is ATOMIC integer units. 0.1 CC
    // == "1000000000" atomic (1 CC = 1e10).
    const serverAtomic = (): PaymentRequirements => ({
      ...ccReq(),
      scheme: "exact",
      amount: "1000000000",
    });

    it('scheme "exact" + atomic still matches itself byte-identically', () => {
      const server = [serverAtomic()];
      expect(selectServerRequirements(server, serverAtomic())).toBe(server[0]);
    });

    it('matches an equal atomic value (the canonical-decimal compare folds equal values)', () => {
      const server = [serverAtomic()];
      expect(
        selectServerRequirements(server, { ...serverAtomic(), amount: "1000000000" })
      ).toBe(server[0]);
    });

    it("a 10x atomic claim does NOT match (over-claim blocked)", () => {
      const server = [serverAtomic()];
      const tenX = {
        ...serverAtomic(),
        amount: "10000000000", // 1.0 CC — 10x the 0.1 CC required
      };
      expect(selectServerRequirements(server, tenX)).toBeNull();
    });

    it("a 0.1x atomic claim does NOT match (under-claim blocked)", () => {
      const server = [serverAtomic()];
      const tenthX = {
        ...serverAtomic(),
        amount: "100000000", // 0.01 CC — 0.1x the 0.1 CC required
      };
      expect(selectServerRequirements(server, tenthX)).toBeNull();
    });

    it("a non-integer atomic value fails closed (the converter throws → no match)", () => {
      // Under scheme "exact" the wire amount MUST be an atomic integer; a Decimal
      // string like "0.1000000000" is NOT a valid atomic integer, so the converter
      // throws → fail-closed → no match (never a coincidence).
      const server = [serverAtomic()];
      const coincidence = {
        ...serverAtomic(),
        amount: "0.1000000000",
      };
      expect(selectServerRequirements(server, coincidence)).toBeNull();
    });

    it("fail-closed: a malformed server amount never matches", () => {
      const badServer = [{ ...serverAtomic(), amount: "not-a-number" }];
      expect(
        selectServerRequirements(badServer, { ...serverAtomic(), amount: "1000000000" })
      ).toBeNull();
    });
  });
});

describe("assertAssetInstrumentConsistency (audit L1)", () => {
  const usdc = (): PaymentRequirements => ({
    scheme: "exact",
    network: "canton:devnet",
    amount: "1000000000000",
    asset: "issuer::1220::USDC",
    payTo: "merchant::1220m",
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: "ftp_facilitator::1220fff",
      synchronizerId: "global-domain::1220xyz",
      instrumentId: { admin: "issuer::1220", id: "USDC" },
      executeBeforeSeconds: 120,
    },
  });

  it("no-op when asset equals admin::id (incl. an admin containing '::')", () => {
    expect(() => assertAssetInstrumentConsistency(usdc())).not.toThrow();
  });

  it("throws when asset disagrees with extra.instrumentId", () => {
    expect(() =>
      assertAssetInstrumentConsistency({ ...usdc(), asset: "wrong::USDC" })
    ).toThrow(/disagrees/);
  });

  it("skips a symbolic asset (no '::') even if instrumentId is present", () => {
    expect(() =>
      assertAssetInstrumentConsistency({ ...usdc(), asset: "canton-coin" })
    ).not.toThrow();
  });

  it("no-op when there is no instrumentId", () => {
    const noInstr: PaymentRequirements = {
      ...usdc(),
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: "ftp_facilitator::1220fff",
        synchronizerId: "global-domain::1220xyz",
        executeBeforeSeconds: 120,
      } as unknown as PaymentRequirements["extra"],
    };
    expect(() => assertAssetInstrumentConsistency(noInstr)).not.toThrow();
  });
});
