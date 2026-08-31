import { randomUUID } from "node:crypto";
import { SubmissionOutcomeUnknownError } from "./transfer-factory.js";
import type {
  CantonClient,
  DisclosedContract,
  ScanClient,
} from "@ftptech/x402-canton-ledger";
import { selectActiveOpenRound } from "../routes/settle.js";
import { isInputContentionError } from "./ledger-errors.js";

const PREAPPROVAL_CHOICE = "AmuletRules_CreateTransferPreapproval";

export interface PreapprovalServiceDeps {
  client: Pick<
    CantonClient,
    | "submitAndWaitForTransaction"
    | "queryActiveContracts"
    | "interactiveSubmissionPrepare"
    | "interactiveSubmissionExecute"
    | "getLedgerEnd"
    | "pollCompletionUpdateId"
  >;
  scan: Pick<
    ScanClient,
    | "getAmuletRules"
    | "getOpenAndIssuingMiningRounds"
    | "getAmuletRulesFresh"
    | "getOpenAndIssuingMiningRoundsFresh"
  >;
  facilitatorParty: string;
  userId: string;
}

export interface CreatePreapprovalInput {
  /** Merchant party (the receiver) that will hold the preapproval. */
  merchant: string;
  /** ISO-8601 expiry. The provider (facilitator) must renew before this. */
  expiresAt: string;
}

export interface CreatePreapprovalResult {
  updateId: string;
  receiver: string;
  provider: string;
  expiresAt: string;
}

/**
 * Phase 2 of the instant-CC-settle feature (see docs/design/merchant-preapproval.md):
 * the facilitator acts as the PROVIDER and creates a Canton-Coin
 * `TransferPreapproval` for a merchant, so the merchant's incoming x402 CC
 * payments settle atomically (transferKind=direct) instead of going two-step
 * Pending. CC-ONLY: a project issuing its own CIP-56 token controls its own
 * TransferFactory and can complete atomically with no preapproval, so this is
 * a Canton-Coin convenience.
 *
 * `AmuletRules_CreateTransferPreapproval` (controllers: provider + receiver;
 * args verified against Splice docs):
 *   { context: PaymentTransferContext, inputs: [TransferInput],
 *     receiver: Party, provider: Party, expiresAt: Time, expectedDso: Optional Party }
 * Because BOTH provider and receiver are controllers, the submission acts as
 * the facilitator party AND the merchant — the facilitator's ledger user MUST
 * have CanActAs the merchant (delegated, mirroring the registry accept flow).
 * The PaymentTransferContext is assembled exactly as the verified v1 settle
 * path (AmuletRules + open round; only already-open issuing rounds disclosed).
 *
 * VALIDATED LIVE ON TESTNET (2026-06-04): the choice burns the fee from
 * `inputs` via splitAndBurn, so the provider MUST supply its own Amulet
 * holdings; empty inputs fail with ITR_InsufficientFunds. The choice also
 * rejects a not-yet-open issuing round in the context (deadline-not-exceeded),
 * so only ALREADY-OPEN issuing rounds are disclosed. The route stays OFF by
 * default (CANTON_X402_ENABLE_PREAPPROVAL_PROVIDER); enable per deployment.
 */
export class PreapprovalService {
  constructor(private readonly deps: PreapprovalServiceDeps) {}

  /**
   * The DSO state this choice DISCLOSES to the ledger: AmuletRules and the
   * mining rounds. Both are read through a TTL cache, so within one TTL of a
   * round rotation the cached cid names a contract the ledger has already
   * archived and the submit is refused. `fresh` is the documented escape:
   * invalidate, refetch, repopulate.
   */
  private async dsoState(fresh: boolean) {
    const { scan } = this.deps;
    return Promise.all([
      fresh ? scan.getAmuletRulesFresh() : scan.getAmuletRules(),
      fresh
        ? scan.getOpenAndIssuingMiningRoundsFresh()
        : scan.getOpenAndIssuingMiningRounds(),
    ]);
  }

  async createTransferPreapproval(
    input: CreatePreapprovalInput
  ): Promise<CreatePreapprovalResult> {
    try {
      return await this.attemptCreate(input, false);
    } catch (err) {
      // Retry ONLY on the refusal we can prove created nothing: the ledger
      // rejecting the submission because a disclosed contract is already
      // archived — which here means our cached round or AmuletRules cid, not
      // anything about the merchant. A rejection is a definite verdict, so the
      // retry cannot double-create. Anything ambiguous (a timeout, a transport
      // error) is rethrown untouched: re-submitting a preapproval that may
      // already exist is not something to guess at.
      if (!isInputContentionError(err)) throw err;
      return await this.attemptCreate(input, true);
    }
  }

  private async attemptCreate(
    input: CreatePreapprovalInput,
    fresh: boolean
  ): Promise<CreatePreapprovalResult> {
    const { facilitatorParty, userId, client } = this.deps;

    const [amulet, rounds] = await this.dsoState(fresh);

    const openRound = selectActiveOpenRound(
      rounds.open_mining_rounds,
      Date.now()
    );
    if (!openRound) {
      throw new Error(
        "no open mining round available for preapproval creation"
      );
    }

    const arc = amulet.amulet_rules.contract;
    const dso = arc.payload.dso;
    const synchronizerId = amulet.amulet_rules.domain_id;

    const disclosedContracts: DisclosedContract[] = [
      {
        templateId: arc.template_id,
        contractId: arc.contract_id,
        createdEventBlob: arc.created_event_blob,
        synchronizerId,
      },
      {
        templateId: openRound.contract.template_id,
        contractId: openRound.contract.contract_id,
        createdEventBlob: openRound.contract.created_event_blob,
        synchronizerId,
      },
    ];

    // Daml `Map Round (ContractId IssuingMiningRound)` → `[[{number}, cid], ...]`
    // in JSON Ledger API v2 (same encoding the v1 settle path uses).
    const issuingPairs: Array<[{ number: string }, string]> = [];
    const nowMsIssuing = Date.now();
    for (const ir of rounds.issuing_mining_rounds) {
      // Only disclose issuing rounds that have already opened. The choice's
      // deadline check rejects a not-yet-open issuing round
      // (deadline-not-exceeded), which fails the whole preapproval creation.
      const opensAtMs = ir.contract.payload.opensAt
        ? Date.parse(ir.contract.payload.opensAt)
        : NaN;
      if (Number.isFinite(opensAtMs) && opensAtMs > nowMsIssuing) continue;
      issuingPairs.push([
        { number: ir.contract.payload.round.number },
        ir.contract.contract_id,
      ]);
      disclosedContracts.push({
        templateId: ir.contract.template_id,
        contractId: ir.contract.contract_id,
        createdEventBlob: ir.contract.created_event_blob,
        synchronizerId,
      });
    }

    // Fund the preapproval fee from the provider's own Amulet holdings
    // (see the class doc): the choice burns it from `inputs`.
    const feeInputs = await this.selectFeeInputs(facilitatorParty);

    const choiceArgument: Record<string, unknown> = {
      context: {
        amuletRules: arc.contract_id,
        context: {
          openMiningRound: openRound.contract.contract_id,
          issuingMiningRounds: issuingPairs,
          validatorRights: [],
          featuredAppRight: null,
        },
      },
      inputs: feeInputs,
      receiver: input.merchant,
      provider: facilitatorParty,
      expiresAt: input.expiresAt,
      expectedDso: dso,
    };

    const result = await client.submitAndWaitForTransaction({
      commandId: `preapproval-${randomUUID()}`,
      userId,
      // provider + receiver are both controllers → actAs BOTH. Requires the
      // merchant's CanActAs to be delegated to the facilitator's ledger user.
      actAs: [facilitatorParty, input.merchant],
      synchronizerId,
      disclosedContracts,
      commands: [
        {
          ExerciseCommand: {
            templateId: arc.template_id,
            contractId: arc.contract_id,
            choice: PREAPPROVAL_CHOICE,
            choiceArgument,
          },
        },
      ],
    });

    return {
      updateId: result.updateId,
      receiver: input.merchant,
      provider: facilitatorParty,
      expiresAt: input.expiresAt,
    };
  }

  /**
   * SELF-PROVIDER preapproval, step 1 (prepare). The MERCHANT is BOTH provider
   * and receiver, so `AmuletRules_CreateTransferPreapproval` has a single
   * controller (the merchant) — NO facilitator CanActAs delegation is needed
   * (unlike createTransferPreapproval above, which the facilitator cannot run
   * for a self-custodial external merchant). The merchant funds its own fee from
   * its own Amulet. Returns an interactive-submission prepared transaction the
   * merchant signs with its OWN key; finish with executeSelfPreapproval. This is
   * what lets a self-custodial external merchant hold a live TransferPreapproval
   * so its incoming transfer-factory payments settle direct (1-tx).
   */
  async prepareSelfPreapproval(input: {
    party: string;
    expiresAt: string;
  }): Promise<{
    preparedTransaction: string;
    txHash: string;
    synchronizerId: string;
  }> {
    const { client, userId } = this.deps;
    // No retry arm here on purpose: this method only PREPARES: the merchant
    // signs and executes it themselves, so a stale disclosed round surfaces at
    // their execute, not ours, and re-reading after the fact would not help
    // them. They re-run the prepare, which by then reads a refreshed cache.
    const [amulet, rounds] = await this.dsoState(false);
    const openRound = selectActiveOpenRound(
      rounds.open_mining_rounds,
      Date.now()
    );
    if (!openRound) {
      throw new Error("no open mining round available for preapproval creation");
    }
    const arc = amulet.amulet_rules.contract;
    const dso = arc.payload.dso;
    const synchronizerId = amulet.amulet_rules.domain_id;
    const disclosedContracts: DisclosedContract[] = [
      {
        templateId: arc.template_id,
        contractId: arc.contract_id,
        createdEventBlob: arc.created_event_blob,
        synchronizerId,
      },
      {
        templateId: openRound.contract.template_id,
        contractId: openRound.contract.contract_id,
        createdEventBlob: openRound.contract.created_event_blob,
        synchronizerId,
      },
    ];
    const issuingPairs: Array<[{ number: string }, string]> = [];
    const nowMsIssuing = Date.now();
    for (const ir of rounds.issuing_mining_rounds) {
      const opensAtMs = ir.contract.payload.opensAt
        ? Date.parse(ir.contract.payload.opensAt)
        : NaN;
      if (Number.isFinite(opensAtMs) && opensAtMs > nowMsIssuing) continue;
      issuingPairs.push([
        { number: ir.contract.payload.round.number },
        ir.contract.contract_id,
      ]);
      disclosedContracts.push({
        templateId: ir.contract.template_id,
        contractId: ir.contract.contract_id,
        createdEventBlob: ir.contract.created_event_blob,
        synchronizerId,
      });
    }
    // The merchant funds its OWN preapproval fee from its OWN Amulet holdings.
    const feeInputs = await this.selectFeeInputs(input.party);
    const choiceArgument: Record<string, unknown> = {
      context: {
        amuletRules: arc.contract_id,
        context: {
          openMiningRound: openRound.contract.contract_id,
          issuingMiningRounds: issuingPairs,
          validatorRights: [],
          featuredAppRight: null,
        },
      },
      inputs: feeInputs,
      receiver: input.party,
      provider: input.party,
      expiresAt: input.expiresAt,
      expectedDso: dso,
    };
    const prepared = await client.interactiveSubmissionPrepare({
      userId,
      commandId: `self-preapproval-${randomUUID()}`,
      // Single controller: the merchant signs interactively with its own key.
      actAs: [input.party],
      synchronizerId,
      disclosedContracts,
      commands: [
        {
          ExerciseCommand: {
            // #package-name (NOT the raw Scan package-id): the participant
            // resolves the choice against its OWN installed splice-amulet, so
            // this survives Splice package upgrades and a package-id the
            // participant store lacks (TEMPLATES_OR_INTERFACES_NOT_FOUND).
            templateId: "#splice-amulet:Splice.AmuletRules:AmuletRules",
            contractId: arc.contract_id,
            choice: PREAPPROVAL_CHOICE,
            choiceArgument,
          },
        },
      ],
    });
    return {
      preparedTransaction: prepared.preparedTransaction,
      txHash: prepared.preparedTransactionHash,
      synchronizerId,
    };
  }

  /**
   * SELF-PROVIDER preapproval, step 2 (execute). Submits the merchant-signed
   * interactive prepared transaction and resolves the created preapproval's
   * updateId (polling the completion stream when /execute omits it, as it does
   * for async participants).
   */
  async executeSelfPreapproval(input: {
    party: string;
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
  }): Promise<{ updateId: string }> {
    const { client, userId } = this.deps;
    const submissionId = `self-preapproval-exec-${randomUUID()}`;
    const offset0 = (await client.getLedgerEnd()).offset;
    const r = await client.interactiveSubmissionExecute({
      preparedTransaction: input.preparedTransaction,
      hashingSchemeVersion: input.hashingSchemeVersion,
      partySignatures: input.partySignatures as unknown as Parameters<
        CantonClient["interactiveSubmissionExecute"]
      >[0]["partySignatures"],
      submissionId,
      // Required by /v2/interactive-submission/execute; no dedup for a one-shot.
      deduplicationPeriod: { Empty: {} },
    });
    // THE EXECUTE POST HAS RETURNED 200 — the submission is accepted and will
    // be sequenced. What follows only READS that outcome.
    //
    // Third copy of the same rule (see canton/transfer-factory.ts execute() and
    // the relay /v1/wallet/submit/execute route). pollCompletionUpdateId gives
    // up with INVALID_RESPONSE on ANY failure of the completion read, and that
    // escaped here as a plain throw, which the route turns into a 502: a
    // definite "your preapproval failed" for a TransferPreapproval that then
    // commits. The merchant runs the flow again and pays a second creation fee
    // for a preapproval they already have.
    //
    // SUBMISSION_FAILED keeps its meaning in all three copies: the completion
    // ARRIVED with a non-zero status, so the participant refused it and nothing
    // moved.
    let updateId = r.updateId;
    if (!updateId) {
      try {
        updateId = await client.pollCompletionUpdateId(
          userId,
          input.party,
          submissionId,
          offset0
        );
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === "SUBMISSION_FAILED") {
          throw err;
        }
        throw new SubmissionOutcomeUnknownError(err);
      }
    }
    return { updateId };
  }

  /**
   * Select the provider's own Amulet holdings to fund the preapproval fee.
   * Largest first, until they cover any realistic fee; the choice returns the
   * remainder as change. Empty holdings throw (the provider is unfunded).
   */
  private async selectFeeInputs(
    party: string
  ): Promise<Array<{ tag: "InputAmulet"; value: string }>> {
    const FEE_INPUT_TARGET_CC = 50;
    const events = await this.deps.client.queryActiveContracts({
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: "#splice-amulet:Splice.Amulet:Amulet",
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });
    const holdings = events
      .map((e) => {
        const arg = e.createArgument as
          | { amount?: { initialAmount?: string } }
          | undefined;
        return {
          cid: e.contractId,
          amount: Number(arg?.amount?.initialAmount ?? 0),
        };
      })
      .filter((h) => Boolean(h.cid) && h.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const inputs: Array<{ tag: "InputAmulet"; value: string }> = [];
    let total = 0;
    for (const h of holdings) {
      inputs.push({ tag: "InputAmulet", value: h.cid });
      total += h.amount;
      if (total >= FEE_INPUT_TARGET_CC) break;
    }
    if (inputs.length === 0) {
      throw new UnfundedFeePartyError(party);
    }
    return inputs;
  }
}

/** The fee-funding party holds no Amulet. On the SELF path that party is the
 *  MERCHANT (it pays its own preapproval fee); on the facilitator-provider path
 *  it is the facilitator. Named so routes can map it to an actionable 4xx
 *  instead of a generic 502 — the fix is always "fund `party`, then retry". */
export class UnfundedFeePartyError extends Error {
  constructor(readonly party: string) {
    super(
      `party ${party} holds no Amulet to fund the preapproval fee — ` +
        `the fee is paid from this wallet; transfer a few CC to it and retry`
    );
    this.name = "UnfundedFeePartyError";
  }
}
