/**
 * Canton x402 type definitions.
 *
 * These mirror the v2 wire format from x402-foundation/x402, specialized
 * for the `exact` scheme on Canton networks. The Canton-specific bits live in
 * `extra` (server side) and `payload` (client side); the envelope is
 * standard x402 v2.
 */

import { ledgerDecimalEquals, wireAmountToLedgerDecimal } from "./amount.js";

/** CAIP-2-style Canton network identifier. */
export type CantonNetwork =
  | `canton:devnet`
  | `canton:mainnet`
  | `canton:${string}`; // canton:<global-synchronizer-id>

/** x402 scheme discriminator. Per the x402-ENVELOPE upstream convention
 *  (PR #2634) the scheme NAME is `"exact"` and Canton is a NETWORK of the exact
 *  scheme (CAIP-2 `canton:*`). This is the ONLY scheme this stack speaks. */
export type ExactScheme = "exact";

/** True when two scheme strings refer to the same scheme. The only scheme is
 *  `"exact"`, so this is plain equality; kept as a named helper so requirement
 *  matching (`selectServerRequirements`) reads intent-first. */
export function schemeMatches(a: string, b: string): boolean {
  return a === b;
}

/** True when two `asset` symbols denote the same instrument. The x402-ENVELOPE
 *  convention is the symbol `"CC"`; `"canton-coin"` (legacy) is the same thing.
 *  The structured `"<admin>::Amulet"` form is also treated as Canton Coin. Any
 *  other value matches only by exact string equality (multi-asset tokens). */
export function assetMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const CC = new Set(["CC", "canton-coin"]);
  const isCC = (s: string): boolean =>
    CC.has(s) || /::Amulet$/.test(s);
  return isCC(a) && isCC(b);
}

/** Which on-ledger primitive carries the actual CC movement.
 *
 *  transfer-factory ("V3", 1-tx meta-transaction) is the SOLE method: the payer
 *  SIGNS a relay-prepared token-standard `TransferFactory_Transfer` (sender =
 *  payer, receiver = the merchant); the facilitator relays the signed tx via
 *  ExecuteSubmission on its own participant and pays the GS traffic. With a
 *  merchant `TransferPreapproval` the transfer completes synchronously —
 *  exactly ONE GS-billed tx, no lock/escrow leg, and no custom DAR (standard
 *  `splice-api-token-transfer-instruction-v1` interface only). The Canton
 *  analog of EIP-3009 transferWithAuthorization: replay is prevented by the
 *  signed tx pinning specific input holdings (a respend fails on the archived
 *  contracts), not by a nonce. */
export type CantonTransferMethod = "transfer-factory";

/** Canton-specific `extra` block in 402 PaymentRequirements.
 *
 * `synchronizerId` MAY be sourced from /supported (AmuletRules.domain_id) rather
 * than stamped here; when present in `extra` it is authoritative. */
export type CantonPaymentRequirementsExtra =
  | {
      /** Token-standard direct transfer ("V3", 1-tx). The payer signs a
       *  relay-prepared `TransferFactory_Transfer` (sender = payer, receiver =
       *  the merchant/payTo); the facilitator relays it (ExecuteSubmission) and
       *  pays the GS traffic. Requires the merchant to hold a live
       *  `TransferPreapproval` — without it the transfer would resolve to a
       *  two-step Pending and /settle fails closed with
       *  `invalid_exact_canton_preapproval_missing`. */
      assetTransferMethod: "transfer-factory";
      /** The party whose participant submits the signed tx and pays the GS
       *  traffic (the facilitator). */
      feePayer: string;
      synchronizerId: string;
      instrumentId: { admin: string; id: string };
      /** Relative deadline (seconds from now) the client uses to compute the
       *  transfer's absolute `executeBefore`. The relay-stashed signed
       *  submission expires with it (see CantonPaymentPayload). */
      executeBeforeSeconds: number;
      memo?: string;
    };

/** Canton-specific `payload` block in PaymentPayload. */
export type CantonPaymentPayload =
  | {
      /** Token-standard direct transfer ("V3"). The heavy signed artifact does
       *  NOT travel in this payload: a prepared Canton tx plus its disclosed
       *  contracts (AmuletRules blob, open mining round, one blob per input
       *  holding) is hundreds of KB and cannot fit an X-PAYMENT header
       *  (~8–16 KB server limits). Instead the client PREPARED and SIGNED via
       *  the facilitator relay (`POST /v1/wallet/pay/prepare` +
       *  `POST /v1/wallet/pay/commit`), the relay stashed the signed submission
       *  (TTL = the transfer's executeBefore), and this payload carries only
       *  the small reference. /verify checks the relay-recorded transfer fields
       *  against PaymentRequirements; /settle loads the stash and relays it
       *  (ExecuteSubmission). Replay: the ledger rejects a respend of the
       *  archived input holdings; a facilitator success-record makes a LEGIT
       *  retry of an already-settled ref idempotent (returns the recorded
       *  success) instead of failing it. */
      assetTransferMethod: "transfer-factory";
      /** Payer party id. Aligns with `SettleResponse`/`VerifyResponse` `payer`. */
      payer: string;
      /** Opaque stash reference returned by the relay's pay/prepare. */
      submissionRef: string;
      /** Hex hash of the prepared tx the payer signed. Binds the ref to the
       *  exact bytes: the facilitator re-checks it against the stash before
       *  relaying, so a swapped/stale stash entry fails closed. */
      preparedTxHash?: string;
    };

/** Resource being paid for. Echoed from the server's 402 PAYMENT-REQUIRED
 *  header into every PaymentPayload per x402 v2. */
export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** /verify and /settle request body (x402 v2). */
export type FacilitatorRequest = {
  x402Version: 2;
  paymentPayload: {
    x402Version: 2;
    scheme: ExactScheme;
    network: CantonNetwork;
    resource: X402ResourceInfo;
    accepted: PaymentRequirements;
    payload: CantonPaymentPayload;
    extensions?: Record<string, unknown>;
  };
  paymentRequirements: PaymentRequirements;
};

/** /verify response (200 regardless of validity; success carried in `isValid`). */
export type VerifyResponse =
  | { isValid: true; payer: string }
  | { isValid: false; invalidReason: CantonErrorCode; payer?: string };

/** /settle response. */
export type SettleResponse =
  | {
      success: true;
      payer: string;
      transaction: string; // Canton updateId
      network: CantonNetwork;
      amount?: string;
      extensions?: Record<string, unknown>;
    }
  | {
      success: false;
      errorReason: CantonErrorCode;
      transaction: "";
    };

/** /supported response. */
export type SupportedResponse = {
  kinds: Array<{
    x402Version: 1 | 2;
    scheme: ExactScheme;
    network: CantonNetwork;
    extra?: {
      transferMethods: CantonTransferMethod[];
      /** x402-ENVELOPE: the Global Synchronizer id (AmuletRules.domain_id) the
       *  facilitator settles on. Advertised here so a 402 `extra` MAY omit
       *  `synchronizerId` and the client sources it from /supported. */
      synchronizerId?: string;
    };
  }>;
  extensions: string[];
  signers: Record<string, string[]>;
};

/** PaymentRequirements entry as advertised in an `accepts[]` array. */
export type PaymentRequirements = {
  scheme: ExactScheme;
  network: CantonNetwork;
  amount: string;     // DEPLOYED REALITY (all three methods): the Daml Decimal
                      // string the Token Standard / TransferCommand uses (e.g.
                      // "0.1000000000"), compared by STRING equality. The live v1
                      // (external-party-amulet-rules, MainNet), cip56, and
                      // allocation paths ALL put a Decimal here today — the
                      // earlier note that v1 encodes 10^10 atomic integer units
                      // was stale (the v1 client signs this Decimal verbatim into
                      // the ledger; no atomic conversion exists on that path).
                      // The x402-ENVELOPE upstream convention is atomic units
                      // (1 CC = 10^10, see @ftptech/x402-canton-core `amount.ts`
                      // decimalToAtomicCC/atomicToDecimalCC); a deploy that opts
                      // into atomic-on-wire converts EXACTLY at the boundary, but
                      // the default wire unit stays Decimal for back-compat with
                      // every deployed v1/cip56 client (see
                      // specs/scheme_exact_canton.upstream.md § Amount units).
  asset: string;      // x402-ENVELOPE: token SYMBOL "CC" for Canton Coin (the
                      // {admin=DSO, id="Amulet"} instrument is resolved
                      // separately via extra.instrumentId). "canton-coin" (legacy
                      // symbol) and the long "<adminParty>::<id>" form are also
                      // accepted as equivalent symbolic values — no validator
                      // rejects on the asset symbol (cip56/allocation validate
                      // extra.instrumentId; v1 ignores asset). See assetMatches.
  payTo: string;      // merchant party id
  maxTimeoutSeconds: number;
  extra: CantonPaymentRequirementsExtra;
};

/** Canton-specific x402 error codes. Prefix `invalid_exact_canton_*`. */
export type CantonErrorCode =
  | "invalid_exact_canton_transfer_command_not_found"
  | "invalid_exact_canton_amount_mismatch"
  | "invalid_exact_canton_asset_mismatch"
  | "invalid_exact_canton_expired"
  | "invalid_exact_canton_nonce_reuse"
  | "invalid_exact_canton_merchant_mismatch"
  | "invalid_exact_canton_signature"
  // NOTE (PR #2634): the facilitator no longer MATCHES memo or resourceUrl on
  // the Token-Standard paths (allocation-api + cip56-transfer-factory). `memo`
  // stays an OPTIONAL pass-through field on PaymentRequirements.extra (the client
  // MAY stamp transferLeg.meta x402.memo for its own reconciliation; the
  // facilitator does NOT validate it), and resourceUrl is no longer bound on the
  // allocation path (reuse protection = receiver+amount+delegate + contract
  // archival; the URL must not be committed on-ledger for privacy). The former
  // `invalid_exact_canton_resource_url_mismatch` / `invalid_exact_canton_memo_mismatch`
  // codes were therefore removed.
  | "invalid_exact_canton_merchant_not_registered"
  | "invalid_exact_canton_counter_not_ready"
  // CIP-56-specific
  | "invalid_exact_canton_transfer_instruction_not_found"
  | "invalid_exact_canton_transfer_completed_not_visible"
  // A TransferInstruction was found but is still pending (awaiting
  // receiver acceptance or registry-internal workflow) — tokens have
  // NOT moved yet. x402 is a synchronous flow, so the facilitator
  // treats a non-final instruction as not-yet-settled. The payer must
  // use a TransferPreapproval (→ synchronous completion / updateId
  // path) or re-submit once the instruction resolves.
  | "invalid_exact_canton_transfer_instruction_pending"
  | "invalid_exact_canton_instrument_id_mismatch"
  | "invalid_exact_canton_transfer_factory_not_found"
  | "invalid_exact_canton_missing_proof"
  // CIP-56 completed path: the receiver's created Holding carries a `lock`
  // (Splice.Api.Token.HoldingV1 `HoldingView.lock : Optional Lock`) held by
  // a party other than the receiver — the tokens are escrowed, not freely
  // the merchant's, so the transfer is NOT settled even though a holding to
  // the receiver exists. Reject rather than deliver against funds that may
  // unwind. (audit H1)
  | "invalid_exact_canton_holding_locked"
  // The payment (on-ledger updateId / paymentId) was already settled —
  // single-use replay protection for the CIP-56 completed path (audit M2).
  | "invalid_exact_canton_payment_already_settled"
  // The facilitator-relayed transfer-factory ExecuteSubmission committed but did
  // not move funds to the merchant (a committed-zero-funds execute), or the
  // relay/execute itself failed. Default-bucketed by classifySettleFailure (→
  // validation_failed).
  | "invalid_exact_canton_execute_failed"
  // x402-ENVELOPE additive guards (PR #2634 review points 8 & 9). Both
  // default-bucket to validation_failed in classifySettleFailure (neither maps
  // to already_settled / counter_not_ready), so no settle-metrics change needed.
  //
  // (8) /verify real-balance check: the proven payer's token balance on the
  // facilitator's participant ACS is below the required amount.
  | "invalid_exact_canton_insufficient_balance"
  // (9) self-payment safety guard: the proven sender equals the executor /
  // feePayer (the facilitator). Fail-closed — the facilitator must never move
  // its own funds.
  | "invalid_exact_canton_self_payment"
  // transfer-factory ("V3") specific codes:
  // - submission_not_found: the payload's submissionRef is unknown, expired
  //   (past executeBefore), not yet committed (unsigned), or its stored hash
  //   does not match payload.preparedTxHash. Fail-closed at /verify + /settle.
  | "invalid_exact_canton_submission_not_found"
  // - preapproval_missing: the merchant (payTo) has no live TransferPreapproval,
  //   so the transfer cannot complete in one tx. /settle refuses BEFORE relaying
  //   (never a silent half-settled Pending). Merchant setup:
  //   `canton-agent-wallet preapproval` (facilitator-as-provider).
  | "invalid_exact_canton_preapproval_missing"
  // - transfer_factory_disabled: kill-switch mirror of direct_disabled — the
  //   transfer-factory path is OFF unless CANTON_X402_TF_ENABLED=true
  //   (config.tfEnabled). A /settle for this method is rejected fail-closed
  //   BEFORE any processing, so a deploy with TF OFF is provably inert.
  | "invalid_exact_canton_transfer_factory_disabled"
  | "unexpected_canton_ledger_error";

/**
 * Pick the server's OWN PaymentRequirements entry that a client claims to
 * be paying against — defeating client tampering of price / recipient.
 *
 * SECURITY (audit SEC-1): the facilitator is a generic relay that
 * validates an on-ledger transfer against whatever `paymentRequirements`
 * it is handed. The resource-server middleware receives the client's
 * claimed `accepted` block from INSIDE the client-controlled
 * PAYMENT-SIGNATURE envelope. If the middleware forwards that claimed
 * block to the facilitator unchecked, an attacker can set `amount: "1"`
 * (or `payTo: <self>`), submit a matching tiny on-ledger transfer, and
 * still unlock the gated resource. The middleware MUST instead pin the
 * requirements to its own configured `accepts` list.
 *
 * Returns the matching SERVER entry (authoritative on every field), or
 * `null` if the client's claim does not correspond to any configured
 * entry — in which case the middleware must respond 402 and never call
 * the facilitator with the client's numbers.
 *
 * Matching is on the money-critical fields only: scheme, network, amount,
 * asset, payTo, and extra.{assetTransferMethod, feePayer, synchronizerId,
 * instrumentId}. `maxTimeoutSeconds` / `memo` / discovery cids are not part of
 * the price contract. asset `"CC"` ≡ `"canton-coin"` ≡ `"<admin>::Amulet"`, and
 * synchronizerId is only enforced when BOTH sides carry it (it may be sourced
 * from /supported).
 */
export function selectServerRequirements(
  accepts: PaymentRequirements[],
  clientAccepted: unknown
): PaymentRequirements | null {
  if (typeof clientAccepted !== "object" || clientAccepted === null) {
    return null;
  }
  const c = clientAccepted as Partial<PaymentRequirements>;
  const cExtra = (c.extra ?? {}) as Partial<{
    assetTransferMethod: string;
    feePayer: string;
    synchronizerId: string;
    instrumentId: { admin: string; id: string };
  }>;
  const cMethod = cExtra.assetTransferMethod;
  const cFeePayer = cExtra.feePayer;
  for (const r of accepts) {
    const rExtra = r.extra as {
      assetTransferMethod?: string;
      feePayer?: string;
      synchronizerId?: string;
      instrumentId?: { admin: string; id: string };
    };
    // scheme: the only scheme is "exact" (plain equality via schemeMatches).
    if (
      typeof r.scheme !== "string" ||
      typeof c.scheme !== "string" ||
      !schemeMatches(r.scheme, c.scheme)
    )
      continue;
    if (r.network !== c.network) continue;
    // amount: canonical-decimal compare. Under scheme "exact" the wire amount is
    // atomic integer units; normalize BOTH sides to the on-ledger Daml Decimal
    // (atomicToDecimalCC) and compare by BigInt atomic units (folds "0.1" ≡
    // "0.1000000000", and a 10x/0.1x amount provably cannot match). Fail-closed:
    // a malformed amount throws in the converter rather than passing. This is the
    // matching authority and MUST agree byte-exactly with the facilitator's
    // wireAmountToLedgerDecimal comparisons.
    {
      let rDec: string;
      let cDec: string;
      try {
        rDec = wireAmountToLedgerDecimal(r.scheme, r.amount);
        cDec = wireAmountToLedgerDecimal(c.scheme, c.amount as string);
      } catch {
        continue; // malformed amount on either side → no match (fail-closed).
      }
      let amountEq: boolean;
      try {
        amountEq = ledgerDecimalEquals(rDec, cDec);
      } catch {
        continue;
      }
      if (!amountEq) continue;
    }
    // asset: "CC" ≡ "canton-coin" ≡ "<admin>::Amulet" (symbolic equivalence).
    if (
      typeof r.asset !== "string" ||
      typeof c.asset !== "string" ||
      !assetMatches(r.asset, c.asset)
    )
      continue;
    if (r.payTo !== c.payTo) continue;
    if (rExtra.assetTransferMethod !== cMethod) continue;
    if (rExtra.feePayer !== cFeePayer) continue;
    // synchronizerId MAY be omitted from `extra` (sourced from /supported).
    // Mirror the instrumentId pattern — only enforce equality when BOTH sides
    // carry it; if either omits it, do not reject on this field.
    if (
      rExtra.synchronizerId !== undefined &&
      cExtra.synchronizerId !== undefined &&
      rExtra.synchronizerId !== cExtra.synchronizerId
    )
      continue;
    // instrumentId (CIP-56): if either side carries it, both must match.
    const rInst = rExtra.instrumentId;
    const cInst = cExtra.instrumentId;
    if (rInst || cInst) {
      if (!rInst || !cInst) continue;
      if (rInst.admin !== cInst.admin || rInst.id !== cInst.id) continue;
    }
    return r;
  }
  return null;
}

/**
 * Config-time consistency guard (audit L1). On the CIP-56 path the facilitator
 * validates against `extra.instrumentId` and ignores `asset`, so if an operator
 * configures an `asset` of the structured `<admin>::<id>` form that disagrees
 * with `extra.instrumentId`, the mismatch is silent and the instrumentId wins.
 * Catch it at middleware setup instead. `asset` may also be a symbolic value
 * such as "CC" / "canton-coin" (see PaymentRequirements.asset) — only the `::`
 * form is cross-checked. Throws on a mismatch; no-op when consistent or not
 * applicable.
 */
export function assertAssetInstrumentConsistency(
  req: PaymentRequirements
): void {
  const inst = (
    req.extra as { instrumentId?: { admin: string; id: string } }
  ).instrumentId;
  if (!inst) return;
  if (!req.asset.includes("::")) return; // symbolic asset (e.g. "canton-coin")
  const expected = `${inst.admin}::${inst.id}`;
  if (req.asset !== expected) {
    throw new Error(
      `payment requirements asset "${req.asset}" disagrees with ` +
        `extra.instrumentId ("${expected}"). On the CIP-56 path instrumentId ` +
        `is authoritative, so a mismatched asset is an operator misconfig — ` +
        `make asset and extra.instrumentId.{admin,id} consistent.`
    );
  }
}
