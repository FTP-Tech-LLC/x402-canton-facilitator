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
  // NO `payer` requirement: the wire payload no longer carries a `payer`
  // (an untrusted client claim, removed per spec — the facilitator proves the
  // payer from the relay stash row). A legacy 0.6.x client may still send a
  // stray `payer` key; it is simply IGNORED here (loose object — no strict
  // rejection), and the trusted payer is resolved later per-method.

  // transfer-factory: the payload carries only the relay-stash reference (the
  // signed prepared tx lives on the relay — it cannot fit an X-PAYMENT header).
  if (inner.assetTransferMethod === "transfer-factory") {
    if (
      typeof inner.submissionRef !== "string" ||
      inner.submissionRef.length === 0 ||
      inner.submissionRef.length > 128
    ) {
      return {
        ok: false,
        error:
          "paymentPayload.payload.submissionRef required for transfer-factory",
      };
    }
    if (
      inner.preparedTxHash !== undefined &&
      typeof inner.preparedTxHash !== "string"
    ) {
      return {
        ok: false,
        error: "paymentPayload.payload.preparedTxHash must be a string",
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
