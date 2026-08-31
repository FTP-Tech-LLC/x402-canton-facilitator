/**
 * Lightweight shape validation for incoming FacilitatorRequest bodies.
 *
 * Fastify's typed `Body: FacilitatorRequest` is *compile-time* —
 * at runtime any JSON gets through. If the route handler then
 * accesses `body.paymentPayload.payload.assetTransferMethod` on a
 * malformed body, Node throws a TypeError → Fastify returns 500.
 * The x402 conformance contract says malformed bodies should be
 * 4xx, so we pre-validate the shape and short-circuit with 400.
 *
 * This is NOT a full schema — just enough to keep callers honest
 * about the top-level discriminated union, so the route handler's
 * pure-async pipeline can assume well-formed input.
 */

import type { FacilitatorRequest } from "@ftptech/x402-canton-core";
import {
  DEFAULT_MAX_COMPRESSED_BYTES,
  MAX_SIGNATURE_B64_CHARS,
  MAX_PREPARED_TX_HASH_CHARS,
} from "@ftptech/x402-canton-core";

/** Base64 expansion of the codec's compressed cap, with a little slack. These
 *  bounds are deliberately the SAME numbers the payload decoder enforces: a
 *  body boundary that were looser would let oversized input through to the
 *  decoder, and one that were tighter would reject payments the decoder would
 *  have accepted. */
const MAX_INLINE_B64_CHARS = Math.ceil(DEFAULT_MAX_COMPRESSED_BYTES / 3) * 4;
const MAX_SIGNATURE_CHARS = MAX_SIGNATURE_B64_CHARS;

export type BodyValidationOutcome =
  | { ok: true; body: FacilitatorRequest }
  | { ok: false; error: string };

/**
 * Optional gate context. `tfEnabled` is the transfer-factory ("V3") path master
 * switch (config.tfEnabled). When it is EXPLICITLY false the shape validator
 * rejects a transfer-factory payload early (defense-in-depth for the rounds-safe
 * rollout: the /settle branch is the authoritative gate, but rejecting at the
 * body boundary too means a disabled deploy never even parses the payload as
 * well-formed). UNDEFINED = permissive (the transfer-factory payload is
 * accepted).
 */
export interface BodyValidationOptions {
  tfEnabled?: boolean | undefined;
}

export function validateFacilitatorRequestShape(
  raw: unknown,
  opts?: BodyValidationOptions
): BodyValidationOutcome {
  if (!isObject(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  if (raw.x402Version !== 1 && raw.x402Version !== 2) {
    return {
      ok: false,
      error: "x402Version must be 1 or 2",
    };
  }
  if (!isObject(raw.paymentPayload)) {
    return { ok: false, error: "paymentPayload must be an object" };
  }
  const pp = raw.paymentPayload;
  // x402-ENVELOPE: the scheme NAME is "exact" (Canton is a network of the exact
  // scheme). It is the only accepted scheme.
  if (pp.scheme !== "exact") {
    return {
      ok: false,
      error: 'paymentPayload.scheme must be "exact"',
    };
  }
  if (typeof pp.network !== "string" || !pp.network.startsWith("canton:")) {
    return {
      ok: false,
      error: "paymentPayload.network must start with 'canton:'",
    };
  }
  if (!isObject(pp.resource) || typeof pp.resource.url !== "string") {
    return { ok: false, error: "paymentPayload.resource.url required" };
  }
  if (!isObject(pp.payload)) {
    return { ok: false, error: "paymentPayload.payload must be an object" };
  }
  const inner = pp.payload;
  // The payload discriminator is `assetTransferMethod`. transfer-factory is the
  // only settlement method the stack speaks.
  if (inner.assetTransferMethod !== "transfer-factory") {
    return {
      ok: false,
      error:
        "paymentPayload.payload.assetTransferMethod must be 'transfer-factory'",
    };
  }

  // transfer-factory enable-gate (defense-in-depth). When the TF path master
  // switch is EXPLICITLY off, a transfer-factory payload is malformed for this
  // deploy — reject at the body boundary so a disabled facilitator never even
  // parses it as well-formed (the authoritative fail-closed reject lives in the
  // /settle tf branch). `tfEnabled === undefined` stays permissive.
  if (
    inner.assetTransferMethod === "transfer-factory" &&
    opts?.tfEnabled === false
  ) {
    return {
      ok: false,
      error:
        "assetTransferMethod 'transfer-factory' is not enabled on this facilitator (CANTON_X402_TF_ENABLED is off)",
    };
  }
  // NO `payer` requirement: the wire payload does not carry a `payer` (an
  // untrusted client claim — the facilitator proves the payer from the signed
  // transaction). A stray `payer` key from an old client is simply IGNORED here
  // (loose object — no strict rejection).

  // transfer-factory: the INLINE carriage is the only one. The payload carries
  // the payer-signed transaction itself (`preparedTransaction` + `signature` +
  // `preparedTxHash`), so any facilitator can relay it. The legacy `submissionRef`
  // stash carriage was removed — a payload carrying it is rejected, and its
  // sender must upgrade to a client that emits the inline form.
  if (inner.assetTransferMethod === "transfer-factory") {
    // NOT rejected here. A payload carrying `submissionRef` parses fine — it is
    // a working client of the older shape, so the answer is a VERDICT, not a
    // malformed-request 400. This repo's own conformance contract says so:
    //   /verify with submissionRef -> 200, isValid:false, discriminated reason
    //   /settle with the same      -> 200, success:false, matching errorReason
    // It also reaches the integrator better: a 402 carrying
    // `invalid_exact_canton_missing_proof` tells them what is wrong, while a
    // 400 surfaces through the shipped middlewares as a generic facilitator
    // error. The rejection lives in runValidation (common.ts) instead.
    // A LEGACY PAYLOAD IS RECOGNISABLY LEGACY — do not judge it by inline's
    // shape. It carries `submissionRef` and, of course, no `preparedTransaction`;
    // failing it for the missing inline field would answer 400 for a body that
    // is not malformed, just old, and the conformance contract wants
    // 200 + isValid:false + a discriminated reason. runValidation names it
    // `invalid_exact_canton_missing_proof` (the code the spec already defines for a
    // payload without the payer-signed submission); let it get there.
    if (inner.submissionRef !== undefined) {
      return { ok: true, body: raw as FacilitatorRequest };
    }
    // Only cheap shape/bound checks here. Base64 canonicality, gzip framing and
    // the decompressed cap belong to the payload decoder, which the verify arm
    // runs — this boundary exists to keep obviously-oversized bodies from
    // reaching it at all.
    if (
      typeof inner.preparedTransaction !== "string" ||
      inner.preparedTransaction.length === 0 ||
      inner.preparedTransaction.length > MAX_INLINE_B64_CHARS
    ) {
      return {
        ok: false,
        error: `paymentPayload.payload.preparedTransaction must be a non-empty base64 string of at most ${MAX_INLINE_B64_CHARS} chars`,
      };
    }
    if (
      typeof inner.signature !== "string" ||
      inner.signature.length === 0 ||
      inner.signature.length > MAX_SIGNATURE_CHARS
    ) {
      return {
        ok: false,
        error: `paymentPayload.payload.signature must be a non-empty base64 string of at most ${MAX_SIGNATURE_CHARS} chars`,
      };
    }
    if (
      typeof inner.preparedTxHash !== "string" ||
      inner.preparedTxHash.length === 0 ||
      inner.preparedTxHash.length > MAX_PREPARED_TX_HASH_CHARS
    ) {
      return {
        ok: false,
        error:
          "paymentPayload.payload.preparedTxHash is required for the inline carriage",
      };
    }
  }

  if (!isObject(raw.paymentRequirements)) {
    return { ok: false, error: "paymentRequirements must be an object" };
  }
  const req = raw.paymentRequirements;
  if (
    req.scheme !== "exact" ||
    typeof req.network !== "string" ||
    typeof req.amount !== "string" ||
    typeof req.payTo !== "string"
  ) {
    return {
      ok: false,
      error:
        "paymentRequirements requires {scheme:'exact', network, amount, payTo}",
    };
  }
  // extra must be an object (the route handler reads its
  // `extra.assetTransferMethod` discriminator). We deliberately do NOT require the
  // method key here: a missing/mismatched method is handled downstream by
  // runValidation's discriminator cross-check, which returns a discriminated 200
  // invalidReason rather than a 5xx.
  if (!isObject(req.extra)) {
    return {
      ok: false,
      error: "paymentRequirements.extra must be an object",
    };
  }

  return { ok: true, body: raw as unknown as FacilitatorRequest };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
