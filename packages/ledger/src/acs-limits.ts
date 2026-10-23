/**
 * The participant and transaction limits a holdings read and an input
 * selection both have to respect. One source for the relay (facilitator) and
 * the wallet (agent-wallet), so the two sides cannot drift apart.
 */
import type { ActiveContractsFilter, CantonClient, CreatedEvent } from "./client.js";

/** How many contracts one bounded active-contracts read asks for: the
 *  participant's default list cap (`http-list-max-elements-limit`, 200). A node
 *  configured lower names its cap in the refusal, and
 *  CantonClient.queryActiveContractsSlice repeats the read at that cap. */
export const ACS_DEFAULT_LIST_LIMIT = 200;

/** Most Amulet inputs one prepared transaction may spend. Canton caps a
 *  transaction at 256 nodes, and measured on MainNet an Amulet input costs ~3
 *  of them (90 inputs tripped the cap). Merge batches, preapproval fee inputs
 *  and a payment chosen from a bounded read stay at or under this. */
export const MAX_TRANSFER_INPUTS_AMULET = 70;

/** Most registry-token (CIP-56) inputs one prepared transaction may spend: a
 *  registry input costs ~1 node (60 inputs = 64 nodes on MainNet). */
export const MAX_TRANSFER_INPUTS_REGISTRY = 90;

/** The participant refused to list this many contracts in one response
 *  (CantonClient maps its 413 to `ACS_LIMIT_EXCEEDED`). The party's state, not
 *  an outage: it holds more matching contracts than the node lists at once. */
export function isAcsLimitExceeded(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ACS_LIMIT_EXCEEDED";
}

/** What queryActiveContractsBounded needs from a client. The slice method is
 *  optional so a test double, or an older client, keeps the plain read. */
export type BoundedAcsClient = Pick<CantonClient, "queryActiveContracts"> &
  Partial<Pick<CantonClient, "queryActiveContractsSlice">>;

/**
 * ONE bounded active-contracts read: at most `limit` contracts, and whether
 * that is all of them.
 *
 * Use it instead of "plain read, and on its 413 a bounded one". For a party
 * known to exceed the cap that sequence fails every time before it does the
 * read that works, which costs two ledger-end lookups and a refused list on
 * every call. The bounded read is one request whatever the party holds.
 *
 * `complete` is false when the read came back full: the events are then a
 * PREFIX (the oldest contracts), never the whole set. A party with exactly
 * `limit` contracts also reads as incomplete, since a full answer cannot tell
 * the two apart. A client without `queryActiveContractsSlice` does the plain
 * read: complete, or ACS_LIMIT_EXCEEDED, as before.
 */
export async function queryActiveContractsBounded(
  client: BoundedAcsClient,
  filter: ActiveContractsFilter,
  limit: number = ACS_DEFAULT_LIST_LIMIT
): Promise<{ events: CreatedEvent[]; complete: boolean }> {
  if (client.queryActiveContractsSlice) {
    const s = await client.queryActiveContractsSlice(filter, limit);
    return { events: s.events, complete: s.complete };
  }
  return { events: await client.queryActiveContracts(filter), complete: true };
}
