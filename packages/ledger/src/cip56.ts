/**
 * CIP-56 Token Standard wire helpers.
 *
 * CIP-56 (Splice Token Standard, defined in the
 * `splice-api-token-*` package family) is Canton's generic token
 * interface. Any token issuer publishes a `TransferFactory`
 * implementation and `Holding` instances; transfers move through
 * the `TransferFactory_Transfer` choice (sender-controlled) and
 * either complete synchronously
 * (`TransferInstructionResult_Completed`) or yield a
 * `TransferInstruction` contract the registry advances
 * asynchronously.
 *
 * For x402 the flow is:
 *
 *   1. Client (sender) exercises `TransferFactory_Transfer` on
 *      the factory cid the merchant advertised in
 *      `extra.transferFactoryCid`. Result is one of:
 *        - `_Completed { receiverHoldingCids }` — tokens already
 *          moved; settlement is on-ledger as of this updateId.
 *        - `_Pending { transferInstructionCid }` — registry needs
 *          additional steps (e.g. receiver acceptance,
 *          registry-internal workflow).
 *   2. Client sends the resulting `updateId` (completed case) or
 *      `transferInstructionCid` (pending case) to the facilitator.
 *   3. Facilitator `/verify` reads either the transaction (by
 *      updateId) or the TransferInstruction (by cid) and validates
 *      sender / receiver / amount / instrumentId / executeBefore.
 *   4. Facilitator `/settle` is a no-op for completed transfers;
 *      for pending it waits for/observes the resolution.
 *
 * This module exposes:
 *   - `CIP56_INTERFACE_IDS` — the well-known package hashes for
 *     the Splice Token Standard v1 interfaces (template ids on
 *     the wire reference these).
 *   - `TransferInstructionStatus` enum the registry uses.
 *   - `TransferFactoryTransferArgs` choice-argument shape.
 *   - Helpers `findTransferInstruction(client, cid)` and
 *     `exerciseTransferFactoryTransfer(...)`.
 *
 * Verified shapes against
 * `splice-api-token-transfer-instruction-v1` 1.0.0 (package id
 * 55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281)
 * which ships in cn-quickstart Splice 0.5.3.
 */

import type { CantonClient, CreatedEvent } from "./client.js";

/** Package hashes for the Splice Token Standard v1 DARs shipped
 *  with Splice 0.5.3+. These are stable for the v1 wire format and
 *  appear as the package-id prefix on every CIP-56 contract's
 *  templateId. */
export const CIP56_INTERFACE_IDS = {
  transferInstructionV1:
    "55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281",
  holdingV1:
    "718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b",
} as const;

/** Template id suffixes for CIP-56 entities. The package-id prefix
 *  is the issuer's specific implementation, NOT the interface
 *  package, so we always match by suffix. */
export const CIP56_TEMPLATE_SUFFIXES = {
  transferInstruction:
    ":Splice.Api.Token.TransferInstructionV1:TransferInstruction",
  transferFactory:
    ":Splice.Api.Token.TransferInstructionV1:TransferFactory",
  holding: ":Splice.Api.Token.HoldingV1:Holding",
} as const;

/** Choice names on the CIP-56 interfaces. */
export const CIP56_CHOICES = {
  transferFactoryTransfer: "TransferFactory_Transfer",
  transferInstructionAccept: "TransferInstruction_Accept",
  transferInstructionReject: "TransferInstruction_Reject",
  transferInstructionWithdraw: "TransferInstruction_Withdraw",
  transferInstructionUpdate: "TransferInstruction_Update",
} as const;

/** `data InstrumentId = InstrumentId with admin : Party; id : Text`
 *  from `Splice.Api.Token.MetadataV1`. */
export interface InstrumentId {
  admin: string;
  id: string;
}

/** `Metadata = with values : Map Text Text` from
 *  `Splice.Api.Token.MetadataV1`. Verified live against
 *  cn-quickstart Splice 0.5.3: Canton's JSON Ledger API v2 wants
 *  `Map Text Text` encoded as a JSON OBJECT `{k: v}`, NOT as the
 *  array-of-pairs form used by `Map k v` with non-string keys.
 *  The Splice serializer emits the object form even though the
 *  general JSON Ledger API v2 docs describe the array form. */
export type Cip56Metadata = { values: Record<string, string> };

/** `data Transfer` from
 *  `Splice.Api.Token.TransferInstructionV1` — choice arg
 *  for `TransferFactory_Transfer.transfer`. */
export interface Cip56Transfer {
  sender: string;
  receiver: string;
  /** Decimal as JSON string (matches JSON Ledger API v2). */
  amount: string;
  instrumentId: InstrumentId;
  /** ISO RFC3339. Must be in the past at submit time. */
  requestedAt: string;
  /** ISO RFC3339. Must be in the future at submit time. */
  executeBefore: string;
  /** Contract ids of `Holding`s the registry should draw from. May
   *  be empty if the registry auto-selects (Amulet does). */
  inputHoldingCids: string[];
  /** See `Cip56Metadata`. */
  meta: Cip56Metadata;
}

/** Choice argument for `TransferFactory_Transfer`. */
export interface TransferFactoryTransferArgs {
  /** The factory's `admin` party. Implementations MUST reject if
   *  this doesn't match the factory contract's own admin field —
   *  defends against bait factories from untrusted sources. */
  expectedAdmin: string;
  transfer: Cip56Transfer;
  /** Token-specific extra context. Shape depends on the
   *  implementation; for the splice-token-test-dummy-holding it's
   *  `{context: Metadata, meta: Metadata}` (empty objects are
   *  accepted). */
  extraArgs: {
    context: Cip56Metadata;
    meta: Cip56Metadata;
  };
}

/** Status of a TransferInstruction per the CIP-56 view. Surfaced
 *  to clients so they can decide whether to wait, accept, or
 *  withdraw. */
export type Cip56TransferInstructionStatus =
  | { tag: "TransferPendingReceiverAcceptance" }
  | {
      tag: "TransferPendingInternalWorkflow";
      pendingActions: Record<string, string>; // party → action
    };

/** Payload subset of a `TransferInstructionView`. The actual
 *  on-ledger contract is the implementation type (Amulet's,
 *  DummyHolding's, ...) but every implementation MUST expose this
 *  view shape per the interface. */
export interface Cip56TransferInstruction {
  contractId: string;
  templateId: string; // implementation-specific package + module
  transfer: Cip56Transfer;
  status: Cip56TransferInstructionStatus;
}

/**
 * Locate a TransferInstruction the facilitator can see (it should
 * be observer because the client included it as a stakeholder in
 * the original Transfer.meta).
 *
 * Returns null if not visible / archived (race-safe — settle then
 * surfaces this as the right error code).
 */
export async function findCip56TransferInstruction(
  client: CantonClient,
  facilitatorParty: string,
  cid: string
): Promise<Cip56TransferInstruction | null> {
  // Use InterfaceFilter scoped to the TransferInstructionV1 interface
  // rather than WildcardFilter. On DevNet (and any busy network) the
  // WildcardFilter returns all contracts visible to the party — 200+
  // on FTP-validator-1 — which hits Canton's /v2/state/active-contracts
  // element limit (HTTP 413 = JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED).
  // InterfaceFilter returns only TransferInstruction contracts, which
  // are O(open payments) not O(total contracts).
  const interfaceId = `${CIP56_INTERFACE_IDS.transferInstructionV1}:Splice.Api.Token.TransferInstructionV1:TransferInstruction`;
  const events = await client.queryActiveContracts({
    filtersByParty: {
      [facilitatorParty]: {
        cumulative: [
          {
            identifierFilter: {
              InterfaceFilter: {
                value: {
                  interfaceId,
                  includeInterfaceView: false,
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
    if (e.contractId !== cid) continue;
    // Defence-in-depth: InterfaceFilter asks only for TransferInstruction
    // contracts, but verify the templateId suffix in case the ledger
    // returns a stale / mis-routed entry.
    if (!e.templateId.endsWith(CIP56_TEMPLATE_SUFFIXES.transferInstruction)) {
      continue;
    }
    return projectToCip56(e);
  }
  return null;
}

/** Project a raw `CreatedEvent` for a TransferInstruction to the
 *  view shape clients care about. Tolerates both the Canton 3.4
 *  JSON-object form for `Map Text Text` and the legacy
 *  array-of-pairs form. */
export function projectToCip56(
  event: CreatedEvent
): Cip56TransferInstruction {
  const arg = event.createArgument as {
    transfer?: {
      sender?: string;
      receiver?: string;
      amount?: string;
      instrumentId?: InstrumentId;
      requestedAt?: string;
      executeBefore?: string;
      inputHoldingCids?: string[];
      meta?: {
        values?: Record<string, string> | Array<[string, string]>;
      };
    };
    status?: {
      tag?: string;
      pendingActions?: Record<string, string> | Array<[string, string]>;
    };
  };
  const tr = arg.transfer ?? {};
  const status = arg.status ?? { tag: "TransferPendingInternalWorkflow" };
  return {
    contractId: event.contractId,
    templateId: event.templateId,
    transfer: {
      sender: tr.sender ?? "",
      receiver: tr.receiver ?? "",
      amount: tr.amount ?? "",
      instrumentId: tr.instrumentId ?? { admin: "", id: "" },
      requestedAt: tr.requestedAt ?? "",
      executeBefore: tr.executeBefore ?? "",
      inputHoldingCids: tr.inputHoldingCids ?? [],
      meta: { values: normalizeDamlMap(tr.meta?.values) },
    },
    status:
      status.tag === "TransferPendingReceiverAcceptance"
        ? { tag: "TransferPendingReceiverAcceptance" }
        : {
            tag: "TransferPendingInternalWorkflow",
            pendingActions: normalizeDamlMap(status.pendingActions),
          },
  };
}

/** Coerce `Map Text Text` from either wire form to a plain object. */
function normalizeDamlMap(
  raw: Record<string, string> | Array<[string, string]> | undefined
): Record<string, string> {
  if (!raw) return {};
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return raw;
}

// Note: a previous `exerciseTransferFactoryTransferCommand` helper
// was removed (2026-05-24) — the only consumer
// (`Cip56KeyfileSigner`) inlines the JsCommand and the two were
// drifting. Re-introduce if a second consumer appears.
