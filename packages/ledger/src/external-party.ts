/**
 * External-party signing for Canton's JSON Ledger API v2.
 *
 * Architecture (per `docs.digitalasset.com/build/3.4/tutorials/app-dev/
 * external_signing_*`):
 *
 *   1. Build a command set as usual.
 *   2. POST /v2/interactive-submission/prepare — the participant
 *      returns a `preparedTransaction` (opaque base64 protobuf) and
 *      its `preparedTransactionHash` (base64).
 *   3. The external party signs the HASH BYTES locally with its own
 *      key (Ed25519 by default). The participant never sees the key.
 *   4. POST /v2/interactive-submission/execute with the prepared
 *      transaction plus the signature inside a `partySignatures`
 *      envelope. The participant submits and confirms.
 *
 * This module wraps step 3 (signing helper) and step 4's orchestration
 * with the wire types in `client.ts`.
 *
 * Open question (logged in CRON-RUNBOOK.md):
 * - The exact string value of `signingAlgorithmSpec` for Ed25519 is
 *   not authoritatively documented in the 3.4 docs we have. We default
 *   to `"SIGNING_ALGORITHM_SPEC_ED25519"` but expose an override so
 *   callers can correct it without a code change once confirmed
 *   against a live participant.
 */

import {
  createHash,
  type KeyObject,
  sign as cryptoSign,
  randomUUID,
} from "node:crypto";
import {
  CantonError,
  type CantonClient,
  type InteractivePrepareBody,
  type InteractiveExecuteBody,
  type InteractiveExecuteResult,
  type PartySignatureEntry,
} from "./client.js";

export interface ExternalPartyKey {
  /** Ed25519 private KeyObject (e.g. from `crypto.generateKeyPairSync`
   *  or `crypto.createPrivateKey({pem, ...})`). */
  privateKey: KeyObject;
  /** Matching public KeyObject. */
  publicKey: KeyObject;
  /**
   * Fingerprint string used in the `signedBy` field of every
   * signature submitted to `/v2/interactive-submission/execute`.
   *
   * The canonical value is the multihash-sha2-256 of Canton's
   * serialized `SigningPublicKey` protobuf, NOT a hash any client
   * can compute over the raw key bytes. The participant produces it
   * when you call `POST /v2/parties/external/generate-topology` —
   * the response `publicKeyFingerprint` field. Store that and pass
   * it here.
   *
   * For convenience during dev/test, `ed25519KeyFromNodeKeyPair()`
   * falls back to sha256(SPKI DER) hex if no fingerprint is given;
   * but the participant will REJECT signatures whose `signedBy`
   * doesn't match its own multihash, so you MUST override before
   * any real interactive-submission/execute call.
   */
  fingerprint: string;
}

/**
 * Build an `ExternalPartyKey` from a `node:crypto` Ed25519 key pair.
 *
 * If `fingerprint` is omitted, falls back to the local hex
 * SHA-256(SPKI-DER) (dev/test only — the participant won't accept
 * this; supply the participant-emitted multihash from
 * `/v2/parties/external/generate-topology` in real use).
 */
export function ed25519KeyFromNodeKeyPair(args: {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Participant-supplied multihash fingerprint. STRONGLY
   *  RECOMMENDED — see `ExternalPartyKey.fingerprint` JSDoc. */
  fingerprint?: string;
}): ExternalPartyKey {
  if (args.publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `ed25519KeyFromNodeKeyPair: expected an Ed25519 public key, got "${args.publicKey.asymmetricKeyType}"`
    );
  }
  const fp = args.fingerprint ?? defaultFingerprintForDev(args.publicKey);
  return {
    privateKey: args.privateKey,
    publicKey: args.publicKey,
    fingerprint: fp,
  };
}

function defaultFingerprintForDev(publicKey: KeyObject): string {
  // Dev-only fallback. Real participants reject this — they expect
  // the multihash of the serialized `SigningPublicKey` proto, which
  // can't be computed without Canton's protobuf schema. Source the
  // value from `POST /v2/parties/external/generate-topology` instead.
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/**
 * Constant strings the participant requires in
 * `SigningPublicKey.format` / `SigningPublicKey.keySpec` /
 * `Signature.signingAlgorithmSpec` when working with Ed25519.
 *
 * Verified live against cn-quickstart Splice 0.5.3 (2026-05-24) and
 * cross-checked against the JSON Ledger API v2 OpenAPI enum.
 */
export const ED25519_WIRE_CONSTANTS = {
  /** For `SigningPublicKey.format` when sending an SPKI/DER blob. */
  publicKeyFormat: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
  /** For `SigningPublicKey.keySpec` when the key is Ed25519. Canton
   *  uses "EC_CURVE25519" (one token, no underscore inside) rather
   *  than "ED25519". */
  keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
  /** For `Signature.signingAlgorithmSpec` when signing with Ed25519. */
  signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
  /** For `Signature.format`. Ed25519 sigs are the concatenated R||S
   *  64-byte form that `node:crypto.sign(null, msg, ed25519Key)`
   *  produces by default. */
  signatureFormat: "SIGNATURE_FORMAT_CONCAT",
} as const;

export interface SignOptions {
  /** Override the algorithm spec string when the participant expects
   *  a different identifier. */
  signingAlgorithmSpec?: string;
}

/**
 * Sign a base64 `preparedTransactionHash` with an Ed25519 key.
 * Returns the `PartySignatureEntry` shape the JSON Ledger API expects
 * inside `partySignatures[].signatures[]`.
 */
export function signPreparedTransactionHash(
  hashBase64: string,
  key: ExternalPartyKey,
  opts: SignOptions = {}
): PartySignatureEntry {
  const hashBytes = Buffer.from(hashBase64, "base64");
  // Ed25519 in Node: pass `null` as the digest — Ed25519 hashes
  // internally per RFC 8032.
  const sigBytes = cryptoSign(null, hashBytes, key.privateKey);
  return {
    format: ED25519_WIRE_CONSTANTS.signatureFormat,
    signature: sigBytes.toString("base64"),
    signingAlgorithmSpec:
      opts.signingAlgorithmSpec ?? ED25519_WIRE_CONSTANTS.signingAlgorithmSpec,
    signedBy: key.fingerprint,
  };
}

export interface PrepareSignAndExecuteOptions {
  /** Override the execution submissionId (defaults to a random UUID). */
  submissionId?: string;
  /** Override the deduplication period for the execute call.
   *  Defaults to `{Empty: {}}`. */
  deduplicationPeriod?: InteractiveExecuteBody["deduplicationPeriod"];
  /** Override the hashing scheme version. Defaults to V2 which is
   *  the only one in production on Canton 3.4. */
  hashingSchemeVersion?: InteractiveExecuteBody["hashingSchemeVersion"];
  /** Pass-through to `signPreparedTransactionHash`. */
  signOptions?: SignOptions;
}

/**
 * Orchestrator that wraps the full prepare → sign → execute round trip
 * for a single external party. The party signs with `key` over the
 * prepared-transaction hash.
 *
 * If the same submission is signed by multiple parties, call
 * `prepare`, sign each hash separately, and then build your own
 * `execute` body — this convenience handles the common single-party
 * case.
 */
export class CantonExternalPartySigner {
  constructor(private readonly client: CantonClient) {}

  async prepareSignAndExecute(
    request: InteractivePrepareBody,
    key: ExternalPartyKey,
    opts: PrepareSignAndExecuteOptions = {}
  ): Promise<InteractiveExecuteResult> {
    // This helper signs ONCE; that single signature is valid only for the one
    // party whose key produced it. Reusing it across multiple actAs entries
    // would attach one party's signature to OTHER parties (audit L4) — the
    // participant rejects it, and semantically it must never be accepted.
    // Multi-party flows: call prepare, sign each hash with its own key, and
    // build the execute body manually.
    if (request.actAs.length > 1) {
      throw new CantonError(
        `CantonExternalPartySigner.prepareSignAndExecute supports a single ` +
          `actAs party; got ${request.actAs.length}. Sign each party's ` +
          `prepared-tx hash separately and build the execute body manually.`,
        "UNSUPPORTED_MULTI_PARTY"
      );
    }
    const prepared = await this.client.interactiveSubmissionPrepare(request);

    const signature = signPreparedTransactionHash(
      prepared.preparedTransactionHash,
      key,
      opts.signOptions
    );

    // `actAs` carries the parties whose authority the command needs.
    // Each entry in `partySignatures.signatures[]` is keyed by party.
    // For a single-party prepare we sign once per actAs entry with the
    // same key. Multi-party flows are out of scope for this helper.
    const partySignatures: InteractiveExecuteBody["partySignatures"] = {
      signatures: request.actAs.map((party) => ({
        party,
        signatures: [signature],
      })),
    };

    const executeBody: InteractiveExecuteBody = {
      submissionId: opts.submissionId ?? randomUUID(),
      preparedTransaction: prepared.preparedTransaction,
      hashingSchemeVersion: opts.hashingSchemeVersion ?? "HASHING_SCHEME_VERSION_V2",
      partySignatures,
      deduplicationPeriod: opts.deduplicationPeriod ?? { Empty: {} },
    };

    return this.client.interactiveSubmissionExecute(executeBody);
  }
}
