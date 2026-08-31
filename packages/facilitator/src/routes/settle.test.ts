import { describe, it, expect } from "vitest";
import { selectActiveOpenRound, settlePaymentRateKey } from "./settle.js";

// The stash-carriage settle integration suite (operational guards / metrics /
// observability driven through a seeded tf_stash row) was removed with the
// legacy carriage. The inline carriage's settle behaviour — idempotency,
// per-payer rate limiting, the master switch, unknown-outcome handling and
// traffic accounting — is covered by settle-inline.test.ts; the circuit-breaker
// unit lives in rate-limit.test.ts. What remains here are the two carriage-
// agnostic units the settle route exports.

// ---------------------------------------------------------------------------
// H2 regression: deterministic active open-mining-round selection
// ---------------------------------------------------------------------------
// Splice exposes several OpenMiningRounds at once; on the SV scan flavor
// they arrive in arbitrary (contractId-key) order. Settle must pick the
// CURRENT active round — the highest round.number whose opensAt is already
// in the past (opensAt = "Time after which transfers can use this mining
// round", splice-amulet Round.daml) — NOT the positional [0], which could
// be a not-yet-open or superseded round and make TransferCommand_Send fail.

describe("selectActiveOpenRound (unit)", () => {
  const NOW = Date.parse("2026-05-30T12:00:00Z");
  const mk = (id: string, number: string, opensAt?: string) => ({
    contract: { contract_id: id, payload: { round: { number }, ...(opensAt ? { opensAt } : {}) } },
  });

  it("returns undefined for an empty list", () => {
    expect(selectActiveOpenRound([], NOW)).toBeUndefined();
  });

  it("picks the highest round.number among already-open rounds (ignores arbitrary order)", () => {
    const past = "2026-05-30T11:00:00Z";
    const rounds = [
      mk("omr-lo", "41", past),
      mk("omr-hi", "43", past),
      mk("omr-mid", "42", past),
    ];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-hi");
  });

  it("does NOT pick a not-yet-open round even if its number is higher", () => {
    const past = "2026-05-30T11:00:00Z";
    const future = "2026-05-30T13:00:00Z";
    const rounds = [
      mk("omr-future-hi", "99", future), // higher number but opensAt > now
      mk("omr-open", "42", past),
    ];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-open");
  });

  it("treats a missing opensAt as eligible (validator scan-proxy / older shapes)", () => {
    const rounds = [mk("omr-a", "7"), mk("omr-b", "9"), mk("omr-c", "8")];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-b");
  });

  it("falls back to the highest-number round when none are open yet (never worse than [0])", () => {
    const future = "2026-05-30T13:00:00Z";
    const rounds = [mk("omr-x", "50", future), mk("omr-y", "51", future)];
    // No eligible round → fall back to highest number overall.
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-y");
  });

  it("a malformed round.number sorts last but a valid round still wins", () => {
    const rounds = [mk("omr-bad", "not-a-number"), mk("omr-ok", "5")];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-ok");
  });
});

describe("settlePaymentRateKey — one payment, ONE bucket, whichever spelling", () => {
  const H = "a".repeat(64);

  it("the bare digest and the 1220-framed multihash share a bucket", () => {
    // The payer-proof verifier accepts both spellings as the same hash, so a
    // caller could exhaust the per-payment cap under one and get a fresh quota
    // under the other. The cap bounded half of what its comment claimed.
    const bare = settlePaymentRateKey({
      preparedTransaction: "cHJlcA==",
      preparedTxHash: H,
    });
    const framed = settlePaymentRateKey({
      preparedTransaction: "cHJlcA==",
      preparedTxHash: `1220${H}`,
    });
    expect(bare).not.toBeNull();
    expect(framed).toBe(bare);
  });

  it("case is not a second spelling either", () => {
    expect(
      settlePaymentRateKey({
        preparedTransaction: "cHJlcA==",
        preparedTxHash: H.toUpperCase(),
      })
    ).toBe(
      settlePaymentRateKey({ preparedTransaction: "cHJlcA==", preparedTxHash: H })
    );
  });

  it("two DIFFERENT payments still get different buckets", () => {
    // DISCRIMINATOR: canonicalising must not collapse distinct payments into
    // one bucket, which would let any caller evict everyone else's quota.
    const other = "b".repeat(64);
    expect(
      settlePaymentRateKey({ preparedTransaction: "cHJlcA==", preparedTxHash: H })
    ).not.toBe(
      settlePaymentRateKey({
        preparedTransaction: "cHJlcA==",
        preparedTxHash: other,
      })
    );
  });

  it("a bare digest that HAPPENS to begin 1220 is not mistaken for framing", () => {
    // The subtle one, and the reason this delegates to the verifier's own
    // function instead of stripping "1220" on sight: roughly one honest digest
    // in 65,536 starts with those four chars. A naive strip would turn it into
    // 60 chars, which is not a hash at all — and would also let a DIFFERENT
    // payment (the 68-char framing of it) share its bucket incorrectly.
    const looksFramed = "1220" + "c".repeat(60); // 64 chars: a BARE digest
    const framedOfIt = "1220" + looksFramed; // 68 chars: its multihash framing
    const bare = settlePaymentRateKey({
      preparedTransaction: "cHJlcA==",
      preparedTxHash: looksFramed,
    });
    const framed = settlePaymentRateKey({
      preparedTransaction: "cHJlcA==",
      preparedTxHash: framedOfIt,
    });
    // Same hash under the verifier's rule → same bucket.
    expect(framed).toBe(bare);
    // And still distinct from the 60-char string a naive strip would produce.
    expect(bare).not.toBe(
      settlePaymentRateKey({
        preparedTransaction: "cHJlcA==",
        preparedTxHash: "c".repeat(60),
      })
    );
  });

  it("an unparseable hash keeps its own bucket rather than pooling", () => {
    // DISCRIMINATOR: junk must not fall back to a shared key, or one caller
    // sending garbage would spend the bucket of every other garbage sender —
    // and, worse, any collapse-to-constant would be a free eviction primitive.
    const a = settlePaymentRateKey({
      preparedTransaction: "cHJlcA==",
      preparedTxHash: "not-a-hash",
    });
    const b = settlePaymentRateKey({
      preparedTransaction: "cHJlcA==",
      preparedTxHash: "also-not-a-hash",
    });
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe("settlePaymentRateKey — one bucket per payment, never a shared constant", () => {
  it("keys the inline carriage on the transaction hash, NOT the payload text", () => {
    const HASH = "ab".repeat(32);
    const k = settlePaymentRateKey({
      preparedTransaction: "H4sIAAAAAAAA",
      preparedTxHash: HASH,
    });
    expect(k).toMatch(/^tx:[0-9a-f]{32}$/);

    // THE POINT: gzip is not canonical, so the same transaction re-compressed
    // produces different text. Keying on that text put an honest retry in a
    // fresh bucket, and the per-payment limit then bounded nothing.
    expect(
      settlePaymentRateKey({
        preparedTransaction: "H4sIAAAAAAAAdifferentBytes",
        preparedTxHash: HASH,
      })
    ).toBe(k);
  });

  it("falls back to the IP bucket for an inline payload with no hash", () => {
    // Unkeyable rather than pooled under a constant: that payload is rejected
    // downstream anyway, and a constant would let it 429 unrelated merchants.
    expect(settlePaymentRateKey({ preparedTransaction: "AAAA" })).toBeNull();
  });

  it("gives DIFFERENT payments different buckets", () => {
    // The whole point: two merchants settling at once must not share a limit.
    expect(
      settlePaymentRateKey({ preparedTransaction: "x", preparedTxHash: "aa" })
    ).not.toBe(
      settlePaymentRateKey({ preparedTransaction: "x", preparedTxHash: "bb" })
    );
  });

  it("returns null rather than a shared constant when it cannot key", () => {
    // A constant here would let ten unkeyable requests per minute 429 every
    // unrelated merchant — the caller handles null by falling back to the IP
    // bucket instead.
    for (const bad of [null, undefined, 42, "str", {}, { preparedTransaction: "" }]) {
      expect(settlePaymentRateKey(bad)).toBeNull();
    }
  });

  it("ignores a stray submissionRef and keys on the inline payload", () => {
    // The legacy stash carriage is gone: a payload's submissionRef means nothing
    // now. With an inline hash present it keys on that; with none it is unkeyable.
    expect(
      settlePaymentRateKey({ submissionRef: "r1", preparedTransaction: "AAAA", preparedTxHash: "aa" })
    ).toMatch(/^tx:[0-9a-f]{32}$/);
    expect(settlePaymentRateKey({ submissionRef: "r1" })).toBeNull();
  });
});
