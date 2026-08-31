import type { FastifyInstance } from "fastify";
import type { FacilitatorConfig } from "../config.js";
import type {
  SupportedResponse,
  CantonTransferMethod,
} from "@ftptech/x402-canton-core";

/**
 * GET /supported — advertise capability surface to the x402 ecosystem.
 * Per x402 v2 spec the `signers` map is keyed by CAIP-2 pattern (e.g.
 * `canton:*`) → list of public addresses the facilitator settles from.
 * Resource servers use this to confirm the facilitator's settle-key is
 * not the same as the payer or merchant party, mitigating attacks.
 */
export async function registerSupportedRoute(
  app: FastifyInstance,
  config: FacilitatorConfig
): Promise<void> {
  app.get("/supported", async () => {
    // transfer-factory ("V3", 1-tx meta-transaction) is the SOLE settlement
    // method the facilitator advertises. The settle path is still independently
    // gated by its master switch (config.tfEnabled) — advertisement here names
    // the only method the stack speaks.
    const transferMethods: CantonTransferMethod[] = ["transfer-factory"];
    const body: SupportedResponse = {
      kinds: [
        // x402-ENVELOPE: advertise the canonical scheme name "exact" with the
        // synchronizerId sourced here (AmuletRules.domain_id) so a 402 `extra`
        // MAY omit it. "exact" is the only scheme this facilitator settles.
        {
          x402Version: 2,
          scheme: "exact",
          network: config.network,
          extra: {
            transferMethods,
            synchronizerId: config.synchronizerId,
            // WHAT THIS FACILITATOR CAN ACTUALLY SETTLE, said out loud.
            //
            // Both of these were previously discoverable only by reading our
            // source. `carriages` names the payload forms /settle accepts: the
            // inline form — the payer-signed transaction carried in the payload,
            // which any facilitator can relay — is the only one. `instruments`
            // names the non-Amulet CIP-56 tokens this deployment is configured
            // for, which is exactly the set a 402 may quote and expect to be
            // settled; Canton Coin is implied by the scheme and never listed.
            //
            // Additive: both are new keys in an object clients already receive,
            // so a client that does not know them is unaffected.
            carriages: ["inline"],
            instruments: Object.keys(config.tokenRegistries ?? {}).map((admin) => {
              // Enrich with the full instrumentId ({admin,id}) + display symbol
              // when configured, so a merchant reads it here instead of hardcoding.
              // `admin` alone (today's shape) is kept when no identity is set.
              const ident = config.tokenInstruments?.[admin];
              return ident
                ? {
                    admin,
                    instrumentId: { admin, id: ident.id },
                    ...(ident.symbol ? { symbol: ident.symbol } : {}),
                  }
                : { admin };
            }),
          },
        },
      ],
      extensions: [],
      signers: {
        "canton:*": [config.facilitatorParty],
      },
    };
    return body;
  });
}
