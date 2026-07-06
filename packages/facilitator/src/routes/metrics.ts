import type { FastifyInstance } from "fastify";
import type { FacilitatorMetrics } from "../metrics.js";

/**
 * GET /metrics — Prometheus exposition of the facilitator's metric registry.
 *
 * Unauthenticated by design (the standard Prometheus scrape contract); the
 * facilitator binds to 127.0.0.1 / sits behind a reverse proxy, so /metrics is
 * not publicly reachable unless an operator deliberately fronts it. The body is
 * the registry's text-format render with the registry's own content type
 * (`text/plain; version=0.0.4; charset=utf-8`).
 */
export async function registerMetricsRoute(
  app: FastifyInstance,
  metrics: FacilitatorMetrics
): Promise<void> {
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
