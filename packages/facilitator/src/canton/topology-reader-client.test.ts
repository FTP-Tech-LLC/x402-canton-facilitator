import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTopologyReaderLookup } from "./topology-reader-client.js";
import { createPayerProofVerifier } from "./payer-proof.js";

const PARTY =
  "agent::1220e8e7295ce8601422a15c4e0e31ac90099fb309dac7cf80ea30b6f65add4c38a6";
/** A real key captured from MainNet topology, DER X.509 SPKI. */
const DER = "MCowBQYDK2VwAyEA9gkgiwSF1eEITnqJsciQfXRplLi0z9Yw9KUrTnVTuE8=";

function reader(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response
) {
  return createTopologyReaderLookup({
    baseUrl: "http://reader:8099/",
    token: "tok",
    fetchImpl: (async (u: string, i?: RequestInit) => handler(u, i)) as never,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("topology reader lookup", () => {
  it("asks the right URL with the bearer, and returns DER buffers", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const keys = await reader((u, i) => {
      seenUrl = u;
      seenAuth = (i?.headers as Record<string, string>)?.authorization;
      return json({ party: PARTY, keys: [{ derBase64: DER }] });
    })(PARTY);

    expect(seenUrl).toBe(
      `http://reader:8099/v1/party/${encodeURIComponent(PARTY)}/signing-keys`
    );
    expect(seenAuth).toBe("Bearer tok");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.toString("base64")).toBe(DER);
  });

  it("throws — never returns empty — when the party has no protocol key", async () => {
    // Returning [] would reach the verifier as "no usable keys", which is also
    // a refusal, but the throw carries WHY. An operator seeing this message
    // looks at the payer; the 503 message below sends them to the node.
    await expect(
      reader(() => json({ party: PARTY, keys: [] }))(PARTY)
    ).rejects.toThrow(/publishes no protocol signing key/);
  });

  it("distinguishes an unreadable topology from an unonboarded payer", async () => {
    await expect(
      reader(() => json({ error: "topology_unavailable" }, 503))(PARTY)
    ).rejects.toThrow(/topology unavailable/);
  });

  it("treats every other failure as a refusal too", async () => {
    for (const h of [
      () => json({}, 401),
      () => json({}, 500),
      () => new Response("not json", { status: 200 }),
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]) {
      await expect(reader(h as never)(PARTY)).rejects.toThrow();
    }
  });
});

describe("reader → verifier, end to end on the key format", () => {
  it("a key served by the reader actually verifies a real signature", async () => {
    // The seam this covers: the reader hands back DER, the verifier consumes
    // DER. Before this wiring the verifier took raw 32 bytes and glued the SPKI
    // header on itself, so a format change would have surfaced as "bad
    // signature" rather than as a type error.
    const { generateKeyPairSync, sign: cryptoSign } = await import("node:crypto");
    const { recomputeHash } = await import("@ftptech/x402-canton-ledger");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;

    // The REAL conformant V2 hash over real bytes: signing anything else would
    // fail the hash-binding half and prove nothing about the key path.
    const bytes = Buffer.from(
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
    const digest = Buffer.from(
      await recomputeHash(bytes.toString("base64")),
      "base64"
    );

    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: reader(() =>
        json({ party: PARTY, keys: [{ derBase64: spki.toString("base64") }] })
      ),
    });

    const r = await verify({
      preparedTransactionBytes: bytes,
      claimedPreparedTxHash: digest.toString("hex"),
      signatureB64: cryptoSign(null, digest, privateKey).toString("base64"),
      payer: PARTY,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    });
    expect(r.verified).toBe(true);
    expect(r.preparedTxHashHex).toBe(digest.toString("hex"));
  });

  it("refuses a key that is not an Ed25519 SPKI, whatever the reader claims", async () => {
    // The verifier pins the exact SPKI header rather than trusting the source:
    // a compromised or confused reader must not steer it into another
    // algorithm's key material.
    const { generateKeyPairSync } = await import("node:crypto");
    const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const der = (
      p256.publicKey.export({ format: "der", type: "spki" }) as Buffer
    ).toString("base64");

    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: reader(() =>
        json({ party: PARTY, keys: [{ derBase64: der }] })
      ),
    });
    const r = await verify({
      preparedTransactionBytes: Buffer.from("x"),
      claimedPreparedTxHash: "ab".repeat(32),
      signatureB64: Buffer.alloc(64).toString("base64"),
      payer: PARTY,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    });
    expect(r.verified).toBe(false);
  });
});

describe("the deadline covers the BODY, not just the headers", () => {
  it("gives up on a reader that answers 200 and then stalls", async () => {
    // The failure this pins: clearing the abort timer as soon as the headers
    // arrive leaves the body read unbounded. A reader that returns a status
    // and then never finishes the stream would hold the request for the HTTP
    // client's own default instead of the timeout this option promises — and
    // since every inline /verify and /settle waits on this call, one stalled
    // reader would pin request handlers rather than failing fast and closed.
    const lookup = createTopologyReaderLookup({
      baseUrl: "http://reader.invalid",
      token: "t",
      timeoutMs: 150,
      fetchImpl: (async (_url: string, init?: { signal?: AbortSignal }) =>
        ({
          status: 200,
          ok: true,
          // Never resolves on its own — only the abort can end this.
          json: () =>
            new Promise((_res, rej) => {
              init?.signal?.addEventListener("abort", () =>
                rej(new Error("aborted"))
              );
            }),
        }) as unknown as Response) as unknown as typeof fetch,
    });

    const started = Date.now();
    await expect(lookup("agent::1220" + "aa".repeat(32))).rejects.toThrow(
      /stalled mid-response/
    );
    // Bounded by the deadline, not by some far larger client default.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not call a stall what is really malformed JSON", async () => {
    const lookup = createTopologyReaderLookup({
      baseUrl: "http://reader.invalid",
      token: "t",
      timeoutMs: 5_000,
      fetchImpl: (async () =>
        ({
          status: 200,
          ok: true,
          json: () => Promise.reject(new SyntaxError("Unexpected token <")),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    await expect(lookup("agent::1220" + "aa".repeat(32))).rejects.toThrow(
      /unparseable JSON/
    );
  });
});

/**
 * The reason has to be a FIELD, because two callers act on it: the metric and
 * the pay/commit enforce gate. It used to be re-derived from the message text
 * in one place and not derivable at all in the other.
 */
describe("every lookup failure names why", () => {
  const lookupWith = (fetchImpl: typeof fetch) =>
    createTopologyReaderLookup({
      baseUrl: "http://reader.test",
      token: "t",
      fetchImpl: fetchImpl as never,
    });

  const reasonOf = async (fetchImpl: typeof fetch): Promise<unknown> => {
    const err = await lookupWith(fetchImpl)(PARTY).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    return (err as { reason?: unknown }).reason;
  };

  it("503 is an outage", async () => {
    expect(await reasonOf((async () => new Response("", { status: 503 })) as typeof fetch)).toBe(
      "unavailable"
    );
  });

  it("an unreachable reader is an outage", async () => {
    expect(
      await reasonOf((async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch)
    ).toBe("unavailable");
  });

  it("200 with an empty key list is a definitive no_key", async () => {
    expect(
      await reasonOf(
        (async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as typeof fetch
      )
    ).toBe("no_key");
  });

  it("a non-503 error status is our reader being broken", async () => {
    for (const status of [400, 401, 404, 500]) {
      expect(
        await reasonOf((async () => new Response("", { status })) as typeof fetch),
        String(status)
      ).toBe("reader_error");
    }
  });
})
