/* ════════════════════════════════════════════════════════════════════════
 * PAYER PROOF — scheme Rule 3 for the inline carriage.
 *
 *   "The decoded prepared transaction MUST contain exactly one
 *    TransferFactory_Transfer, its recomputed hash MUST equal `preparedTxHash`,
 *    and `signature` MUST verify against the payer party over that hash."
 *
 * BOTH HALVES ARE NOW IMPLEMENTED.
 *
 *   A. HASH BINDING — recompute the Canton hash from the decoded bytes and
 *      compare it to the hash the payload claims. Fully implemented here, using
 *      the same conformant recompute the agent signs with (`recomputeHash`,
 *      backed by the official `core-tx-visualizer` and gated by a conformance
 *      test against a captured live-participant vector).
 *
 *   B. SIGNATURE — verify the payer's Ed25519 signature over that hash. The
 *      cryptography is trivial; the hard part was the KEY. A party id carries a
 *      FINGERPRINT (a multihash over the serialized SigningPublicKey protobuf),
 *      which is one-way, so the key cannot be recovered from it. It comes from a
 *      synchronizer topology read — `getPartySigningKeys` — which does NOT
 *      require our participant to host the party.
 *
 * THE LOOKUP IS STILL A PORT, and its absence is still a refusal. That matters
 * operationally: the topology route exists only from Canton 3.5.10 (Splice
 * 0.6.14). On an older participant it 404s, the lookup yields nothing, and this
 * verifier answers false — so an inline payment does not settle rather than
 * settling half-checked.
 *
 * WHY HALF A STILL EARNS ITS PLACE. `preparedTxHash` is what the signature is
 * over and what any audit trail records. Binding it to the bytes removes the
 * case where a client's claimed hash describes a different transaction from the
 * one it shipped. It does NOT prove authorship — only B does — which is why B
 * is not optional and why absence of the key source fails closed rather than
 * degrading to "hash matched, good enough".
 * ════════════════════════════════════════════════════════════════════════ */
import { createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import { recomputeHash } from "@ftptech/x402-canton-ledger";

/**
 * Reads an external party's raw Ed25519 signing keys from synchronizer topology.
 * An empty array means we learned nothing — unknown party, or a participant too
 * old to serve the route — and callers must treat it as "cannot verify".
 */
export type PayerSigningKeyLookup = (party: string) => Promise<Buffer[]>;

/**
 * What a verification PROVED, so the caller never has to re-derive it.
 *
 * `preparedTxHashHex` is the hash this module RECOMPUTED from the bytes and
 * then matched — not the client's claim. The two are equal once verification
 * passes, but only this one is canonical: the claim is accepted in two
 * spellings (bare digest and `1220`-prefixed), so anything keyed on the claim
 * can be split into two by re-spelling it. Callers that need a stable identity
 * for this payment must use this field.
 *
 * There is deliberately NO key identifier here. Canton topology publishes the
 * key BYTES and nothing that can serve as `Signature.signedBy`: the proto's
 * fingerprint field is reserved ("previously public key id"), and the JWKS
 * `kid` that does exist elsewhere is an RFC 7638 thumbprint, which names no key
 * the participant knows. The relay names the payer's namespace instead, which
 * for a single-key external party IS that key's fingerprint. Carrying a field
 * nothing can correctly populate only invites someone to populate it wrongly.
 */
export interface PayerProofResult {
  verified: boolean;
  preparedTxHashHex?: string;
  /**
   * How many usable protocol signing keys topology published for this payer.
   *
   * Reported because it is the one observable that tells an operator a
   * relayed submission may be about to fail for a reason that looks nothing
   * like its cause. `Signature.signedBy` can only ever name the party's
   * NAMESPACE key (see the note above: topology publishes no id we could use
   * for a second one), so a party that published a second key and signed with
   * it verifies here and is then rejected by the participant — which reads as
   * a signature failure, and is not one.
   *
   * Not a gate. Refusing every multi-key payer would also refuse the ones that
   * signed with their namespace key, which relay correctly today; this turns an
   * invisible condition into a log line instead.
   */
  publishedProtocolKeys?: number;
  /**
   * True only when the key lookup itself failed — our reader was unreachable,
   * not the payer's proof being wrong.
   *
   * `onLookupError` already reports this, but as a side channel: it tells the
   * OPERATOR while telling the CALLER nothing, and the caller is the one
   * deciding whether to refuse the payment. A blocking gate needs the
   * distinction in the answer it acts on, because refusing every payment
   * during our own outage turns a dependency blip into a total money-path
   * failure — while a genuinely bad signature is refused by the participant at
   * execute anyway, which is what makes failing open here affordable.
   */
  keyLookupFailed?: boolean;
}

export interface PayerProofOptions {
  fetchPayerSigningKey?: PayerSigningKeyLookup;
  /**
   * Called when the key lookup itself fails, as opposed to succeeding and
   * finding nothing.
   *
   * The reader and its client go to real trouble to keep those two apart — 503
   * "could not read topology" versus 200 "read fine, this party publishes no
   * key" — and both correctly fail closed. But collapsing them at the last
   * consumer destroys the distinction where it matters most: during a reader
   * outage EVERY inline payment is refused with `signature_invalid`, which is
   * indistinguishable on the wire from a forged signature. The operator sees
   * an apparent attack; the truth is their own dependency is down.
   */
  onLookupError?: (party: string, err: unknown) => void;
}

export interface PayerProofInput {
  preparedTransactionBytes: Buffer;
  claimedPreparedTxHash: string;
  signatureB64: string;
  payer: string;
  hashingSchemeVersion: string;
}

/**
 * Reduce a Canton hash to ONE spelling: the bare 64-char lower-case digest.
 *
 * Producers differ on framing: a prepared-transaction hash comes back as 32 raw
 * bytes, while topology hashes carry the `1220` multihash prefix (sha2-256,
 * 32 bytes). A client may reasonably send either spelling of the same hash, so
 * both are reduced before comparing — otherwise an honest payment would be
 * rejected as a mismatch over pure framing.
 *
 * EXPORTED because accepting two spellings is only safe while EVERYTHING that
 * keys on the hash agrees on which one it is. /settle's per-payment rate key
 * did not: it hashed the raw string, so the same payment under the other
 * spelling opened a second bucket with a fresh quota. Anything that derives a
 * key, a counter or an id from a client-supplied hash goes through here.
 */
export function canonicalTxHashHex(hex: string): string | null {
  const lower = hex.trim().toLowerCase();
  // Disambiguate by LENGTH, not by prefix. A bare 32-byte digest whose first
  // two bytes happen to be 0x12 0x20 also "starts with 1220" — roughly one
  // honest payment in 65,536 — and stripping four chars off it leaves 60,
  // which fails the hex test and refuses a perfectly valid signature as
  // invalid. Only a 68-char string can actually be multihash framing.
  const body =
    lower.length === 68 && lower.startsWith("1220") ? lower.slice(4) : lower;
  if (!/^[0-9a-f]{64}$/.test(body)) return null;
  return body;
}

export function digestBytes(hex: string): Buffer | null {
  const body = canonicalTxHashHex(hex);
  return body === null ? null : Buffer.from(body, "hex");
}

/**
 * Build the verifier the inline arm calls. Returns false — never throws for a
 * bad proof — so the caller's single "did it verify" question has a single
 * answer.
 */
export function createPayerProofVerifier(
  opts: PayerProofOptions = {}
): (input: PayerProofInput) => Promise<PayerProofResult> {
  const NO: PayerProofResult = { verified: false };
  return async (input) => {
    // Only V2 is produced by the participants we relay for. An unknown scheme
    // is refused rather than assumed, since guessing wrong yields a hash that
    // cannot match and would surface as a confusing signature failure.
    if (input.hashingSchemeVersion !== "HASHING_SCHEME_VERSION_V2") return NO;

    const claimed = digestBytes(input.claimedPreparedTxHash);
    if (!claimed) return NO;

    // ── A. hash binding ────────────────────────────────────────────────────
    let recomputed: Buffer;
    try {
      recomputed = Buffer.from(
        await recomputeHash(input.preparedTransactionBytes.toString("base64")),
        "base64"
      );
    } catch {
      // A recompute that failed proves nothing; it never falls back to trusting
      // the claimed hash.
      return NO;
    }
    if (recomputed.length !== claimed.length) return NO;
    if (!timingSafeEqual(recomputed, claimed)) return NO;

    // ── B. signature over that hash ────────────────────────────────────────
    if (!opts.fetchPayerSigningKey) return NO;

    // A party may publish more than one protocol signing key, and the payload
    // does not say which one signed. Any of them verifying is the party
    // verifying — that is what the topology threshold means for a single-key
    // signature. An empty list means we learned nothing, which is a refusal.
    let published: Buffer[];
    try {
      published = await opts.fetchPayerSigningKey(input.payer);
    } catch (err) {
      // A lookup that failed is "cannot verify", never "no keys, so accept".
      // Say so out loud: the refusal that reaches the client is
      // `signature_invalid`, and without this the operator cannot tell their
      // own reader being down from someone forging signatures at them.
      opts.onLookupError?.(input.payer, err);
      // `keyLookupFailed` is the ONE exemption from the pay/commit enforce
      // gate, so it has to mean "we could not look", not "we did not like the
      // answer". Topology answering that a party publishes no signing key is a
      // DISPROOF; a 401 from a rotated token is our own breakage. Neither is an
      // outage of topology, and granting them the exemption turned enforce back
      // into observe with no distinct signal. An error shape we do not
      // recognise earns nothing either — an exemption must be proved, not
      // assumed, which is the same direction an UNCONFIGURED lookup already
      // takes (it refuses everything).
      const outage = (err as { reason?: unknown } | null)?.reason === "unavailable";
      return outage
        ? { verified: false, keyLookupFailed: true }
        : { verified: false };
    }
    // Canton publishes an X.509 SubjectPublicKeyInfo. Pin the exact Ed25519
    // SPKI header rather than trusting the source's own type claim: a key of a
    // different algorithm reaching an Ed25519 verify is a category error, and
    // the 44-byte length falls out of the same check.
    const usable = published.filter(
      (der) =>
        der.length === ED25519_SPKI_PREFIX.length + 32 &&
        der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    );
    if (usable.length === 0) return NO;

    let signature: Buffer;
    try {
      signature = Buffer.from(input.signatureB64, "base64");
    } catch {
      return NO;
    }
    if (signature.length !== 64) return NO;

    const keyCount = usable.length;
    for (const der of usable) {
      try {
        // The DER goes in verbatim: topology already hands back exactly the
        // encoding node wants, so there is nothing to re-wrap.
        const key = createPublicKey({ key: der, format: "der", type: "spki" });
        // Ed25519 signs the message directly, so the algorithm argument is null
        // and the "message" is the recomputed digest the payer signed.
        if (cryptoVerify(null, recomputed, key, signature)) {
          return {
            verified: true,
            preparedTxHashHex: recomputed.toString("hex"),
            publishedProtocolKeys: keyCount,
          };
        }
      } catch {
        /* try the next key */
      }
    }
    return NO;
  };
}

/** DER SPKI header for an Ed25519 public key; the raw 32 bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Fingerprint of a raw Ed25519 public key, for a future topology lookup to
 * cross-check what it fetched against the party id's own namespace.
 *
 * NOT used by the verifier above: it hashes the RAW key bytes, whereas Canton's
 * party fingerprint is a multihash over the serialized `SigningPublicKey`
 * protobuf. The two differ, and treating this as the party fingerprint would be
 * a real bug — it is exported for diagnostics only, and named to say so.
 */
export function rawKeySha256Hex(rawKey: Buffer): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
