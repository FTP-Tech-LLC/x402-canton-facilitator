import type { CantonClient } from "@ftptech/x402-canton-ledger";
import type { ScanClient } from "@ftptech/x402-canton-ledger";

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
const TRANSFER_INSTRUCTION_SUFFIX_RE =
  /:Splice\.Api\.Token\.TransferInstructionV1:TransferInstruction$/;

export type PreapprovalKind = "yes" | "no" | "unknown";

export interface TransferFactoryDeps {
  client: Pick<
    CantonClient,
    | "interactiveSubmissionExecute"
    | "getLedgerEnd"
    | "pollCompletionUpdateId"
    | "getTransactionById"
  >;
  scan: Pick<ScanClient, "resolveTransferKind">;
  /** The facilitator's own party — the `sender` the registry resolve probes
   *  with (resolveTransferKind is sender-agnostic for the merchant's kind). */
  facilitatorParty: string;
  /** Ledger user the relay executes as (validator m2m; holds CanActAs on the
   *  payer party). */
  userId: string;
  /** getTransactionById confirmation retry (the payer projection can lag the
   *  execute completion by a beat). */
  confirmRetry?: { attempts: number; delayMs: number };
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
}

const DEFAULT_CONFIRM_RETRY = { attempts: 4, delayMs: 500 };

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
    try {
      const kind = await this.deps.scan.resolveTransferKind({
        sender: this.deps.facilitatorParty,
        receiver: args.merchant,
        amount: "1.0000000000",
        admin: args.admin,
        id: args.id,
        requestedAt: new Date(now).toISOString(),
        executeBefore: new Date(now + 3_600_000).toISOString(),
      });
      return kind === "direct" ? "yes" : "no";
    } catch {
      return "unknown";
    }
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
  }): Promise<TfExecuteResult> {
    const offset0 = (await this.deps.client.getLedgerEnd()).offset;
    const r = await this.deps.client.interactiveSubmissionExecute({
      preparedTransaction: input.preparedTransaction,
      hashingSchemeVersion: input.hashingSchemeVersion,
      partySignatures:
        input.partySignatures as unknown as Parameters<
          TransferFactoryDeps["client"]["interactiveSubmissionExecute"]
        >[0]["partySignatures"],
      submissionId: input.submissionId,
      // Required by /v2/interactive-submission/execute (participant 400s without
      // it). The submissionRef already gives us idempotency, so no dedup window.
      deduplicationPeriod: { Empty: {} },
    });
    let updateId = r.updateId;
    if (!updateId) {
      updateId = await this.deps.client.pollCompletionUpdateId(
        this.deps.userId,
        input.payer,
        input.submissionId,
        offset0
      );
    }

    // Funds-moved gate (read as the PAYER — always hosted by the facilitator).
    const cfg = this.deps.confirmRetry ?? DEFAULT_CONFIRM_RETRY;
    for (let i = 0; i < cfg.attempts; i++) {
      const tx = await this.deps.client.getTransactionById({
        updateId,
        requestingParties: [input.payer],
      });
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
        return {
          updateId,
          transferred: sawArchivedAmulet && !sawPendingInstruction,
          confirmInconclusive: false,
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
