import type { FastifyInstance } from "fastify";
import type { ReadinessProbe } from "../readiness.js";

/**
 * GET /ready — readiness probe (can this facilitator settle right now?).
 *
 * 200 + { ready:true, checks } when every critical dependency is healthy;
 * 503 + { ready:false, checks } with a per-dependency breakdown otherwise, so an
 * operator (and the Docker HEALTHCHECK / orchestrator) sees WHICH dep is down.
 * The probe itself caches results for a short TTL, so a HEALTHCHECK/scrape storm
 * cannot turn /ready into a load source on the participant / Scan / IdP.
 *
 * INFO LEAK (closed): the wire body exposes only a GENERIC per-dep status
 * (`{ ok }`, plus `error:"unavailable"` on failure). The raw `detail` (error
 * class/message — which can carry an upstream URL, a stack-ish string, or an
 * IdP/token error) is NEVER returned to an unauthenticated /ready caller; it is
 * logged server-side via `req.log` (pino) instead, where an operator can read
 * the full diagnostics without exposing them on a public probe.
 */
export async function registerReadyRoute(
  app: FastifyInstance,
  probe: ReadinessProbe
): Promise<void> {
  app.get("/ready", async (req, reply) => {
    const report = await probe.evaluate();

    // Strip the raw per-dep `detail` from the wire: expose only a generic
    // status. `detail` may contain an upstream URL / IdP error / message that
    // an unauthenticated /ready caller must not see.
    const checks: Record<string, { ok: boolean; error?: string }> = {};
    for (const [name, r] of Object.entries(report.checks)) {
      checks[name] = r.ok ? { ok: true } : { ok: false, error: "unavailable" };
    }

    // Log the FULL diagnostics server-side (operator-visible) when not ready,
    // including each failing dep's raw detail. `cached` is logged too so an
    // operator can tell a fresh probe from a TTL-cached one.
    if (!report.ready) {
      const failing: Record<string, string | undefined> = {};
      for (const [name, r] of Object.entries(report.checks)) {
        if (!r.ok) failing[name] = r.detail;
      }
      req.log.warn(
        { readiness: { cached: report.cached, failing } },
        "readiness probe not ready"
      );
    }

    // The `cached` flag is an internal debug aid — don't leak it on the wire.
    const body = { ready: report.ready, checks };
    return reply.code(report.ready ? 200 : 503).send(body);
  });
}
