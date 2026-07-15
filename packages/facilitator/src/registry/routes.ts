import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { MerchantContractService } from "../canton/merchant-contract.js";
import type { ScanClient } from "@ftptech/x402-canton-ledger";
import type { PreapprovalService } from "../canton/preapproval.js";

/**
 * Merchant registration HTTP API.
 *
 * Out-of-band channel for a Resource Server (merchant) to register
 * with this facilitator. Two endpoints:
 *
 *   POST /v1/merchants/register
 *     body: { merchant, asset, defaultPrice, resourcePattern, description }
 *     → creates MerchantRegistrationProposal on-ledger.
 *     → returns { proposalCid, updateId } — the merchant exercises
 *       AcceptRegistration on the proposal to materialize a
 *       MerchantContract co-signed by both parties.
 *
 *   GET /v1/merchants/:party
 *     → looks up the live MerchantContract for the given merchant
 *       party with this facilitator. 404 if not registered.
 */

export interface RegistryRouteServices {
  merchantContract: Pick<
    MerchantContractService,
    | "createRegistrationProposal"
    | "findMerchantContract"
    | "acceptRegistrationProposal"
  >;
  /** Read-only Scan resolve, for merchant preapproval-status detection. */
  scan: Pick<ScanClient, "resolveTransferKind">;
  /** Probe sender for the resolve (any party works; the check is on receiver). */
  facilitatorParty: string;
  synchronizerId: string;
  userId: string;
  /** Bearer token required for registry MUTATIONS. Unset → mutations
   *  disabled (503). Read-only GET is always public. (audit H3) */
  operatorToken: string | undefined;
  /** Facilitator-as-provider preapproval creation (Phase 2; CC-only). */
  preapproval: Pick<PreapprovalService, "createTransferPreapproval">;
  /** Gate for the preapproval route; OFF by default (money-path, DevNet-validate). */
  enablePreapprovalProvider: boolean;
}

interface RegisterBody {
  merchant?: unknown;
  asset?: unknown;
  defaultPrice?: unknown;
  resourcePattern?: unknown;
  description?: unknown;
}

/**
 * Authorize an operator for registry MUTATIONS (audit H3). These routes
 * make the facilitator party submit on-ledger writes, so they must never
 * be anonymous. Fail-secure: when no operator token is configured the
 * mutation is DISABLED (503) rather than open. When configured, require a
 * matching `Authorization: Bearer <token>` (constant-time compare).
 * Returns true iff the caller is authorized; otherwise it has already
 * sent the error response.
 */
function authorizeOperator(
  req: FastifyRequest,
  reply: FastifyReply,
  operatorToken: string | undefined
): boolean {
  if (!operatorToken) {
    reply.status(503).send({
      error:
        "merchant registry mutations are disabled — set CANTON_X402_OPERATOR_TOKEN to enable",
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
      .send({ error: "operator authorization required for registry mutations" });
    return false;
  }
  return true;
}

export async function registerRegistryRoutes(
  app: FastifyInstance,
  svc: RegistryRouteServices
): Promise<void> {
  app.post<{ Body: RegisterBody }>(
    "/v1/merchants/register",
    async (req, reply) => {
      if (!authorizeOperator(req, reply, svc.operatorToken)) return;
      const b = req.body ?? {};
      if (
        typeof b.merchant !== "string" ||
        typeof b.asset !== "string" ||
        typeof b.defaultPrice !== "string" ||
        typeof b.resourcePattern !== "string" ||
        typeof b.description !== "string"
      ) {
        return reply.status(400).send({
          error:
            "merchant, asset, defaultPrice, resourcePattern, description are required strings",
        });
      }

      let result: Awaited<ReturnType<typeof svc.merchantContract.createRegistrationProposal>>;
      try {
        result = await svc.merchantContract.createRegistrationProposal({
          merchant: b.merchant,
          asset: b.asset,
          defaultPrice: b.defaultPrice,
          resourcePattern: b.resourcePattern,
          description: b.description,
          synchronizerId: svc.synchronizerId,
          commandId: `register-${randomUUID()}`,
          userId: svc.userId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({
          error: "ledger unavailable — could not create registration proposal",
          detail: msg.slice(0, 200),
        });
      }

      return {
        proposalCid: result.proposalCid,
        updateId: result.updateId,
      };
    }
  );

  app.get<{ Params: { party: string } }>(
    "/v1/merchants/:party",
    async (req, reply) => {
      let found: Awaited<ReturnType<typeof svc.merchantContract.findMerchantContract>>;
      try {
        found = await svc.merchantContract.findMerchantContract(req.params.party);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({
          error: "ledger unavailable — could not look up merchant contract",
          detail: msg.slice(0, 200),
        });
      }
      if (!found) {
        return reply
          .status(404)
          .send({ error: "merchant not registered with this facilitator" });
      }
      return {
        contractId: found.contractId,
        merchant: found.payload.merchant,
        facilitator: found.payload.facilitator,
        asset: found.payload.asset,
        defaultPrice: found.payload.defaultPrice,
        resourcePattern: found.payload.resourcePattern,
        description: found.payload.description,
        createdAt: found.payload.createdAt,
      };
    }
  );

  // Preapproval status (instant-CC-settle feature, Phase 1 = detect + guide).
  // Read-only: resolves the transferKind the registry would use for a transfer
  // to this merchant. `direct` => the merchant holds a TransferPreapproval =>
  // x402 CC settles atomically; `offer` => no preapproval => payments resolve
  // two-step Pending and cannot settle in one round-trip. Public GET. Requires
  // the instrument admin (DSO) as a query param; `id` defaults to Amulet.
  app.get<{
    Params: { party: string };
    Querystring: { admin?: string; id?: string };
  }>("/v1/merchants/:party/preapproval-status", async (req, reply) => {
    const admin = req.query.admin;
    if (!admin) {
      return reply.status(400).send({
        error:
          "missing ?admin=<DSO party id> (the instrument admin); ?id defaults to Amulet",
      });
    }
    const id = req.query.id ?? "Amulet";
    const now = Date.now();
    let transferKind: string;
    try {
      transferKind = await svc.scan.resolveTransferKind({
        sender: svc.facilitatorParty,
        receiver: req.params.party,
        amount: "1.0000000000",
        admin,
        id,
        requestedAt: new Date(now).toISOString(),
        executeBefore: new Date(now + 3_600_000).toISOString(),
      });
    } catch (err) {
      // UNSUPPORTED (validator flavor) / transport — cannot determine. Report
      // unknown rather than fail; the caller can retry or check via Scan.
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(200).send({
        merchant: req.params.party,
        instrumentId: { admin, id },
        transferKind: "unknown",
        hasPreapproval: null,
        // null != "no preapproval": the check could not run. Most commonly the
        // facilitator uses the validator Scan flavor, where the registry
        // resolve is unsupported (sv flavor only); or the resolve failed.
        note: "hasPreapproval is null because the preapproval check could not run (requires the SV Scan flavor, or the resolve failed). It does NOT mean the merchant has no preapproval.",
        detail: msg.slice(0, 200),
      });
    }
    const hasPreapproval = transferKind === "direct";
    return {
      merchant: req.params.party,
      instrumentId: { admin, id },
      transferKind,
      hasPreapproval,
      ...(hasPreapproval
        ? {}
        : {
            guidance:
              "This merchant has no TransferPreapproval, so x402 Canton Coin " +
              "payments resolve to a two-step Pending transfer and will not " +
              "settle in one round-trip. Create a TransferPreapproval for the " +
              "merchant party via its Splice wallet/validator (receiver = the " +
              "merchant) to enable atomic settlement.",
          }),
    };
  });

  /**
   * POST /v1/merchants/:proposalCid/accept
   *
   * Exercises AcceptRegistration on a MerchantRegistrationProposal,
   * co-signing as the merchant to materialize a MerchantContract.
   *
   * This endpoint requires the facilitator's ledger user to have
   * CanActAs rights on the merchant party. Two legitimate uses:
   *   - Reference/demo setup where the facilitator == merchant
   *     (both parties share the same participant / user).
   *   - Delegated accept flow where the merchant explicitly grants
   *     CanActAs to the facilitator's user for acceptance only.
   *
   * In production, merchants typically exercise AcceptRegistration
   * from their own Canton wallet instead of calling this endpoint.
   *
   * Body: { merchant, proposalTemplateId }
   * Returns: { merchantContractCid, updateId }
   */
  app.post<{
    Params: { proposalCid: string };
    Body: { merchant?: unknown; proposalTemplateId?: unknown };
  }>(
    "/v1/merchants/:proposalCid/accept",
    async (req, reply) => {
      if (!authorizeOperator(req, reply, svc.operatorToken)) return;
      const { proposalCid } = req.params;
      const b = req.body ?? {};
      if (typeof b.merchant !== "string" || typeof b.proposalTemplateId !== "string") {
        return reply.status(400).send({
          error: "merchant (party id) and proposalTemplateId are required strings",
        });
      }
      try {
        const result = await svc.merchantContract.acceptRegistrationProposal({
          proposalCid,
          proposalTemplateId: b.proposalTemplateId,
          merchantParty: b.merchant,
          synchronizerId: svc.synchronizerId,
          userId: svc.userId,
        });
        return {
          merchantContractCid: result.merchantContractCid,
          updateId: result.updateId,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // PERMISSION_DENIED → facilitator user lacks CanActAs on merchant
        if (msg.includes("PERMISSION_DENIED") || msg.includes("PermissionDenied")) {
          return reply.status(403).send({
            error: "facilitator user does not have CanActAs on merchant party — merchant must accept via their own Canton wallet",
            detail: msg.slice(0, 200),
          });
        }
        return reply.status(503).send({
          error: "ledger unavailable — could not accept registration proposal",
          detail: msg.slice(0, 200),
        });
      }
    }
  );

  // POST /v1/merchants/:party/preapproval — facilitator-as-provider creates a
  // Canton-Coin TransferPreapproval for the merchant so its x402 CC payments
  // settle atomically (Phase 2; CC-only). MONEY PATH: operator-token gated AND
  // OFF by default (enablePreapprovalProvider). Requires the merchant to have
  // delegated CanActAs to the facilitator's ledger user (provider + receiver
  // are both controllers). Body: { expiresAt? } ISO-8601, default now + 90d.
  app.post<{ Params: { party: string }; Body: { expiresAt?: string } }>(
    "/v1/merchants/:party/preapproval",
    async (req, reply) => {
      if (!authorizeOperator(req, reply, svc.operatorToken)) return;
      if (!svc.enablePreapprovalProvider) {
        return reply.status(503).send({
          error:
            "preapproval-provider route is disabled — set CANTON_X402_ENABLE_PREAPPROVAL_PROVIDER=true (money-path; validate on DevNet first)",
        });
      }
      const expiresAt =
        req.body?.expiresAt ??
        new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
      try {
        const result = await svc.preapproval.createTransferPreapproval({
          merchant: req.params.party,
          expiresAt,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        req.log.warn({ err }, "createTransferPreapproval failed");
        return reply.status(503).send({
          error:
            "could not create TransferPreapproval (the merchant must have delegated CanActAs to the facilitator user; the facilitator must hold CC for the fee)",
          detail: msg.slice(0, 200),
        });
      }
    }
  );
}
