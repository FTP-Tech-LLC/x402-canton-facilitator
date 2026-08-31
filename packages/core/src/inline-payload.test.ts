import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  decodeInlinePaymentPayload,
  encodeInlinePaymentPayload,
  InlinePayloadError,
  MAX_SIGNATURE_B64_CHARS,
  DEFAULT_HASHING_SCHEME_VERSION,
} from "./inline-payload.js";

const BYTES = Buffer.from("prepared-transfer-factory-bytes".repeat(40));
const HASH = "1220" + "ab".repeat(32);
const SIG = Buffer.alloc(64, 7).toString("base64");

function wire(over: Record<string, unknown> = {}) {
  return {
    ...encodeInlinePaymentPayload({
      preparedTransactionBytes: BYTES,
      preparedTxHash: HASH,
      signatureB64: SIG,
    }),
    ...over,
  };
}

/** Assert the thrown error carries the scheme code the facilitator must answer
 *  with — a right rejection under the wrong code is still a spec violation. */
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InlinePayloadError);
    expect((err as InlinePayloadError).code).toBe(code);
    return;
  }
  throw new Error("expected a rejection, got none");
}

describe("inline payload — round trip", () => {
  it("round-trips the bytes and normalises the hash", () => {
    const w = wire();
    expect(w.assetTransferMethod).toBe("transfer-factory");
    expect(w.hashingSchemeVersion).toBe(DEFAULT_HASHING_SCHEME_VERSION);

    const d = decodeInlinePaymentPayload(w);
    expect(d.preparedTransactionBytes).toEqual(BYTES);
    expect(d.claimedPreparedTxHash).toBe(HASH);
    expect(d.signatureB64).toBe(SIG);
  });

  it("emits a hash our own decoder accepts, even from upper-case input", () => {
    // A producer and a verifier that disagree on canonicalisation is a
    // self-inflicted outage, so the encoder must pre-canonicalise.
    const w = encodeInlinePaymentPayload({
      preparedTransactionBytes: BYTES,
      preparedTxHash: HASH.toUpperCase(),
      signatureB64: SIG,
    });
    expect(decodeInlinePaymentPayload(w).claimedPreparedTxHash).toBe(HASH);
  });

  it("carries a real MainNet prepared transfer inside the default caps", () => {
    const raw = Buffer.from(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../agent-wallet/src/__fixtures__/mainnet-transfer-preapproval-0.1.21.b64",
            import.meta.url
          )
        ),
        "utf8"
      ).trim(),
      "base64"
    );
    const w = encodeInlinePaymentPayload({
      preparedTransactionBytes: raw,
      preparedTxHash: HASH,
      signatureB64: SIG,
    });
    // The whole point of gzip: ~26 KB of prepared tx becomes a payload small
    // enough to travel in a request.
    expect(w.preparedTransaction.length).toBeLessThan(9000);
    expect(decodeInlinePaymentPayload(w).preparedTransactionBytes).toEqual(raw);
  });

  it("defaults to V2, and refuses V1 AT DECODE rather than later", () => {
    // The scheme admits V1; our conformant recompute implements V2 only.
    // Refusing here names the real reason. Accepting the field and failing at
    // the signature gate would report an unsupported hash scheme as a bad
    // signature and send an integrator to debug their key.
    expectCode(
      () =>
        decodeInlinePaymentPayload(
          wire({ hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" })
        ),
      "invalid_exact_canton_malformed_payload"
    );

    const { hashingSchemeVersion: _drop, ...noScheme } = wire();
    expect(decodeInlinePaymentPayload(noScheme).hashingSchemeVersion).toBe(
      "HASHING_SCHEME_VERSION_V2"
    );
  });
});

describe("inline payload — missing proof (Rule 2)", () => {
  it.each(["preparedTransaction", "preparedTxHash", "signature"])(
    "reports a missing %s as missing_proof, not malformed",
    (field) => {
      const w = wire() as Record<string, unknown>;
      delete w[field];
      expectCode(
        () => decodeInlinePaymentPayload(w),
        "invalid_exact_canton_missing_proof"
      );
    }
  );

  it.each([undefined, null, "", 42, [], {}])(
    "rejects %p as a payload or field value",
    (bad) => {
      expectCode(
        () => decodeInlinePaymentPayload(bad),
        "invalid_exact_canton_missing_proof"
      );
      expectCode(
        () => decodeInlinePaymentPayload(wire({ signature: bad })),
        "invalid_exact_canton_missing_proof"
      );
    }
  );
});

describe("inline payload — canonical encoding", () => {
  it("rejects base64 with whitespace even though it would decode", () => {
    const w = wire();
    const spaced =
      w.preparedTransaction.slice(0, 40) + "\n" + w.preparedTransaction.slice(40);
    expect(Buffer.from(spaced, "base64").length).toBeGreaterThan(0); // Node accepts it
    expectCode(
      () => decodeInlinePaymentPayload(wire({ preparedTransaction: spaced })),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("rejects a non-canonical base64 that decodes to the SAME bytes", () => {
    // "AA==" and "AB==" both decode to one 0x00 byte: the trailing bits are
    // discarded. Two distinct wire strings for one payment would let an
    // attacker vary any key derived from the string while the ledger sees one
    // transaction.
    expect(Buffer.from("AB==", "base64")).toEqual(Buffer.from("AA==", "base64"));
    expectCode(
      () => decodeInlinePaymentPayload(wire({ signature: "AB==" })),
      "invalid_exact_canton_malformed_payload"
    );
    expect(() => decodeInlinePaymentPayload(wire({ signature: "AA==" }))).not.toThrow();
  });

  it("rejects base64url and other alphabets", () => {
    expectCode(
      () => decodeInlinePaymentPayload(wire({ signature: "a-b_c===" })),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it.each([
    ["upper-case hex", HASH.toUpperCase()],
    ["odd length", "1220abc"],
    ["non-hex", "1220zzzz"],
    ["hex with 0x prefix", "0x1220abcd"],
  ])("rejects a preparedTxHash with %s", (_label, bad) => {
    expectCode(
      () => decodeInlinePaymentPayload(wire({ preparedTxHash: bad })),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("rejects an unknown hashing scheme", () => {
    expectCode(
      () => decodeInlinePaymentPayload(wire({ hashingSchemeVersion: "V3" })),
      "invalid_exact_canton_malformed_payload"
    );
    expectCode(
      () => decodeInlinePaymentPayload(wire({ hashingSchemeVersion: 2 })),
      "invalid_exact_canton_malformed_payload"
    );
  });
});

describe("inline payload — bounds", () => {
  it("refuses an over-cap preparedTransaction on the STRING, before any decode", () => {
    // The payload here is perfectly valid gzip that decompresses well inside
    // every other bound, so the char cap is the only thing that can reject it.
    // Written this way on purpose: a bomb would also trip the gzip cap, and
    // then the test would pass with the string cap deleted — proving nothing
    // about the ordering it exists to enforce.
    const valid = wire();
    expect(() => decodeInlinePaymentPayload(valid)).not.toThrow();
    expectCode(
      () =>
        decodeInlinePaymentPayload(valid, {
          maxPreparedTransactionB64Chars: 10,
        }),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("caps the signature field, which was previously unbounded", () => {
    const long = "A".repeat(MAX_SIGNATURE_B64_CHARS + 4);
    expectCode(
      () => decodeInlinePaymentPayload(wire({ signature: long })),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("caps the preparedTxHash field", () => {
    expectCode(
      () => decodeInlinePaymentPayload(wire({ preparedTxHash: "ab".repeat(200) })),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("propagates a decompression bomb as malformed_payload", () => {
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024), { level: 9 }).toString(
      "base64"
    );
    expectCode(
      () => decodeInlinePaymentPayload(wire({ preparedTransaction: bomb })),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("propagates concatenated gzip members as malformed_payload", () => {
    const one = gzipSync(BYTES);
    expectCode(
      () =>
        decodeInlinePaymentPayload(
          wire({ preparedTransaction: Buffer.concat([one, one]).toString("base64") })
        ),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("rejects a payload that decompresses to nothing", () => {
    expectCode(
      () =>
        decodeInlinePaymentPayload(
          wire({ preparedTransaction: gzipSync(Buffer.alloc(0)).toString("base64") })
        ),
      "invalid_exact_canton_malformed_payload"
    );
  });

  it("rejects base64 that is not gzip at all", () => {
    expectCode(
      () =>
        decodeInlinePaymentPayload(
          wire({ preparedTransaction: Buffer.alloc(40, 0x41).toString("base64") })
        ),
      "invalid_exact_canton_malformed_payload"
    );
  });
});

describe("inline payload — the boundary of what this module proves", () => {
  it("does NOT verify the hash against the bytes — that is the caller's job", () => {
    // Documents the contract deliberately: a wrong hash decodes fine. The field
    // is named `claimedPreparedTxHash` so a caller cannot read it as checked.
    // If this test ever starts failing because decoding began verifying the
    // hash, the naming and the docs must change with it.
    const lying = wire({ preparedTxHash: "1220" + "00".repeat(32) });
    const d = decodeInlinePaymentPayload(lying);
    expect(d.claimedPreparedTxHash).toBe("1220" + "00".repeat(32));
    expect(d.preparedTransactionBytes).toEqual(BYTES);
    expect(d).not.toHaveProperty("preparedTxHash");
  });

  it("does NOT verify the signature", () => {
    const d = decodeInlinePaymentPayload(
      wire({ signature: Buffer.alloc(64, 0).toString("base64") })
    );
    expect(d.signatureB64).toBe(Buffer.alloc(64, 0).toString("base64"));
  });
});
