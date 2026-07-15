import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AttributionStore } from "../db/attribution-store.js";

export type AttributionRouteServices = {
  attribution: AttributionStore | undefined;
  excludedParticipants: string[];
  excludedParties: string[];
  /** Bearer token gating the read (decision #10). GET /attribution exposes
   *  milestone-progress + per-payment counters, so it is gated behind the same
   *  operator token as the registry MUTATIONS rather than left public. Unset ->
   *  the route is DISABLED (503), fail-secure - consistent with the registry. */
  operatorToken: string | undefined;
};

/**
 * Authorize an operator for the attribution read. Fail-secure: when no operator
 * token is configured the route is DISABLED (503) rather than public, matching
 * registry-mutation behavior. When configured, require a matching
 * `Authorization: Bearer <token>` (constant-time compare). Returns true iff the
 * caller is authorized; otherwise it has already sent the error response.
 */
function authorizeOperator(
  req: FastifyRequest,
  reply: FastifyReply,
  operatorToken: string | undefined
): boolean {
  if (!operatorToken) {
    reply.status(503).send({
      error:
        "attribution read is disabled - set CANTON_X402_OPERATOR_TOKEN to enable",
    });
    return false;
  }
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  const presented = header.startsWith(prefix)
    ? header.slice(prefix.length)
    : "";
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(operatorToken, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    reply
      .status(401)
      .send({ error: "operator authorization required for attribution read" });
    return false;
  }
  return true;
}

export async function registerAttributionRoute(
  app: FastifyInstance,
  svc: AttributionRouteServices
): Promise<void> {
  app.get("/attribution", async (req, reply) => {
    if (!authorizeOperator(req, reply, svc.operatorToken)) return;
    if (!svc.attribution) {
      return reply.code(503).send({ error: "attribution not configured" });
    }
    const t = await svc.attribution.getTotals({
      excludedParticipants: svc.excludedParticipants,
      excludedParties: svc.excludedParties,
    });
    const totalBytes = (t.confirmedBytes + t.createConfirmedBytes).toString();
    return reply.code(200).send({
      total_payments: t.totalPayments,
      send_bytes_confirmed: t.confirmedBytes.toString(),
      create_bytes_confirmed: t.createConfirmedBytes.toString(),
      total_bytes_confirmed: totalBytes,
      eligible_bytes: t.eligibleBytes.toString(),
      pending_count: t.pendingCount,
      failed_count: t.failedCount,
      rejected_count: t.rejectedCount,
      no_summary_count: t.noSummaryCount,
      attempted_count: t.attemptedCount,
      create_pending_count: t.createPendingCount,
      create_failed_count: t.createFailedCount,
      as_of: new Date().toISOString(),
    });
  });
}
