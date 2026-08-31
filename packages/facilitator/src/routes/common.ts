/**
 * Shared validation pipeline used by both /verify and /settle.
 *
 * Returns a discriminated result so each route can map it into its
 * own response shape:
 *   - /verify  → VerifyResponse
 *   - /settle  → SettleResponse (and dispatches per transfer method)
 */
import type {
  FacilitatorRequest,
  CantonErrorCode,
  CantonNetwork,
} from "@ftptech/x402-canton-core";
import type { ConsumedPaymentStore } from "../db/consumed-store.js";
import type { FastifyRequest } from "fastify";
import {
  isInlineCarriage,
  validateInlineTransferPath,
  type InlineValidationDeps,
} from "./inline-transfer.js";

/**
 * Resolve the client IP used as the rate-limit key for the PUBLIC endpoints
 * (/verify and the /settle IP sub-key).
 *
 * `req.ip` is the SINGLE source of truth: Fastify derives it from the
 * X-Forwarded-For chain according to the `trustProxy` policy configured in
 * server.ts (default: trust only the loopback proxy). Under that policy `req.ip`
 * is the real client appended by the trusted proxy, and any client-forged
 * left-hand XFF entries are truncated away by proxy-addr.
 *
 * We deliberately DO NOT fall back to parsing the raw `X-Forwarded-For` header
 * ourselves: that header is fully attacker-controlled, so reading it directly
 * would let a caller mint a fresh per-IP rate-limit bucket on every request by
 * rotating the header — exactly the bypass the limiter exists to prevent. If
 * `req.ip` is somehow empty (it is always populated by Fastify in practice) we
 * key on a single fixed string rather than on a forgeable header, so the
 * limiter still bites instead of failing open.
 */
export function clientIp(req: FastifyRequest): string {
  return req.ip || "unknown";
}

export interface ValidationServices {
  /** Single-use payment store, read by the attribution repair worker.
   *
   *  It does NOT provide settle replay protection today, whatever an earlier
   *  version of this comment claimed: nothing in the source ever calls
   *  `markSettled`, so the table is never written and the worker's `has()`
   *  probe can never be true. Idempotency lives entirely in the inline settle
   *  store (db/inline-settle-store.ts). Left wired because the worker reads it,
   *  and documented honestly so nobody counts it as a guard it is not. */
  consumed?: ConsumedPaymentStore;
  /** transfer-factory ("V3") MASTER SWITCH (config.tfEnabled). Explicit `false`
   *  refuses the inline carriage before it does any work; `undefined` stays
   *  permissive so a caller that never wires it keeps its behaviour.
   *
   *  Gating inline on anything else would be gating it on the wrong thing: with
   *  the switch off, an unauthenticated /verify still ran the whole inline
   *  validation — one Scan read on a caller-chosen merchant party and one
   *  participant ACS query on the decoded payer, under the facilitator's own
   *  credentials, on a deploy the operator believes is inert — and answered
   *  isValid:true. (/settle has its own inline gate, so no money ever moved.) */
  tfEnabled?: boolean | undefined;
  /** Inline-carriage deps. Absent means the inline arm cannot verify a
   *  signature, and it then REFUSES every inline payload — the missing
   *  capability is a rejection, not a skipped check. */
  inline?:
    | Pick<
        InlineValidationDeps,
        | "verifySignature"
        | "fetchPreapproval"
        | "fetchOwnedHoldingAmounts"
        | "maxExecuteBeforeSeconds"
        | "merchantPolicy"
        | "merchantAllowlist"
        | "tokenRegistries"
        | "registryTrustedParties"
      >
    | undefined;
  facilitatorParty: string;
  /** CAIP-2 network identifier this facilitator is configured for.
   *  Used to reject cross-network payment claims (e.g. mainnet claim
   *  submitted to a devnet facilitator). */
  network: CantonNetwork;
}

/**
 * Discriminated outcome. /verify ignores the per-method carriers (just uses
 * the `ok` + `payer` fields); /settle dispatches on `method` to decide how to
 * settle.
 */
export type ValidationOutcome =
  | {
      ok: true;
      /** INLINE carriage — the only one. Settle relays bytes the PAYLOAD
       *  carried, not a row the facilitator stored, so there is nothing to mark
       *  settled and the ledger's own rejection of a respend is the replay
       *  guard. */
      method: "transfer-factory-inline";
      payer: string;
      merchant: string;
      /** Instrument admin of the transfer (pinned by verification). Threads the
       *  registry-utility funds-moved rule into settle's execute. */
      instrumentAdmin: string;
      /** Base64 prepared transaction, exactly as decoded — relayed verbatim. */
      preparedTransaction: string;
      signatureB64: string;
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
      /** The RECOMPUTED transaction hash, proven against the bytes during
       *  verification. /settle keys its idempotency record on this — never on
       *  the client's claimed hash, which is accepted in two spellings and so
       *  could be re-spelled into a second bucket for the same payment. */
      preparedTxHashHex?: string;
      publishedProtocolKeys?: number;
    }
  | { ok: false; reason: CantonErrorCode; payer: string };

/**
 * Runs the full facilitator-side validation pipeline against an
 * incoming FacilitatorRequest. Pure-async — no side effects beyond
 * the read-only Scan + ACS lookups.
 */
export async function runValidation(
  body: FacilitatorRequest,
  svc: ValidationServices,
  nowMs: number
): Promise<ValidationOutcome> {
  const { paymentPayload, paymentRequirements } = body;
  const payload = paymentPayload.payload;
  const extra = paymentRequirements.extra;
  // No trusted payer exists before the inline payload is decoded: the wire
  // payload carries no `payer` claim, so these method-agnostic early-guard
  // outcomes (network / discriminator / exhaustiveness) echo an empty payer.
  // The PROVEN payer is only known after the inline transfer is verified.
  const payer = "";

  // Network guard: reject payments claiming a different network.
  // A mainnet payment submitted to a devnet facilitator (or vice versa)
  // must never silently validate — the holdings live on different ledgers.
  if (paymentRequirements.network !== svc.network) {
    return {
      ok: false,
      reason: "unexpected_canton_ledger_error",
      payer,
    };
  }

  // Discriminator MUST match between payload + requirements; anything else is
  // operator misconfiguration on the merchant side.
  if (payload.assetTransferMethod !== extra.assetTransferMethod) {
    return {
      ok: false,
      reason: "unexpected_canton_ledger_error",
      payer,
    };
  }

  let outcome: ValidationOutcome | null = null;
  if (payload.assetTransferMethod === "transfer-factory") {
    // THE LEGACY CARRIAGE IS A VERDICT, NOT A BAD REQUEST.
    //
    // A payload carrying `submissionRef` comes from a client that worked
    // yesterday; the body is well-formed and we simply no longer settle that
    // shape. Answering 400 would be saying "you sent nonsense", and the shipped
    // middlewares turn a non-2xx into a generic facilitator failure — so the one
    // party who needs to hear "upgrade your client" is the one least likely to.
    // A discriminated reason travels the channel integrators already read.
    if ((payload as { submissionRef?: unknown }).submissionRef !== undefined) {
      // The spec already names this. Rule 2 of specs/scheme_exact_canton.md:
      // "The payload MUST carry preparedTransaction, preparedTxHash and
      // signature. If absent, reject with invalid_exact_canton_missing_proof."
      // A submissionRef payload lacks exactly those three, so it IS that case —
      // and packages/core/src/inline-payload.ts already answers other payloads
      // missing the signed submission with the same code.
      //
      // A second code for one condition would be the divergence this codebase
      // keeps paying for: integrators read the spec's error table, and a reason
      // that appears only in our source is one they cannot look up. The "upgrade
      // your client" detail belongs in the docs and the spec text, not in a
      // parallel enum entry.
      return {
        ok: false,
        reason: "invalid_exact_canton_missing_proof",
        payer,
      };
    }
    outcome = await validateTransferFactoryPath(body, svc, nowMs);
  }

  if (outcome) {
    return outcome;
  }

  // Exhaustiveness: at compile time `payload` is `never` here; at
  // runtime the body validator already rejected unknown
  // assetTransferMethod values with 400, so this branch is only
  // reachable if validate-body.ts gets a new variant added without
  // updating runValidation. No payer was proven, so the discriminated
  // error echoes an empty payer.
  return {
    ok: false,
    reason: "unexpected_canton_ledger_error",
    payer,
  };
}

/**
 * transfer-factory ("V3") verify arm. The client's payload carries the
 * payer-signed prepared transaction INLINE, so any facilitator can relay it —
 * there is no relay-side stash reference (the legacy `submissionRef` carriage
 * was removed). This routes straight to the inline validator, which decodes and
 * structurally verifies the signed bytes against the server's PaymentRequirements.
 *
 * Rejections (all fail-closed):
 *   - TF disabled (master switch off) → transfer_factory_disabled.
 *   - a payload that is not the inline carriage (body validation already rejects
 *     it) → malformed_payload.
 *   - inline structural / signature / amount / receiver / instrument mismatch →
 *     the matching discriminated reason from validateInlineTransferPath.
 */
async function validateTransferFactoryPath(
  body: FacilitatorRequest,
  svc: ValidationServices,
  nowMs: number
): Promise<ValidationOutcome> {
  const { paymentPayload, paymentRequirements } = body;

  // MASTER SWITCH FIRST, then carriage. See ValidationServices.tfEnabled.
  if (svc.tfEnabled === false) {
    return {
      ok: false,
      reason: "invalid_exact_canton_transfer_factory_disabled",
      payer: "",
    };
  }

  // Inline is the ONLY carriage. Body validation already guaranteed the payload
  // is the inline form; a non-inline payload falls through to malformed_payload.
  if (isInlineCarriage(paymentPayload.payload)) {
    const r = await validateInlineTransferPath(body, {
      facilitatorParty: svc.facilitatorParty,
      // The SAME clock the caller passed. Reading the wall clock here instead
      // is the defect that made a 2026 fixture look expired — one field over,
      // same shape, and nothing tested the seam.
      nowMs,
      ...(svc.inline?.verifySignature
        ? { verifySignature: svc.inline.verifySignature }
        : {}),
      ...(svc.inline?.fetchPreapproval
        ? { fetchPreapproval: svc.inline.fetchPreapproval }
        : {}),
      ...(svc.inline?.fetchOwnedHoldingAmounts
        ? { fetchOwnedHoldingAmounts: svc.inline.fetchOwnedHoldingAmounts }
        : {}),
      ...(svc.inline?.merchantPolicy
        ? { merchantPolicy: svc.inline.merchantPolicy }
        : {}),
      ...(svc.inline?.maxExecuteBeforeSeconds !== undefined
        ? { maxExecuteBeforeSeconds: svc.inline.maxExecuteBeforeSeconds }
        : {}),
      ...(svc.inline?.merchantAllowlist
        ? { merchantAllowlist: svc.inline.merchantAllowlist }
        : {}),
      ...(svc.inline?.tokenRegistries
        ? { tokenRegistries: svc.inline.tokenRegistries }
        : {}),
      ...(svc.inline?.registryTrustedParties
        ? { registryTrustedParties: svc.inline.registryTrustedParties }
        : {}),
    });
    if (!r.ok) {
      return {
        ok: false,
        reason: r.reason ?? "invalid_exact_canton_malformed_payload",
        payer: r.payer,
      };
    }
    return {
      ok: true,
      method: "transfer-factory-inline",
      payer: r.payer,
      // Provably the merchant: the structural match pinned the transfer's
      // receiver to paymentRequirements.payTo before this point.
      merchant: paymentRequirements.payTo,
      instrumentAdmin: paymentRequirements.extra?.instrumentId?.admin ?? "",
      preparedTransaction: (r.preparedTransactionBytes ?? Buffer.alloc(0)).toString("base64"),
      signatureB64: r.signatureB64 ?? "",
      hashingSchemeVersion: r.hashingSchemeVersion ?? "HASHING_SCHEME_VERSION_V2",
      ...(r.publishedProtocolKeys !== undefined
        ? { publishedProtocolKeys: r.publishedProtocolKeys }
        : {}),
      ...(r.preparedTxHashHex !== undefined
        ? { preparedTxHashHex: r.preparedTxHashHex }
        : {}),
    };
  }

  // Not the inline carriage — body validation should have rejected it already,
  // so reaching here means a malformed payload.
  return {
    ok: false,
    reason: "invalid_exact_canton_malformed_payload",
    payer: "",
  };
}
