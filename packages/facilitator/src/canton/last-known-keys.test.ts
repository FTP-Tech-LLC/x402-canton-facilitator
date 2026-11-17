import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLastKnownKeys } from "./last-known-keys.js";
import { TopologyLookupError } from "./topology-reader-client.js";
import { createPayerProofVerifier } from "./payer-proof.js";

const A = "agent::1220aa";
const B = "agent::1220bb";
const KEY = Buffer.from("MCowBQYDK2VwAyEA9gkgiwSF1eEITnqJsciQfXRplLi0z9Yw9KUrTnVTuE8=", "base64");
const HOUR = 3_600_000;

/** A lookup whose answer the test switches between keys and a failure. */
function source() {
  let answer: Buffer[] | Error = [KEY];
  let calls = 0;
  const lookup = async (_party: string): Promise<Buffer[]> => {
    calls++;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    lookup,
    calls: () => calls,
    give: (keys: Buffer[]) => {
      answer = keys;
    },
    fail: (reason: "unavailable" | "no_key" | "reader_error") => {
      answer = new TopologyLookupError(`reader says ${reason}`, reason);
    },
  };
}

describe("last known keys", () => {
  it("passes a fresh answer through and remembers nothing by itself", async () => {
    const s = source();
    const known = createLastKnownKeys({ maxStaleMs: HOUR });
    const lookup = known.wrap(s.lookup);
    expect((await lookup(A))[0]!.equals(KEY)).toBe(true);
    s.fail("unavailable");
    await expect(lookup(A)).rejects.toMatchObject({ reason: "unavailable" });
    expect(known.recentParty()).toBeUndefined();
  });

  it("uses a verified payer's keys when no reader answers, and says so", async () => {
    let t = 0;
    const served: Array<[string, number]> = [];
    const s = source();
    const known = createLastKnownKeys({
      maxStaleMs: HOUR,
      now: () => t,
      onServedStale: (party, age) => served.push([party, age]),
    });
    const lookup = known.wrap(s.lookup);
    known.remember(A, [KEY]);
    s.fail("unavailable");
    t = 5_000;
    expect((await lookup(A))[0]!.equals(KEY)).toBe(true);
    expect(served).toEqual([[A, 5_000]]);
  });

  it("also stands in for a misconfigured reader", async () => {
    const s = source();
    const known = createLastKnownKeys({ maxStaleMs: HOUR });
    known.remember(A, [KEY]);
    s.fail("reader_error");
    expect((await known.wrap(s.lookup)(A))[0]!.equals(KEY)).toBe(true);
  });

  it("refuses a copy older than the limit, and forgets it", async () => {
    let t = 0;
    const s = source();
    const known = createLastKnownKeys({ maxStaleMs: HOUR, now: () => t });
    const lookup = known.wrap(s.lookup);
    known.remember(A, [KEY]);
    s.fail("unavailable");
    t = HOUR + 1;
    await expect(lookup(A)).rejects.toMatchObject({ reason: "unavailable" });
    t = 0;
    await expect(lookup(A)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("lets topology's no_key win over memory and drops the copy", async () => {
    const s = source();
    const known = createLastKnownKeys({ maxStaleMs: HOUR });
    const lookup = known.wrap(s.lookup);
    known.remember(A, [KEY]);
    s.fail("no_key");
    await expect(lookup(A)).rejects.toMatchObject({ reason: "no_key" });
    s.fail("unavailable");
    await expect(lookup(A)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("has nothing to offer for a payer it never verified", async () => {
    const s = source();
    const known = createLastKnownKeys({ maxStaleMs: HOUR });
    s.fail("unavailable");
    await expect(known.wrap(s.lookup)(B)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("drops the least recently verified payer first", async () => {
    const s = source();
    const known = createLastKnownKeys({ maxStaleMs: HOUR, maxEntries: 1 });
    const lookup = known.wrap(s.lookup);
    known.remember(A, [KEY]);
    known.remember(B, [KEY]);
    s.fail("unavailable");
    await expect(lookup(A)).rejects.toMatchObject({ reason: "unavailable" });
    expect((await lookup(B))[0]!.equals(KEY)).toBe(true);
  });

  it("keeps its own copy, so neither the caller nor the source can change it", async () => {
    const s = source();
    const known = createLastKnownKeys({ maxStaleMs: HOUR });
    const lookup = known.wrap(s.lookup);
    const mine = Buffer.from(KEY);
    known.remember(A, [mine]);
    mine.fill(0);
    s.fail("unavailable");
    (await lookup(A))[0]!.fill(0);
    expect((await lookup(A))[0]!.equals(KEY)).toBe(true);
  });

  it("names the most recently verified payer while its copy is usable", () => {
    let t = 0;
    const known = createLastKnownKeys({ maxStaleMs: HOUR, now: () => t });
    expect(known.recentParty()).toBeUndefined();
    known.remember(A, [KEY]);
    known.remember(B, [KEY]);
    expect(known.recentParty()).toBe(B);
    known.forget(B);
    expect(known.recentParty()).toBe(A);
    t = HOUR + 1;
    expect(known.recentParty()).toBeUndefined();
  });

  it("refuses a limit of zero", () => {
    expect(() => createLastKnownKeys({ maxStaleMs: 0 })).toThrow();
  });

  it("verifies a real signature during an outage with the key of the payer's last verified payment", async () => {
    const { generateKeyPairSync, sign: cryptoSign } = await import("node:crypto");
    const { recomputeHash } = await import("@ftptech/x402-canton-ledger");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
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
    const digest = Buffer.from(await recomputeHash(bytes.toString("base64")), "base64");
    const input = {
      preparedTransactionBytes: bytes,
      claimedPreparedTxHash: digest.toString("hex"),
      signatureB64: cryptoSign(null, digest, privateKey).toString("base64"),
      payer: A,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
    };

    const s = source();
    s.give([spki]);
    const known = createLastKnownKeys({ maxStaleMs: HOUR });
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: known.wrap(s.lookup),
      onVerified: (party, keys) => known.remember(party, keys),
    });

    // A forged signature does not get its party remembered.
    const other = generateKeyPairSync("ed25519").privateKey;
    const forged = { ...input, signatureB64: cryptoSign(null, digest, other).toString("base64") };
    expect((await verify(forged)).verified).toBe(false);
    expect(known.recentParty()).toBeUndefined();

    expect((await verify(input)).verified).toBe(true);
    expect(known.recentParty()).toBe(A);
    s.fail("unavailable");
    expect((await verify(input)).verified).toBe(true);
    expect((await verify(forged)).verified).toBe(false);
  });
});
