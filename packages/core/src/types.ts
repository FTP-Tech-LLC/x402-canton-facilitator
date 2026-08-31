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
 *  (upstream scheme review) the scheme NAME is `"exact"` and Canton is a NETWORK of the exact
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
       *  transfer's absolute `executeBefore`. The payer-signed transfer expires
       *  with it (see CantonPaymentPayload). */
      executeBeforeSeconds: number;
      memo?: string;
    };

/**
 * INLINE carriage — the form the merged upstream scheme defines, and the one
 * new clients emit. The payer-signed transaction travels in the payload itself,
 * so the payload is self-contained and ANY facilitator can relay it.
 *
 * This is what the old `submissionRef` stash form could never be. A stash reference
 * is meaningful only to the one facilitator that prepared it, which forces the
 * payer and the merchant onto the same facilitator — but in x402 the MERCHANT
 * picks the facilitator and the payer is never told which one. The pointer form
 * therefore only ever worked because both ends happened to be ours.
 *
 * Size was the original objection to going inline, and it was measured wrong: a
 * real signed `TransferFactory_Transfer` on MainNet is ~22-27 KB, not the
 * "hundreds of KB" this comment used to claim. Gzipped it is ~5 KB — too big
 * for an HTTP header, comfortable in a request body.
 */
export interface CantonInlinePayload {
  assetTransferMethod: "transfer-factory";
  /** `base64(gzip(prepared TransferFactory_Transfer))`, disclosed contracts
   *  embedded. Bounded on decode — see `decodeInlinePaymentPayload`. */
  preparedTransaction: string;
  /** Lower-case hex hash of the prepared tx the payer signed. A CLAIM until the
   *  facilitator recomputes it from the decoded bytes. */
  preparedTxHash: string;
  /** Base64 Ed25519 signature over `preparedTxHash`. The facilitator wraps it
   *  into the ledger's nested `partySignatures` for the proven payer; `signedBy`
   *  is the payer party's own namespace fingerprint, so flattening to one string
   *  drops nothing the facilitator cannot reconstruct. */
  signature: string;
  /** Canton hashing scheme used for `preparedTxHash`. Defaults to V2. */
  hashingSchemeVersion?: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
}

/** Canton-specific `payload` block in PaymentPayload. The inline carriage is the
 *  ONLY form: the payer-signed transaction travels in the payload itself, so the
 *  payload is self-contained and any facilitator can relay it. (The legacy
 *  `submissionRef` stash carriage — which pinned payer and merchant to the one
 *  facilitator that prepared it — was removed; inline is what upstream adopted.) */
export type CantonPaymentPayload = CantonInlinePayload;

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
      /** Payload forms this facilitator's /settle accepts. "inline" carries the
       *  payer-signed transaction itself, so any facilitator can relay it — the
       *  only carriage the stack speaks. Optional and additive. */
      carriages?: Array<"inline">;
      /** Non-Amulet CIP-56 instruments this deployment is configured to settle.
       *  Always carries the registrar/admin party; when the operator configures
       *  instrument identity it also carries the full `instrumentId` ({admin,id})
       *  and a display `symbol`, so a merchant reads the instrumentId here instead
       *  of hardcoding it. Canton Coin is implied by the scheme and never listed.
       *  Optional and additive. */
      instruments?: Array<{
        admin: string;
        id?: string;
        instrumentId?: { admin: string; id: string };
        symbol?: string;
      }>;
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
  // merchant-set `extra.memo` not carried, or mismatched, in the signed
  // transfer's `x402.memo` meta entry (transfer-factory path; fail-closed).
  | "invalid_exact_canton_memo_mismatch"
  // NOTE (upstream scheme review, revised): `extra.memo`, WHEN SET by the merchant, IS enforced
  // on the transfer-factory path. The payer's signed transfer must carry exactly
  // that value in its meta as `x402.memo`; the inline verify
  // (assertPreparedTransferMatches, Rule 12) pins it and rejects a missing OR
  // divergent memo with `invalid_exact_canton_memo_mismatch` (fail-closed: a
  // signed transfer without a memo while the merchant requires one is a
  // mismatch). A payer MAY still carry a memo
  // the merchant did NOT require (no check runs then). `resourceUrl` remains
  // UNMATCHED on the Token-Standard paths (reuse protection = receiver+amount+
  // delegate + contract archival; the URL must not be committed on-ledger for
  // privacy), so the former `invalid_exact_canton_resource_url_mismatch` code
  // stays removed.
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
  // ── Inline-carriage codes, from the merged scheme's normative table ──
  // `preparedTransaction` is not canonical base64 / not a single gzip member,
  // or breaches the compressed, decompressed or decode bound.
  | "invalid_exact_canton_malformed_payload"
  // `signature` does not verify against the proven payer over `preparedTxHash`.
  | "invalid_exact_canton_signature_invalid"
  // `extra.feePayer` is not this facilitator's own relaying party — it would be
  // paying traffic for a transfer that names someone else as fee payer.
  | "invalid_exact_canton_fee_payer_mismatch"
  // The prepared transaction's input holdings do not have distinct contract ids,
  // or do not sum to the amount plus fees.
  | "invalid_exact_canton_insufficient_inputs"
  // CIP-56 completed path: the receiver's created Holding carries a `lock`
  // (Splice.Api.Token.HoldingV1 `HoldingView.lock : Optional Lock`) held by
  // a party other than the receiver — the tokens are escrowed, not freely
  // the merchant's, so the transfer is NOT settled even though a holding to
  // the receiver exists. Reject rather than deliver against funds that may
  // unwind. (audit H1)
  | "invalid_exact_canton_holding_locked"
  // The transfer's executeBefore is further out than the facilitator will
  // accept. Distinct from `invalid_exact_canton_expired`, which is the same
  // field failing the other way: expired means "too late to settle", this one
  // means "you asked us to keep this settleable for too long". A payer that
  // sees it can re-prepare with a shorter horizon and retry.
  //
  // The bound exists because the deadline is what makes a payment replayable:
  // a settled inline payment is answered from the facilitator's record for as
  // long as it could still be settled, and everything downstream — the
  // merchant's one-payment-one-delivery ticket above all — has to remember it
  // for at least that long. Letting the PAYER choose that window unbounded
  // made it unbounded for everyone else too.
  | "invalid_exact_canton_execute_before_too_far"
  // The payment (on-ledger updateId / paymentId) was already settled —
  // single-use replay protection for the CIP-56 completed path (audit M2).
  | "invalid_exact_canton_payment_already_settled"
  // The facilitator-relayed transfer-factory ExecuteSubmission committed but did
  // not move funds to the merchant (a committed-zero-funds execute), or the
  // relay/execute itself failed. Default-bucketed by classifySettleFailure (→
  // validation_failed).
  | "invalid_exact_canton_execute_failed"
  // x402-ENVELOPE additive guards (upstream review points 8 & 9). Both
  // default-bucket to validation_failed in classifySettleFailure (neither maps
  // to already_settled / counter_not_ready), so no settle-metrics change needed.
  //
  // (8) insufficient balance: returned by /settle when the ledger rejects the
  // relayed `TransferFactory_Transfer` ExecuteSubmission with
  // `ITR_InsufficientFunds`. The transfer-factory flow is UTXO-style — the input
  // holdings are pinned at build time (pay/prepare) and enforced on-ledger at
  // execute — so there is NO off-chain balance read; the ledger rejection is the
  // authoritative signal that the payer's chosen inputs no longer cover the
  // amount.
  | "invalid_exact_canton_insufficient_balance"
  // input contention: the ledger refused the relayed transfer because its PINNED
  // input holdings were already consumed, or are locked by a concurrent
  // in-flight transaction. Split out of `execute_failed` because the two demand
  // opposite client behaviour: `execute_failed` is the catch-all around the
  // submit and may hide a network failure over a submission that committed, so
  // a client must stop and let a human check the ledger. This one is a verdict
  // that ARRIVED, from conflict detection, before any effect — nothing moved,
  // and a re-pay over fresh holdings is a retry rather than a second payment.
  //
  // It is reachable on the honest path: pay/prepare picks input Amulets
  // largest-first from the ACS and keeps no record, so two payments from one
  // party overlapping in time are built over the same holding and the ledger
  // settles exactly one of them.
  | "invalid_exact_canton_input_contention"
  // (9) self-payment safety guard: the proven sender equals the executor /
  // feePayer (the facilitator). Fail-closed — the facilitator must never move
  // its own funds.
  | "invalid_exact_canton_self_payment"
  // transfer-factory ("V3") specific codes:
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
