/**
 * MerchantContract domain wrapper.
 *
 * Operates on our own Daml templates declared in
 * `packages/daml/daml/Canton/X402.daml`:
 *
 *   template MerchantRegistrationProposal
 *     with facilitator, merchant, asset, defaultPrice,
 *          resourcePattern, description
 *     where signatory facilitator
 *           observer  merchant
 *
 *   template MerchantContract
 *     with facilitator, merchant, asset, defaultPrice,
 *          resourcePattern, createdAt, description
 *     where signatory facilitator, merchant
 *
 * The facilitator initiates registration by creating a proposal that
 * the merchant signs out-of-band (calls `AcceptRegistration`). Once
 * accepted, the resulting `MerchantContract` is what `/verify` looks
 * up to confirm the merchant is registered with this facilitator.
 *
 * `Deactivate` requires BOTH parties as controllers and is therefore
 * a future propose-accept dance — deferred until a real merchant
 * needs to revoke. Tracked in CRON-RUNBOOK.md if/when needed.
 */

import { randomUUID } from "node:crypto";
import {
  type CantonClient,
  type CreatedEvent,
  type JsCommand,
} from "@ftptech/x402-canton-ledger";

const MERCHANT_CONTRACT_TEMPLATE_SUFFIX =
  ":Canton.X402:MerchantContract";

const REGISTRATION_PROPOSAL_TEMPLATE_ID =
  "#canton-x402:Canton.X402:MerchantRegistrationProposal";

const REGISTRATION_PROPOSAL_SUFFIX =
  ":Canton.X402:MerchantRegistrationProposal";

export interface MerchantContractPayload {
  facilitator: string;
  merchant: string;
  asset: string;
  /** Daml Decimal as a JSON string. */
  defaultPrice: string;
  resourcePattern: string;
  /** RFC3339 ISO. */
  createdAt: string;
  description: string;
}

export interface MerchantContract {
  contractId: string;
  payload: MerchantContractPayload;
}

export interface CreateRegistrationProposalInput {
  merchant: string;
  asset: string;
  defaultPrice: string;
  resourcePattern: string;
  description: string;
  synchronizerId: string;
  commandId: string;
  userId: string;
}

export interface CreateRegistrationProposalResult {
  proposalCid: string;
  updateId: string;
  offset: number;
}

export class MerchantContractService {
  constructor(
    private readonly client: CantonClient,
    private readonly facilitatorParty: string
  ) {}

  /**
   * Submit a CreateCommand for `MerchantRegistrationProposal`. The
   * facilitator is the sole signatory; the merchant is observer and
   * must subsequently exercise `AcceptRegistration` to materialize a
   * `MerchantContract` co-signed by both.
   *
   * Returns the proposal contractId so the caller can hand it back
   * to the merchant for acceptance.
   */
  async createRegistrationProposal(
    input: CreateRegistrationProposalInput
  ): Promise<CreateRegistrationProposalResult> {
    const command: JsCommand = {
      CreateCommand: {
        templateId: REGISTRATION_PROPOSAL_TEMPLATE_ID,
        createArguments: {
          facilitator: this.facilitatorParty,
          merchant: input.merchant,
          asset: input.asset,
          defaultPrice: input.defaultPrice,
          resourcePattern: input.resourcePattern,
          description: input.description,
        },
      },
    };

    const result = await this.client.submitAndWaitForTransaction({
      commandId: input.commandId,
      userId: input.userId,
      actAs: [this.facilitatorParty],
      synchronizerId: input.synchronizerId,
      commands: [command],
    });

    const created = result.events.find((e) =>
      e.templateId.endsWith(REGISTRATION_PROPOSAL_SUFFIX)
    );
    if (!created) {
      throw new Error(
        "submitAndWaitForTransaction returned no CreatedEvent for MerchantRegistrationProposal"
      );
    }
    return {
      proposalCid: created.contractId,
      updateId: result.updateId,
      offset: result.offset,
    };
  }

  /**
   * Exercise AcceptRegistration on a MerchantRegistrationProposal.
   *
   * In production the MERCHANT's Canton participant submits this.
   * This helper covers two use-cases:
   *   1. Reference/demo: the facilitator has CanActAs both parties
   *      (test setup where facilitator == merchant).
   *   2. Delegated accept: merchant authorises the facilitator to
   *      act on their behalf (grant CanActAs temporarily).
   *
   * Returns the resulting MerchantContract cid.
   */
  async acceptRegistrationProposal(input: {
    proposalCid: string;
    proposalTemplateId: string;
    merchantParty: string;
    synchronizerId: string;
    commandId?: string;
    userId: string;
  }): Promise<{ merchantContractCid: string; updateId: string }> {
    const command: JsCommand = {
      ExerciseCommand: {
        templateId: input.proposalTemplateId,
        contractId: input.proposalCid,
        choice: "AcceptRegistration",
        choiceArgument: {},
      },
    };
    const result = await this.client.submitAndWaitForTransaction({
      userId: input.userId,
      commandId: input.commandId ?? `accept-${randomUUID()}`,
      actAs: [input.merchantParty],
      synchronizerId: input.synchronizerId,
      disclosedContracts: [],
      commands: [command],
    });
    const createdEvent = result.events.find((e) =>
      e.templateId?.endsWith(MERCHANT_CONTRACT_TEMPLATE_SUFFIX)
    );
    return {
      merchantContractCid: createdEvent?.contractId ?? "",
      updateId: result.updateId,
    };
  }

  async findMerchantContract(
    merchantParty: string,
    // When the caller pins a specific MerchantContract (the client stamped
    // extra.merchantContractCid), match THAT contract id — not just any live
    // contract for (facilitator, merchant). Otherwise the pinned cid is
    // decorative and a stale/wrong cid silently resolves to a different
    // contract (audit L3). Absent → first (facilitator, merchant) match.
    contractCid?: string
  ): Promise<MerchantContract | null> {
    // Use TemplateFilter so the participant returns only MerchantContract
    // events — a WildcardFilter would return all contracts in the ACS
    // (potentially thousands on DevNet) and cause a 413 response.
    const events = await this.client.queryActiveContracts({
      filtersByParty: {
        [this.facilitatorParty]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: "#canton-x402:Canton.X402:MerchantContract",
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });
    for (const e of events) {
      if (!e.templateId.endsWith(MERCHANT_CONTRACT_TEMPLATE_SUFFIX)) continue;
      const candidate = toMerchantContract(e);
      if (
        candidate.payload.facilitator === this.facilitatorParty &&
        candidate.payload.merchant === merchantParty &&
        (contractCid === undefined || candidate.contractId === contractCid)
      ) {
        return candidate;
      }
    }
    return null;
  }
}

function toMerchantContract(e: CreatedEvent): MerchantContract {
  return {
    contractId: e.contractId,
    payload: e.createArgument as unknown as MerchantContractPayload,
  };
}
