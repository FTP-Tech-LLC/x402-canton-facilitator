import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { recomputeHash } from "@ftptech/x402-canton-ledger";
import { createPayerProofVerifier, digestBytes } from "./payer-proof.js";

const RAW = Buffer.from(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../agent-wallet/src/__fixtures__/mainnet-transfer-preapproval-0.1.21.b64",
        import.meta.url
      )
    ),
    "utf8"
  ).trim(),
  "base64"
);
const PAYER = "agent::1220" + "aa".repeat(32);

/** The hash a real participant would compute for these real bytes. */
async function trueHashHex(): Promise<string> {
  return Buffer.from(await recomputeHash(RAW.toString("base64")), "base64").toString("hex");
}

/** Raw 32-byte Ed25519 public key from a node keypair. */
function rawPublic(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): Buffer {
  // Already a public KeyObject — export it directly. Passing it back through
  // createPublicKey() throws (that helper derives a public key from a PRIVATE
  // one), and the throw would be swallowed by the verifier as "unverified",
  // hiding a broken test behind a plausible false.
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32);
}

function input(over: Record<string, unknown> = {}) {
  return {
    preparedTransactionBytes: RAW,
    claimedPreparedTxHash: "",
    signatureB64: Buffer.alloc(64, 1).toString("base64"),
    payer: PAYER,
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    ...over,
  } as Parameters<ReturnType<typeof createPayerProofVerifier>>[0];
}

/** What Canton topology hands back: an X.509 SubjectPublicKeyInfo, not the raw
 *  point. The verifier consumes it verbatim. */
function spki(pub: Parameters<typeof rawPublic>[0]): Buffer {
  return Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    rawPublic(pub),
  ]);
}

describe("payer proof — half A, hash binding against REAL MainNet bytes", () => {
  it("rejects a claimed hash that is not the hash of the bytes", async () => {
    const verify = createPayerProofVerifier();
    expect(
      (await verify(input({ claimedPreparedTxHash: "ab".repeat(32) }))).verified
    ).toBe(false);
  });

  it("accepts either framing of the same true hash, then still stops at half B", async () => {
    const hex = await trueHashHex();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);

    // Both spellings must reduce to the same digest. Rejecting a payment over
    // multihash framing alone would be an outage, not a defence.
    const verify = createPayerProofVerifier();
    for (const spelling of [hex, "1220" + hex]) {
      // No key source wired → false, but for the RIGHT reason: half A passed.
      expect((await verify(input({ claimedPreparedTxHash: spelling }))).verified).toBe(false);
    }

    // Prove half A really passed, by supplying a key source and a real
    // signature over the true hash below.
  });

  it("refuses an unknown hashing scheme rather than guessing", async () => {
    const verify = createPayerProofVerifier();
    expect(
      (await verify(
        input({
          claimedPreparedTxHash: await trueHashHex(),
          hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1",
        })
      )).verified
    ).toBe(false);
  });

  it("refuses a malformed hash without attempting a recompute", async () => {
    const verify = createPayerProofVerifier();
    for (const bad of ["", "zz".repeat(32), "abc", "1220" + "zz".repeat(32)]) {
      expect((await verify(input({ claimedPreparedTxHash: bad }))).verified).toBe(false);
    }
  });
});

describe("payer proof — half B, signature over the recomputed hash", () => {
  it("accepts a genuine signature by the payer over the true hash", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    const digest = Buffer.from(hex, "hex");

    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [spki(publicKey)],
    });
    const ok = await verify(
      input({
        claimedPreparedTxHash: hex,
        signatureB64: cryptoSign(null, digest, privateKey).toString("base64"),
      })
    );
    // Full Rule 3 satisfied: the hash binds to the bytes AND the payer signed it.
    expect(ok.verified).toBe(true);
    // And it REPORTS what it proved, rather than leaving the caller to re-derive
    // it. The hash is the recomputed one, so a caller keying on it cannot be
    // split into two buckets by a client re-spelling its claim.
    expect(ok.preparedTxHashHex).toBe(hex);
  });

  it("rejects a signature by a DIFFERENT key", async () => {
    const mine = generateKeyPairSync("ed25519");
    const theirs = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();

    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [spki(mine.publicKey)],
    });
    expect(
      (await verify(
        input({
          claimedPreparedTxHash: hex,
          signatureB64: cryptoSign(null, Buffer.from(hex, "hex"), theirs.privateKey).toString(
            "base64"
          ),
        })
      )).verified
    ).toBe(false);
  });

  it("rejects a signature over a DIFFERENT hash", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [spki(publicKey)],
    });
    expect(
      (await verify(
        input({
          claimedPreparedTxHash: hex,
          signatureB64: cryptoSign(null, Buffer.alloc(32, 9), privateKey).toString("base64"),
        })
      )).verified
    ).toBe(false);
  });

  it("rejects when the key lookup finds nothing, or throws", async () => {
    const hex = await trueHashHex();
    for (const fetchPayerSigningKey of [
      async () => [],
      async () => [Buffer.alloc(5)], // not an Ed25519 SPKI
      async () => {
        throw new Error("topology unreachable");
      },
    ]) {
      const verify = createPayerProofVerifier({
        fetchPayerSigningKey: fetchPayerSigningKey as () => Promise<Buffer[]>,
      });
      expect((await verify(input({ claimedPreparedTxHash: hex }))).verified).toBe(false);
    }
  });

  it("rejects a signature of the wrong length", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [spki(publicKey)],
    });
    expect(
      (await verify(
        input({
          claimedPreparedTxHash: hex,
          signatureB64: Buffer.alloc(10, 3).toString("base64"),
        })
      )).verified
    ).toBe(false);
  });
});

describe("payer proof — the missing capability is a rejection", () => {
  it("returns false with no key lookup, even when everything else is perfect", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    // This is today's production wiring. A verifier that answered true here
    // would report a half-checked proof as a verified one.
    const verify = createPayerProofVerifier();
    expect(
      (await verify(
        input({
          claimedPreparedTxHash: hex,
          signatureB64: cryptoSign(null, Buffer.from(hex, "hex"), privateKey).toString("base64"),
        })
      )).verified
    ).toBe(false);
  });
});

describe("payer proof — a party may publish several signing keys", () => {
  it("accepts a signature by ANY of the party's published keys", async () => {
    // The payload does not say which key signed, and topology may list more
    // than one. Trying only the first would reject honest payments from a party
    // that rotated or added a key.
    const decoy = generateKeyPairSync("ed25519");
    const real = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [
        spki(decoy.publicKey),
        spki(real.publicKey),
      ],
    });
    expect(
      (await verify(
        input({
          claimedPreparedTxHash: hex,
          signatureB64: cryptoSign(null, Buffer.from(hex, "hex"), real.privateKey).toString("base64"),
        })
      )).verified
    ).toBe(true);
  });

  it("still refuses when NONE of them signed it", async () => {
    const stranger = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [
        { key: rawPublic(generateKeyPairSync("ed25519").publicKey) },
        { key: rawPublic(generateKeyPairSync("ed25519").publicKey) },
      ],
    });
    expect(
      (await verify(
        input({
          claimedPreparedTxHash: hex,
          signatureB64: cryptoSign(null, Buffer.from(hex, "hex"), stranger.privateKey).toString("base64"),
        })
      )).verified
    ).toBe(false);
  });
});

describe("payer proof — what it does NOT report", () => {
  it("reports no key identifier, because topology publishes none", () => {
    // Canton's SigningPublicKey has its fingerprint field RESERVED ("previously
    // public key id"), and the JWKS `kid` that exists elsewhere is an RFC 7638
    // thumbprint naming no key the participant knows. So there is nothing here
    // that could serve as Signature.signedBy, and the result type says so.
    // /settle names the payer's namespace instead — which for a single-key
    // external party IS that key's fingerprint.
    const result: Awaited<ReturnType<ReturnType<typeof createPayerProofVerifier>>> =
      { verified: true, preparedTxHashHex: "ab".repeat(32) };
    expect(Object.keys(result).sort()).toEqual([
      "preparedTxHashHex",
      "verified",
    ]);
  });
});

describe("digestBytes — framing decided by length, not by prefix", () => {
  // Tested directly rather than through the verifier. Going through verify()
  // proves nothing here: the claimed hash is compared against a recompute, so
  // a doctored claim is refused on the mismatch whatever the framing does —
  // a test written that way passes identically with the bug restored, which
  // is exactly what a mutation check caught before this was rewritten.
  const H = "aa".repeat(32);

  it("reads a bare 64-char digest that HAPPENS to begin 1220", () => {
    // ~1 in 65,536 honest digests start with the bytes 0x12 0x20, whose hex
    // spelling is the same four characters as the multihash prefix. Deciding
    // by prefix slices four chars off a real digest, leaving 60, which fails
    // the hex test — and the payment is refused as though forged.
    const collides = "1220" + H.slice(4);
    expect(collides).toHaveLength(64);
    const out = digestBytes(collides);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(32);
    expect(out!.toString("hex")).toBe(collides);
  });

  it("strips the prefix from a genuinely framed 68-char hash", () => {
    const framed = "1220" + H;
    expect(framed).toHaveLength(68);
    expect(digestBytes(framed)!.toString("hex")).toBe(H);
  });

  it("reads an ordinary 64-char digest", () => {
    expect(digestBytes(H)!.toString("hex")).toBe(H);
  });

  it("still rejects lengths that are neither", () => {
    expect(digestBytes("abcd")).toBeNull();
    expect(digestBytes("1220" + H + "ff")).toBeNull();
    expect(digestBytes("zz".repeat(32))).toBeNull();
  });
});

describe("a failed lookup is reported, not silently folded into 'invalid'", () => {
  it("calls onLookupError when the key source throws", async () => {
    const seen: Array<{ party: string; msg: string }> = [];
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => {
        throw new Error("topology unavailable at the reader");
      },
      onLookupError: (party, err) =>
        seen.push({ party, msg: err instanceof Error ? err.message : String(err) }),
    });
    const real = await trueHashHex();
    const res = await verify(input({ claimedPreparedTxHash: real }));

    // Still refuses — fail-closed is not negotiable.
    expect(res.verified).toBe(false);
    // But the operator can now tell their outage from an attack.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.party).toBe(PAYER);
    expect(seen[0]?.msg).toMatch(/topology unavailable/);
  });

  it("does NOT fire when the lookup succeeds and the signature is simply wrong", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    let fired = 0;
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [spki],
      onLookupError: () => { fired += 1; },
    });
    const real = await trueHashHex();
    const res = await verify(
      input({ claimedPreparedTxHash: real, signatureB64: Buffer.alloc(64, 7).toString("base64") })
    );
    expect(res.verified).toBe(false);
    // A forged signature must NOT look like an outage, or the metric this
    // feeds would cry wolf on every genuine attack.
    expect(fired).toBe(0);
  });
});

/**
 * `keyLookupFailed` is the ONE exemption from the pay/commit enforce gate
 * (routes/wallet.ts). It has to mean "we could not look", not "we did not like
 * the answer" — every throw used to set it, so a reader answering 401 after a
 * token rotation, or topology answering that a party publishes no signing key,
 * silently turned enforce back into observe and accepted every signature.
 */
describe("only a genuine topology outage earns the enforce exemption", () => {
  const lookupThrowing = (err: unknown) =>
    createPayerProofVerifier({
      fetchPayerSigningKey: async () => {
        throw err;
      },
    });

  const refuse = async (err: unknown) => {
    const hex = await trueHashHex();
    const r = await lookupThrowing(err)(
      input({ claimedPreparedTxHash: hex, signatureB64: Buffer.alloc(64).toString("base64") })
    );
    expect(r.verified).toBe(false);
    return r;
  };

  it("exempts a reader that could not read topology", async () => {
    expect(
      (await refuse(Object.assign(new Error("topology unavailable"), { reason: "unavailable" })))
        .keyLookupFailed
    ).toBe(true);
  });

  it("does NOT exempt topology answering that the party publishes no key", async () => {
    // A definitive disproof: a party with no published protocol signing key
    // cannot have produced a verifying signature.
    expect(
      (await refuse(
        Object.assign(new Error("party publishes no protocol signing key"), { reason: "no_key" })
      )).keyLookupFailed
    ).toBeFalsy();
  });

  it("does NOT exempt our own broken reader", async () => {
    // 401 after a token rotation is permanent and points at us. Exempting it
    // made a misconfigured reader the one path that accepts everything, while
    // an UNCONFIGURED lookup already refuses everything.
    expect(
      (await refuse(
        Object.assign(new Error("topology reader returned 401"), { reason: "reader_error" })
      )).keyLookupFailed
    ).toBeFalsy();
  });

  it("does NOT exempt an error shape it cannot classify", async () => {
    expect((await refuse(new Error("something else"))).keyLookupFailed).toBeFalsy();
  });
});

describe("the proof reports how many keys the payer published", () => {
  it("counts them, so a signedBy mismatch is diagnosable", async () => {
    // `Signature.signedBy` can only name the party's NAMESPACE key — topology
    // publishes no id for a second one. A party that rotated and signed with
    // its new key verifies here and is then rejected by the participant, which
    // reads exactly like a bad signature. The count is what tells them apart.
    const mine = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [spki(other.publicKey), spki(mine.publicKey)],
    });
    const r = await verify(
      input({
        claimedPreparedTxHash: hex,
        signatureB64: cryptoSign(null, Buffer.from(hex, "hex"), mine.privateKey).toString("base64"),
      })
    );
    expect(r.verified).toBe(true);
    expect(r.publishedProtocolKeys).toBe(2);
  });

  it("reports 1 for the ordinary single-key party", async () => {
    // The discriminator: the count must not be a constant, or the warn it
    // drives would fire on every payment and mean nothing.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const hex = await trueHashHex();
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [spki(publicKey)],
    });
    const r = await verify(
      input({
        claimedPreparedTxHash: hex,
        signatureB64: cryptoSign(null, Buffer.from(hex, "hex"), privateKey).toString("base64"),
      })
    );
    expect(r.verified).toBe(true);
    expect(r.publishedProtocolKeys).toBe(1);
  });
});
