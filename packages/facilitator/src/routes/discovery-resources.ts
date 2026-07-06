import type { FastifyInstance } from "fastify";
import type { FacilitatorConfig } from "../config.js";

/**
 * GET /discovery/resources — the x402 "Bazaar" listing of payable resources and
 * their `accepts[]` payment schema. A discovery-driven agent asks the
 * facilitator what it can buy and gets back each resource URL plus the exact
 * payment-requirements to pay for it.
 *
 * Populated from `config.discoveryResources` (operator env
 * `CANTON_X402_DISCOVERY_RESOURCES`). An empty registry returns `items: []`,
 * which is a valid Bazaar and satisfies the conformance contract.
 *
 * Query params: `type` filters by resource transport type; `limit` (clamped to
 * 1..100, default 20) and `offset` paginate.
 */
export async function registerDiscoveryResourcesRoute(
  app: FastifyInstance,
  config: FacilitatorConfig
): Promise<void> {
  app.get<{ Querystring: { type?: string; limit?: number; offset?: number } }>(
    "/discovery/resources",
    async (req) => {
      const all = req.query.type
        ? config.discoveryResources.filter((r) => r.type === req.query.type)
        : config.discoveryResources;

      const rawLimit = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 20;
      const rawOffset = Number(req.query.offset ?? 0);
      const offset =
        Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

      return {
        x402Version: 2,
        items: all.slice(offset, offset + limit),
        pagination: { limit, offset, total: all.length },
      };
    }
  );
}
