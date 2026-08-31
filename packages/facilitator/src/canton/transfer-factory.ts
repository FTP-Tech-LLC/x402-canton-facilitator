import type { CantonClient } from "@ftptech/x402-canton-ledger";
import type { ScanClient, TransferPreapprovalRecord } from "@ftptech/x402-canton-ledger";

/**
 * transfer-factory ("V3") settle primitive — the facilitator RELAYS a
 * payer-signed `TransferFactory_Transfer` and pays the GS traffic. It signs
 * nothing for the payer: the prepared tx + the payer's signature come from the
 * relay stash (pay/prepare + pay/commit). The Canton analog of EIP-3009
 * transferWithAuthorization.
 *
 * Two responsibilities:
 *   - `preapprovalKind` — resolve whether the merchant holds a live
 *     `TransferPreapproval` (registry `resolveTransferKind` === "direct"). The
 *     /settle tf branch gates on this: without it the transfer would resolve to
 *     a two-step Pending and never settle in one round-trip, so /settle refuses
 *     BEFORE relaying (never a silent half-settled state — brief invariant I2).
 *   - `execute` — interactive-execute the stashed signed submission and confirm
 *     funds moved. The facilitator hosts the PAYER (relay-onboarded), so the
 *     funds-moved gate reads the settle tx from the PAYER's projection and looks
 *     for an archived input Amulet WITHOUT a created `TransferInstruction`
 *     (a Pending would create one; a Completed direct transfer just consumes the
 *     payer's Amulet). No cross-participant read of the merchant is needed.
 */

const AMULET_SUFFIX_RE = /:Splice\.Amulet:Amulet$/;
// A PENDING two-step outcome creates a `TransferInstruction` contract. The
// getTransactionById read returns CONCRETE template ids (no interface filter),
// and a registry's concrete impl lives in its OWN module: Amulet's is
// `Splice.Api.Token.TransferInstructionV1:TransferInstruction`, but a DA
// Registry Utility token's is `Utility.Registry.App.V0.Model:TransferInstruction`.
// Match the template NAME (final `:`-segment) so pending is detected for ANY
// registry family — pinning the module would miss a utility pending and let the
// funds-moved gate report a still-pending settlement as `transferred`. (The
// name convention holds across the token-standard families we settle; a real
// utility pending tx should still be confirmed against this before production.)
/**
 * POSITIVE PROOF THAT A REGISTRY TRANSFER DELIVERED, read from the token
 * standard's own discriminator rather than guessed from a template name.
 *
 * `TransferFactory_Transfer` returns a TransferInstructionResult whose
 * `output.tag` says what happened. MEASURED on a live MainNet USDCx transfer,
 * not assumed:
 *
 *   "exerciseResult": { "output": {
 *       "tag": "TransferInstructionResult_Completed",
 *       "value": { "receiverHoldingCids": ["00ccead9…"] } } }
 *
 * A pending (two-step) transfer reports the Pending tag instead. This is the
 * signal the registry arm lacked: it had only the ABSENCE of a pending
 * TransferInstruction created event, matched by template NAME — a name nobody
 * had observed. Absence of a guess is not evidence; this is.
 *
 * Returns undefined when the result is not readable at all, and the caller then
 * keeps the previous behaviour rather than inventing a negative — a payment we
 * cannot read is inconclusive, never "did not happen".
 */
export function transferCompletedFromResult(
  events: ReadonlyArray<{
    ExercisedEvent?: { choice?: string; exerciseResult?: unknown };
  }>
): boolean | undefined {
  for (const ev of events) {
    const ex = ev.ExercisedEvent;
    if (!ex || ex.choice !== "TransferFactory_Transfer") continue;
    const out = (ex.exerciseResult as { output?: { tag?: unknown } } | undefined)
      ?.output;
    const tag = typeof out?.tag === "string" ? out.tag : undefined;
    if (tag === undefined) return undefined;
    return tag === "TransferInstructionResult_Completed";
  }
  return undefined;
}

const TRANSFER_INSTRUCTION_SUFFIX_RE = /:TransferInstruction$/;

export type PreapprovalKind = "yes" | "no" | "unknown";

export interface TransferFactoryDeps {
  client: Pick<
    CantonClient,
    | "interactiveSubmissionExecute"
    | "getLedgerEnd"
    | "pollCompletionUpdateId"
    | "findCompletion"
    | "getTransactionById"
  >;
  /** REQUIRED, both of them: `resolveTransferKind` alone cannot answer the
   *  question the gate asks (see `preapprovalKind`). Not optional, so the
   *  expiry half cannot be silently left unwired in a deployment. */
  scan: Pick<ScanClient, "resolveTransferKind" | "getTransferPreapprovalByParty">;
  /** The facilitator's own party — the `sender` the registry resolve probes
   *  with (resolveTransferKind is sender-agnostic for the merchant's kind). */
  facilitatorParty: string;
  /** Ledger user the relay executes as (validator m2m; holds CanActAs on the
   *  payer party). */
  userId: string;
  /** getTransactionById confirmation retry (the payer projection can lag the
   *  execute completion by a beat). */
  confirmRetry?: { attempts: number; delayMs: number };
  /** Non-Amulet CIP-56 instrument registries: instrument admin party →
   *  DA Registry Utility base URL. When an instrument's admin is present here,
   *  the preapproval probe routes to that utility (per-registrar path) instead
   *  of the SV Scan. Absent/empty → Amulet-only (SV Scan), the default. */
  tokenRegistries?: Record<string, string>;
}

export interface TfExecuteResult {
  updateId: string;
  /** True when the settle tx provably consumed the payer's Amulet as a direct
   *  (Completed) transfer — an archived Amulet with NO pending
   *  TransferInstruction created. */
  transferred: boolean;
  /** True when the funds-moved read was inconclusive (no events surfaced after
   *  retries) and `transferred` fell back to the committed-execute signal. The
   *  caller logs it; the preapproval gate already excluded the Pending case. */
  confirmInconclusive: boolean;
  /**
   * Registry arm only. Set when the token standard's result tag and the old
   * name-based signal DISAGREED about whether funds moved.
   *
   * This exists to be counted. The old signal inferred delivery from the
   * absence of a created event matched by template name, and nobody could say
   * how often that was wrong because nothing ever compared it against a real
   * answer. Now something does. A non-empty stream of these on live traffic is
   * the evidence that the name-based heuristic was mis-classifying settlements;
   * silence is the evidence that it happened to be right.
   *
   * The caller logs it — same division of labour as `confirmInconclusive`,
   * which keeps the gate free of a logger it would otherwise need threading in.
   */
  registrySignalDisagreement?: { tagSaid: boolean; nameSaid: boolean };
  /** Registry arm only. The result tag could not be read at all, so the verdict
   *  fell back to the name-based signal. Worth counting separately: it means
   *  the positive proof is not actually reaching us. */
  registryTagUnreadable?: boolean;
}

const DEFAULT_CONFIRM_RETRY = { attempts: 4, delayMs: 500 };

/**
 * The submission was ACCEPTED by the participant (the /execute POST returned)
 * but its outcome could not be read. It may be committing right now.
 *
 * This is the one distinction /settle needs and could not make: a definite
 * refusal may be reported to the merchant as a payment rejection, an unknown
 * outcome may not. Reporting this one as a rejection made the merchant refuse
 * to deliver while the payer's CC left anyway.
 */
export class SubmissionOutcomeUnknownError extends Error {
  constructor(override readonly cause: unknown) {
    super(
      `interactive submission accepted but its outcome could not be read: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "SubmissionOutcomeUnknownError";
  }
}

export class TransferFactoryService {
  constructor(private readonly deps: TransferFactoryDeps) {}

  /**
   * Does the merchant hold a live TransferPreapproval for this instrument?
   * "yes" → a transfer to it completes in ONE tx. "no" → it would Pend
   * (reject the settle). "unknown" → the check could not run (validator Scan
   * flavor, or a transient resolve error) — the caller decides (we fail closed
   * on the money path: treat unknown as "cannot guarantee 1-tx").
   */
  async preapprovalKind(args: {
    merchant: string;
    admin: string;
    id: string;
  }): Promise<PreapprovalKind> {
    const now = Date.now();
    // Non-Amulet CIP-56 token → probe its DA Registry Utility, not the SV Scan.
    const registryBaseUrl = this.deps.tokenRegistries?.[args.admin];
    try {
      const kind = await this.deps.scan.resolveTransferKind({
        sender: this.deps.facilitatorParty,
        receiver: args.merchant,
        amount: "1.0000000000",
        admin: args.admin,
        id: args.id,
        requestedAt: new Date(now).toISOString(),
        executeBefore: new Date(now + 3_600_000).toISOString(),
        ...(registryBaseUrl ? { registryBaseUrl } : {}),
      });
      if (kind !== "direct") return "no";
    } catch {
      return "unknown";
    }

    // The `expiresAt` double-check below reads an Amulet `TransferPreapproval`
    // from the SV Scan (`getTransferPreapprovalByParty`). It does not apply to a
    // non-Amulet token whose preapproval lives in a DA Registry Utility, and the
    // utility's transfer-factory route already honours the preapproval's
    // deadline (an expired one resolves away from `direct`). So for a
    // registry-utility instrument, a `direct` answer is authoritative here.
    if (registryBaseUrl) return "yes";

    // `resolveTransferKind` answers "how would a transfer route", and it stays
    // `direct` for an EXPIRED preapproval — the transfer then dies at
    // interpretation with `deadline-exceeded` on `TransferPreapproval.expiresAt`
    // AFTER we have relayed it and burned Global Synchronizer traffic. That
    // limitation is written down on `getTransferPreapprovalByParty`, which
    // carries the `expiresAt` that distinguishes the two, and the registry
    // route already honours it. This gate is on the money path and did not.
    //
    // Strictly an EXTRA refusal, never a new one on honest traffic: anything
    // short of a record that names this merchant and has already expired keeps
    // the answer this gate gave before. A Scan 429, a payload without
    // `expiresAt` (which the reader collapses into `null`), an unparseable
    // timestamp, or a record for a different receiver all leave it at "yes" —
    // the doomed-submit outcome we have today, rather than refusing a payment
    // that would have settled.
    let record: TransferPreapprovalRecord | null;
    try {
      record = await this.deps.scan.getTransferPreapprovalByParty(args.merchant);
    } catch {
      return "yes";
    }
    if (
      record &&
      record.receiver === args.merchant &&
      Date.parse(record.expiresAt) <= now
    ) {
      return "no";
    }
    return "yes";
  }

  /**
   * Interactive-execute the stashed signed submission and confirm funds moved.
   * Throws on a ledger/transport error (the caller maps it to a settle failure
   * and counts a traffic failure against the breaker). A committed-but-did-not-
   * move-funds outcome returns `transferred:false` (NOT a throw), mirroring the
   * direct path's funds-moved gate.
   */
  async execute(input: {
    payer: string;
    preparedTransaction: string;
    hashingSchemeVersion:
      | "HASHING_SCHEME_VERSION_V1"
      | "HASHING_SCHEME_VERSION_V2";
    partySignatures: {
      signatures: Array<{
        party: string;
        signatures: Array<Record<string, unknown>>;
      }>;
    };
    submissionId: string;
    /** Ledger end captured by the caller BEFORE it recorded its intent row. */
    beginExclusive?: number;
    /** Instrument admin of the transfer. When it names a registry-utility token
     *  (present in `tokenRegistries`), the funds-moved gate uses the CIP-56
     *  generic signal (committed + no pending instruction) rather than looking
     *  for an archived `Splice.Amulet:Amulet` (which only Canton Coin emits).
     *  Omitted / an Amulet admin → the Amulet archive check, unchanged. */
    instrumentAdmin?: string;
  }): Promise<TfExecuteResult> {
    // The caller may hand us the offset it ALREADY recorded with its
    // pre-dispatch intent row. Using that one rather than reading a fresh
    // ledger end matters: the durable row and this poll then name the same
    // starting point, so a later resolve of an unknown outcome searches the
    // window this submission was actually made in. Reading our own would leave
    // the row pointing somewhere subtly later.
    const offset0 =
      input.beginExclusive ?? (await this.deps.client.getLedgerEnd()).offset;
    const r = await this.deps.client.interactiveSubmissionExecute({
      preparedTransaction: input.preparedTransaction,
      hashingSchemeVersion: input.hashingSchemeVersion,
      partySignatures:
        input.partySignatures as unknown as Parameters<
          TransferFactoryDeps["client"]["interactiveSubmissionExecute"]
        >[0]["partySignatures"],
      submissionId: input.submissionId,
      // Required by /v2/interactive-submission/execute (participant 400s without
      // it). Idempotency is handled upstream (the inline settle store), so no
      // dedup window.
      deduplicationPeriod: { Empty: {} },
    });
    // THE EXECUTE POST HAS RETURNED 200. The submission is accepted and will be
    // sequenced; /execute is async and normally answers `{}` with the updateId
    // arriving on the completion stream. So everything below is reading the
    // outcome of something already in flight — it can classify that payment, it
    // can never unmake it.
    //
    // The confirm-read further down already knows that. This step did not.
    // pollCompletionUpdateId gives up with INVALID_RESPONSE after ~12s, and it
    // gets there on ANY failure of the completion read — readCompletions turns a
    // 401 after a token refresh, a participant 5xx, or a 502/504 from the bridge
    // in front of it into an empty list. That error escaped execute() and
    // /settle answered `success:false`, which express turns into a 402: the
    // merchant refuses to deliver for a payment that then commits on-ledger, and
    // nothing is recorded anywhere, because the idempotency rows are only
    // written after the funds-moved gate.
    //
    // SUBMISSION_FAILED is the opposite case and must keep its meaning: the
    // completion ARRIVED carrying a non-zero status, so the participant refused
    // it and nothing moved.
    let updateId = r.updateId;
    if (!updateId) {
      try {
        updateId = await this.deps.client.pollCompletionUpdateId(
          this.deps.userId,
          input.payer,
          input.submissionId,
          offset0
        );
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === "SUBMISSION_FAILED") {
          throw err;
        }
        throw new SubmissionOutcomeUnknownError(err);
      }
    }

    // Funds-moved gate, read as the PAYER.
    //
    // EVERYTHING PAST THIS POINT IS AFTER THE MONEY MOVED. We hold a real
    // updateId: the execute committed, the payer's Amulet is archived and the
    // merchant is paid. So this read can only ever CLASSIFY a payment that
    // already happened — it must never be able to unmake it.
    //
    // It could. The read was unguarded, and the retry loop absorbs exactly one
    // failure shape: a 200 whose `events` array is empty. Every THROWN failure
    // — the 45s abort (mainnet submits "can take 30s+ under load", says our own
    // config) or any non-2xx from our participant — escaped `execute()`
    // entirely and past the `confirmInconclusive: true` fallback below, which
    // exists precisely to say "unreadable confirmation, trust the commit".
    // /settle then answered `success:false` for a payment that had settled,
    // wrote no idempotency record anywhere, and the client — whose
    // STOP_IF_REPEATED list does not contain this code — paid a SECOND time.
    //
    // A throw is now treated as exactly what it is: an inconclusive read.
    // Same retry, same fallback.
    //
    // (The old comment here claimed the payer is "always hosted by the
    // facilitator". That is false for the inline carriage, which exists to
    // relay for payers we do not host.)
    return this.confirmTransferred(input.payer, updateId, input.instrumentAdmin);
  }

  /**
   * The current ledger end, for a caller that wants to record WHERE it was
   * looking from before it dispatches. Handed back into `execute` so the
   * durable intent row and the completion poll name the same starting point.
   */
  async ledgerEnd(): Promise<number> {
    return (await this.deps.client.getLedgerEnd()).offset;
  }

  /**
   * ANSWER A QUESTION WE LEFT OPEN: what happened to a submission we dispatched
   * and never saw the outcome of?
   *
   * The pre-dispatch intent row records the submissionId and the ledger offset
   * captured just before the submit. That is everything needed to go and look:
   * the completion for that submissionId, from that offset. No new submission,
   * no traffic burned — a read.
   *
   * Three answers, and the third is not a failure:
   *   settled   the completion says it committed. The funds-moved verdict comes
   *             from the SAME confirm the live path uses, so a resolved payment
   *             is classified exactly as it would have been in the moment.
   *   rejected  the completion carries a non-zero status: the participant
   *             refused it and nothing moved. Safe to let the payer retry.
   *   unknown   the completion is not there (yet), or the read failed. Still
   *             unknown, and saying so is the whole point of this machinery.
   *
   * NEVER throws for "I could not tell" — that is a return value here, because
   * every caller has to distinguish it from "it failed" and an exception makes
   * the two look alike.
   */
  async resolveDispatched(input: {
    payer: string;
    submissionId: string;
    beginExclusive: number;
    /** Instrument admin — threads the same registry-utility funds-moved rule as
     *  {@link execute} into a resolved (missed-outcome) settlement. */
    instrumentAdmin?: string;
  }): Promise<
    | { state: "settled"; updateId: string; transferred: boolean; confirmInconclusive: boolean }
    | { state: "rejected"; message: string }
    | { state: "unknown" }
  > {
    let found: Awaited<ReturnType<TransferFactoryDeps["client"]["findCompletion"]>>;
    try {
      found = await this.deps.client.findCompletion(
        this.deps.userId,
        input.payer,
        input.submissionId,
        input.beginExclusive
      );
    } catch {
      // An unreadable completion stream is not evidence of anything.
      return { state: "unknown" };
    }
    if (found.kind === "absent") return { state: "unknown" };
    if (found.kind === "rejected") {
      return { state: "rejected", message: found.message };
    }
    // A completion with an empty updateId cannot be confirmed against, and
    // guessing "transferred" from a blank id would be inventing a settlement.
    if (!found.updateId) return { state: "unknown" };
    const confirmed = await this.confirmTransferred(
      input.payer,
      found.updateId,
      input.instrumentAdmin
    );
    return {
      state: "settled",
      updateId: confirmed.updateId,
      transferred: confirmed.transferred,
      confirmInconclusive: confirmed.confirmInconclusive,
    };
  }

  /**
   * Did the funds actually move under this updateId?
   *
   * Extracted so `execute` and `resolveDispatched` cannot drift: one is the
   * live path, the other resolves a submission whose answer we missed, and
   * they must reach the same verdict from the same evidence. A second copy of
   * this rule is precisely the divergence class that keeps producing money
   * bugs here.
   */
  async confirmTransferred(
    payer: string,
    updateId: string,
    instrumentAdmin?: string
  ): Promise<TfExecuteResult> {
    const cfg = this.deps.confirmRetry ?? DEFAULT_CONFIRM_RETRY;
    for (let i = 0; i < cfg.attempts; i++) {
      let events: Awaited<
        ReturnType<TransferFactoryDeps["client"]["getTransactionById"]>
      >["events"] = [];
      try {
        // A registry token's proof of delivery is the exercise result, and the
        // narrow projection does not carry exercises at all — measured on live
        // MainNet: payer sees 2 Created/Archived events and no exercise. Ask for
        // the full effects tree there, and ONLY there: the Amulet path keeps the
        // exact request it has always made.
        const wantEffects = instrumentAdmin
          ? Boolean(this.deps.tokenRegistries?.[instrumentAdmin])
          : false;
        events = (
          await this.deps.client.getTransactionById({
            updateId,
            requestingParties: [payer],
            ...(wantEffects ? { fullEffects: true } : {}),
          })
        ).events;
      } catch {
        events = []; // unreadable == inconclusive, never == "did not happen"
      }
      const tx = { events };
      let sawArchivedAmulet = false;
      let sawPendingInstruction = false;
      let sawAnyEvent = false;
      for (const ev of tx.events) {
        sawAnyEvent = true;
        if (
          ev.ArchivedEvent &&
          AMULET_SUFFIX_RE.test(ev.ArchivedEvent.templateId ?? "")
        ) {
          sawArchivedAmulet = true;
        }
        if (
          ev.CreatedEvent &&
          TRANSFER_INSTRUCTION_SUFFIX_RE.test(ev.CreatedEvent.templateId ?? "")
        ) {
          sawPendingInstruction = true;
        }
      }
      if (sawAnyEvent) {
        // Amulet emits an archived `Splice.Amulet:Amulet` as the consumed input,
        // the positive "funds moved" signal. A non-Amulet CIP-56 token archives
        // its own (unknown-to-us) Holding template, so that positive check does
        // not apply; the preapproval gate already guaranteed `direct`, and a
        // committed transfer that created NO pending `TransferInstruction` is a
        // `_Completed` direct settlement. So for a registry-utility instrument
        // the signal is "committed + not pending".
        const isRegistryUtility = instrumentAdmin
          ? Boolean(this.deps.tokenRegistries?.[instrumentAdmin])
          : false;
        // For a registry token, prefer the standard's own result tag — real
        // evidence the delivery node executed — over the absence of a
        // name-matched pending event. Fall back to the old signal only when the
        // result cannot be read, so an unreadable shape degrades to today's
        // behaviour instead of turning into a false "nothing moved".
        const completedByResult = transferCompletedFromResult(tx.events);
        const nameSaid = !sawPendingInstruction;
        return {
          updateId,
          transferred: isRegistryUtility
            ? (completedByResult ?? nameSaid)
            : sawArchivedAmulet && !sawPendingInstruction,
          confirmInconclusive: false,
          // Report, do not decide: the tag still wins above. These two fields
          // only make the comparison observable.
          ...(isRegistryUtility && completedByResult === undefined
            ? { registryTagUnreadable: true }
            : {}),
          ...(isRegistryUtility &&
          completedByResult !== undefined &&
          completedByResult !== nameSaid
            ? {
                registrySignalDisagreement: {
                  tagSaid: completedByResult,
                  nameSaid,
                },
              }
            : {}),
        };
      }
      if (i < cfg.attempts - 1) {
        await new Promise((res) => setTimeout(res, cfg.delayMs));
      }
    }
    // Inconclusive read after retries: the execute committed (we have an
    // updateId) and the caller only reaches here AFTER the preapproval=yes gate,
    // which excludes the Pending case. Trust the committed signal; flag it.
    return { updateId, transferred: true, confirmInconclusive: true };
  }
}
