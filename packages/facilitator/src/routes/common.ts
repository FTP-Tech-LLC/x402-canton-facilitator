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
import {
  wireAmountToLedgerDecimal,
  ledgerDecimalEquals,
} from "@ftptech/x402-canton-core";
import type { ConsumedPaymentStore } from "../db/consumed-store.js";
import type { TfStashStore, TfStashRecord } from "../db/stash-store.js";
import type { FastifyRequest } from "fastify";

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
  /** Single-use payment store for replay protection (audit M2). When set,
   *  /settle records each settled txid (rejecting a second settle) and
   *  /verify rejects an already-settled payment. Optional so route tests
   *  may omit it. */
  consumed?: ConsumedPaymentStore;
  /** transfer-factory ("V3") verify deps. OPTIONAL — a deploy with TF off omits
   *  them; a transfer-factory payload then fails closed
   *  (invalid_exact_canton_transfer_factory_disabled). `stash.get` reads the
   *  relay-recorded transfer fields the /verify arm compares against
   *  PaymentRequirements (NO facilitator-side protobuf decode — the relay built
   *  the tx itself, so its recorded fields are the trust anchor). */
  tf?:
    | {
        stash: Pick<TfStashStore, "get">;
        tfEnabled: boolean;
      }
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
      method: "transfer-factory";
      payer: string;
      /** The MERCHANT (paymentRequirements.payTo) — provably == the relay-
       *  recorded transfer receiver (validateTransferFactoryPath pins
       *  stash.receiver == payTo). */
      merchant: string;
      /** The verified relay stash row — /settle reads its prepared tx +
       *  signature bundle to relay, and its executeBefore/amount for the settle
       *  gate. */
      stash: TfStashRecord;
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
  // No trusted payer exists before the stash row is loaded: the wire payload
  // carries no `payer` claim anymore, so these method-agnostic early-guard
  // outcomes (network / discriminator / exhaustiveness) echo an empty payer.
  // The PROVEN payer is only known per-method, from the relay stash row.
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
    outcome = await validateTransferFactoryPath(body, svc, nowMs);
  }

  if (outcome) {
    return outcome;
  }

  // Exhaustiveness: at compile time `payload` is `never` here; at
  // runtime the body validator already rejected unknown
  // assetTransferMethod values with 400, so this branch is only
  // reachable if validate-body.ts gets a new variant added without
  // updating runValidation. No stash row was resolved, so the discriminated
  // error echoes an empty payer.
  return {
    ok: false,
    reason: "unexpected_canton_ledger_error",
    payer,
  };
}

/**
 * transfer-factory ("V3") verify arm. The client's payload carries only a
 * relay-stash `submissionRef` (the signed prepared tx is 100s of KB and lives on
 * the relay). We load the stash row the RELAY built and recorded at prepare time
 * and compare its recorded transfer fields against the server's
 * PaymentRequirements. No protobuf decode: the relay built the tx, so its
 * recorded fields are the trust anchor; the PAYER's own protection is the
 * client-side verify-before-sign over the returned preparedTransaction.
 *
 * Rejections (all fail-closed):
 *   - TF disabled / deps unwired → transfer_factory_disabled.
 *   - ref unknown / uncommitted (unsigned) / expired
 *     (executeBefore ≤ now) / preparedTxHash mismatch → submission_not_found.
 *   - amount / receiver / instrument mismatch vs requirements → the matching
 *     discriminated reason.
 */
async function validateTransferFactoryPath(
  body: FacilitatorRequest,
  svc: ValidationServices,
  nowMs: number
): Promise<ValidationOutcome> {
  const { paymentPayload, paymentRequirements } = body;
  const payload = paymentPayload.payload as {
    submissionRef?: string;
    preparedTxHash?: string;
  };

  if (!svc.tf || !svc.tf.tfEnabled) {
    // No stash row is loaded yet, so there is no proven payer to echo.
    return {
      ok: false,
      reason: "invalid_exact_canton_transfer_factory_disabled",
      payer: "",
    };
  }
  const submissionRef = payload.submissionRef ?? "";
  const row = submissionRef ? await svc.tf.stash.get(submissionRef) : null;
  // Unknown, uncommitted (unsigned), expired, or hash-mismatch all read as
  // submission_not_found (no ref/state enumeration oracle). No payer-match
  // conjunct: the ref is an unguessable stash reference, `signature` must be
  // present, and `preparedTxHash` binds the exact bytes — matching a
  // client-claimed payer added no authentication (and there is no wire payer
  // to match anymore).
  if (
    !row ||
    row.signature === undefined ||
    new Date(row.executeBefore).getTime() <= nowMs ||
    (payload.preparedTxHash !== undefined &&
      payload.preparedTxHash !== row.txHash)
  ) {
    // No row (or an unusable one) → no proven payer to echo.
    return {
      ok: false,
      reason: "invalid_exact_canton_submission_not_found",
      payer: "",
    };
  }

  // Receiver must be the merchant (paymentRequirements.payTo).
  if (row.receiver !== paymentRequirements.payTo) {
    return {
      ok: false,
      reason: "invalid_exact_canton_merchant_mismatch",
      payer: row.payer,
    };
  }
  // Amount: the recorded row.amount is a ledger Daml Decimal; the wire
  // requirement is atomic under scheme "exact". Normalize both to the ledger
  // Decimal and compare by atomic units (folds "0.1" ≡ "0.1000000000"). A
  // malformed amount on either side fails closed.
  let amountEq = false;
  try {
    amountEq = ledgerDecimalEquals(
      row.amount,
      wireAmountToLedgerDecimal(
        paymentRequirements.scheme,
        paymentRequirements.amount
      )
    );
  } catch {
    amountEq = false;
  }
  if (!amountEq) {
    return {
      ok: false,
      reason: "invalid_exact_canton_amount_mismatch",
      payer: row.payer,
    };
  }
  // Instrument: if the requirement pins an instrumentId, the recorded row must
  // match its admin (+id). (assetMatches at the middleware already pinned the
  // symbol; this pins the on-ledger admin/id the transfer was built for.)
  const reqInstr = (
    paymentRequirements.extra as {
      instrumentId?: { admin?: string; id?: string };
    }
  ).instrumentId;
  if (
    reqInstr &&
    (reqInstr.admin !== row.instrumentAdmin || reqInstr.id !== row.instrumentId)
  ) {
    return {
      ok: false,
      reason: "invalid_exact_canton_asset_mismatch",
      payer: row.payer,
    };
  }

  // Merchant memo binding: when the merchant REQUIRES a memo (extra.memo is a
  // non-empty string) the relay-recorded transfer MUST carry exactly that value
  // as `x402.memo` (row.memo, stamped at pay/prepare). Fail-CLOSED — a stash row
  // WITHOUT a memo while the merchant requires one is a mismatch (an old / non-
  // compliant client that dropped it). When the merchant sets no memo there is no
  // check (a payer-supplied memo the merchant did not require is fine). Cast
  // mirrors the reqInstr read just above.
  const wantMemo = (paymentRequirements.extra as { memo?: string }).memo;
  if (typeof wantMemo === "string" && wantMemo.length > 0 && row.memo !== wantMemo) {
    return {
      ok: false,
      reason: "invalid_exact_canton_memo_mismatch",
      payer: row.payer,
    };
  }

  return {
    ok: true,
    method: "transfer-factory",
    payer: row.payer,
    merchant: paymentRequirements.payTo,
    stash: row,
  };
}
