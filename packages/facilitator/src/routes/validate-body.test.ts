import { describe, it, expect } from "vitest";
import { validateFacilitatorRequestShape } from "./validate-body.js";

// A well-formed transfer-factory body — the generic VALID fixture most tests
// build on. transfer-factory is the SOLE settlement method: the payload carries
// a non-empty payer + a bounded submissionRef; extra carries the discriminator +
// instrument fields.
const VALID = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: "canton:devnet",
    resource: { url: "https://api.example.com/data" },
    accepted: {},
    payload: {
      assetTransferMethod: "transfer-factory",
      payer: "agent::1220",
      submissionRef: "8f14e45f-ceea-467f-9c1d-1a2b3c4d5e6f",
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: "canton:devnet",
    amount: "1000000000",
    asset: "canton-coin",
    payTo: "merchant::1220",
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory",
      feePayer: "fac::1220",
      synchronizerId: "sync::1220",
      instrumentId: { admin: "admin::1220", id: "cc" },
      executeBeforeSeconds: 120,
    },
  },
};

describe("validateFacilitatorRequestShape", () => {
  it("accepts a well-formed v2 body", () => {
    const r = validateFacilitatorRequestShape(VALID);
    expect(r.ok).toBe(true);
  });

  // PAYER FIELD (phdargen naming): the wire payer-party field is `payer`. The
  // legacy `payerParty` is retired — the body validator now REQUIRES `payer`.
  describe("payer field", () => {
    const withPayload = (payload: Record<string, unknown>) => ({
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, payload },
    });
    const base = {
      assetTransferMethod: "transfer-factory",
      submissionRef: "8f14e45f-ceea-467f-9c1d-1a2b3c4d5e6f",
    };

    it("accepts a payload with `payer` (new primary key)", () => {
      const r = validateFacilitatorRequestShape(
        withPayload({ ...base, payer: "agent::1220" })
      );
      expect(r.ok).toBe(true);
    });

    it("rejects a payload with ONLY the retired `payerParty` (no `payer`)", () => {
      const r = validateFacilitatorRequestShape(
        withPayload({ ...base, payerParty: "agent::1220" })
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/payer/);
    });

    it("accepts a payload with BOTH `payer` and `payerParty`", () => {
      const r = validateFacilitatorRequestShape(
        withPayload({ ...base, payer: "agent::1220", payerParty: "agent::1220" })
      );
      expect(r.ok).toBe(true);
    });

    it("rejects a payload with NEITHER `payer` nor `payerParty`", () => {
      const r = validateFacilitatorRequestShape(withPayload({ ...base }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/payer/);
    });

    it("rejects when both keys are empty strings (neither valid)", () => {
      const r = validateFacilitatorRequestShape(
        withPayload({ ...base, payer: "", payerParty: "" })
      );
      expect(r.ok).toBe(false);
    });

    it("accepts when `payer` is set even if `payerParty` is empty", () => {
      const r = validateFacilitatorRequestShape(
        withPayload({ ...base, payer: "agent::1220", payerParty: "" })
      );
      expect(r.ok).toBe(true);
    });
  });

  it("rejects non-object bodies", () => {
    expect(validateFacilitatorRequestShape(null).ok).toBe(false);
    expect(validateFacilitatorRequestShape("foo").ok).toBe(false);
    expect(validateFacilitatorRequestShape(42).ok).toBe(false);
    expect(validateFacilitatorRequestShape([]).ok).toBe(false);
  });

  it("rejects bodies with the wrong x402Version", () => {
    const r = validateFacilitatorRequestShape({
      ...VALID,
      x402Version: "v2",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/x402Version/);
  });

  it("rejects when paymentPayload.scheme isn't exact", () => {
    const bad = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, scheme: "exact-eth" },
    };
    const r = validateFacilitatorRequestShape(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exact/);
  });

  it("rejects when network doesn't start with canton:", () => {
    const bad = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, network: "eip155:1" },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects missing resource.url", () => {
    const bad = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, resource: {} },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects unknown assetTransferMethod", () => {
    const bad = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        payload: {
          ...VALID.paymentPayload.payload,
          assetTransferMethod: "deposit-and-call",
        },
      },
    };
    const r = validateFacilitatorRequestShape(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/assetTransferMethod/);
  });

  it("rejects empty payerParty when no payer is present (neither key valid)", () => {
    const bad = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        // Replace the whole payload so `payer` is ABSENT and the only payer-party
        // field is the empty (retired) payerParty → no valid `payer` → rejected.
        payload: {
          assetTransferMethod: "transfer-factory",
          submissionRef: "8f14e45f-ceea-467f-9c1d-1a2b3c4d5e6f",
          payerParty: "",
        },
      },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects when paymentRequirements is missing required fields", () => {
    const bad = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, amount: 5 },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects paymentPayload being a non-object", () => {
    const bad = { ...VALID, paymentPayload: "oops" };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });
});

describe("validate-body additional edge cases", () => {
  it("rejects x402Version as string '2'", () => {
    const bad = { ...VALID, x402Version: "2" };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects null paymentPayload", () => {
    const bad = { ...VALID, paymentPayload: null };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects array paymentRequirements", () => {
    const bad = { ...VALID, paymentRequirements: [VALID.paymentRequirements] };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects null payerParty", () => {
    const bad = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        // Replace the whole payload so `payer` is ABSENT and the only payer-party
        // field is the null (retired) payerParty → no valid `payer` → rejected.
        payload: {
          assetTransferMethod: "transfer-factory",
          submissionRef: "8f14e45f-ceea-467f-9c1d-1a2b3c4d5e6f",
          payerParty: null,
        },
      },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects numeric amount in paymentRequirements", () => {
    const bad = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, amount: 1.5 },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects missing extra object", () => {
    const bad = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, extra: undefined },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });

  it("rejects payload.assetTransferMethod = null", () => {
    const bad = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        payload: { ...VALID.paymentPayload.payload, assetTransferMethod: null },
      },
    };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });



  it("accepts x402Version = 1 (backwards compat)", () => {
    const v1 = { ...VALID, x402Version: 1 as const };
    expect(validateFacilitatorRequestShape(v1).ok).toBe(true);
  });

  it("rejects x402Version = 99 (unknown)", () => {
    const bad = { ...VALID, x402Version: 99 };
    expect(validateFacilitatorRequestShape(bad).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-field and network mismatch tests
// ---------------------------------------------------------------------------

describe("validate-body cross-field checks (network / scheme / extra.assetTransferMethod)", () => {
  it("accepts when paymentPayload.network differs from paymentRequirements.network (body validator does not cross-check)", () => {
    // Network cross-field enforcement is in common.ts runValidation,
    // not in the body validator. Document current accepted behaviour.
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        network: "canton:mainnet" as const,
      },
      paymentRequirements: {
        ...VALID.paymentRequirements,
        network: "canton:devnet" as const,
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("rejects when paymentPayload.scheme is not exact (scheme mismatch → 400)", () => {
    // The body validator checks paymentPayload.scheme — a payload with a
    // non-exact scheme is rejected immediately with 400.
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        scheme: "exact-eth",
      },
    };
    const r = validateFacilitatorRequestShape(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exact/);
  });

  it("accepts when paymentRequirements.extra has no assetTransferMethod field (body validator only requires extra to be an object)", () => {
    // extra.assetTransferMethod is not validated by the body validator —
    // that enforcement lives in common.ts discriminator check.
    // Document current accepted behaviour so a future tightening is explicit.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        extra: { feePayer: "fac::1220" }, // no assetTransferMethod key
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("accepts x402Version=1 in paymentPayload and x402Version=2 at top-level", () => {
    // The body validator only checks the top-level x402Version.
    // Payloads carrying x402Version=1 inside paymentPayload are not rejected
    // here — backwards compatibility is a concern for the protocol layer.
    const body = {
      ...VALID,
      x402Version: 2,
      paymentPayload: {
        ...VALID.paymentPayload,
        x402Version: 1,
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Amount string edge cases
// ---------------------------------------------------------------------------

describe("validate-body amount string edge cases", () => {
  it("accepts a very long amount string — body validator only type-checks, not length-checks", () => {
    // The validator checks `typeof req.amount !== "string"` but imposes
    // no length constraint. A 1000-char string passes validation here;
    // downstream semantic validation would reject it at settlement time.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        amount: "9".repeat(1000),
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("accepts an amount string containing Unicode digits — body validator only type-checks", () => {
    // Unicode chars in amount: body validator does not run numeric
    // parsing. Downstream logic (the allocation amount pin) rejects
    // semantic nonsense; the 400 gate only blocks non-string types.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        amount: "１０００",  // fullwidth digits
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("rejects when amount is a number (not a string)", () => {
    const body = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, amount: 1000 },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(false);
  });

  it("amount = '' (empty string) → accepted (body validator only checks typeof, not length)", () => {
    // The body validator checks `typeof req.amount !== "string"` only.
    // An empty string passes that check; semantic rejection (non-numeric
    // empty amount) happens downstream at the allocation amount-pin step.
    // Document current accepted behaviour so a future tightening is explicit.
    const body = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, amount: "" },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extra field edge cases
// ---------------------------------------------------------------------------

describe("validate-body extra field edge cases", () => {
  it("paymentRequirements.extra.feePayer missing → accepted (body validator only requires extra to be an object)", () => {
    // The body validator calls isObject(req.extra) — it does NOT check
    // for individual keys inside extra (feePayer, synchronizerId).
    // Missing feePayer is accepted here and rejected downstream
    // during runValidation's network / discriminator checks.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        extra: { synchronizerId: "sync::1220" }, // no feePayer
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("paymentRequirements.extra.synchronizerId missing → accepted (body validator does not require it)", () => {
    // Same as above: synchronizerId is not checked by the body validator.
    // It is consumed by the Canton submit path at /settle, not during
    // the shape-validation gate at /verify.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        extra: { feePayer: "fac::1220" }, // no synchronizerId
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("paymentPayload.payload with extra unknown fields → accepted (forward compatibility)", () => {
    // Unknown keys in payload must not cause a rejection. The validator
    // only reads the fields it cares about; extra properties are ignored.
    // This ensures forward-compat with new payload extensions.
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        payload: {
          ...VALID.paymentPayload.payload,
          unknownFutureField: "some-value",
          anotherNewField: 42,
        },
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });


  it("paymentRequirements.maxTimeoutSeconds = 0 → accepted (body validator does not validate this field)", () => {
    // maxTimeoutSeconds = 0 is semantically odd (instant timeout) but
    // the body validator does not read this field at all. It passes
    // through to the route handler unchanged.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        maxTimeoutSeconds: 0,
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });


  it("paymentPayload with null resource → 400", () => {
    // resource must be an object with a string url field.
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        resource: null,
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(false);
  });

  it("paymentPayload.resource.url = '' → accepted (body validator only checks typeof string, not length)", () => {
    // The validator checks `typeof pp.resource.url !== "string"`.
    // An empty string is still typeof "string" → accepted here.
    // Downstream runValidation / resource matching would reject it semantically.
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        resource: { url: "" },
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("paymentRequirements.scheme = 'EXACT' (wrong case) → 400", () => {
    // The validator checks strict equality against the lowercase literal.
    // An uppercase variant must be rejected.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        scheme: "EXACT",
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(false);
  });

  it("both paymentPayload and paymentRequirements with scheme=exact → accepted", () => {
    // Both sides of the request carry the exact scheme.
    // The body validator checks paymentPayload.scheme and
    // paymentRequirements.scheme independently — both matching is valid.
    const body = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, scheme: "exact" },
      paymentRequirements: { ...VALID.paymentRequirements, scheme: "exact" },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional targeted tests per spec
// ---------------------------------------------------------------------------

describe("validate-body additional targeted tests", () => {
  it("valid minimal body with exactly the required fields → ok", () => {
    // VALID already represents the minimal valid body (no extra fields).
    // Reaffirm this as an explicit documented test with no overrides.
    const r = validateFacilitatorRequestShape(VALID);
    expect(r.ok).toBe(true);
  });

  it("paymentRequirements.scheme='exact-eth' → rejected (body validator does check paymentRequirements.scheme)", () => {
    // validate-body.ts checks req.scheme !== "exact" — the body validator
    // validates BOTH payload and requirements schemes.
    // A mismatched paymentRequirements.scheme is rejected at the 400 gate.
    const body = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, scheme: "exact" },
      paymentRequirements: { ...VALID.paymentRequirements, scheme: "exact-eth" as any },
    };
    const r = validateFacilitatorRequestShape(body);
    expect(r.ok).toBe(false);
  });

  it("payerParty with '::' in it → accepted (valid Canton party format)", () => {
    // Canton parties are "<hint>::<fingerprint>" — the '::' separator is standard.
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        payload: {
          ...VALID.paymentPayload.payload,
          payerParty: "alice::1220abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
        },
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("paymentRequirements.payTo='' (empty string) → accepted (body validator doesn't reject)", () => {
    // payTo (if present in extra or top-level) is not checked by the body validator.
    // An empty payTo passes here and would only fail at semantic validation time.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        payTo: "",
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("paymentRequirements.maxTimeoutSeconds=86400 → accepted", () => {
    // A 24-hour timeout is unusual but the body validator doesn't constrain this field.
    const body = {
      ...VALID,
      paymentRequirements: {
        ...VALID.paymentRequirements,
        maxTimeoutSeconds: 86400,
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fuzz / property tests for malformed bodies (audit).
//
// The body validator is the 400-gate that keeps junk away from the money-path,
// and it runs on a publicly-reachable endpoint. The two invariants it must
// never violate, on ANY input:
//   (1) it returns a discriminated `{ ok: boolean }` result and NEVER throws
//       (a throw becomes a 500 instead of the contract's 4xx); and
//   (2) it never mutates `Object.prototype` (prototype-pollution safety).
// These cases pin specific adversarial shapes plus a deterministic property
// loop. (Built without an external property-testing dep — the loop is a
// hand-rolled, seeded generator so the gate stays dependency-light.)
// ---------------------------------------------------------------------------

describe("validate-body fuzz — prototype pollution safety", () => {
  // The attack vector is untrusted JSON over the wire, so build the bodies the
  // same way Fastify does: JSON.parse (which makes `__proto__` an OWN data
  // property, not a prototype write). The validator must never copy these keys
  // onto any object, so Object.prototype must stay pristine and no throw.
  function expectNoPollution(json: string) {
    const before = (Object.prototype as Record<string, unknown>).polluted;
    expect(before).toBeUndefined();
    const raw: unknown = JSON.parse(json);
    let result: ReturnType<typeof validateFacilitatorRequestShape> | undefined;
    expect(() => {
      result = validateFacilitatorRequestShape(raw);
    }).not.toThrow();
    // Discriminated result, no prototype write, no leaked key on a fresh object.
    expect(typeof result?.ok).toBe("boolean");
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  }

  it("__proto__ on the top-level body does not pollute and does not throw", () => {
    expectNoPollution('{"__proto__":{"polluted":"yes"},"x402Version":2}');
  });

  it("__proto__ inside paymentPayload.payload does not pollute / throw", () => {
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        payload: { ...VALID.paymentPayload.payload },
      },
    };
    // Inject via JSON so __proto__ is an own key on payload.
    const json = JSON.stringify(body).replace(
      '"payload":{',
      '"payload":{"__proto__":{"polluted":"yes"},'
    );
    expectNoPollution(json);
  });

  it("__proto__ inside paymentRequirements.extra does not pollute / throw", () => {
    const json = JSON.stringify(VALID).replace(
      '"extra":{',
      '"extra":{"__proto__":{"polluted":"yes"},'
    );
    expectNoPollution(json);
  });

  it("constructor / prototype keys on raw do not pollute / throw", () => {
    expectNoPollution(
      '{"constructor":{"polluted":"x"},"prototype":{"polluted":"y"},"x402Version":"bad"}'
    );
  });

  it("a valid body carrying an extra __proto__ key still validates ok without pollution", () => {
    const json = JSON.stringify(VALID).replace(
      "{",
      '{"__proto__":{"polluted":"yes"},'
    );
    const raw: unknown = JSON.parse(json);
    const r = validateFacilitatorRequestShape(raw);
    // The injected key is ignored by the field-by-field validator.
    expect(r.ok).toBe(true);
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
  });
});

describe("validate-body fuzz — huge and deeply-nested bodies (no throw, O(1) depth)", () => {
  it("a multi-MB resource.url string does not throw (only typeof checked)", () => {
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        resource: { url: "x".repeat(5_000_000) },
      },
    };
    let r: ReturnType<typeof validateFacilitatorRequestShape> | undefined;
    expect(() => {
      r = validateFacilitatorRequestShape(body);
    }).not.toThrow();
    expect(r?.ok).toBe(true); // huge but type-valid
  });

  it("a giant extra object with many keys does not throw", () => {
    const extra: Record<string, unknown> = {
      assetTransferMethod: "transfer-factory",
    };
    for (let i = 0; i < 100_000; i += 1) extra[`k${i}`] = i;
    const body = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, extra },
    };
    expect(() => validateFacilitatorRequestShape(body)).not.toThrow();
  });

  it("a deeply-nested payload value does not blow the stack (validator never recurses)", () => {
    // The validator only reads fixed top-level paths; arbitrary depth elsewhere
    // must not matter. Build ~50k-deep nesting under an ignored key.
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 50_000; i += 1) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    const body = {
      ...VALID,
      paymentPayload: {
        ...VALID.paymentPayload,
        payload: { ...VALID.paymentPayload.payload, deepIgnored: root },
      },
    };
    let r: ReturnType<typeof validateFacilitatorRequestShape> | undefined;
    expect(() => {
      r = validateFacilitatorRequestShape(body);
    }).not.toThrow();
    expect(r?.ok).toBe(true);
  });
});

describe("validate-body property loop — never throws, always returns {ok:boolean}", () => {
  // Deterministic, seeded LCG so failures reproduce. We mutate a deep copy of a
  // valid body by overwriting random paths with adversarial values and assert
  // the two invariants on every iteration: no throw, discriminated result.
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  const ADVERSARIAL: unknown[] = [
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_VALUE,
    -1,
    1.5,
    0,
    "",
    "exact-eth",
    "EIP155:1",
    null,
    undefined,
    true,
    false,
    [],
    [1, 2, 3],
    {},
    { nested: { a: 1 } },
    Symbol.iterator, // not JSON, exercises non-plain values
    () => 0,
    "x".repeat(10_000),
    -0,
    1e308,
  ];

  // Top-level mutable paths the validator reads.
  const PATHS: Array<(b: Record<string, any>, v: unknown) => void> = [
    (b, v) => (b.x402Version = v),
    (b, v) => (b.paymentPayload = v),
    (b, v) => b.paymentPayload && (b.paymentPayload.scheme = v),
    (b, v) => b.paymentPayload && (b.paymentPayload.network = v),
    (b, v) => b.paymentPayload && (b.paymentPayload.resource = v),
    (b, v) =>
      b.paymentPayload?.resource && (b.paymentPayload.resource.url = v),
    (b, v) => b.paymentPayload && (b.paymentPayload.payload = v),
    (b, v) =>
      b.paymentPayload?.payload &&
      (b.paymentPayload.payload.assetTransferMethod = v),
    (b, v) =>
      b.paymentPayload?.payload && (b.paymentPayload.payload.payerParty = v),
    (b, v) =>
      b.paymentPayload?.payload && (b.paymentPayload.payload.payer = v),
    (b, v) =>
      b.paymentPayload?.payload && (b.paymentPayload.payload.nonce = v),
    (b, v) =>
      b.paymentPayload?.payload &&
      (b.paymentPayload.payload.submissionRef = v),
    (b, v) =>
      b.paymentPayload?.payload &&
      (b.paymentPayload.payload.preparedTxHash = v),
    (b, v) => (b.paymentRequirements = v),
    (b, v) => b.paymentRequirements && (b.paymentRequirements.amount = v),
    (b, v) => b.paymentRequirements && (b.paymentRequirements.payTo = v),
    (b, v) => b.paymentRequirements && (b.paymentRequirements.extra = v),
  ];

  it("2000 randomized malformed bodies never throw and always return a boolean ok", () => {
    const rng = makeRng(0xc0ffee);
    const bases = [VALID];
    for (let i = 0; i < 2000; i += 1) {
      // Deep clone a base (drop functions/symbols via JSON, then re-inject).
      const base = bases[Math.floor(rng() * bases.length)];
      const body = JSON.parse(JSON.stringify(base)) as Record<string, any>;
      // Apply 1-4 random adversarial mutations.
      const mutations = 1 + Math.floor(rng() * 4);
      for (let m = 0; m < mutations; m += 1) {
        const path = PATHS[Math.floor(rng() * PATHS.length)] as (
          b: Record<string, any>,
          v: unknown
        ) => void;
        const value = ADVERSARIAL[Math.floor(rng() * ADVERSARIAL.length)];
        try {
          path(body, value);
        } catch {
          // Setting a property on a value that became a primitive can throw in
          // strict mode; that's a test-setup artifact, not the validator. Skip.
        }
      }
      let result: ReturnType<typeof validateFacilitatorRequestShape> | undefined;
      expect(() => {
        result = validateFacilitatorRequestShape(body);
      }, `iteration ${i} body=${safeStringify(body)}`).not.toThrow();
      expect(typeof result?.ok).toBe("boolean");
      if (result && !result.ok) {
        expect(typeof result.error).toBe("string");
      }
    }
    // Prototype stayed clean across the whole run.
    expect(
      (Object.prototype as Record<string, unknown>).polluted
    ).toBeUndefined();
  });
});

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 300) ?? String(v);
  } catch {
    return "<unstringifiable>";
  }
}

describe("x402-ENVELOPE accept-both shapes (scheme + extra renames)", () => {
  it("accepts scheme 'exact' (the only x402-ENVELOPE scheme) in both payload + requirements", () => {
    const body = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, scheme: "exact" },
      paymentRequirements: { ...VALID.paymentRequirements, scheme: "exact" },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("now REJECTS the removed legacy scheme 'exact-canton' (exact is the only scheme)", () => {
    const payloadOnly = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, scheme: "exact-canton" },
    };
    expect(validateFacilitatorRequestShape(payloadOnly).ok).toBe(false);
    const reqOnly = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, scheme: "exact-canton" },
    };
    expect(validateFacilitatorRequestShape(reqOnly).ok).toBe(false);
  });

  it("accepts the NEW extra shape (assetTransferMethod + feePayer, no synchronizerId)", () => {
    const body = {
      ...VALID,
      paymentPayload: { ...VALID.paymentPayload, scheme: "exact" },
      paymentRequirements: {
        ...VALID.paymentRequirements,
        scheme: "exact",
        asset: "CC",
        extra: {
          assetTransferMethod: "transfer-factory",
          feePayer: "fac::1220",
          instrumentId: { admin: "admin::1220", id: "cc" },
          executeBeforeSeconds: 120,
        },
      },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(true);
  });

  it("rejects a non-exact scheme even with the new extra shape", () => {
    const body = {
      ...VALID,
      paymentRequirements: { ...VALID.paymentRequirements, scheme: "exact-eth" },
    };
    expect(validateFacilitatorRequestShape(body).ok).toBe(false);
  });
});

// transfer-factory ("V3") payload arm: the body carries only the relay-stash
// reference; the signed prepared tx lives on the relay.
describe("transfer-factory payload arm", () => {
  const tfBody = (payload: Record<string, unknown>) => ({
    ...VALID,
    paymentPayload: {
      ...VALID.paymentPayload,
      payload,
    },
    paymentRequirements: {
      ...VALID.paymentRequirements,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: "fac::1220",
        synchronizerId: "sync::1220",
        instrumentId: { admin: "admin::1220", id: "cc" },
        executeBeforeSeconds: 120,
      },
    },
  });
  const base = {
    assetTransferMethod: "transfer-factory",
    payer: "agent::1220",
    submissionRef: "8f14e45f-ceea-467f-9c1d-1a2b3c4d5e6f",
  };

  it("accepts a well-formed tf payload (permissive gate)", () => {
    const r = validateFacilitatorRequestShape(tfBody(base));
    expect(r.ok).toBe(true);
  });

  it("accepts an optional string preparedTxHash; rejects a non-string one", () => {
    expect(
      validateFacilitatorRequestShape(tfBody({ ...base, preparedTxHash: "aa" }))
        .ok
    ).toBe(true);
    const bad = validateFacilitatorRequestShape(
      tfBody({ ...base, preparedTxHash: 42 })
    );
    expect(bad.ok).toBe(false);
  });

  it("requires a non-empty bounded submissionRef", () => {
    for (const submissionRef of [undefined, "", "x".repeat(200)]) {
      const r = validateFacilitatorRequestShape(
        tfBody({ ...base, submissionRef })
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/submissionRef/);
    }
  });

  it("tfEnabled=false rejects a tf payload at the body boundary (inert deploy)", () => {
    const r = validateFacilitatorRequestShape(tfBody(base), {
      tfEnabled: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/CANTON_X402_TF_ENABLED/);
  });

  it("tfEnabled=true (or undefined) accepts a well-formed tf body", () => {
    expect(validateFacilitatorRequestShape(VALID, { tfEnabled: true }).ok).toBe(
      true
    );
    expect(validateFacilitatorRequestShape(VALID).ok).toBe(true);
  });

  it("still rejects an unknown method", () => {
    const r = validateFacilitatorRequestShape(
      tfBody({ ...base, assetTransferMethod: "carrier-pigeon" })
    );
    expect(r.ok).toBe(false);
  });
});
