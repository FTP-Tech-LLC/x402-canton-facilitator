/* ════════════════════════════════════════════════════════════════════════
 * INLINE transfer-factory verify arm.
 *
 * THE PAYER SUPPLIES THE BYTES, which is the whole reason this file is careful.
 * Attacker-controlled protobuf reaches the facilitator, and relaying it
 * spends our participant's Global-Synchronizer traffic — real money. So every
 * field the merchant is promised must be proven from the bytes themselves,
 * before anything is submitted.
 *
 * WHAT PROVES THE PAYER. The payload carries no `payer`; a client-supplied one
 * would be an assertion, not evidence. The submitter is read from the SIGNED
 * `Metadata.submitter_info.act_as` and then `assertPreparedTransferMatches`
 * requires the transfer's own sender field to equal it (`assertActAsIsSender`).
 * That is not circular: it proves the party that authorised the transaction is
 * the party whose money moves.
 *
 * ORDER IS PART OF THE DESIGN. Structural validation runs FIRST and the
 * signature gate LAST. Every check is therefore reachable and observable by its
 * own error code, which is what lets a test prove each one bites. A version
 * that rejected everything up front on the missing capability would be equally
 * "safe" and would hide whether any of this works.
 * ════════════════════════════════════════════════════════════════════════ */
import {
  decodeInlinePaymentPayload,
  InlinePayloadError,
  decodePrepared,
  assertPreparedTransferMatches,
  extractTransfer,
  PreparedTransferMismatchError,
  wireAmountToLedgerDecimal,
  type CantonErrorCode,
} from "@ftptech/x402-canton-core";
import type { FacilitatorRequest } from "@ftptech/x402-canton-core";

/** How much future an `executeBefore` must have left to be worth relaying.
 *  Settle is not instantaneous — preapproval read, submit, funds-moved confirm
 *  — so a transfer expiring inside this window would be refused by the ledger
 *  after we had already spent the traffic. */
const EXECUTE_BEFORE_MARGIN_MS = 5_000;

/** True when the payload uses the inline carriage rather than a stash ref. */
export function isInlineCarriage(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)["preparedTransaction"] ===
      "string"
  );
}

export interface InlineValidationDeps {
  /** This facilitator's own party — it relays and pays the traffic fee. */
  facilitatorParty: string;
  /** Clock override for tests; production reads the real clock. */
  nowMs?: number;
  /**
   * Ceiling (seconds) on how far ahead of now the transfer's `executeBefore`
   * may sit. The relay path has always had this — `tfMaxExecuteBeforeSeconds`,
   * clamped at prepare time — and the inline carriage, which exists precisely
   * so a client need not use our relay, had only a floor.
   *
   * The deadline is what makes a payment replayable: a settled inline payment
   * is answered from the facilitator's own record, with no submission and no
   * traffic, for as long as it could still be settled, and every downstream
   * memory has to outlive that. Leaving the ceiling to the PAYER left it
   * unbounded for the merchant too.
   *
   * Absent means unbounded, for callers that construct these deps directly;
   * services.ts always passes the configured value.
   */
  maxExecuteBeforeSeconds?: number;
  /**
   * Rule 3: recompute the Canton hash from the decoded bytes, check it equals
   * the payload's claimed `preparedTxHash`, and verify the Ed25519 signature
   * against the proven payer over it.
   *
   * DELIBERATELY REQUIRED, and deliberately not optional-with-a-default. The
   * conformant hasher exists (`canton-hash.ts`, delegating to the official
   * `core-tx-visualizer`) but lives in agent-wallet, and a
   * facilitator→agent-wallet dependency runs the wrong way; moving it is its
   * own change. Until it is injected here, this arm CANNOT return ok — the
   * absent capability is a rejection, never a skipped check.
   */
  /**
   * Rule 7: does the merchant hold a LIVE TransferPreapproval, so the transfer
   * resolves `direct`? Returns its expiry, or null when there is none.
   *
   * Required in practice and injected rather than imported so the arm stays a
   * pure function: absent means the arm cannot answer the question, and it
   * refuses instead of assuming yes.
   */
  fetchPreapproval?: (party: string) => Promise<{
    receiver: string;
    dso: string;
    expiresAt: string;
    /** The on-ledger app provider recorded on the merchant's preapproval. The
     *  served-merchant gate reads it; creating a preapproval that names a
     *  provider requires that provider's own authority, which is what makes it
     *  usable as proof of a relationship rather than a claim. */
    provider?: string;
    /** When present, the preapproval is not yet ACTIVE before this instant. An
     *  unexpired-but-not-yet-valid contract would still resolve the transfer to
     *  a pending two-step — the exact state Rule 7 exists to prevent. */
    validFrom?: string;
  } | null>;
  /**
   * Rule 13's second half: an AUTHORITATIVE, CURRENT view of the payer's
   * holdings, keyed by contract id, as ledger Decimals.
   *
   * "Authoritative" is the whole contract. The payer's inputs are chosen from
   * the participant's LIVE ledger at prepare time, so answering the question
   * from a lagging source refuses honest payers: a wallet spending change from
   * its previous payment, or a fresh faucet claim, holds cids newer than any
   * periodic snapshot. That is an outage, not a defence.
   *
   * Return undefined when no such view is available — the scheme itself makes
   * this check conditional ("When the facilitator's participant hosts the
   * proven sender with read access, it SHOULD additionally verify..."), and
   * settlement enforces what verification could not.
   */
  fetchOwnedHoldingAmounts?: (
    party: string
  ) => Promise<Map<string, string> | undefined>;
  /**
   * Which merchants this facilitator will BURN ITS OWN TRAFFIC for.
   *
   * /settle is unauthenticated, and the inline carriage means a stranger can
   * post a well-formed transaction between two parties we have no relationship
   * with and make us pay to relay it. Rule 9 (feePayer == us) only confirms we
   * were named; it cannot stop the naming. This is the gate that can.
   *
   *   open                  today's behaviour, byte-for-byte. The default.
   *   allowlist             the operator declared this merchant. The only mode
   *                         that is an authorization proof on every deployment.
   *   provider              the merchant's preapproval names US as its app
   *                         provider. READ THE WARNING BELOW BEFORE ENABLING.
   *   provider-or-allowlist either proof — and therefore no stronger than
   *                         `provider`, since either arm alone admits.
   *
   * WHAT `provider` ACTUALLY PROVES, measured rather than assumed.
   *
   * `TransferPreapproval.provider` is a signatory in splice-amulet, so the
   * FIELD is not forgeable: creating the contract needs the named provider's
   * DAML authority. An earlier version of this comment stopped there and
   * concluded the mode was therefore safe. That conclusion does not follow,
   * because the provider's authority can be granted on our behalf, by our own
   * software, without anyone deciding to:
   *
   *   - `TransferPreapprovalProposal` (splice-wallet) has `signatory receiver,
   *     observer provider` — so ANY party can unilaterally create a proposal
   *     naming ANY provider, ours included.
   *   - the stock Splice validator registers AcceptTransferPreapprovalProposal
   *     unconditionally when a wallet is enabled, and its only guard is that
   *     the receiver be hosted on our participant.
   *   - our facilitator party IS the validator operator party, so that trigger
   *     acts as us; and our relay onboards parties onto our own participant.
   *
   * Chain those and a stranger can manufacture "this merchant's preapproval
   * names us as provider" without our consent. The DAML field is unforgeable;
   * the RELATIONSHIP the gate reads it as evidence of is not.
   *
   * So `provider` is only an authorization proof once BOTH hold: the
   * facilitator has an app party distinct from the validator operator party,
   * and relay onboarding is authenticated. Until then run `allowlist`.
   *
   * `provider` ALONE would also refuse every self-provisioned merchant, whose
   * preapproval names the merchant itself as provider — that is this repo's own
   * documented onboarding route, so it is the common case, not an edge one.
   * Absent → "open", which is why every existing caller is unaffected.
   */
  merchantPolicy?:
    | "open"
    | "provider"
    | "allowlist"
    | "provider-or-allowlist";
  merchantAllowlist?: readonly string[];
  /** Non-Amulet CIP-56 instrument registries (admin → DA Registry Utility base
   *  URL). When the transfer's `instrumentId.admin` is listed here, Rule 7 is
   *  answered STRUCTURALLY from the signed bytes (the transfer must carry a
   *  `TransferRule_DirectTransfer` delivery consequence) rather than the Amulet
   *  `fetchPreapproval` lookup. Only membership matters here; the URL is used by
   *  the settle-side gate. */
  tokenRegistries?: Record<string, string>;
  /** OUT-OF-BAND-trusted registry infra parties (admin → party[]). A real registry
   *  `TransferFactory_Transfer` names the registry operator (and, for a bridged
   *  token, the bridge operator) as signatories/observers; without admitting them
   *  the shared foreign-party backstop rejects the honest transfer. Keyed by
   *  instrument admin; only the entry for THIS transfer's admin is used. Empty /
   *  undefined → Amulet-identical. */
  registryTrustedParties?: Record<string, string[]>;
  verifySignature?: (args: {
    preparedTransactionBytes: Buffer;
    claimedPreparedTxHash: string;
    signatureB64: string;
    payer: string;
    hashingSchemeVersion: string;
  }) => Promise<{
    verified: boolean;
    /** The hash the verifier RECOMPUTED from the bytes and matched. Canonical,
     *  unlike the client's claim, which is accepted in two spellings. */
    preparedTxHashHex?: string;
    /** How many protocol signing keys topology published for the payer.
     *  Diagnostic only — see PayerProofResult. */
    publishedProtocolKeys?: number;
  }>;
}

export interface InlineValidationResult {
  ok: boolean;
  reason?: CantonErrorCode;
  /** The PROVEN payer, echoed even on most failures so a merchant can see who
   *  tried. Empty only when the bytes never yielded one. */
  payer: string;
  /** Present on success: the decoded bytes /settle would relay verbatim. */
  preparedTransactionBytes?: Buffer;
  signatureB64?: string;
  hashingSchemeVersion?:
    | "HASHING_SCHEME_VERSION_V1"
    | "HASHING_SCHEME_VERSION_V2";
  /** Present on success: the RECOMPUTED transaction hash. /settle keys its
   *  idempotency record on this, never on the client's claim. */
  preparedTxHashHex?: string;
  /** Diagnostic: how many protocol signing keys the payer published. >1 means
   *  the signature may have been made with a key `signedBy` cannot name. */
  publishedProtocolKeys?: number;
}

function fail(reason: CantonErrorCode, payer = ""): InlineValidationResult {
  return { ok: false, reason, payer };
}

/**
 * Validate an inline transfer-factory payload against the merchant's
 * requirements. Never submits anything; never mutates state.
 */
export async function validateInlineTransferPath(
  body: FacilitatorRequest,
  deps: InlineValidationDeps
): Promise<InlineValidationResult> {
  const { paymentPayload, paymentRequirements } = body;

  // Rule 2 — decode within the scheme's bounds. The codec enforces single-gzip
  // -member framing and both size caps, so a bomb dies here rather than in the
  // protobuf decoder.
  let decoded;
  try {
    decoded = decodeInlinePaymentPayload(paymentPayload.payload);
  } catch (err) {
    if (err instanceof InlinePayloadError) return fail(err.code);
    return fail("invalid_exact_canton_malformed_payload");
  }

  const preparedB64 = decoded.preparedTransactionBytes.toString("base64");

  // Rule 8 — the proven payer. Read the authoritative submitter from the SIGNED
  // metadata. More than one `act_as` party is refused rather than picked from:
  // there would be no single answer to "whose money is this".
  let payer: string;
  try {
    const pt = decodePrepared(preparedB64);
    // Redundant with the core validator's own `assertActAsIsSender`, which
    // refuses an empty or multi-party act_as a few lines below. Kept because it
    // is what stops `payer` from being undefined here; mutation testing cannot
    // separate the two without a hand-built protobuf, so treat the core check
    // as the authoritative one.
    if (pt.actAs.length !== 1 || !pt.actAs[0]) {
      return fail("invalid_exact_canton_malformed_payload");
    }
    payer = pt.actAs[0];
  } catch {
    return fail("invalid_exact_canton_malformed_payload");
  }

  // Rule 11 — self-payment guard. Checked BEFORE the structural match so that a
  // facilitator-impersonating payload is named for what it is instead of
  // surfacing as some downstream mismatch.
  if (payer === deps.facilitatorParty) {
    return fail("invalid_exact_canton_self_payment", payer);
  }

  const extra = (paymentRequirements.extra ?? {}) as {
    instrumentId?: { admin?: string; id?: string };
    synchronizerId?: string;
    feePayer?: string;
    memo?: string;
  };

  // Rule 9 — fee payer. The merchant must be quoting THIS facilitator as the
  // relayer; otherwise we would be spending our own traffic budget settling a
  // payment quoted against somebody else.
  // ABSENT IS A MISMATCH, not a pass. /settle is unauthenticated, so treating a
  // missing feePayer as "fine" let anyone hand this facilitator a transfer
  // quoted against a different relayer and make it pay the Global Synchronizer
  // fee in real CC. The merchant must name us explicitly.
  if (extra.feePayer !== deps.facilitatorParty) {
    return fail("invalid_exact_canton_fee_payer_mismatch", payer);
  }

  // Rule 6 — the instrument must be PINNED, both halves. A requirements block
  // that omits `extra.instrumentId` used to fall back to the literal "Amulet"
  // with no admin at all, which left the transfer free to name any issuer and
  // also switched OFF the trusted-admin foreign-party backstop. A merchant that
  // does not say which instrument it wants cannot be paid in it.
  if (
    typeof extra.instrumentId?.admin !== "string" ||
    extra.instrumentId.admin.length === 0 ||
    typeof extra.instrumentId.id !== "string" ||
    extra.instrumentId.id.length === 0
  ) {
    return fail("invalid_exact_canton_instrument_id_mismatch", payer);
  }

  // Rules 4/5/6 — amount, receiver, instrument, plus the synchronizer and the
  // single-root-exercise invariant, all proven from the signed bytes by the
  // shared structural validator. The wire amount is atomic; the ledger field is
  // a Daml Decimal, so it is converted rather than compared as text.
  let expectedAmount: string;
  try {
    expectedAmount = wireAmountToLedgerDecimal(
      paymentRequirements.scheme,
      paymentRequirements.amount
    );
  } catch {
    return fail("invalid_exact_canton_amount_mismatch", payer);
  }

  let declaredInputs: string[];
  let declaredExecuteBefore: number | undefined;
  // Registry-utility (non-Amulet) one-shot marker, read from the SIGNED bytes:
  // a DA Registry Utility transfer resolves `direct` iff the merchant holds a
  // live preapproval, in which case the relay-built `TransferFactory_Transfer`
  // carries a `TransferRule_DirectTransfer` delivery consequence on the registry
  // `TransferRule` template (empirically confirmed on real MainNet USDCx bytes).
  // With no preapproval the factory instead exercises
  // `AllocationFactory_TransferInternal` and creates a PENDING TransferInstruction
  // — which the consequence-choice whitelist already rejects structurally above.
  // So Rule 7 for a registry token is answered from the bytes themselves (stateless,
  // idempotent, no ledger read / TOCTOU), not a live probe against holdings that a
  // prior settle may have consumed.
  let registryDirectDelivery = false;
  try {
    // Same decode the validator uses; read AFTER it has passed, so the inputs
    // reasoned over are the ones it approved.
    assertPreparedTransferMatches(preparedB64, {
      sender: payer,
      receiver: paymentRequirements.payTo,
      amount: expectedAmount,
      instrumentId: extra.instrumentId.id,
      // Rule 13: a transfer that funds itself from nothing is not a payment.
      requireInputHoldings: true,
      // Always pinned now, which ALSO arms the trusted-admin arm of the
      // foreign-party backstop rather than leaving it dormant.
      instrumentAdmin: extra.instrumentId.admin,
      // Registry tokens (USDCx, …) name the registry operator + bridge operator in
      // the signed tree; admit exactly the out-of-band-trusted infra set for THIS
      // instrument's admin so the backstop passes an honest transfer while still
      // rejecting any other foreign party. Undefined for Amulet (byte-identical).
      ...(deps.registryTrustedParties?.[extra.instrumentId.admin]
        ? {
            trustedRegistryParties: new Set(
              deps.registryTrustedParties[extra.instrumentId.admin]
            ),
          }
        : {}),
      ...(extra.synchronizerId !== undefined
        ? { synchronizerId: extra.synchronizerId }
        : {}),
      // Rule 12: only pinned when the merchant actually requires a memo. A
      // payer-supplied memo the merchant never asked for is not a violation.
      ...(typeof extra.memo === "string" && extra.memo.length > 0
        ? { memo: extra.memo }
        : {}),
      // ONE clock for the whole arm. The structural validator has its own
      // timing check (max_record_time / max_ledger_effective_time already in
      // the past) and, without this, it read the real clock while every rule
      // below read `deps.nowMs` — so the arm ran on two clocks, and the
      // structural half could not be tested at all. In production `deps.nowMs`
      // is undefined and core falls back to Date.now(), so this changes
      // nothing about how a real payment is judged; it only stops the check
      // from being untestable, which is how its error classification stayed
      // wrong unnoticed.
      ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs } : {}),
    });
    const pt = decodePrepared(preparedB64);
    const ex = pt.exercises.find((e) =>
      /TransferFactory_Transfer/.test(e.choiceId)
    );
    const t = ex?.chosenValue ? extractTransfer(ex.chosenValue) : undefined;
    declaredInputs = t?.inputHoldingCids ?? [];
    declaredExecuteBefore = t?.executeBeforeMs;
    registryDirectDelivery = pt.exercises.some(
      (e) =>
        e.choiceId === "TransferRule_DirectTransfer" &&
        e.templateQualifiedName === "Utility.Registry.V0.Rule.Transfer:TransferRule"
    );
  } catch (err) {
    if (err instanceof PreparedTransferMismatchError) {
      return fail(classifyMismatch(err.message), payer);
    }
    return fail("invalid_exact_canton_malformed_payload", payer);
  }

  // Rule 7 — the merchant must hold a live TransferPreapproval, or the transfer
  // resolves to a PENDING two-step instruction instead of paying directly. The
  // spec is explicit that this is checked BEFORE relaying: settling into a
  // pending state would leave the payment half-done, with the payer's funds
  // committed and the merchant unpaid.
  //
  // Placed here, after every local structural check, so junk never costs a Scan
  // lookup: a payload only reaches this line if it already encodes a valid
  // transfer of the right amount to THIS merchant.
  // A non-Amulet CIP-56 token's preapproval lives in its DA Registry Utility,
  // not the SV Scan, and it has no Amulet-shaped {dso, provider, expiresAt}
  // record. Check Rule 7 against that utility (resolveTransferKind must answer
  // "direct"); everything below is Amulet-specific and is skipped for it.
  const utilRegistry = deps.tokenRegistries?.[extra.instrumentId.admin];
  if (utilRegistry) {
    // One-shot gate for a registry token, answered from the SIGNED bytes: the
    // relay-built transfer must carry the `TransferRule_DirectTransfer` delivery
    // consequence (present iff the merchant held a live preapproval when the
    // factory was built). A no-preapproval transfer instead exercises
    // `AllocationFactory_TransferInternal` + creates a PENDING instruction, which
    // the consequence-choice whitelist already refused above — so reaching here
    // without the direct-delivery marker means the payment would NOT settle in one
    // tx. Fail closed with the same reason the Amulet lookup uses.
    //
    // This is stronger than a live preapproval probe: it checks the EXACT bytes to
    // be relayed (no resolve→settle TOCTOU) and is stateless, so a retried /settle
    // whose holdings a prior settle consumed still answers consistently (fixes
    // idempotency). If the preapproval was revoked between build and settle the
    // delivery exercise fails at interpretation and the funds-moved gate reports
    // no movement — a denial, never a loss.
    if (!registryDirectDelivery) {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    // Served-merchant policy. A registry-utility preapproval carries no on-ledger
    // `provider`, so the "provider" arm cannot be satisfied — a utility merchant
    // is served only under an "open" policy or an explicit allowlist. Fail
    // closed: a provider-only deployment refuses utility merchants until they
    // are allowlisted.
    const policy = deps.merchantPolicy ?? "open";
    if (policy !== "open") {
      const byAllowlist =
        (policy === "allowlist" || policy === "provider-or-allowlist") &&
        (deps.merchantAllowlist ?? []).includes(paymentRequirements.payTo);
      if (!byAllowlist) {
        return fail("invalid_exact_canton_merchant_not_registered", payer);
      }
    }
    // No Amulet validFrom/expiry read: the utility's transfer-factory route
    // resolves away from "direct" once the preapproval is not currently valid.
  } else {
    if (!deps.fetchPreapproval) {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    let pre: Awaited<ReturnType<NonNullable<InlineValidationDeps["fetchPreapproval"]>>>;
    try {
      pre = await deps.fetchPreapproval(paymentRequirements.payTo);
    } catch {
      // A lookup that failed did not establish a live preapproval. Fail closed:
      // relaying on an unknown answer is what leaves the half-settled state.
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    if (!pre) {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    // BIND it, do not merely find it. A live preapproval belonging to some other
    // receiver, or covering a different issuer, says nothing about whether THIS
    // merchant can be paid in THIS instrument — and reading only its expiry made
    // exactly that mistake.
    if (
      pre.receiver !== paymentRequirements.payTo ||
      pre.dso !== extra.instrumentId.admin
    ) {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    // ── Served merchant ────────────────────────────────────────────────────
    // Placed HERE deliberately: after every local structural check, so junk
    // never reaches a policy decision, and before the deadline and signature
    // work, so a merchant we do not serve costs nothing further. It must stay in
    // the VALIDATION arm rather than in /settle — both /verify and /settle route
    // through here, so this is also what lets /verify answer honestly BEFORE the
    // payer signs, instead of taking a signature and refusing afterwards.
    const policy = deps.merchantPolicy ?? "open";
    if (policy !== "open") {
      const byProvider =
        (policy === "provider" || policy === "provider-or-allowlist") &&
        pre.provider !== undefined &&
        pre.provider === deps.facilitatorParty;
      const byAllowlist =
        (policy === "allowlist" || policy === "provider-or-allowlist") &&
        (deps.merchantAllowlist ?? []).includes(paymentRequirements.payTo);
      if (!byProvider && !byAllowlist) {
        return fail("invalid_exact_canton_merchant_not_registered", payer);
      }
    }

    if (pre.validFrom !== undefined) {
      const fromMs = Date.parse(pre.validFrom);
      if (!Number.isFinite(fromMs) || fromMs > (deps.nowMs ?? Date.now())) {
        return fail("invalid_exact_canton_preapproval_missing", payer);
      }
    }
    const expiryMs = Date.parse(pre.expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= (deps.nowMs ?? Date.now())) {
      // An unparseable expiry is treated as expired, not as "probably fine".
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
  }

  // Rule 10 — deadline. A transfer whose executeBefore has passed (or is about
  // to) cannot settle, and relaying it burns traffic for a submission the
  // ledger will refuse. The margin exists because settle is not instantaneous:
  // accepting at T-1ms guarantees the waste it is meant to avoid.
  if (declaredExecuteBefore === undefined) {
    return fail("invalid_exact_canton_expired", payer);
  }
  const nowMs = deps.nowMs ?? Date.now();
  if (declaredExecuteBefore <= nowMs + EXECUTE_BEFORE_MARGIN_MS) {
    return fail("invalid_exact_canton_expired", payer);
  }
  // ...and the same field the other way. Rule 10 was a floor only, so the payer
  // alone decided how long its payment stayed settleable — and therefore how
  // long everyone downstream had to keep remembering it. A separate code, not
  // `expired`: the client can re-prepare with a shorter horizon and retry,
  // which it cannot do if we tell it the deadline has passed.
  const maxAhead = deps.maxExecuteBeforeSeconds;
  if (
    maxAhead !== undefined &&
    maxAhead > 0 &&
    declaredExecuteBefore > nowMs + maxAhead * 1000
  ) {
    return fail("invalid_exact_canton_execute_before_too_far", payer);
  }

  // Rule 13, second half — the declared inputs must actually cover the payment.
  // Uniqueness is already proven from the bytes by the structural validator;
  // what needs the ledger is their VALUE, which the prepared transaction does
  // not carry.
  //
  // SCOPE, stated rather than implied: this compares against the payment amount
  // ALONE. The Amulet transfer fees are not knowable before submission, so a
  // transfer that covers the amount but not the fees still fails on-ledger.
  // Checking what can be checked beats checking nothing, but it is not the
  // whole of "amount plus fees" and must not be read as such.
  //
  // NOT having an authoritative view is NOT a rejection. This is the one place
  // in the arm where absence means "skip", and it is deliberate: the scheme
  // makes the sum conditional on hosting the payer, and refusing without it
  // would reject every payer we do not host — which is precisely the population
  // the inline carriage exists to serve.
  let owned: Map<string, string> | undefined;
  try {
    owned = deps.fetchOwnedHoldingAmounts
      ? await deps.fetchOwnedHoldingAmounts(payer)
      : undefined;
  } catch {
    // A read that failed proves nothing either way; it does not get to reject.
    owned = undefined;
  }

  // A view that does not contain EVERY declared input is not an authoritative
  // view of this payer, it is a partial one — and a partial view cannot tell
  // "this payer does not own that holding" apart from "we cannot see this
  // payer's holdings". Reading a party's contracts requires rights on that
  // party, so for any payer we do not host the read returns nothing (or an
  // error, handled above) rather than failing loudly.
  //
  // Treating a missing input as proof of a lie would therefore refuse EVERY
  // foreign payer — the exact population the inline carriage exists to serve —
  // the moment a holdings reader is wired at all. That is an outage wearing a
  // security guard's uniform. A transfer that really does name a holding it
  // does not own is refused by the LEDGER on submission; the cost of letting it
  // through here is traffic, and traffic is what the rate limiter and the
  // breaker already bound.
  const authoritative =
    owned !== undefined && declaredInputs.every((cid) => owned.has(cid));

  if (authoritative && owned) {
    let total = 0n;
    for (const cid of declaredInputs) {
      const units = ledgerDecimalToAtomic(owned.get(cid) ?? "");
      if (units === null) {
        return fail("invalid_exact_canton_insufficient_inputs", payer);
      }
      total += units;
    }
    const needed = ledgerDecimalToAtomic(expectedAmount);
    if (needed === null || total < needed) {
      return fail("invalid_exact_canton_insufficient_inputs", payer);
    }
  }

  // Rule 3 — LAST, and fail-closed. Reaching here means the bytes encode
  // exactly the transfer the merchant asked for; what is still unproven is that
  // the payer actually authorised THESE bytes.
  // Explicit, though the catch below reaches the same verdict by other means
  // (calling an absent verifier throws, and a verifier that throws is a
  // verifier that did not verify). Mutation testing confirms the two are
  // outcome-equivalent; this line states the intent rather than relying on it.
  if (!deps.verifySignature) {
    return fail("invalid_exact_canton_signature_invalid", payer);
  }
  let proof: {
    verified: boolean;
    preparedTxHashHex?: string;
    publishedProtocolKeys?: number;
  } = {
    verified: false,
  };
  try {
    proof = await deps.verifySignature({
      preparedTransactionBytes: decoded.preparedTransactionBytes,
      claimedPreparedTxHash: decoded.claimedPreparedTxHash,
      signatureB64: decoded.signatureB64,
      payer,
      hashingSchemeVersion: decoded.hashingSchemeVersion,
    });
  } catch {
    // A verifier that throws is a verifier that did not verify.
    proof = { verified: false };
  }
  if (!proof.verified) {
    return fail("invalid_exact_canton_signature_invalid", payer);
  }

  return {
    ok: true,
    payer,
    preparedTransactionBytes: decoded.preparedTransactionBytes,
    signatureB64: decoded.signatureB64,
    hashingSchemeVersion: decoded.hashingSchemeVersion,
    ...(proof.publishedProtocolKeys !== undefined
      ? { publishedProtocolKeys: proof.publishedProtocolKeys }
      : {}),
    ...(proof.preparedTxHashHex !== undefined
      ? { preparedTxHashHex: proof.preparedTxHashHex }
      : {}),
  };
}

/**
 * Map the structural validator's message onto the scheme's error table.
 *
 * The validator raises one error type for every mismatch, but the scheme
 * requires the merchant be told WHICH field disagreed. Unrecognised messages
 * fall through to `malformed_payload` rather than to any specific code — a
 * wrong-but-specific reason would be a worse answer than an honest generic one.
 */
export function classifyMismatch(message: string): CantonErrorCode {
  const m = message.toLowerCase();
  if (m.includes("amount")) return "invalid_exact_canton_amount_mismatch";
  if (m.includes("receiver")) return "invalid_exact_canton_merchant_mismatch";
  if (m.includes("instrument"))
    return "invalid_exact_canton_instrument_id_mismatch";
  if (m.includes("memo")) return "invalid_exact_canton_memo_mismatch";
  if (m.includes("input holding"))
    return "invalid_exact_canton_insufficient_inputs";
  // Staleness has THREE spellings, because three different clocks can run out
  // and only one of them is called "expire". The structural validator refuses a
  // transaction whose `max_record_time` or `max_ledger_effective_time` is
  // "already in the past", and neither phrase contains the word this used to
  // look for — so a payment that was merely SLOW came back
  // `malformed_payload`.
  //
  // That is the wrong answer in the way that matters: "you were slow, sign
  // again" and "your bytes are broken, stop" call for opposite actions, and a
  // correct client told the second will either give up or retry forever a
  // payload that can never work. Measured on MainNet — a payload signed with a
  // 15s horizon and settled 40s later reported `malformed_payload`.
  if (
    m.includes("expire") ||
    m.includes("executebefore") ||
    m.includes("record_time") ||
    m.includes("effective_time") ||
    m.includes("already in the past")
  )
    return "invalid_exact_canton_expired";
  return "invalid_exact_canton_malformed_payload";
}

/**
 * Ledger Decimal ("0.0100000000") to atomic units, exactly. Returns null on
 * anything that is not a plain non-negative decimal.
 *
 * Done as integer string surgery rather than through a float: 1 CC is 1e10
 * atomic units, and IEEE-754 cannot represent every value in that range
 * exactly. A rounding error here is a wrong sufficiency verdict about money.
 */
function ledgerDecimalToAtomic(value: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > 10) return null;
  return BigInt(whole + frac.padEnd(10, "0"));
}
