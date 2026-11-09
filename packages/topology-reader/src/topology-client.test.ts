import { describe, it, expect } from "vitest";
import { selectCurrentStore, extractKeys } from "./topology-client.js";

/** The real shape, copied from a live MainNet read of an agent party. Writing
 *  a shape by hand is how the JWKS path went wrong; this one was observed. */
const PARTY =
  "agent::1220e8e7295ce8601422a15c4e0e31ac90099fb309dac7cf80ea30b6f65add4c38a6";
const DER = "MCowBQYDK2VwAyEA9gkgiwSF1eEITnqJsciQfXRplLi0z9Yw9KUrTnVTuE8=";

function result(over: Record<string, unknown> = {}, party = PARTY) {
  return {
    context: { serial: 1 },
    item: {
      party,
      threshold: 1,
      participants: [
        {
          participantUid: "FTP-validator-1::1220c065",
          permission: "PARTICIPANT_PERMISSION_CONFIRMATION",
        },
      ],
      partySigningKeys: {
        keys: [
          {
            format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
            publicKey: DER,
            usage: [
              "SIGNING_KEY_USAGE_NAMESPACE",
              "SIGNING_KEY_USAGE_PROOF_OF_OWNERSHIP",
              "SIGNING_KEY_USAGE_PROTOCOL",
            ],
            keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
          },
        ],
      },
      ...over,
    },
  };
}

describe("selectCurrentStore", () => {
  const NS = "global-domain::1220b143";
  it("picks the post-LSU store, not the retired one", () => {
    // This node really does carry both. Selecting the older store would read a
    // frozen topology and miss every party onboarded since the upgrade.
    expect(
      selectCurrentStore([
        { synchronizer: { physicalId: `${NS}::34-0` } },
        { synchronizer: { physicalId: `${NS}::35-5` } },
        { authorized: {} },
      ])
    ).toBe(`${NS}::35-5`);
  });

  it("ranks by serial when the protocol version ties", () => {
    expect(
      selectCurrentStore([
        { synchronizer: { physicalId: `${NS}::35-5` } },
        { synchronizer: { physicalId: `${NS}::35-12` } },
      ])
    ).toBe(`${NS}::35-12`);
  });

  it("refuses to guess rather than picking an unrankable store", () => {
    // Falling back to "the first one" would silently pin a retired store after
    // the next logical synchronizer upgrade, which is a scheduled event.
    expect(() => selectCurrentStore([{ authorized: {} }])).toThrow();
    expect(() =>
      selectCurrentStore([{ synchronizer: { physicalId: "no-suffix" } }])
    ).toThrow();
  });
});

describe("extractKeys — the prefix-filter defence", () => {
  it("returns the key for an exactly-matching party", () => {
    const keys = extractKeys([result()], PARTY);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.derBase64).toBe(DER);
    expect(keys[0]?.keySpec).toBe("SIGNING_KEY_SPEC_EC_CURVE25519");
  });

  it("DROPS a party that merely starts with the requested id", () => {
    // THE ONE THAT MATTERS. Canton's filter_party is a PREFIX filter, so a
    // request for a shortened id comes back with every party underneath it.
    // Without the exact pin we would hand back a stranger's key and then
    // happily verify a stranger's signature against it.
    const impostor = result({}, PARTY + "deadbeef");
    expect(extractKeys([impostor], PARTY)).toHaveLength(0);
    // And the honest record alongside it still comes through.
    expect(extractKeys([impostor, result()], PARTY)).toHaveLength(1);
  });

  it("drops a key that cannot sign a protocol transaction", () => {
    // A namespace-only key would verify nothing the ledger accepts; returning
    // it invites the caller to accept a signature that execute will reject.
    const noProtocol = result({
      partySigningKeys: {
        keys: [
          {
            format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
            publicKey: DER,
            usage: ["SIGNING_KEY_USAGE_NAMESPACE"],
            keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
          },
        ],
      },
    });
    expect(extractKeys([noProtocol], PARTY)).toHaveLength(0);
  });

  it("drops a curve or encoding we did not measure", () => {
    // Silently re-interpreting an unknown format is exactly the guess that
    // broke the previous key-lookup attempt.
    for (const over of [
      { format: "CRYPTO_KEY_FORMAT_RAW" },
      { keySpec: "SIGNING_KEY_SPEC_EC_P256" },
    ]) {
      const odd = result({
        partySigningKeys: {
          keys: [
            {
              format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
              publicKey: DER,
              usage: ["SIGNING_KEY_USAGE_PROTOCOL"],
              keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
              ...over,
            },
          ],
        },
      });
      expect(extractKeys([odd], PARTY)).toHaveLength(0);
    }
  });

  it("survives a party that has no key block at all", () => {
    const bare = result({ partySigningKeys: undefined });
    expect(extractKeys([bare], PARTY)).toEqual([]);
  });

  it("normalises a Buffer publicKey to the same base64", () => {
    // proto-loader hands back Buffers; the HTTP contract is base64.
    const asBuffer = result({
      partySigningKeys: {
        keys: [
          {
            format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
            publicKey: Buffer.from(DER, "base64"),
            usage: ["SIGNING_KEY_USAGE_PROTOCOL"],
            keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
          },
        ],
      },
    });
    expect(extractKeys([asBuffer], PARTY)[0]?.derBase64).toBe(DER);
  });

  it("returns DER that node can actually load as an Ed25519 key", async () => {
    // The whole point of the format pin: what comes out must be consumable
    // without any re-wrapping. If this ever fails, the format assumption moved.
    const { createPublicKey } = await import("node:crypto");
    const key = createPublicKey({
      key: Buffer.from(extractKeys([result()], PARTY)[0]!.derBase64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });
});
