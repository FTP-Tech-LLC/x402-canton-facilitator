import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  encodeInlinePaymentPayload,
  decodePrepared,
  type FacilitatorRequest,
} from "@ftptech/x402-canton-core";
import { validateInlineTransferPath, isInlineCarriage, classifyMismatch } from "./inline-transfer.js";

/* Real MainNet bytes. Every assertion below is against a transaction that
 * actually settled on MainNet, so a check that passes here passes against the
 * real thing — not against a fixture shaped to make it pass. */
const FIXTURES = fileURLToPath(
  new URL("../../../agent-wallet/src/__fixtures__/", import.meta.url)
);
const RAW = Buffer.from(
  readFileSync(FIXTURES + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim(),
  "base64"
);
const META = JSON.parse(
  readFileSync(FIXTURES + "mainnet-0.1.21.json", "utf8")
).transfer as {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
};

const FACILITATOR = "ftp_facilitator::1220ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
/** 0.01 CC as the wire's atomic units (1 CC = 1e10). */
const ATOMIC = "100000000";

function inlinePayload(over: Record<string, unknown> = {}) {
  return {
    ...encodeInlinePaymentPayload({
      preparedTransactionBytes: RAW,
      preparedTxHash: "1220" + "ab".repeat(32),
      signatureB64: Buffer.alloc(64, 7).toString("base64"),
    }),
    ...over,
  };
}

function request(
  reqOver: Record<string, unknown> = {},
  extraOver: Record<string, unknown> = {},
  payloadOver: Record<string, unknown> = {}
): FacilitatorRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "canton:mainnet",
      resource: { url: "https://api.example.com/x" },
      accepted: {} as never,
      payload: inlinePayload(payloadOver) as never,
    },
    paymentRequirements: {
      scheme: "exact",
      network: "canton:mainnet",
      amount: ATOMIC,
      asset: "CC",
      payTo: META.receiver,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: FACILITATOR,
        instrumentId: META.instrumentId,
        executeBeforeSeconds: 60,
        ...extraOver,
      },
      ...reqOver,
    } as never,
  } as FacilitatorRequest;
}

/* The captured transfer carries its own validity window, so the structural
 * validator's timing check would reject it at today's wall clock. The clock is
 * derived from the bytes themselves rather than hard-coded, so re-capturing a
 * fixture never silently strands this suite. */
beforeEach(() => {
  const prepUs = decodePrepared(RAW.toString("base64")).preparationTime;
  vi.useFakeTimers();
  vi.setSystemTime(Number((prepUs ?? 0n) / 1000n) + 1000);
});
afterEach(() => vi.useRealTimers());

/** Bare arm: nothing injected. Rule 7 bites before the signature gate, so this
 *  shape is used only where the FIRST missing capability is the point. */
const deps = { facilitatorParty: FACILITATOR };
/** Everything downstream satisfied, so the STRUCTURAL checks are what a test
 *  observes. A live preapproval a year out, and a verifier that says yes. */
const LIVE_PREAPPROVAL = new Date(Date.now() + 365 * 864e5).toISOString();
/** A preapproval genuinely BOUND to this merchant and this issuer. */
const BOUND_PREAPPROVAL = {
  receiver: META.receiver,
  dso: META.instrumentId.admin,
  expiresAt: LIVE_PREAPPROVAL,
  /** Self-provisioned: the merchant is its own provider. This repo's own
   *  documented onboarding route, so it is the COMMON shape, not an edge one. */
  provider: META.receiver,
};
/** The captured transfer's one input holding, and enough value in it. */
const INPUT_CID =
  "003ef4393069db908df8633c7d3825414e1fe21cba014b76528f62ccaef7e51306" +
  "ca121220b7036a0899ce867d3d05206e5794c542d6c3d3b9c48f41c5e9b554773a153790";
const FUNDED = async () => new Map([[INPUT_CID, "1.0000000000"]]);
const depsSigOk = {
  facilitatorParty: FACILITATOR,
  verifySignature: async () => ({ verified: true }),
  fetchPreapproval: async () => BOUND_PREAPPROVAL,
  fetchOwnedHoldingAmounts: FUNDED,
  // NO nowMs: fall through to Date.now(), which beforeEach has pinned to the
  // captured transfer's own clock. Reading the real clock here compared a 2026
  // fixture against today and made every payment look expired.
};

describe("inline arm — registry-utility Rule 7 (non-Amulet CIP-56)", () => {
  // Treat the fixture's own instrument admin as a registry-utility token so the
  // utility branch is exercised while the structural match (Rule 6) still holds.
  const UTIL = { [META.instrumentId.admin]: "https://reg.example" };

  // Rule 7 for a registry token is STRUCTURAL: the signed transfer must carry the
  // `TransferRule_DirectTransfer` delivery consequence (present only when the
  // merchant held a live preapproval at build time). This Amulet CC fixture
  // carries `TransferPreapproval_Send`, NOT the registry direct-delivery choice,
  // so treated as a registry token it fails closed — the same "no one-shot
  // preapproval" outcome the Amulet path returns, proven WITHOUT any live probe
  // (stateless → a retried settle is idempotent). The positive case (a real
  // MainNet USDCx transfer that DOES carry the delivery consequence) is covered in
  // inline-transfer-registry.test.ts against the captured USDCx bytes.
  it("a transfer lacking the registry direct-delivery consequence fails closed", async () => {
    const fetchPreapproval = vi.fn(async () => BOUND_PREAPPROVAL);
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchPreapproval,
      tokenRegistries: UTIL,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "invalid_exact_canton_preapproval_missing",
    });
    // The Amulet lookup must NOT run for a utility instrument.
    expect(fetchPreapproval).not.toHaveBeenCalled();
  });
});

describe("isInlineCarriage", () => {
  it("discriminates the two carriages", () => {
    expect(isInlineCarriage(inlinePayload())).toBe(true);
    expect(isInlineCarriage({ submissionRef: "r" })).toBe(false);
    expect(isInlineCarriage(null)).toBe(false);
  });
});

describe("inline arm — the honest MainNet payment", () => {
  it("proves the payer from the signed bytes, not from any client claim", async () => {
    const r = await validateInlineTransferPath(request(), depsSigOk);
    expect(r.ok).toBe(true);
    expect(r.payer).toBe(META.sender);
    // The bytes /settle would relay are returned verbatim.
    expect(r.preparedTransactionBytes).toEqual(RAW);
  });

  it("passes every structural check, then stops at the signature gate", async () => {
    // Everything upstream satisfied EXCEPT the verifier. Reaching
    // signature_invalid — rather than any structural or preapproval reason —
    // proves amount/receiver/instrument/payer/preapproval all matched: the
    // signature gate is genuinely LAST.
    const { verifySignature: _drop, ...noVerifier } = depsSigOk;
    const r = await validateInlineTransferPath(request(), noVerifier);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_signature_invalid");
    expect(r.payer).toBe(META.sender);
  });

  it("treats a verifier that says no, or that throws, as unverified", async () => {
    for (const verifySignature of [
      async () => ({ verified: false }),
      async () => {
        throw new Error("hasher exploded");
      },
    ]) {
      const r = await validateInlineTransferPath(request(), {
        ...depsSigOk,
        verifySignature: verifySignature as InlineValidationDeps["verifySignature"],
      });
      expect(r.reason).toBe("invalid_exact_canton_signature_invalid");
    }
  });
});


describe("inline arm — whose traffic we are willing to burn", () => {
  // /settle is unauthenticated. Without a policy, a stranger can post a
  // well-formed payment between two parties we have no relationship with and
  // make this facilitator pay the Global-Synchronizer traffic to relay it. The
  // feePayer rule only confirms we were named; it cannot stop the naming.
  const FACILITATOR_PROVIDED = {
    ...BOUND_PREAPPROVAL,
    provider: FACILITATOR,
  };

  it("defaults to OPEN — a deploy that sets nothing behaves exactly as before", async () => {
    // The single most important case here: shipping this must not change any
    // running facilitator until its operator opts in.
    expect((await validateInlineTransferPath(request(), depsSigOk)).ok).toBe(true);
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "open",
    });
    expect(r.ok).toBe(true);
  });

  it("under `provider`, accepts a merchant whose preapproval names US", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "provider",
      fetchPreapproval: async () => FACILITATOR_PROVIDED,
    });
    expect(r.ok).toBe(true);
  });

  it("under `provider`, refuses a merchant we have no relationship with", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "provider",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_merchant_not_registered");
    // The payer is still echoed: a merchant reading this can see who tried.
    expect(r.payer).toBe(META.sender);
  });

  it("refuses when the provider field never arrived, rather than passing blind", async () => {
    // The composition root maps this from the Scan record. If that mapping is
    // ever dropped, the gate must FAIL rather than silently admit everyone —
    // an absent field is not evidence of a relationship.
    const { provider: _drop, ...noProvider } = BOUND_PREAPPROVAL;
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "provider",
      fetchPreapproval: async () => noProvider,
    });
    expect(r.reason).toBe("invalid_exact_canton_merchant_not_registered");
  });

  it("under `allowlist`, accepts exactly the declared merchants", async () => {
    const allowed = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "allowlist",
      merchantAllowlist: [META.receiver],
    });
    expect(allowed.ok).toBe(true);

    const notAllowed = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "allowlist",
      merchantAllowlist: ["someone_else::1220" + "99".repeat(32)],
    });
    expect(notAllowed.reason).toBe("invalid_exact_canton_merchant_not_registered");
  });

  it("under `provider-or-allowlist`, EITHER proof is enough", async () => {
    // The mode an operator should actually run. `provider` alone would refuse
    // every self-provisioned merchant — the common case — so the allowlist arm
    // is what makes the on-ledger arm safe to turn on at all.
    const byList = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "provider-or-allowlist",
      merchantAllowlist: [META.receiver],
    });
    expect(byList.ok).toBe(true);

    const byProvider = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "provider-or-allowlist",
      merchantAllowlist: [],
      fetchPreapproval: async () => FACILITATOR_PROVIDED,
    });
    expect(byProvider.ok).toBe(true);

    const neither = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "provider-or-allowlist",
      merchantAllowlist: [],
    });
    expect(neither.reason).toBe("invalid_exact_canton_merchant_not_registered");
  });

  it("refuses BEFORE the signature work, so an unserved merchant costs nothing", async () => {
    // Ordering is the point: the gate sits after the local structural checks
    // and before the deadline and signature legs. A verifier that throws would
    // surface as a signature failure if the gate ran late.
    let verifierCalled = false;
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      merchantPolicy: "provider",
      verifySignature: async () => {
        verifierCalled = true;
        return { verified: true };
      },
    });
    expect(r.reason).toBe("invalid_exact_canton_merchant_not_registered");
    expect(verifierCalled).toBe(false);
  });
});

describe("inline arm — the merchant gets what was quoted", () => {
  it("rejects a receiver that is not the merchant", async () => {
    const r = await validateInlineTransferPath(
      request({ payTo: "attacker::1220" + "cd".repeat(32) }),
      depsSigOk
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_merchant_mismatch");
    expect(r.payer).toBe(META.sender);
  });

  it("rejects an amount that differs from the requirement", async () => {
    const r = await validateInlineTransferPath(
      request({ amount: "200000000" }),
      depsSigOk
    );
    expect(r.reason).toBe("invalid_exact_canton_amount_mismatch");
  });

  it("accepts the same amount written differently", async () => {
    // Atomic wire units vs the ledger's Daml Decimal: the comparison must be
    // numeric, or every honest payment whose text form differs would be
    // rejected as fraud.
    const r = await validateInlineTransferPath(request({ amount: ATOMIC }), depsSigOk);
    expect(r.ok).toBe(true);
  });

  it("rejects a different instrument admin", async () => {
    const r = await validateInlineTransferPath(
      request({}, { instrumentId: { admin: "EvilDSO::1220" + "ef".repeat(32), id: "Amulet" } }),
      depsSigOk
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_instrument_id_mismatch");
  });

  it("rejects a fee payer that is not this facilitator", async () => {
    // Otherwise we would spend our own traffic budget settling a payment quoted
    // against somebody else's relayer.
    const r = await validateInlineTransferPath(
      request({}, { feePayer: "other_facilitator::1220" + "11".repeat(32) }),
      depsSigOk
    );
    expect(r.reason).toBe("invalid_exact_canton_fee_payer_mismatch");
  });

  it("rejects a payment whose proven payer is the facilitator itself", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      facilitatorParty: META.sender,
    });
    expect(r.reason).toBe("invalid_exact_canton_self_payment");
  });
});

describe("inline arm — hostile bytes never reach the ledger", () => {
  it("rejects a decompression bomb as a malformed payload", async () => {
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024), { level: 9 }).toString("base64");
    const r = await validateInlineTransferPath(
      request({}, {}, { preparedTransaction: bomb }),
      depsSigOk
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_malformed_payload");
  });

  it("rejects gzip that is not a prepared transaction", async () => {
    const junk = gzipSync(Buffer.alloc(500, 0x41)).toString("base64");
    const r = await validateInlineTransferPath(
      request({}, {}, { preparedTransaction: junk }),
      depsSigOk
    );
    expect(r.reason).toBe("invalid_exact_canton_malformed_payload");
    expect(r.payer).toBe(""); // no payer could be proven, so none is claimed
  });

  it("rejects a payload missing its proof fields", async () => {
    const { signature: _drop, ...noSig } = inlinePayload();
    const req = request();
    (req.paymentPayload as { payload: unknown }).payload = noSig;
    const r = await validateInlineTransferPath(req, depsSigOk);
    expect(r.reason).toBe("invalid_exact_canton_missing_proof");
  });

  it("shows WHY the signature gate is mandatory: structure alone cannot see tampering", async () => {
    // Most of the 26 KB is disclosed-contract blobs the structural validator
    // passes through rather than parses. Flip a byte in there and every
    // structural check still passes — the transfer still says the right
    // receiver, amount and instrument.
    const mutated = Buffer.from(RAW);
    mutated[Math.floor(mutated.length / 2)] ^= 0xff;
    const tampered = request(
      {},
      {},
      {
        preparedTransaction: encodeInlinePaymentPayload({
          preparedTransactionBytes: mutated,
          preparedTxHash: "1220" + "ab".repeat(32),
          signatureB64: Buffer.alloc(64, 7).toString("base64"),
        }).preparedTransaction,
      }
    );

    // With a verifier that rubber-stamps anything, the tampering survives.
    // That is not a hole in this arm — it is the precise reason Rule 3 exists:
    // structure proves the bytes SAY the right thing; only the hash+signature
    // proves the payer AUTHORISED these exact bytes.
    expect((await validateInlineTransferPath(tampered, depsSigOk)).ok).toBe(true);

    // With no verifier wired — today's real configuration — it is refused.
    const { verifySignature: _drop, ...noVerifier } = depsSigOk;
    const real = await validateInlineTransferPath(tampered, noVerifier);
    expect(real.ok).toBe(false);
    expect(real.reason).toBe("invalid_exact_canton_signature_invalid");
  });
});

describe("inline arm — Rule 7, the merchant must be able to be paid directly", () => {
  const base = { ...depsSigOk };

  it("refuses when the merchant holds no preapproval", async () => {
    // Without one the transfer resolves to a PENDING two-step instruction:
    // the payer's funds commit and the merchant is not paid. Refusing before
    // relaying is what keeps that half-settled state from existing.
    const r = await validateInlineTransferPath(request(), {
      ...base,
      fetchPreapproval: async () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
    expect(r.payer).toBe(META.sender);
  });

  it("refuses an EXPIRED preapproval", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...base,
      fetchPreapproval: async () => ({ ...BOUND_PREAPPROVAL, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    });
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
  });

  it("treats an unreadable expiry as expired, not as probably fine", async () => {
    for (const bad of ["", "soon", "not-a-date"]) {
      const r = await validateInlineTransferPath(request(), {
        ...base,
        fetchPreapproval: async () => ({ ...BOUND_PREAPPROVAL, expiresAt: bad }),
      });
      expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
    }
  });

  it("refuses when the lookup throws — an unknown answer is not a yes", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...base,
      fetchPreapproval: async () => {
        throw new Error("scan unreachable");
      },
    });
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
  });

  it("refuses when no reader is wired at all", async () => {
    const { fetchPreapproval: _drop, ...noReader } = base;
    const r = await validateInlineTransferPath(request(), noReader);
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
  });

  it("asks about the MERCHANT, never about the payer", async () => {
    // The preapproval that matters belongs to whoever is being paid. Asking
    // about the payer would pass for any payer that happens to run a merchant.
    const asked: string[] = [];
    await validateInlineTransferPath(request(), {
      ...base,
      fetchPreapproval: async (p: string) => {
        asked.push(p);
        return BOUND_PREAPPROVAL;
      },
    });
    expect(asked).toEqual([META.receiver]);
  });

  it("does not spend a Scan lookup on a structurally invalid payload", async () => {
    // Junk must never cost an external call — that is an amplification the
    // attacker gets for free.
    let calls = 0;
    const r = await validateInlineTransferPath(
      request({ payTo: "attacker::1220" + "cd".repeat(32) }),
      {
        ...base,
        fetchPreapproval: async () => {
          calls++;
          return BOUND_PREAPPROVAL;
        },
      }
    );
    expect(r.reason).toBe("invalid_exact_canton_merchant_mismatch");
    expect(calls).toBe(0);
  });
});

describe("inline arm — Rule 12, the merchant's memo is compared for real", () => {
  it("refuses when the merchant requires a memo the transfer does not carry", async () => {
    // The captured MainNet transfer has an EMPTY meta map, so a merchant that
    // demands a memo is not satisfied by it. Absent counts as a mismatch —
    // fail-closed, not "no memo means any memo".
    const r = await validateInlineTransferPath(
      request({}, { memo: "invoice-2024-001" }),
      depsSigOk
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_memo_mismatch");
    expect(r.payer).toBe(META.sender);
  });

  it("is unaffected when the merchant sets no memo — the common case", async () => {
    expect((await validateInlineTransferPath(request(), depsSigOk)).ok).toBe(true);
    for (const memo of [undefined, ""]) {
      const r = await validateInlineTransferPath(request({}, { memo }), depsSigOk);
      expect(r.ok).toBe(true);
    }
  });
});

describe("inline arm — Rule 13, the declared inputs must be real", () => {
  it("the real MainNet payment declares exactly one input holding", async () => {
    // Pins the shape the rule reasons over, read from the signed bytes.
    const { extractTransfer, decodePrepared } = await import(
      "@ftptech/x402-canton-core"
    );
    const d = decodePrepared(RAW.toString("base64"));
    const ex = d.exercises.find((e) =>
      /TransferFactory_Transfer/.test(e.choiceId)
    );
    const t = extractTransfer(ex!.chosenValue!);
    expect(t.inputHoldingCids).toHaveLength(1);
    expect(new Set(t.inputHoldingCids).size).toBe(1);
    expect(t.memo).toBeUndefined(); // empty meta on the captured transfer
  });
});

describe("inline arm — Rule 13, the declared inputs must cover the payment", () => {
  it("accepts when the payer's holding covers the amount", async () => {
    const r = await validateInlineTransferPath(request(), depsSigOk);
    expect(r.ok).toBe(true);
  });

  it("refuses when the holdings sum below the amount", async () => {
    // 0.01 CC required; the holding has 0.009.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () =>
        new Map([[INPUT_CID, "0.0090000000"]]),
    });
    expect(r.reason).toBe("invalid_exact_canton_insufficient_inputs");
  });

  it("accepts a holding worth EXACTLY the amount", async () => {
    // Off-by-one on the boundary would reject a legitimate exact-change
    // payment. Fees are out of scope here by design — see the arm.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () =>
        new Map([[INPUT_CID, "0.0100000000"]]),
    });
    expect(r.ok).toBe(true);
  });

  it("compares exactly, without float rounding", async () => {
    // One atomic unit short. A float-based comparison would call this equal.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () =>
        new Map([[INPUT_CID, "0.0099999999"]]),
    });
    expect(r.reason).toBe("invalid_exact_canton_insufficient_inputs");
  });

  it("refuses a malformed holding amount rather than coercing it", async () => {
    for (const bad of ["", "abc", "-1.0", "1.00000000000"]) {
      const r = await validateInlineTransferPath(request(), {
        ...depsSigOk,
        fetchOwnedHoldingAmounts: async () => new Map([[INPUT_CID, bad]]),
      });
      expect(r.reason).toBe("invalid_exact_canton_insufficient_inputs");
    }
  });

  it("refuses a preapproval that has not become ACTIVE yet", async () => {
    // Unexpired is not the same as active. A preapproval whose validFrom is in
    // the future would leave the transfer resolving to a PENDING two-step —
    // the merchant does not get paid, which is the exact state Rule 7 exists
    // to prevent. Nothing else about the payment is wrong here.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchPreapproval: async () => ({
        ...BOUND_PREAPPROVAL,
        validFrom: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");

    // Already active passes, so the guard is a window and not a blanket
    // refusal of every preapproval that reports the field.
    const ok = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchPreapproval: async () => ({
        ...BOUND_PREAPPROVAL,
        validFrom: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    expect(ok.ok).toBe(true);
  });

  it("SKIPS the sum when no authoritative view exists — it does not refuse", async () => {
    // This is the one place in the arm where absence means skip, and it is
    // deliberate. The scheme makes the sum conditional on hosting the payer.
    // Refusing without a view would reject every payer we do not host — the
    // exact population the inline carriage exists to serve — and an over-strict
    // money path is an outage, not a defence.
    const throwing = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () => {
        throw new Error("holdings read down");
      },
    });
    expect(throwing.ok).toBe(true);

    const { fetchOwnedHoldingAmounts: _drop, ...unwired } = depsSigOk;
    expect((await validateInlineTransferPath(request(), unwired)).ok).toBe(true);

    // An explicit "I looked and cannot tell" is also a skip, not a refusal.
    const unknown = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () => undefined,
    });
    expect(unknown.ok).toBe(true);
  });

  it("still refuses when an AUTHORITATIVE view says the inputs fall short", async () => {
    // Skipping on absence must not weaken the case where we DO know: every
    // declared input is visible to us, and together they do not cover the
    // payment.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () => new Map([[INPUT_CID, "0.0000000001"]]),
    });
    expect(r.reason).toBe("invalid_exact_canton_insufficient_inputs");
  });

  it("treats a PARTIAL view as no view — a foreign payer is not a liar", async () => {
    // The failure this prevents: reading a party's contracts requires rights on
    // that party, so for a payer we do not host the query returns nothing
    // rather than erroring. Reading "input not in my view" as "input does not
    // exist" would refuse every foreign payer the moment a holdings reader was
    // wired — the exact population the inline carriage exists to serve. A
    // transfer that really names a holding it does not own is refused by the
    // LEDGER; the cost of passing it here is traffic, which is already bounded.
    const empty = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () => new Map(),
    });
    expect(empty.ok).toBe(true);

    // Same for a view that shows OTHER holdings but not the declared one.
    const elsewhere = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchOwnedHoldingAmounts: async () =>
        new Map([["00" + "ff".repeat(48), "999.0000000000"]]),
    });
    expect(elsewhere.ok).toBe(true);
  });
});

describe("inline arm — regressions the audit found", () => {
  it("Rule 9: an ABSENT feePayer is a mismatch, not a pass", async () => {
    // /settle is unauthenticated. Treating a missing feePayer as fine let anyone
    // hand this facilitator a transfer quoted against a different relayer and
    // make it pay the Global Synchronizer fee in real CC.
    const { feePayer: _drop, ...noFeePayer } = {
      assetTransferMethod: "transfer-factory",
      feePayer: FACILITATOR,
      instrumentId: META.instrumentId,
      executeBeforeSeconds: 60,
    };
    const req = request();
    (req.paymentRequirements as { extra: unknown }).extra = noFeePayer;
    const r = await validateInlineTransferPath(req, depsSigOk);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_fee_payer_mismatch");
  });

  it("Rule 10: a transfer past its executeBefore is refused", async () => {
    // Relaying it would burn traffic for a submission the ledger will reject.
    const past = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      nowMs: Date.now() + 10 * 60_000,
    });
    expect(past.reason).toBe("invalid_exact_canton_expired");
  });

  it("Rule 10 the other way: a deadline further out than we allow is refused", async () => {
    // The floor was the only half. The payer alone decided how long its payment
    // stayed settleable — and therefore how long the facilitator's settle
    // record, and the merchant's one-payment-one-delivery ticket, had to keep
    // remembering it. The relay path has always clamped this; the inline
    // carriage skips prepare by construction, so it needs the ceiling handed to
    // it. Distinct code, so a client can shorten the horizon and retry.
    const { extractTransfer, decodePrepared } = await import(
      "@ftptech/x402-canton-core"
    );
    const ex = decodePrepared(RAW.toString("base64")).exercises.find((e) =>
      /TransferFactory_Transfer/.test(e.choiceId)
    );
    const deadline = extractTransfer(ex!.chosenValue!).executeBeforeMs!;

    // Pretend we are far enough back that this fixture's deadline sits well
    // beyond a 60 s ceiling.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      nowMs: deadline - 10 * 60_000,
      maxExecuteBeforeSeconds: 60,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_execute_before_too_far");
  });

  it("a deadline INSIDE the ceiling still passes — the honest client is unaffected", async () => {
    // The discriminator. The relay's own default horizon is 120 s and its
    // ceiling 600 s, so a transfer prepared through the shipped path must sail
    // through this; a ceiling that refused it would take the money path down.
    const { extractTransfer, decodePrepared } = await import(
      "@ftptech/x402-canton-core"
    );
    const ex = decodePrepared(RAW.toString("base64")).exercises.find((e) =>
      /TransferFactory_Transfer/.test(e.choiceId)
    );
    const deadline = extractTransfer(ex!.chosenValue!).executeBeforeMs!;

    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      nowMs: deadline - 30_000, // 30 s of headroom left
      maxExecuteBeforeSeconds: 600,
    });
    expect(r.reason).not.toBe("invalid_exact_canton_execute_before_too_far");
  });

  it("no ceiling configured means no ceiling — the check is opt-in by wiring", async () => {
    // services.ts always passes the configured value; a caller constructing
    // these deps by hand must not have a bound appear from nowhere.
    const { extractTransfer, decodePrepared } = await import(
      "@ftptech/x402-canton-core"
    );
    const ex = decodePrepared(RAW.toString("base64")).exercises.find((e) =>
      /TransferFactory_Transfer/.test(e.choiceId)
    );
    const deadline = extractTransfer(ex!.chosenValue!).executeBeforeMs!;
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      nowMs: deadline - 10 * 60_000,
    });
    expect(r.reason).not.toBe("invalid_exact_canton_execute_before_too_far");
  });

  it("Rule 10: the margin bites — expiring inside it is already too late", async () => {
    const { extractTransfer, decodePrepared } = await import(
      "@ftptech/x402-canton-core"
    );
    const ex = decodePrepared(RAW.toString("base64")).exercises.find((e) =>
      /TransferFactory_Transfer/.test(e.choiceId)
    );
    const deadline = extractTransfer(ex!.chosenValue!).executeBeforeMs!;
    expect(deadline).toBeGreaterThan(0);

    // 1 ms before the deadline: inside the settle margin, so refused.
    const tight = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      nowMs: deadline - 1,
    });
    expect(tight.reason).toBe("invalid_exact_canton_expired");
  });
});

describe("inline arm — audit round 2: pinning and binding", () => {
  it("Rule 6: a requirements block with no instrumentId cannot be paid", async () => {
    // The old fallback to a bare "Amulet" left the issuer unpinned AND left the
    // trusted-admin foreign-party backstop switched off. A merchant that does
    // not say which instrument it wants cannot be paid in it.
    for (const bad of [
      undefined,
      {},
      { id: "Amulet" },
      { admin: META.instrumentId.admin },
      { admin: "", id: "Amulet" },
    ]) {
      const r = await validateInlineTransferPath(
        request({}, { instrumentId: bad }),
        depsSigOk
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("invalid_exact_canton_instrument_id_mismatch");
    }
  });

  it("Rule 7: a preapproval belonging to somebody ELSE does not count", async () => {
    // Reading only the expiry accepted any live preapproval on the network.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchPreapproval: async () => ({
        ...BOUND_PREAPPROVAL,
        receiver: "other_merchant::1220" + "99".repeat(32),
      }),
    });
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
  });

  it("Rule 7: a preapproval for a DIFFERENT issuer does not count", async () => {
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      fetchPreapproval: async () => ({
        ...BOUND_PREAPPROVAL,
        dso: "OtherDSO::1220" + "88".repeat(32),
      }),
    });
    expect(r.reason).toBe("invalid_exact_canton_preapproval_missing");
  });
});

describe("classifyMismatch — staleness has three spellings, not one", () => {
  /**
   * Driven by the REAL validator, not by strings invented here. The core
   * timing check is given a `nowMs` far past the fixture's own timestamps, so
   * it produces its genuine message, and that message is what gets classified.
   *
   * Coupling the test to the producer this way is the point: if core ever
   * rewords "already in the past", this fails loudly instead of quietly
   * reverting a slow payer to `malformed_payload`.
   */
  it("a stale payload comes back EXPIRED from the real route, not MALFORMED", async () => {
    // Drives the production path with the clock moved past the fixture's own
    // deadlines — the same thing that happens to a payer who is simply slow.
    //
    // Written this way rather than by feeding a hand-made string to the
    // classifier: the classifier can only be right if the message it receives
    // is the message the validator actually produces, and that coupling is the
    // part worth pinning.
    // The fixture was prepared at 09:52:06.778Z and its
    // max_ledger_effective_time is 09:54:06.707Z — two minutes of life. One
    // hour later it is stale, while still inside the validator's 24h
    // preparation-time tolerance, so the check that fires is the DEADLINE one
    // and not the "implausibly far from now" one. That is the shape a slow
    // payer produces, and picking the clock by measuring the fixture rather
    // than by choosing a round number is what makes it that shape.
    const r = await validateInlineTransferPath(request(), {
      ...depsSigOk,
      nowMs: Date.parse("2026-08-02T10:52:06Z"),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_exact_canton_expired");
  });

  it("covers each spelling the timing check can produce", () => {
    for (const m of [
      "relay-prepared transaction max_record_time (2020-01-01T00:00:00.000Z) is already in the past — refusing to sign (command could never be recorded)",
      "relay-prepared transaction max_ledger_effective_time (2020-01-01T00:00:00.000Z) is already in the past",
      "executeBefore has passed",
      "transfer is expired",
    ]) {
      expect(classifyMismatch(m)).toBe("invalid_exact_canton_expired");
    }
  });

  it("still answers the other fields, and still falls through honestly", () => {
    expect(classifyMismatch("amount mismatch")).toBe("invalid_exact_canton_amount_mismatch");
    expect(classifyMismatch("receiver mismatch")).toBe("invalid_exact_canton_merchant_mismatch");
    expect(classifyMismatch("instrument admin mismatch")).toBe("invalid_exact_canton_instrument_id_mismatch");
    expect(classifyMismatch("memo mismatch")).toBe("invalid_exact_canton_memo_mismatch");
    expect(classifyMismatch("input holding not owned")).toBe("invalid_exact_canton_insufficient_inputs");
    // An unrecognised message must NOT be guessed into a specific code: a
    // confidently wrong reason is worse than an honest generic one.
    expect(classifyMismatch("something nobody anticipated")).toBe(
      "invalid_exact_canton_malformed_payload"
    );
  });
});
