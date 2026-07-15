import type { FastifyInstance } from "fastify";

/**
 * The x402-foundation conformance harness sends POST /close to ask the
 * facilitator to shut down gracefully and exit with code 0. We respond
 * first, then close.
 */
export async function registerCloseRoute(
  app: FastifyInstance,
  enabled: boolean
): Promise<void> {
  // SECURITY: /close calls process.exit(0) with NO authentication — an
  // anonymous remote kill switch. Only register it when explicitly enabled
  // (conformance harness). In production the route is absent → 404.
  if (!enabled) return;
  app.post("/close", async (_req, reply) => {
    reply.send({ ok: true });
    // Defer until after the reply has flushed.
    setImmediate(async () => {
      await app.close();
      process.exit(0);
    });
  });
}
