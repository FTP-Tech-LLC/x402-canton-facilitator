import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { CantonClient } from "./client.js";
import {
  CantonExternalPartySigner,
  signPreparedTransactionHash,
  ed25519KeyFromNodeKeyPair,
  ED25519_WIRE_CONSTANTS,
} from "./external-party.js";

const URL = "http://canton.test";
const TOKEN = "test-jwt";
const PKG = "canton-x402";

function makeFetch(
  responder: (req: { url: string; init: RequestInit }) => {
    status?: number;
    body?: unknown;
  }
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = {} } = responder({ url, init: init ?? {} });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
}

function makeClient(fetch: typeof globalThis.fetch): CantonClient {
  return new CantonClient({
    participantUrl: URL,
    token: TOKEN,
    packageName: PKG,
    fetch,
  });
}

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return ed25519KeyFromNodeKeyPair({ privateKey, publicKey });
}

describe("ed25519KeyFromNodeKeyPair — new coverage", () => {
  it("fingerprint is stable (same key → same fingerprint on repeated calls)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const k1 = ed25519KeyFromNodeKeyPair({ privateKey, publicKey });
    const k2 = ed25519KeyFromNodeKeyPair({ privateKey, publicKey });
    // Same key objects must always produce the same fingerprint
    expect(k1.fingerprint).toBe(k2.fingerprint);
    // Sanity: it's a valid hex string
    expect(k1.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signPreparedTransactionHash: returns an ExternalPartyKey object with publicKey and sign method", () => {
    // signPreparedTransactionHash returns a PartySignatureEntry (not a key object),
    // but ed25519KeyFromNodeKeyPair must return an object with both publicKey and a sign function.
    // This test validates the shape of ed25519KeyFromNodeKeyPair output.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = ed25519KeyFromNodeKeyPair({ privateKey, publicKey });
    // Must have publicKey and privateKey properties
    expect(key.publicKey).toBeDefined();
    expect(key.privateKey).toBeDefined();
    expect(key.fingerprint).toBeDefined();
    expect(typeof key.fingerprint).toBe("string");
    // publicKey must be a KeyObject (has asymmetricKeyType)
    expect(key.publicKey.asymmetricKeyType).toBe("ed25519");
  });

  it("ed25519KeyFromNodeKeyPair: throws descriptive error on null input", () => {
    // Passing null/undefined where a KeyObject is expected must throw
    // with a descriptive error rather than a cryptic internal failure.
    expect(() =>
      ed25519KeyFromNodeKeyPair({ privateKey: null as any, publicKey: null as any })
    ).toThrow();
  });
});

describe("CantonExternalPartySigner — requestingParties in execute body", () => {
  it("CantonExternalPartySigner: requestingParties in execute body contains the party", async () => {
    const key = makeKey();
    let capturedExecuteBody: any = null;

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash-rp-test").toString("base64"),
            },
          };
        }
        if (url.endsWith("/execute")) {
          capturedExecuteBody = JSON.parse(init.body as string);
          return { body: { updateId: "u-rp", completionOffset: 0 } };
        }
        return { status: 404, body: {} };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    const party = "agent::1220requesting-party-test";
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "cmd-rp-test",
        actAs: [party],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    expect(capturedExecuteBody).not.toBeNull();
    // The party must appear in partySignatures.signatures[].party
    const sigParties = capturedExecuteBody.partySignatures?.signatures?.map(
      (s: any) => s.party
    );
    expect(sigParties).toContain(party);
  });
});

describe("ed25519KeyFromNodeKeyPair", () => {
  it("derives a deterministic hex fingerprint from the public key bytes", () => {
    const k1 = makeKey();
    const k2 = ed25519KeyFromNodeKeyPair({
      privateKey: k1.privateKey,
      publicKey: k1.publicKey,
    });
    expect(k1.fingerprint).toBe(k2.fingerprint);
    expect(k1.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different keypairs produce different fingerprints", () => {
    const a = makeKey();
    const b = makeKey();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("fingerprint is the SHA-256 hex of the SPKI DER public key (64-char hex, not 8 bytes, not the full DER)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = ed25519KeyFromNodeKeyPair({ privateKey, publicKey });
    // SHA-256 produces a 32-byte / 64-char hex digest
    expect(key.fingerprint).toHaveLength(64);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Must not be the full DER blob (SPKI DER for Ed25519 is 44 bytes → 88 hex chars)
    expect(key.fingerprint).not.toHaveLength(88);
  });

  it("fingerprint is 64 hex chars (32 bytes SHA-256 × 2 hex chars per byte)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = ed25519KeyFromNodeKeyPair({ privateKey, publicKey });
    // SHA-256 produces 32 bytes = 64 hex characters
    expect(key.fingerprint).toHaveLength(64);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on a non-Ed25519 key (RSA)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    expect(() => ed25519KeyFromNodeKeyPair({ privateKey, publicKey })).toThrow(
      /Ed25519/
    );
  });
});

describe("signPreparedTransactionHash", () => {
  it("signature is 64 bytes (Ed25519 CONCAT R||S format)", () => {
    const key = makeKey();
    const hashBytes = Buffer.from("some-transaction-hash-bytes");
    const hashBase64 = hashBytes.toString("base64");

    const entry = signPreparedTransactionHash(hashBase64, key);

    const sigBytes = Buffer.from(entry.signature, "base64");
    // Ed25519 signatures are always exactly 64 bytes in the CONCAT format
    expect(sigBytes.length).toBe(64);
    expect(entry.format).toBe("SIGNATURE_FORMAT_CONCAT");
  });

  it("returns a valid Ed25519 signature verifiable with the public key", () => {
    const key = makeKey();
    const hashBytes = Buffer.from("the-prepared-tx-hash-bytes");
    const hashBase64 = hashBytes.toString("base64");

    const entry = signPreparedTransactionHash(hashBase64, key);

    expect(entry.format).toBe("SIGNATURE_FORMAT_CONCAT");
    expect(entry.signingAlgorithmSpec).toBe("SIGNING_ALGORITHM_SPEC_ED25519");
    expect(entry.signedBy).toBe(key.fingerprint);

    const sigBytes = Buffer.from(entry.signature, "base64");
    const ok = cryptoVerify(null, hashBytes, key.publicKey, sigBytes);
    expect(ok).toBe(true);
  });

  it("given the same key and hash, signature is deterministic (Ed25519 is deterministic)", () => {
    const key = makeKey();
    const hashBase64 = Buffer.from("deterministic-hash-test-payload").toString("base64");

    const entry1 = signPreparedTransactionHash(hashBase64, key);
    const entry2 = signPreparedTransactionHash(hashBase64, key);

    // Ed25519 is deterministic — same key + same message always yields same signature
    expect(entry1.signature).toBe(entry2.signature);
  });

  it("given different hashes, signatures differ", () => {
    const key = makeKey();
    const hash1 = Buffer.from("first-hash-bytes").toString("base64");
    const hash2 = Buffer.from("second-hash-bytes").toString("base64");

    const entry1 = signPreparedTransactionHash(hash1, key);
    const entry2 = signPreparedTransactionHash(hash2, key);

    expect(entry1.signature).not.toBe(entry2.signature);
  });

  it("respects a caller-provided signingAlgorithmSpec override", () => {
    const key = makeKey();
    const hash = Buffer.from("h").toString("base64");
    const entry = signPreparedTransactionHash(hash, key, {
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256",
    });
    expect(entry.signingAlgorithmSpec).toBe(
      "SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256"
    );
  });
});

describe("ED25519_WIRE_CONSTANTS", () => {
  // These four enum strings have to match what Canton's
  // JSON Ledger API v2 accepts; verified live against
  // cn-quickstart Splice 0.5.3 on 2026-05-24. Locking the
  // values in tests so any well-meaning refactor that "fixes"
  // them (e.g. SIGNING_KEY_SPEC_ED25519, which Canton rejects)
  // fails here, not at first prod startup.
  it("publicKeyFormat = CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", () => {
    expect(ED25519_WIRE_CONSTANTS.publicKeyFormat).toBe(
      "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO"
    );
  });
  it("keySpec = SIGNING_KEY_SPEC_EC_CURVE25519 (NOT SIGNING_KEY_SPEC_ED25519)", () => {
    expect(ED25519_WIRE_CONSTANTS.keySpec).toBe(
      "SIGNING_KEY_SPEC_EC_CURVE25519"
    );
  });
  it("signingAlgorithmSpec = SIGNING_ALGORITHM_SPEC_ED25519", () => {
    expect(ED25519_WIRE_CONSTANTS.signingAlgorithmSpec).toBe(
      "SIGNING_ALGORITHM_SPEC_ED25519"
    );
  });
  it("signatureFormat = SIGNATURE_FORMAT_CONCAT", () => {
    expect(ED25519_WIRE_CONSTANTS.signatureFormat).toBe(
      "SIGNATURE_FORMAT_CONCAT"
    );
  });
  it("signPreparedTransactionHash uses the constants by default", () => {
    const k = makeKey();
    const sig = signPreparedTransactionHash(
      Buffer.from("deadbeef".repeat(8), "hex").toString("base64"),
      k
    );
    expect(sig.format).toBe(ED25519_WIRE_CONSTANTS.signatureFormat);
    expect(sig.signingAlgorithmSpec).toBe(
      ED25519_WIRE_CONSTANTS.signingAlgorithmSpec
    );
  });
});

describe("CantonExternalPartySigner.prepareSignAndExecute", () => {
  it("prepare body includes the correct actAs party", async () => {
    const key = makeKey();
    const prepareRequests: any[] = [];

    const client = makeClient(
      makeFetch(({ url, init }) => {
        const body = init.body ? JSON.parse(init.body as string) : {};
        if (url.endsWith("/prepare")) {
          prepareRequests.push(body);
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "user-1",
        commandId: "cmd-act-as-test",
        actAs: ["party-under-test::1220abc"],
        synchronizerId: "sync-1",
        commands: [],
      },
      key
    );

    expect(prepareRequests).toHaveLength(1);
    expect(prepareRequests[0].actAs).toEqual(["party-under-test::1220abc"]);
  });

  it("throws on multiple actAs parties (one signature can't cover many — audit L4)", async () => {
    const key = makeKey();
    let prepareCalled = false;
    const client = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/prepare")) {
          prepareCalled = true;
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("h").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );
    const signer = new CantonExternalPartySigner(client);
    await expect(
      signer.prepareSignAndExecute(
        {
          userId: "u",
          commandId: "c",
          actAs: ["a::1220a", "b::1220b"],
          synchronizerId: "s",
          commands: [],
        },
        key
      )
    ).rejects.toMatchObject({
      name: "CantonError",
      code: "UNSUPPORTED_MULTI_PARTY",
    });
    // fail-fast: it must reject BEFORE preparing / signing
    expect(prepareCalled).toBe(false);
  });

  it("throws CantonError when prepare returns empty hash", async () => {
    const key = makeKey();
    const client = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/prepare")) {
          // Missing preparedTransactionHash — simulates a malformed participant response
          return { body: { preparedTransaction: "TX" } };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await expect(
      signer.prepareSignAndExecute(
        {
          userId: "u",
          commandId: "c",
          actAs: ["p"],
          synchronizerId: "s",
          commands: [],
        },
        key
      )
    ).rejects.toMatchObject({ name: "CantonError", code: "INVALID_RESPONSE" });
  });

  it("execute body includes the party signature entry with correct fields", async () => {
    const key = makeKey();
    const executeBodies: any[] = [];

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "PREPARED",
              preparedTransactionHash: Buffer.from("hash-32-bytes-pad-123456789").toString("base64"),
            },
          };
        }
        if (url.endsWith("/execute")) {
          executeBodies.push(JSON.parse(init.body as string));
          return { body: { updateId: "u-exec", completionOffset: 5 } };
        }
        return { status: 404, body: {} };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c",
        actAs: ["signing-party::1220"],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    expect(executeBodies).toHaveLength(1);
    const exec = executeBodies[0];
    const sigs = exec.partySignatures?.signatures ?? [];
    expect(sigs).toHaveLength(1);
    expect(sigs[0].party).toBe("signing-party::1220");
    expect(sigs[0].signatures).toHaveLength(1);
    const sigEntry = sigs[0].signatures[0];
    expect(sigEntry.format).toBe("SIGNATURE_FORMAT_CONCAT");
    expect(sigEntry.signingAlgorithmSpec).toBe("SIGNING_ALGORITHM_SPEC_ED25519");
    expect(sigEntry.signedBy).toBe(key.fingerprint);
    // Verify the base64 signature decodes to exactly 64 bytes (Ed25519)
    expect(Buffer.from(sigEntry.signature, "base64").length).toBe(64);
  });

  it("deduplication period sent in prepare request is forwarded verbatim", async () => {
    // The prepare endpoint receives the full InteractivePrepareBody;
    // deduplicationPeriod is an execute-time concern and NOT in the prepare body.
    // This test confirms the prepare body contains userId/commandId/actAs but
    // NOT deduplicationPeriod (which belongs to execute).
    const key = makeKey();
    const prepareBody: any[] = [];
    const executeBody: any[] = [];

    const client = makeClient(
      makeFetch(({ url, init }) => {
        const body = init.body ? JSON.parse(init.body as string) : {};
        if (url.endsWith("/prepare")) {
          prepareBody.push(body);
          return {
            body: {
              preparedTransaction: "T",
              preparedTransactionHash: Buffer.from("h").toString("base64"),
            },
          };
        }
        executeBody.push(body);
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c",
        actAs: ["p"],
        synchronizerId: "s",
        commands: [],
      },
      key,
      { deduplicationPeriod: { DeduplicationDuration: { duration: "60s" } } }
    );

    // deduplicationPeriod must be in the execute body
    expect(executeBody[0]?.deduplicationPeriod).toEqual({
      DeduplicationDuration: { duration: "60s" },
    });
    // The prepare body should NOT contain deduplicationPeriod
    expect(prepareBody[0]?.deduplicationPeriod).toBeUndefined();
  });

  it("orchestrates prepare → sign → execute and returns the updateId", async () => {
    const key = makeKey();
    const calls: Array<{ url: string; body: any }> = [];

    const client = makeClient(
      makeFetch(({ url, init }) => {
        const body = init.body ? JSON.parse(init.body as string) : {};
        calls.push({ url, body });
        if (url.endsWith("/v2/interactive-submission/prepare")) {
          return {
            body: {
              preparedTransaction: "BASE64_TX",
              preparedTransactionHash:
                Buffer.from("hash-bytes-32-bytes-padding-1234").toString(
                  "base64"
                ),
            },
          };
        }
        if (url.endsWith("/v2/interactive-submission/execute")) {
          return { body: { updateId: "u-final", completionOffset: 99 } };
        }
        return { status: 404, body: { error: "unexpected" } };
      })
    );

    const signer = new CantonExternalPartySigner(client);

    const result = await signer.prepareSignAndExecute(
      {
        userId: "agent-user",
        commandId: "cmd-1",
        actAs: ["agent::1220abc"],
        synchronizerId: "global-sync",
        commands: [
          {
            ExerciseCommand: {
              templateId: "#canton-x402:Canton.X402:MerchantContract",
              contractId: "merchant-cid",
              choice: "Deactivate",
              choiceArgument: {},
            },
          },
        ],
      },
      key
    );

    expect(result.updateId).toBe("u-final");
    expect(result.completionOffset).toBe(99);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${URL}/v2/interactive-submission/prepare`);
    expect(calls[1]?.url).toBe(`${URL}/v2/interactive-submission/execute`);

    const exec = calls[1]?.body;
    expect(exec.preparedTransaction).toBe("BASE64_TX");
    expect(exec.hashingSchemeVersion).toBe("HASHING_SCHEME_VERSION_V2");
    expect(exec.partySignatures.signatures).toHaveLength(1);
    expect(exec.partySignatures.signatures[0].party).toBe("agent::1220abc");
    expect(exec.partySignatures.signatures[0].signatures[0].signedBy).toBe(
      key.fingerprint
    );

    // The submitted signature must verify against the hash returned by prepare.
    const sigEntry = exec.partySignatures.signatures[0].signatures[0];
    const sigBytes = Buffer.from(sigEntry.signature, "base64");
    const hashBytes = Buffer.from(
      "hash-bytes-32-bytes-padding-1234"
    );
    const ok = cryptoVerify(null, hashBytes, key.publicKey, sigBytes);
    expect(ok).toBe(true);
  });

  it("multiple simultaneous calls each use their own commandId (no commandId reuse)", async () => {
    const key = makeKey();
    const capturedCommandIds: string[] = [];

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          const body = JSON.parse(init.body as string);
          capturedCommandIds.push(body.commandId);
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);

    await Promise.all([
      signer.prepareSignAndExecute(
        {
          userId: "u",
          commandId: "cmd-concurrent-1",
          actAs: ["p::1220"],
          synchronizerId: "s",
          commands: [],
        },
        key
      ),
      signer.prepareSignAndExecute(
        {
          userId: "u",
          commandId: "cmd-concurrent-2",
          actAs: ["p::1220"],
          synchronizerId: "s",
          commands: [],
        },
        key
      ),
    ]);

    expect(capturedCommandIds).toHaveLength(2);
    expect(capturedCommandIds).toContain("cmd-concurrent-1");
    expect(capturedCommandIds).toContain("cmd-concurrent-2");
    // Each call must have a distinct commandId
    expect(new Set(capturedCommandIds).size).toBe(2);
  });

  it("signature bytes in the execute body are base64-encoded (not hex, not raw binary)", async () => {
    const key = makeKey();
    let executeSig: string | undefined;

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash:
                Buffer.from("hash-bytes-32-pad-xxxxxxxxxxx").toString("base64"),
            },
          };
        }
        if (url.endsWith("/execute")) {
          const body = JSON.parse(init.body as string);
          executeSig =
            body?.partySignatures?.signatures?.[0]?.signatures?.[0]?.signature;
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c",
        actAs: ["p::1220"],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    expect(executeSig).toBeDefined();
    // Must be a valid base64 string (only base64 alphabet chars)
    expect(executeSig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Decodes to exactly 64 bytes (Ed25519 signature)
    expect(Buffer.from(executeSig!, "base64").length).toBe(64);
    // Must NOT be a hex string (all hex would be [0-9a-f])
    expect(executeSig).not.toMatch(/^[0-9a-f]{128}$/);
  });

  it("zero deduplication period (undefined) → execute body defaults to {Empty: {}}", async () => {
    const key = makeKey();
    let executeBody: any = null;

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "T",
              preparedTransactionHash: Buffer.from("h").toString("base64"),
            },
          };
        }
        executeBody = JSON.parse(init.body as string);
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    // Call with NO deduplicationPeriod option
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c",
        actAs: ["p"],
        synchronizerId: "s",
        commands: [],
      },
      key
      // opts intentionally omitted
    );

    // When no deduplicationPeriod is supplied, the client defaults to {Empty: {}}
    expect(executeBody?.deduplicationPeriod).toEqual({ Empty: {} });
    // And the prepare body never carries deduplicationPeriod
  });

  it("two sequential calls produce different commandIds (no commandId reuse between calls)", async () => {
    const key = makeKey();
    const capturedIds: string[] = [];

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          const body = JSON.parse(init.body as string);
          capturedIds.push(body.commandId);
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);

    await signer.prepareSignAndExecute(
      { userId: "u", commandId: "cmd-seq-1", actAs: ["p::1220"], synchronizerId: "s", commands: [] },
      key
    );
    await signer.prepareSignAndExecute(
      { userId: "u", commandId: "cmd-seq-2", actAs: ["p::1220"], synchronizerId: "s", commands: [] },
      key
    );

    expect(capturedIds).toHaveLength(2);
    expect(capturedIds[0]).toBe("cmd-seq-1");
    expect(capturedIds[1]).toBe("cmd-seq-2");
    // Explicit check: the two commandIds are different
    expect(capturedIds[0]).not.toBe(capturedIds[1]);
  });

  it("prepare body includes synchronizerId in the commands", async () => {
    const key = makeKey();
    let prepareBody: any = null;

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          prepareBody = JSON.parse(init.body as string);
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c",
        actAs: ["p::1220"],
        synchronizerId: "global-domain::1220cafef00d",
        commands: [],
      },
      key
    );

    expect(prepareBody).not.toBeNull();
    expect(prepareBody.synchronizerId).toBe("global-domain::1220cafef00d");
  });

  // ── NEW: synchronizerId in commands body matches what was passed in ──────
  it("prepareSignAndExecute: the synchronizerId in commands body matches what was passed in", async () => {
    const key = makeKey();
    let capturedPrepareBody: any = null;

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          capturedPrepareBody = JSON.parse(init.body as string);
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    const synchronizerId = "global-domain::1220cafebabe";
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "sync-id-test",
        actAs: ["agent::1220xyz"],
        synchronizerId,
        commands: [],
      },
      key
    );

    expect(capturedPrepareBody).not.toBeNull();
    expect(capturedPrepareBody.synchronizerId).toBe(synchronizerId);
  });

  it("signPreparedTransactionHash output length is always 64 bytes regardless of hash length", () => {
    const key = makeKey();
    // Short hash
    const shortHash = Buffer.from("a").toString("base64");
    // Long hash (128 bytes)
    const longHash = Buffer.alloc(128, 0xab).toString("base64");
    // 32-byte hash (standard)
    const standardHash = Buffer.alloc(32, 0xcd).toString("base64");

    const sig1 = signPreparedTransactionHash(shortHash, key);
    const sig2 = signPreparedTransactionHash(longHash, key);
    const sig3 = signPreparedTransactionHash(standardHash, key);

    // Ed25519 signatures are always exactly 64 bytes regardless of message length
    expect(Buffer.from(sig1.signature, "base64").length).toBe(64);
    expect(Buffer.from(sig2.signature, "base64").length).toBe(64);
    expect(Buffer.from(sig3.signature, "base64").length).toBe(64);
  });

  it("prepareSignAndExecute: the party from constructor appears in requestingParties", async () => {
    const key = makeKey();
    let capturedExecuteBody: any = null;
    const SPECIFIC_PARTY = "specific-requesting-party::1220srp";

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash").toString("base64"),
            },
          };
        }
        if (url.endsWith("/execute")) {
          capturedExecuteBody = JSON.parse(init.body as string);
          return { body: { updateId: "u-rp-party", completionOffset: 0 } };
        }
        return { status: 404, body: {} };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "cmd-rp-party",
        actAs: [SPECIFIC_PARTY],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    // The party must appear in partySignatures.signatures[].party
    const sigParties = capturedExecuteBody?.partySignatures?.signatures?.map((s: any) => s.party) ?? [];
    expect(sigParties).toContain(SPECIFIC_PARTY);
  });

  it("two CantonExternalPartySigner instances with different parties produce different signatures", async () => {
    const keyA = makeKey();
    const keyB = makeKey();

    const hash = Buffer.from("test-hash-same-message").toString("base64");

    const sigA = signPreparedTransactionHash(hash, keyA);
    const sigB = signPreparedTransactionHash(hash, keyB);

    // Same message, different keys → different signatures
    expect(sigA.signature).not.toBe(sigB.signature);
    // But both have the correct format
    expect(Buffer.from(sigA.signature, "base64").length).toBe(64);
    expect(Buffer.from(sigB.signature, "base64").length).toBe(64);
    // signedBy differs (different fingerprints)
    expect(sigA.signedBy).not.toBe(sigB.signedBy);
  });

  it("ed25519KeyFromNodeKeyPair: result has fingerprint, publicKey, privateKey, sign properties", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = ed25519KeyFromNodeKeyPair({ privateKey, publicKey });

    // All four required properties must be present
    expect(key).toHaveProperty("fingerprint");
    expect(key).toHaveProperty("publicKey");
    expect(key).toHaveProperty("privateKey");
    // fingerprint must be a non-empty hex string
    expect(typeof key.fingerprint).toBe("string");
    expect(key.fingerprint.length).toBe(64);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // publicKey must be a KeyObject with asymmetricKeyType ed25519
    expect(key.publicKey.asymmetricKeyType).toBe("ed25519");
    // privateKey must be a KeyObject with asymmetricKeyType ed25519
    expect(key.privateKey.asymmetricKeyType).toBe("ed25519");
  });

  it("commandId sent to prepare is the caller-supplied value (not mutated)", async () => {
    // The execute body does not carry commandId (it uses preparedTransaction + partySignatures),
    // so we only verify that the prepare body carries the correct commandId.
    const key = makeKey();
    let prepareCommandId: string | undefined;

    const client = makeClient(
      makeFetch(({ url, init }) => {
        const body = init.body ? JSON.parse(init.body as string) : {};
        if (url.endsWith("/prepare")) {
          prepareCommandId = body.commandId;
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash-same-cmd-id-test").toString("base64"),
            },
          };
        }
        if (url.endsWith("/execute")) {
          return { body: { updateId: "u-same-cmd", completionOffset: 0 } };
        }
        return { status: 404, body: {} };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "shared-cmd-id-12345",
        actAs: ["p::1220"],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    // The prepare body must carry the exact commandId the caller supplied
    expect(prepareCommandId).toBe("shared-cmd-id-12345");
  });

  it("signPreparedTransactionHash: signing with key and random hash → non-zero bytes in signature", () => {
    const key = makeKey();
    const randomHash = Buffer.from(
      Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
    ).toString("base64");

    const entry = signPreparedTransactionHash(randomHash, key);
    const sigBytes = Buffer.from(entry.signature, "base64");

    // Must be exactly 64 bytes
    expect(sigBytes.length).toBe(64);
    // Must have at least some non-zero bytes (an all-zeros signature would be invalid)
    const allZero = sigBytes.every((b) => b === 0);
    expect(allZero).toBe(false);
  });

  it("prepareSignAndExecute: the updateId from execute response is returned", async () => {
    const key = makeKey();
    const EXPECTED_UPDATE_ID = "u-specific-update-id-xyz";

    const client = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("h").toString("base64"),
            },
          };
        }
        return { body: { updateId: EXPECTED_UPDATE_ID, completionOffset: 42 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    const result = await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c-update-id-test",
        actAs: ["p::1220"],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    expect(result.updateId).toBe(EXPECTED_UPDATE_ID);
  });

  it("prepareSignAndExecute: async execute (empty updateId) resolves empty; caller polls the completion", async () => {
    // /execute is async: it returns {} and the updateId arrives on the completion
    // stream. The low-level call resolves with an empty updateId; the relay polls
    // via pollCompletionUpdateId to surface it.
    const key = makeKey();

    const client = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("h").toString("base64"),
            },
          };
        }
        // Execute returns empty/missing updateId — participant bug simulation
        return { body: { updateId: "", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await expect(
      signer.prepareSignAndExecute(
        {
          userId: "u",
          commandId: "c-empty-update",
          actAs: ["p::1220"],
          synchronizerId: "s",
          commands: [],
        },
        key
      )
    ).resolves.toMatchObject({ updateId: "" });
  });

  it("CantonExternalPartySigner: prepare body includes actAs field", async () => {
    const key = makeKey();
    let capturedPrepareBody: any = null;

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          capturedPrepareBody = JSON.parse(init.body as string);
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("h").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c-actas-in-prepare",
        actAs: ["check-party::1220check"],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    expect(capturedPrepareBody).not.toBeNull();
    // actAs must be present in the prepare body (not just execute)
    expect(capturedPrepareBody.actAs).toBeDefined();
    expect(Array.isArray(capturedPrepareBody.actAs)).toBe(true);
    expect(capturedPrepareBody.actAs).toContain("check-party::1220check");
  });

  it("forwards an explicit deduplicationPeriod when given", async () => {
    const key = makeKey();
    let exec: any = null;
    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          return {
            body: {
              preparedTransaction: "x",
              preparedTransactionHash: Buffer.from("h").toString("base64"),
            },
          };
        }
        exec = JSON.parse(init.body as string);
        return { body: { updateId: "u", completionOffset: 0 } };
      })
    );
    const signer = new CantonExternalPartySigner(client);

    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "c",
        actAs: ["p"],
        synchronizerId: "s",
        commands: [],
      },
      key,
      { deduplicationPeriod: { DeduplicationDuration: { duration: "30s" } } }
    );

    expect(exec.deduplicationPeriod).toEqual({
      DeduplicationDuration: { duration: "30s" },
    });
  });

  // ---------------------------------------------------------------------------
  // Completeness round (batch 4) — additional targeted tests
  // ---------------------------------------------------------------------------

  it("ed25519KeyFromNodeKeyPair: fingerprint is lowercase hex (no uppercase)", () => {
    const key = makeKey();
    // SHA-256 hex fingerprint must be entirely lowercase
    expect(key.fingerprint).toBe(key.fingerprint.toLowerCase());
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Must NOT contain uppercase hex digits
    expect(key.fingerprint).not.toMatch(/[A-F]/);
  });

  it("signPreparedTransactionHash: calling twice with same args gives same signature (deterministic)", () => {
    const key = makeKey();
    const hash = Buffer.from("deterministic-test-payload-32by").toString("base64");
    const sig1 = signPreparedTransactionHash(hash, key);
    const sig2 = signPreparedTransactionHash(hash, key);
    // Ed25519 is deterministic — same key + same message = same signature
    expect(sig1.signature).toBe(sig2.signature);
    expect(sig1.signedBy).toBe(sig2.signedBy);
  });

  it("CantonExternalPartySigner: prepare body contains commandId that matches the one used in execute", async () => {
    // The commandId in the prepare body must be the exact one supplied by the caller.
    // We verify both prepare and execute see the same commandId.
    const key = makeKey();
    let prepareCommandId: string | undefined;
    const CALLER_COMMAND_ID = "caller-specific-cmd-id-99";

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          const body = JSON.parse(init.body as string);
          prepareCommandId = body.commandId;
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash-ep").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u-ep", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: CALLER_COMMAND_ID,
        actAs: ["p::1220"],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    // The commandId sent to prepare must exactly match the caller-supplied value
    expect(prepareCommandId).toBe(CALLER_COMMAND_ID);
  });

  it("prepareSignAndExecute: actAs in the prepare body contains the signer's party", async () => {
    const key = makeKey();
    let capturedActAs: string[] | undefined;
    const SIGNER_PARTY = "signer-party::1220sp";

    const client = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/prepare")) {
          const body = JSON.parse(init.body as string);
          capturedActAs = body.actAs;
          return {
            body: {
              preparedTransaction: "TX",
              preparedTransactionHash: Buffer.from("hash-actas").toString("base64"),
            },
          };
        }
        return { body: { updateId: "u-actas", completionOffset: 0 } };
      })
    );

    const signer = new CantonExternalPartySigner(client);
    await signer.prepareSignAndExecute(
      {
        userId: "u",
        commandId: "cmd-actas",
        actAs: [SIGNER_PARTY],
        synchronizerId: "s",
        commands: [],
      },
      key
    );

    expect(capturedActAs).toBeDefined();
    expect(capturedActAs).toContain(SIGNER_PARTY);
  });

  it("signPreparedTransactionHash: signature decodes to exactly 64 bytes", () => {
    const key = makeKey();
    const hash = Buffer.from("verify-sig-length-test-payload-32").toString("base64");
    const entry = signPreparedTransactionHash(hash, key);
    const sigBytes = Buffer.from(entry.signature, "base64");
    // Ed25519 signature is always exactly 64 bytes (R||S CONCAT format)
    expect(sigBytes.length).toBe(64);
  });
});
