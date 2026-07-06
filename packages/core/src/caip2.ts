/**
 * CAIP-2-style network identifiers for Canton.
 *
 * x402 v2 uses CAIP-2 (`<namespace>:<reference>`) for networks: `eip155:8453`
 * for Base mainnet, `solana:<genesis-hash>` for Solana, etc. Canton's
 * canonical reference is the Global Synchronizer ID. For convenience we
 * also accept the short forms `canton:devnet`, `canton:testnet`, and `canton:mainnet`.
 */
import type { CantonNetwork } from "./types.js";

export const CANTON_NAMESPACE = "canton" as const;

export const CANTON_DEVNET: CantonNetwork = "canton:devnet";
export const CANTON_TESTNET: CantonNetwork = "canton:testnet";
export const CANTON_MAINNET: CantonNetwork = "canton:mainnet";

export function buildNetworkId(synchronizerId: string): CantonNetwork {
  return `canton:${synchronizerId}` as CantonNetwork;
}

export function isCantonNetwork(value: string): value is CantonNetwork {
  return value.startsWith(`${CANTON_NAMESPACE}:`);
}

export function parseNetworkReference(network: CantonNetwork): string {
  // Validate the `canton:` prefix explicitly (defense-in-depth: the type says
  // CantonNetwork, but a runtime caller could hand us a raw string). Then take
  // EVERYTHING after the prefix — a Global Synchronizer ID like
  // `canton:global-domain::1220abc` must survive intact, so we slice on the
  // prefix length rather than split(":") which would truncate the embedded `::`.
  const prefix = `${CANTON_NAMESPACE}:`;
  if (!network.startsWith(prefix)) {
    throw new Error(
      `malformed Canton network id (missing "${prefix}" prefix): ${network}`
    );
  }
  const ref = network.slice(prefix.length);
  if (!ref) {
    throw new Error(
      `malformed Canton network id (empty reference): ${network}`
    );
  }
  return ref;
}
