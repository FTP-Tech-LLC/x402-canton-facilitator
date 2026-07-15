/**
 * Agent-wallet RELAY routes (Phase 1 of the canton-x402-agent skill).
 *
 * An agent self-custodies its own Ed25519 key but has no Canton account, so it
 * cannot call the participant's authed JSON Ledger API directly. These endpoints
 * are a thin bridge: the agent talks plain HTTP to the facilitator, and the
 * facilitator forwards onboarding + interactive submission to the participant
 * using the validator's token. The agent's signature authorizes every action —
 * the relay never holds the key and cannot move the agent's funds.
 *
 * Gated by `enableAgentWallet` (off by default). Optional `X-Agent-Key` header
 * check (anti-abuse) when `agentWalletApiKey` is set. See
 * docs/design/agent-wallet-skill.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  CantonClient,
  DisclosedContract,
  InteractivePrepareBody,
  InteractiveExecuteBody,
} from "@ftptech/x402-canton-ledger";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createSlidingWindowLimiter } from "../rate-limit.js";
import { FaucetService } from "../canton/faucet.js";
import { UnfundedFeePartyError } from "../canton/preapproval.js";
import type { FaucetClaimStore } from "../db/faucet-store.js";
import type { TfStashStore } from "../db/stash-store.js";

/** Constant-time string equality (length-checked first, then timingSafeEqual on
 *  equal-length buffers). Mirrors the attribution/registry token checks. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface WalletRelayServices {
  /** SELF-PROVIDER preapproval (the merchant provisions its OWN
   *  TransferPreapproval — single controller, no facilitator CanActAs). When
   *  undefined the self-preapproval routes 503. Same instance as `preapproval`. */
  selfPreapproval?:
    | {
        prepareSelfPreapproval(input: {
          party: string;
          expiresAt: string;
        }): Promise<{
          preparedTransaction: string;
          txHash: string;
          synchronizerId: string;
        }>;
        executeSelfPreapproval(input: {
          party: string;
          preparedTransaction: string;
          hashingSchemeVersion:
            | "HASHING_SCHEME_VERSION_V1"
            | "HASHING_SCHEME_VERSION_V2";
          partySignatures: {
            signatures: Array<{
              party: string;
              signatures: Array<Record<string, unknown>>;
            }>;
          };
        }): Promise<{ updateId: string }>;
      }
    | undefined;
  client: Pick<
    CantonClient,
    | "generateExternalPartyTopology"
    | "allocateExternalParty"
    | "interactiveSubmissionPrepare"
    | "interactiveSubmissionExecute"
    | "queryActiveContracts"
    | "grantUserRights"
    | "getLedgerEnd"
    | "pollCompletionUpdateId"
    // transfer-command cid resolve by the create's updateId — O(1), immune to
    // the ACS maximum-list-elements cap that the (sender, nonce) poll hits
    // once a payer accumulates enough unspent TransferCommands.
    | "getTransactionById"
    // faucet: the facilitator submits its OWN TransferFactory_Transfer to seed an
    // agent party (actAs:[facilitator]) — same submit path as settle/preapproval.
    | "submitAndWaitForTransaction"
  >;
  synchronizerId: string;
  /** Relay's ledger user (validator m2m). Granted CanActAs on each onboarded
   * agent party so the relay can PREPARE (never sign) for it. */
  userId: string;
  /** SV Scan base URL; the relay proxies registry resolves (factory/accept). */
  scanUrl: string;
  /** Alternate SV Scan bases the raw-fetch resolves fail over to after a
   *  transient 5xx/429 on the primary (see FacilitatorConfig.scanFallbackUrls).
   *  OPTIONAL — absent/empty means no failover (tests, default). */
  scanFallbackUrls?: string[];
  /**
   * The facilitator's OWN party id — the faucet submits its
   * TransferFactory_Transfer as this party (actAs:[facilitator]). OPTIONAL so
   * relay tests that exercise only the onboard/submit paths can omit it; the
   * faucet route stays disabled (503) when it is absent.
   */
  facilitatorParty?: string;
  /** Off by default; turns the whole /v1/wallet/* surface on. */
  enableAgentWallet: boolean;
  /** When set, every /v1/wallet/* call must carry `X-Agent-Key: <value>`. */
  agentWalletApiKey?: string | undefined;
  /** Agent CC faucet. undefined → POST /v1/wallet/faucet/claim returns 503
   *  (disabled). When set (and `facilitatorParty` is present), the route seeds an
   *  agent party with `amountCc` from the facilitator's OWN holdings, bounded by
   *  the ATOMIC `store.tryClaim` guard (per-party-once + rolling daily payout
   *  budget over `windowMs` + all-time `lifetimeCapCc`, durable + fail-closed)
   *  plus an in-process per-IP cap. See canton/faucet.ts + db/faucet-store.ts. */
  faucet?:
    | {
        store: FaucetClaimStore;
        amountCc: string;
        maxPerIp: number;
        dailyBudgetCc: string;
        /** All-time payout ceiling (CC). "0" disables. Enforced atomically with
         *  the party-once + daily-budget checks in `store.tryClaim`. */
        lifetimeCapCc: string;
        windowMs: number;
        /** When set, the faucet route requires header `X-Faucet-Secret: <value>`
         *  (constant-time compare) and 403s otherwise. This locks the raw faucet
         *  to trusted internal callers (the pay-proxy, which sets the header) so
         *  the public internet cannot curl it directly — the ONLY way to trigger
         *  a grant becomes the quest flow. Independent of `agentWalletApiKey`
         *  (which would gate the public self-custody onboard routes too, so it is
         *  left unset in prod). Unset here → no faucet-secret gate (dev/back-compat). */
        internalSecret?: string | undefined;
        /** Global burst cap: max claims per `burstWindowMs` across all non-exempt
         *  callers (IP-independent). `0`/undefined disables it. */
        maxGlobalPerMin?: number | undefined;
        /** Window (ms) for the global burst cap. Default 60000. */
        burstWindowMs?: number | undefined;
        /** IPs exempt from the per-IP + global-burst caps (trusted internal
         *  callers, e.g. the pay-proxy). per-party-once + budget still apply. */
        ipExempt?: readonly string[] | undefined;
      }
    | undefined;
  /** transfer-factory ("V3") relay-pay surface. undefined → POST
   *  /v1/wallet/pay/{prepare,commit} return 503 (disabled). The relay BUILDS
   *  the TransferFactory_Transfer itself (sender = the agent party),
   *  interactive-PREPAREs it, and stashes the prepared bytes + the transfer
   *  fields it recorded AT BUILD TIME; `pay/commit` attaches the payer's
   *  signing bundle. /verify + /settle later read the stash by submissionRef —
   *  the X-PAYMENT header carries only that small ref because a prepared tx +
   *  disclosed contracts is hundreds of KB. */
  tfPay?:
    | {
        stash: TfStashStore;
        /** Max live (unsettled, unexpired) stash rows per payer. */
        capPerPayer: number;
        /** executeBefore horizon when the client does not request one. */
        defaultExecuteBeforeSeconds: number;
        /** Hard ceiling on a client-requested executeBefore horizon. */
        maxExecuteBeforeSeconds: number;
      }
    | undefined;
}

const AMULET_RE = /:Splice\.Amulet:Amulet$/;

/**
 * Canton party-id shape: `<hint>::<fingerprint>` where the fingerprint is a hex
 * key hash (≥8 hex chars in practice; real ones are 60+). The faucet's recipient
 * becomes an on-ledger `receiver` party, so we reject anything that does not
 * match BEFORE any store/ledger work — garbage must never reach the ledger
 * submit (it would burn a doomed Scan/submit round-trip and the GS traffic fee).
 * Intentionally narrow (alnum + `:_-` hint, lowercase-hex fingerprint).
 */
const FAUCET_PARTY_RE = /^[A-Za-z0-9:_-]+::[0-9a-f]{8,}$/;

export async function registerWalletRoutes(
  app: FastifyInstance,
  svc: WalletRelayServices
): Promise<void> {
  if (!svc.enableAgentWallet) return; // routes simply do not exist when off

  // Shared API-key gate. Returns true if the request may proceed.
  const authed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!svc.agentWalletApiKey) return true;
    if (req.headers["x-agent-key"] === svc.agentWalletApiKey) return true;
    reply.code(401).send({ error: "missing or invalid X-Agent-Key" });
    return false;
  };

  const relayError = (reply: FastifyReply, where: string, err: unknown) => {
    let detail = err instanceof Error ? err.message : String(err);
    // Surface the upstream Canton error code/cause (e.g. TOO_MANY_USER_RIGHTS)
    // instead of a bare "HTTP 400": the participant body carries the real reason,
    // and hiding it costs real debugging time.
    const body = (err as { responseBody?: unknown }).responseBody;
    if (typeof body === "string" && body) {
      try {
        const j = JSON.parse(body) as { code?: unknown; cause?: unknown };
        const code = typeof j.code === "string" ? j.code : undefined;
        const cause = typeof j.cause === "string" ? j.cause : undefined;
        if (code || cause) detail += ` [${code ?? "?"}${cause ? ": " + cause : ""}]`;
        else detail += ` [body: ${body.slice(0, 500)}]`;
      } catch {
        detail += ` [body: ${body.slice(0, 500)}]`;
      }
    }
    // Full error (incl. CantonError responseBody/code/cause via the custom pino
    // serializer) to the server log — invaluable for money-path debugging.
    reply.log.error({ err, where }, `wallet relay ${where} failed`);
    reply.code(502).send({ error: `wallet relay ${where} failed`, detail });
  };

  // ── SELF-PROVIDER preapproval: prepare (relay builds+prepares) ──
  // The merchant provisions its OWN TransferPreapproval so its incoming
  // transfer-factory payments settle direct. Single controller (the merchant),
  // so no facilitator CanActAs delegation is required. Two-step interactive:
  // /prepare returns a prepared tx the merchant signs with its OWN key, then
  // /commit executes it.
  app.post<{ Body: { party?: string; expiresAt?: string } }>(
    "/v1/wallet/preapproval/self/prepare",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      if (!svc.selfPreapproval) {
        return reply.code(503).send({ error: "self-preapproval disabled" });
      }
      const party = req.body?.party?.trim();
      if (!party || !FAUCET_PARTY_RE.test(party)) {
        return reply.code(400).send({ error: "party required/malformed" });
      }
      const expiresAt =
        req.body?.expiresAt?.trim() ||
        new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
      try {
        const p = await svc.selfPreapproval.prepareSelfPreapproval({
          party,
          expiresAt,
        });
        return reply.send({ ...p, party, expiresAt });
      } catch (err) {
        // An unfunded merchant is a caller-fixable state, not a relay fault:
        // 409 + the party that must be funded, so integrators don't read it as
        // a facilitator outage (live report: a reviewer did exactly that).
        if (err instanceof UnfundedFeePartyError) {
          return reply
            .code(409)
            .send({ error: "merchant_unfunded", party: err.party, detail: err.message });
        }
        return relayError(reply, "preapproval/self/prepare", err);
      }
    }
  );

  // ── SELF-PROVIDER preapproval: commit (merchant-signed execute) ──
  app.post<{
    Body: {
      party?: string;
      preparedTransaction?: string;
      hashingSchemeVersion?: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
      partySignatures?: {
        signatures: Array<{
          party: string;
          signatures: Array<Record<string, unknown>>;
        }>;
      };
    };
  }>("/v1/wallet/preapproval/self/commit", async (req, reply) => {
    if (!authed(req, reply)) return;
    if (!svc.selfPreapproval) {
      return reply.code(503).send({ error: "self-preapproval disabled" });
    }
    const party = req.body?.party?.trim();
    const preparedTransaction = req.body?.preparedTransaction;
    const partySignatures = req.body?.partySignatures;
    if (!party || !preparedTransaction || !partySignatures) {
      return reply
        .code(400)
        .send({ error: "party, preparedTransaction, partySignatures required" });
    }
    try {
      const r = await svc.selfPreapproval.executeSelfPreapproval({
        party,
        preparedTransaction,
        hashingSchemeVersion:
          req.body?.hashingSchemeVersion ?? "HASHING_SCHEME_VERSION_V2",
        partySignatures,
      });
      return reply.send(r);
    } catch (err) {
      return relayError(reply, "preapproval/self/commit", err);
    }
  });

  // ── Onboard: generate the topology for a new external party ──
  app.post<{
    Body: {
      publicKey: { format: string; keyData: string; keySpec: string };
      partyHint: string;
    };
  }>("/v1/wallet/onboard/prepare", async (req, reply) => {
    if (!authed(req, reply)) return;
    const { publicKey, partyHint } = req.body ?? ({} as never);
    if (!publicKey?.keyData || !partyHint) {
      return reply.code(400).send({ error: "publicKey and partyHint required" });
    }
    try {
      const r = await svc.client.generateExternalPartyTopology({
        synchronizer: svc.synchronizerId,
        partyHint,
        publicKey,
        localParticipantObservationOnly: false,
        confirmationThreshold: 0,
      });
      return reply.send({
        party: r.partyId,
        publicKeyFingerprint: r.publicKeyFingerprint,
        onboardingTransactions: r.topologyTransactions,
        hashToSign: r.multiHash,
      });
    } catch (err) {
      return relayError(reply, "onboard/prepare", err);
    }
  });

  // ── Onboard: finalize with the agent's multiHash signature ──
  app.post<{
    Body: {
      onboardingTransactions: string[];
      multiHashSignatures: Array<{
        format: string;
        signature: string;
        signingAlgorithmSpec: string;
        signedBy: string;
      }>;
    };
  }>("/v1/wallet/onboard/finalize", async (req, reply) => {
    if (!authed(req, reply)) return;
    const { onboardingTransactions, multiHashSignatures } =
      req.body ?? ({} as never);
    if (!onboardingTransactions?.length || !multiHashSignatures?.length) {
      return reply
        .code(400)
        .send({ error: "onboardingTransactions and multiHashSignatures required" });
    }
    try {
      const r = await svc.client.allocateExternalParty({
        synchronizer: svc.synchronizerId,
        identityProviderId: "",
        onboardingTransactions: onboardingTransactions.map((t) => ({
          transaction: t,
        })),
        multiHashSignatures,
      });
      // Let the relay user PREPARE interactive submissions for this external
      // party. Execute still needs the agent's own signature, so this is NOT
      // custody (standard CIP-0103 hosting; m2m user has ParticipantAdmin).
      // Best-effort: the relay user has ParticipantAdmin and can PREPARE
      // interactive submissions for this external party WITHOUT a per-party
      // CanActAs grant (existing agents already pay via that path). Newer Canton
      // rejects a CanActAs grant on an EXTERNAL party (HTTP 400); that must NOT
      // abort onboarding, since the party is already allocated and usable.
      try {
        await svc.client.grantUserRights(svc.userId, r.partyId);
      } catch (grantErr) {
        req.log.warn(
          { err: grantErr, party: r.partyId },
          "onboard/finalize: grantUserRights failed (non-fatal; relay user has ParticipantAdmin)"
        );
      }
      return reply.send({ party: r.partyId });
    } catch (err) {
      return relayError(reply, "onboard/finalize", err);
    }
  });

  // ── Submit: prepare an interactive submission (agent will sign the hash) ──
  app.post<{ Body: InteractivePrepareBody }>(
    "/v1/wallet/submit/prepare",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const body = req.body;
      if (!body?.commands?.length || !body?.actAs?.length) {
        return reply.code(400).send({ error: "commands and actAs required" });
      }
      try {
        const r = await svc.client.interactiveSubmissionPrepare({
          ...body,
          // The agent cannot know the participant user; the relay acts as the
          // hosting user (which holds CanActAs on the agent party).
          userId: svc.userId,
          synchronizerId: body.synchronizerId || svc.synchronizerId,
          packageIdSelectionPreference: body.packageIdSelectionPreference ?? [],
          verboseHashing: body.verboseHashing ?? false,
        });
        return reply.send({
          preparedTransaction: r.preparedTransaction,
          hash: r.preparedTransactionHash,
        });
      } catch (err) {
        return relayError(reply, "submit/prepare", err);
      }
    }
  );

  // ── Submit: execute with the agent's party signature ──
  app.post<{ Body: InteractiveExecuteBody }>(
    "/v1/wallet/submit/execute",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const body = req.body;
      if (!body?.preparedTransaction) {
        return reply.code(400).send({ error: "preparedTransaction required" });
      }
      try {
        const submissionId = body.submissionId || randomUUID();
        const offset0 = (await svc.client.getLedgerEnd()).offset;
        const r = await svc.client.interactiveSubmissionExecute({ ...body, submissionId });
        let updateId = r.updateId;
        if (!updateId) {
          const party = body.partySignatures?.signatures?.[0]?.party;
          if (party) {
            updateId = await svc.client.pollCompletionUpdateId(
              svc.userId,
              party,
              submissionId,
              offset0
            );
          }
        }
        return reply.send({ updateId });
      } catch (err) {
        return relayError(reply, "submit/execute", err);
      }
    }
  );

  // ── Balance: sum the party's Amulet (CC) holdings ──
  app.get<{ Params: { party: string } }>(
    "/v1/wallet/:party/balance",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const party = req.params.party;
      try {
        // Scope to the Amulet TEMPLATE — NOT a WildcardFilter. The loop below
        // only counts `Splice.Amulet:Amulet` contracts anyway, but a wildcard
        // pulls the party's WHOLE ACS first, so a party with >200 total
        // contracts trips Canton's /v2/state/active-contracts element cap
        // (JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED) and this route 502s —
        // breaking `claim` (final balance display) AND `pay` (tx.ts selects
        // inputHoldingCids from these holdings). Same class as the /pending fix.
        const events = await svc.client.queryActiveContracts({
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: {
                        templateId: "#splice-amulet:Splice.Amulet:Amulet",
                        includeCreatedEventBlob: false,
                      },
                    },
                  },
                },
              ],
            },
          },
        });
        let amulet = 0;
        let cc = 0;
        const holdings: Array<{ cid: string; amount: string }> = [];
        for (const e of events) {
          if (AMULET_RE.test(e.templateId ?? "")) {
            amulet++;
            const amt = (e.createArgument as { amount?: { initialAmount?: string } })
              ?.amount?.initialAmount;
            if (amt) {
              cc += Number(amt);
              holdings.push({ cid: e.contractId, amount: amt });
            }
          }
        }
        return reply.send({ party, amulet, cc: cc.toFixed(10), holdings });
      } catch (err) {
        // The element cap bounds RESULT size, so a party holding more amulets
        // than the participant's JSON-API limit cannot be enumerated through
        // /v2/state/active-contracts even with the template-scoped filter
        // above. That is a per-party state problem (merge holdings / raise the
        // node limit), not a relay outage — surface a distinct 413 the caller
        // can branch on instead of a generic 502.
        if ((err as { code?: unknown }).code === "ACS_LIMIT_EXCEEDED") {
          return reply.code(413).send({
            error: "wallet relay balance failed",
            code: "holdings_exceed_node_limit",
            party,
            detail:
              "this party holds more amulet contracts than the participant's " +
              "JSON-API element cap allows in one active-contracts response; " +
              "merge/consolidate holdings, or ask the relay operator to raise " +
              "the participant's element limit. " +
              (err instanceof Error ? err.message : String(err)),
          });
        }
        return relayError(reply, "balance", err);
      }
    }
  );

  // ── Scan registry proxy (the agent has no Scan access) ──
  // These raw-fetch registry/DSO resolves bypass ScanClient, so they carry
  // their OWN bounded retry + SV failover. The public SV Scan sheds load with
  // transient 503s; without this a single upstream 503 surfaced as a relay 502
  // and failed the agent's onboard/claim (dev-reported). All are idempotent
  // reads, so retry + failover are safe. `base + path` per attempt; a real
  // non-2xx (404/400) is returned immediately for the caller to handle.
  const scanBases = (): string[] =>
    [
      svc.scanUrl.replace(/\/$/, ""),
      ...(svc.scanFallbackUrls ?? []).map((u) => u.replace(/\/$/, "")),
    ].filter((u, i, a) => u && a.indexOf(u) === i);
  const scanFetchRetry = async (
    path: string,
    init: RequestInit
  ): Promise<Response> => {
    let lastErr: unknown;
    let lastRes: Response | undefined;
    for (const base of scanBases()) {
      for (let attempt = 0; ; attempt++) {
        let res: Response | undefined;
        try {
          res = await fetch(`${base}${path}`, init);
        } catch (err) {
          lastErr = err; // network/transport fault — transient
        }
        if (res?.ok) return res;
        const transient = !res || res.status === 429 || res.status >= 500;
        if (res) lastRes = res;
        if (transient && attempt < 3) {
          await new Promise((r) =>
            setTimeout(r, 400 * 2 ** attempt + Math.floor(Math.random() * 150))
          );
          continue;
        }
        if (!transient && res) return res; // real non-2xx → caller decides
        break; // transient exhausted on this base → next SV (if any)
      }
    }
    if (lastRes) return lastRes; // let the caller's !r.ok throw the upstream status
    throw lastErr ?? new Error("scan fetch failed");
  };
  let dsoCache: string | undefined;
  const getDso = async (): Promise<string> => {
    if (dsoCache) return dsoCache;
    const r = await scanFetchRetry("/api/scan/v0/dso-party-id", {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`dso-party-id HTTP ${r.status}`);
    dsoCache = ((await r.json()) as { dso_party_id: string }).dso_party_id;
    return dsoCache;
  };

  // ── SV Scan ACS-snapshot holdings enumeration (whale-wallet path) ──
  // The participant's /v2/state/active-contracts caps result size, so a party
  // holding more amulets than that cap cannot be enumerated through the ledger at
  // all (balance → 413 holdings_exceed_node_limit). The PUBLIC SV Scan serves the
  // same holdings from a paginated ACS snapshot with NO node cap, so the merge
  // path reads them from there instead. All reads go through scanFetchRetry (multi
  // -SV failover); paths carry the FULL `/api/scan/v0/...` prefix (scanFetchRetry
  // composes `${base}${path}` and the base has no /api/scan suffix — same as the
  // registry/DSO resolves above).

  // Discover the CURRENT migration id. Older migrations keep serving STALE
  // snapshots forever, so "the first migration that answers" is wrong — we probe
  // a descending range, keep every migration that returns a snapshot, and pick the
  // one with the LATEST record_time (that is the live migration). Cached in-process
  // for MIGRATION_ID_TTL_MS (the migration id changes at most a few times a year).
  const MIGRATION_ID_PROBE_MAX = 9; // probe 9..0 descending
  const MIGRATION_ID_TTL_MS = 3_600_000; // ~1h
  let migrationIdCache: { migrationId: number; recordTime: string; at: number } | undefined;
  const snapshotBefore = (): string => new Date().toISOString();
  /** Read the snapshot record_time for a specific migration id, or null when that
   *  migration has no snapshot before `before` (non-2xx after the bounded retries). */
  const snapshotTimestampFor = async (
    migrationId: number,
    before: string
  ): Promise<string | null> => {
    const r = await scanFetchRetry(
      `/api/scan/v0/state/acs/snapshot-timestamp?before=${encodeURIComponent(before)}` +
        `&migration_id=${migrationId}`,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { record_time?: string };
    return typeof j.record_time === "string" ? j.record_time : null;
  };
  /** The live migration id + its snapshot record_time, cached ~1h. Picks the
   *  probed migration with the LATEST record_time (not merely the first present). */
  const discoverMigration = async (): Promise<{
    migrationId: number;
    recordTime: string;
  }> => {
    const now = Date.now();
    if (migrationIdCache && now - migrationIdCache.at < MIGRATION_ID_TTL_MS) {
      return {
        migrationId: migrationIdCache.migrationId,
        recordTime: migrationIdCache.recordTime,
      };
    }
    const before = snapshotBefore();
    let best: { migrationId: number; recordTime: string } | undefined;
    for (let mid = MIGRATION_ID_PROBE_MAX; mid >= 0; mid--) {
      const recordTime = await snapshotTimestampFor(mid, before);
      if (recordTime === null) continue;
      // Latest record_time wins — string compare is correct for ISO-8601 UTC.
      if (!best || recordTime > best.recordTime) best = { migrationId: mid, recordTime };
    }
    if (!best) throw new Error("no SV Scan ACS snapshot found for any migration id");
    migrationIdCache = { ...best, at: now };
    return best;
  };

  // ── Balance via the SV Scan ACS snapshot (paginated, no node cap) ──
  //   Whale path for `canton-agent-wallet merge`: enumerate a party's Amulet
  //   holdings from the PUBLIC snapshot when /balance 413s. The snapshot LAGS by
  //   hours; that is fine for merge (an idle wallet's amulets don't move and each
  //   cid is consumed at most once), so `recordTime` is surfaced for callers.
  const HOLDINGS_SCAN_PAGE_SIZE = 500;
  const HOLDINGS_SCAN_MAX_PAGES = 40; // bound the work: 40 * 500 = 20k amulets
  app.get<{ Params: { party: string } }>(
    "/v1/wallet/:party/holdings-scan",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const party = req.params.party;
      try {
        const { migrationId, recordTime } = await discoverMigration();
        const holdings: Array<{ cid: string; amount: string }> = [];
        // `after` is the cursor: absent on the first request, then the previous
        // page's next_page_token. The last page omits/nulls next_page_token.
        let after: number | undefined;
        let pages = 0;
        let more = false;
        for (; pages < HOLDINGS_SCAN_MAX_PAGES; pages++) {
          const r = await scanFetchRetry("/api/scan/v0/holdings/state", {
            method: "POST",
            headers: { "content-type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              migration_id: migrationId,
              record_time: recordTime,
              owner_party_ids: [party],
              page_size: HOLDINGS_SCAN_PAGE_SIZE,
              ...(after !== undefined ? { after } : {}),
            }),
          });
          if (!r.ok) throw new Error(`holdings/state HTTP ${r.status}`);
          const j = (await r.json()) as {
            created_events?: Array<{
              contract_id?: string;
              template_id?: string;
              create_arguments?: {
                owner?: string;
                amount?: { initialAmount?: string };
              };
            }>;
            next_page_token?: number | null;
          };
          for (const e of j.created_events ?? []) {
            // Keep only Amulet contracts owned by THIS party — the snapshot page
            // can carry a caller's other holding kinds / co-owned contracts.
            if (!AMULET_RE.test(e.template_id ?? "")) continue;
            if (e.create_arguments?.owner !== party) continue;
            const amt = e.create_arguments?.amount?.initialAmount;
            if (e.contract_id && amt) holdings.push({ cid: e.contract_id, amount: amt });
          }
          const token = j.next_page_token;
          if (token === undefined || token === null) {
            more = false; // last page — no cursor remains
            break;
          }
          after = token;
          more = true; // a token means at least one more page exists
        }
        // complete === false when we hit the page cap with a cursor still pending
        // (the caller only saw a prefix of the holdings).
        return reply.send({
          party,
          source: "scan-snapshot",
          recordTime,
          holdings,
          complete: !more,
        });
      } catch (err) {
        return relayError(reply, "holdings-scan", err);
      }
    }
  );

  // ── Resolve a transfer factory + its disclosed contracts + context ──
  app.post<{
    Body: { sender: string; receiver: string; amount: string; meta?: Record<string, string> };
  }>("/v1/wallet/resolve/transfer-factory", async (req, reply) => {
    if (!authed(req, reply)) return;
    const { sender, receiver, amount, meta } = req.body ?? ({} as never);
    if (!sender || !receiver || !amount) {
      return reply.code(400).send({ error: "sender, receiver, amount required" });
    }
    try {
      const dso = await getDso();
      const now = Date.now();
      const r = await scanFetchRetry(`/registry/transfer-instruction/v1/transfer-factory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          choiceArguments: {
            expectedAdmin: dso,
            transfer: {
              sender,
              receiver,
              amount,
              instrumentId: { admin: dso, id: "Amulet" },
              requestedAt: new Date(now).toISOString(),
              executeBefore: new Date(now + 3_600_000).toISOString(),
              inputHoldingCids: [],
              meta: { values: meta ?? {} },
            },
            extraArgs: { context: { values: {} }, meta: { values: {} } },
          },
          excludeDebugFields: true,
        }),
      });
      if (!r.ok) throw new Error(`transfer-factory HTTP ${r.status}`);
      const j = (await r.json()) as {
        factoryId: string;
        transferKind: string;
        choiceContext: { choiceContextData: unknown; disclosedContracts: unknown[] };
      };
      return reply.send({
        factoryId: j.factoryId,
        transferKind: j.transferKind,
        transferFactoryTemplateId:
          "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
        instrumentId: { admin: dso, id: "Amulet" },
        choiceContextData: j.choiceContext.choiceContextData,
        disclosedContracts: j.choiceContext.disclosedContracts,
      });
    } catch (err) {
      return relayError(reply, "resolve/transfer-factory", err);
    }
  });

  // ── Read the Amulet OUTPUT cids a transfer transaction created for `party` ──
  //    (whale-merge OUTPUT DISCOVERY). After a `merge` batch self-transfer the
  //    resulting change/output amulets are NOT in the (lagging, daily) Scan
  //    snapshot and — for a whale wallet whose output count still exceeds the
  //    participant's element cap — cannot be read via /balance either. So the
  //    merge client CHAINS: after every successful batch it asks the relay for
  //    that batch's own output cids by updateId and feeds them into the next
  //    round: read the tx by updateId, walk its
  //    CreatedEvents, keep the Amulet contracts OWNED BY `party`. The agent is
  //    relay-only (no Scan/ledger access), so the relay does the bounded per-tx
  //    read (getTransactionById is O(one tx), immune to the ACS element cap).
  app.get<{ Params: { party: string }; Querystring: { updateId?: string } }>(
    "/v1/wallet/:party/tx-amulets",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const party = req.params.party;
      const updateId = req.query?.updateId;
      if (!updateId) return reply.code(400).send({ error: "updateId required" });
      try {
        const tx = await svc.client.getTransactionById({
          updateId,
          requestingParties: [party],
        });
        const amulets: Array<{ cid: string; amount: string }> = [];
        for (const e of tx.events) {
          const created = e.CreatedEvent;
          if (!created) continue;
          // Keep only Amulet contracts OWNED BY this party — the tx also creates
          // amulets for other parties (fees/receiver) and non-Amulet contracts.
          if (!AMULET_RE.test(created.templateId ?? "")) continue;
          const arg = created.createArgument as {
            owner?: unknown;
            amount?: { initialAmount?: unknown };
          };
          if (arg?.owner !== party) continue;
          const amt = arg?.amount?.initialAmount;
          if (created.contractId && typeof amt === "string") {
            amulets.push({ cid: created.contractId, amount: amt });
          }
        }
        return reply.send({ party, updateId, amulets });
      } catch (err) {
        return relayError(reply, "tx-amulets", err);
      }
    }
  );

  // ── Resolve the accept choice-context for a pending TransferInstruction ──
  app.post<{ Body: { instructionCid: string } }>(
    "/v1/wallet/resolve/accept",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const cid = req.body?.instructionCid;
      if (!cid) return reply.code(400).send({ error: "instructionCid required" });
      try {
        const r = await scanFetchRetry(
          `/registry/transfer-instruction/v1/${encodeURIComponent(cid)}/choice-contexts/accept`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meta: {} }) }
        );
        if (!r.ok) throw new Error(`choice-contexts/accept HTTP ${r.status}`);
        const j = (await r.json()) as { choiceContextData: unknown; disclosedContracts: unknown[] };
        return reply.send({ choiceContextData: j.choiceContextData, disclosedContracts: j.disclosedContracts });
      } catch (err) {
        return relayError(reply, "resolve/accept", err);
      }
    }
  );

  // ── Pending incoming transfers the agent can claim (accept) ──
  app.get<{ Params: { party: string } }>("/v1/wallet/:party/pending", async (req, reply) => {
    if (!authed(req, reply)) return;
    const party = req.params.party;
    try {
      // Scope to the TransferInstructionV1 interface — NOT a WildcardFilter. A
      // party with a large ACS (many amulets/coupons) blows past Canton's
      // /v2/state/active-contracts element cap (JSON_API_MAXIMUM_LIST_ELEMENTS_
      // NUMBER_REACHED -> 502) when we pull ALL its contracts just to keep the
      // TransferInstructions. The interface filter returns O(open payments), not
      // O(total contracts). includeInterfaceView:false keeps createArgument in
      // the concrete template shape the loop below reads. Mirrors
      // findCip56TransferInstruction in @ftptech/x402-canton-ledger.
      const events = await svc.client.queryActiveContracts({
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId:
                        "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
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
      const pending: Array<{ cid: string; amount: string | undefined; sender: string | undefined }> = [];
      for (const e of events) {
        if (!/TransferInstruction/.test(e.templateId ?? "")) continue;
        const t = (e.createArgument as { transfer?: { amount?: string; sender?: string; receiver?: string } })?.transfer;
        if (t?.receiver === party) pending.push({ cid: e.contractId, amount: t.amount, sender: t.sender });
      }
      return reply.send({ party, pending });
    } catch (err) {
      return relayError(reply, "pending", err);
    }
  });

  // ── Faucet: facilitator seeds an agent party with a tiny one-time CC grant ──
  // Out-of-box e2e: gives away REAL CC, so every guardrail below is load-bearing.
  // Same TransferFactory_Transfer the funder uses (e2e/fund.mjs), submitted as
  // the facilitator's OWN party; lands as a pending TransferInstruction the agent
  // then accepts via claimAll. See canton/faucet.ts + db/faucet-store.ts.
  const faucetCfg = svc.faucet;
  const faucetSvc =
    faucetCfg && svc.facilitatorParty
      ? new FaucetService({
          client: svc.client,
          facilitatorParty: svc.facilitatorParty,
          userId: svc.userId,
          synchronizerId: svc.synchronizerId,
          amountCc: faucetCfg.amountCc,
          getDso,
          resolveTransferFactory: async ({ transfer, dso }) => {
            // SAME scanFetchRetry path as resolve/transfer-factory + e2e/fund.mjs,
            // but with the facilitator's own inputHoldingCids in `transfer`.
            const r = await scanFetchRetry(
              `/registry/transfer-instruction/v1/transfer-factory`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  choiceArguments: {
                    expectedAdmin: dso,
                    transfer,
                    extraArgs: {
                      context: { values: {} },
                      meta: { values: {} },
                    },
                  },
                  excludeDebugFields: true,
                }),
              }
            );
            if (!r.ok) throw new Error(`transfer-factory HTTP ${r.status}`);
            const j = (await r.json()) as {
              factoryId: string;
              choiceContext: {
                choiceContextData: unknown;
                disclosedContracts: unknown[];
              };
            };
            return {
              factoryId: j.factoryId,
              transferFactoryTemplateId:
                "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
              choiceContextData: j.choiceContext.choiceContextData,
              disclosedContracts: j.choiceContext
                .disclosedContracts as DisclosedContract[],
            };
          },
        })
      : undefined;
  // Per-IP cap only (no per-payer / global): the per-party-once store is the hard
  // single-use guard; this throttles one host minting fresh party ids. windowMs
  // spans the IP cap AND the budget sum.
  const faucetLimiter = createSlidingWindowLimiter({
    maxPerPayer: 0,
    maxGlobal: 0,
    windowMs: faucetCfg?.windowMs ?? 86_400_000,
  });
  // SEPARATE short-window limiter for the GLOBAL burst cap: the daily budget
  // bounds the 24h total but not a fast flood, so this throttles claims/minute
  // across ALL non-exempt callers (one shared bucket → IP-independent, so it
  // holds even when abusers rotate IPs or legit callers share one).
  const faucetBurstLimiter = createSlidingWindowLimiter({
    maxPerPayer: 0,
    maxGlobal: 0,
    windowMs: faucetCfg?.burstWindowMs ?? 60_000,
  });

  app.post<{ Body: { party?: string } }>(
    "/v1/wallet/faucet/claim",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      if (!faucetCfg || !faucetSvc) {
        return reply.code(503).send({ error: "faucet disabled" });
      }
      // Internal-caller lock: when an internalSecret is configured the raw faucet
      // is NOT public — the caller must present the matching X-Faucet-Secret. This
      // makes the quest flow (pay-proxy, which sets the header) the ONLY way to
      // trigger a grant; a direct public curl is 403. Constant-time compare so a
      // wrong secret leaks no timing signal. Unset → no gate (dev/back-compat).
      if (faucetCfg.internalSecret) {
        const presented = req.headers["x-faucet-secret"];
        if (
          typeof presented !== "string" ||
          !timingSafeEqualStr(presented, faucetCfg.internalSecret)
        ) {
          return reply.code(403).send({ error: "faucet is internal-only" });
        }
      }
      const party = req.body?.party?.trim();
      if (!party) return reply.code(400).send({ error: "party is required" });
      // Validate the recipient party SHAPE before any store/ledger work — a
      // malformed id must never reach the ledger submit (garbage in -> a doomed
      // round-trip that still burns the GS traffic fee).
      if (!FAUCET_PARTY_RE.test(party)) {
        return reply.code(400).send({ error: "party is malformed" });
      }
      const now = Date.now();
      try {
        // 1. Already claimed? (durable + fail-closed). Friendly 429 first — the
        //    atomic tryClaim below is still the real single-use authority (this
        //    only avoids a needless per-IP-cap consume on an obvious repeat).
        if (await faucetCfg.store.hasClaimed(party)) {
          return reply
            .code(429)
            .send({ error: "faucet already claimed for this party" });
        }
        // Trusted internal callers (the pay-proxy, which self-limits: the quest
        // funds only in STEP 2 after a real payment and is bounded by its own
        // budget) are EXEMPT from the per-IP + global-burst caps. per-party-once +
        // the daily budget still apply to them.
        const exempt = faucetCfg.ipExempt?.includes(req.ip) ?? false;
        // 2a. GLOBAL burst cap (IP-independent) — throttles a fast flood so nobody
        //     can hammer the public faucet, even by rotating IPs. Low-rate legit
        //     callers (a dev running auto_fund once) never hit it.
        if (
          !exempt &&
          faucetCfg.maxGlobalPerMin !== undefined &&
          faucetCfg.maxGlobalPerMin > 0 &&
          !faucetBurstLimiter.allowKeys(
            [{ key: "faucet:global", max: faucetCfg.maxGlobalPerMin }],
            now
          )
        ) {
          return reply
            .code(429)
            .send({ error: "faucet rate limit (global burst)" });
        }
        // 2b. Per-IP cap (in-process). `<=0` disables it.
        if (
          !exempt &&
          faucetCfg.maxPerIp > 0 &&
          !faucetLimiter.allowKeys(
            [{ key: `faucet:ip:${req.ip}`, max: faucetCfg.maxPerIp }],
            now
          )
        ) {
          return reply.code(429).send({ error: "faucet rate limit (per IP)" });
        }
        // 3. ATOMIC reserve-and-budget BEFORE the transfer. ONE operation
        //    enforces party-once + the rolling daily budget + the all-time
        //    lifetime cap and inserts the reservation, closing the
        //    check-then-act race the old separate sumSince+tryReserve left open
        //    (concurrent fresh-party claims could each pass a stale budget read
        //    and collectively overshoot the ceiling). The reason picks the
        //    status: already_claimed -> 429, daily_budget/lifetime_cap -> 503.
        const reason = await faucetCfg.store.tryClaim({
          party,
          ip: req.ip,
          amountCc: faucetCfg.amountCc,
          nowMs: now,
          windowMs: faucetCfg.windowMs,
          dailyBudgetCc: faucetCfg.dailyBudgetCc,
          lifetimeCapCc: faucetCfg.lifetimeCapCc,
        });
        if (reason === "already_claimed") {
          return reply
            .code(429)
            .send({ error: "faucet already claimed for this party" });
        }
        if (reason === "daily_budget") {
          return reply
            .code(503)
            .send({ error: "faucet daily budget exhausted" });
        }
        if (reason === "lifetime_cap") {
          return reply
            .code(503)
            .send({ error: "faucet lifetime cap reached" });
        }
        // 4. Pay. Release the reservation ONLY if the transfer itself fails (so a
        //    failed payout can retry). Once CC has moved the reservation MUST
        //    stand — a markPaid failure is non-fatal and must NOT release it,
        //    else the party could claim again (double payout).
        let result: { updateId: string; amount: string; recipient: string };
        try {
          result = await faucetSvc.claim({ recipient: party });
        } catch (err) {
          await faucetCfg.store.release(party).catch(() => {});
          return relayError(reply, "faucet/claim", err);
        }
        await faucetCfg.store
          .markPaid({ party, updateId: result.updateId })
          .catch((e: unknown) =>
            req.log.warn(
              { err: e instanceof Error ? e.message : String(e), party },
              "faucet markPaid failed (non-fatal; reservation holds)"
            )
          );
        req.log.info(
          {
            party,
            ip: req.ip,
            amount: faucetCfg.amountCc,
            updateId: result.updateId,
          },
          "faucet payout"
        );
        return reply.send({
          updateId: result.updateId,
          amount: faucetCfg.amountCc,
          party,
        });
      } catch (err) {
        // A store error in steps 1/3 (fail-closed) → deny rather than risk a
        // double payout. The transfer path has its own catch above.
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "faucet store error (fail-closed 503)"
        );
        return reply
          .code(503)
          .send({ error: "faucet temporarily unavailable" });
      }
    }
  );

  // ── transfer-factory ("V3") pay: relay-build + prepare + stash ──
  //   The relay builds the token-standard transfer ITSELF (faucet-pattern
  //   build, but sender = the agent party and prepare is an interactive
  //   submission the agent will sign). Because the relay built the command,
  //   the stash records trusted expected fields for a decode-free /verify;
  //   the payer's own protection is the client-side verify-before-sign over
  //   the returned preparedTransaction (assertPreparedTransferMatches).
  const tfPay = svc.tfPay;
  /** Positive Daml Decimal (≤10 frac digits) — the ledger amount grammar. */
  const TF_AMOUNT_RE = /^\d{1,15}(\.\d{1,10})?$/;

  /** Largest-first Amulet selection for the AGENT party, with the same fee
   *  headroom the faucet uses. Returns everything selected plus the party's
   *  scanned total so the route can report an honest insufficient error. */
  const selectPartyInputs = async (
    party: string,
    wantCc: number
  ): Promise<{ cids: string[]; totalCc: number }> => {
    const events = await svc.client.queryActiveContracts({
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: "#splice-amulet:Splice.Amulet:Amulet",
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });
    const holdings = events
      .map((e) => ({
        cid: e.contractId,
        amount: Number(
          (e.createArgument as { amount?: { initialAmount?: string } } | undefined)
            ?.amount?.initialAmount ?? 0
        ),
      }))
      .filter((h) => Boolean(h.cid) && h.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const cids: string[] = [];
    let selected = 0;
    let total = 0;
    for (const h of holdings) {
      total += h.amount;
      if (selected < wantCc + 0.01) {
        cids.push(h.cid as string);
        selected += h.amount;
      }
    }
    return { cids, totalCc: total };
  };

  app.post<{
    Body: {
      party?: string;
      receiver?: string;
      amount?: string;
      executeBeforeSeconds?: number;
      memo?: unknown;
    };
  }>("/v1/wallet/pay/prepare", async (req, reply) => {
    if (!authed(req, reply)) return;
    if (!tfPay) {
      return reply.code(503).send({ error: "transfer-factory pay disabled" });
    }
    const party = req.body?.party?.trim();
    const receiver = req.body?.receiver?.trim();
    const amount = req.body?.amount?.trim();
    if (!party || !receiver || !amount) {
      return reply.code(400).send({ error: "party, receiver, amount required" });
    }
    if (!FAUCET_PARTY_RE.test(party) || !FAUCET_PARTY_RE.test(receiver)) {
      return reply.code(400).send({ error: "party or receiver is malformed" });
    }
    if (party === receiver) {
      return reply
        .code(400)
        .send({ error: "receiver must differ from party (self-payment)" });
    }
    if (!TF_AMOUNT_RE.test(amount) || Number(amount) <= 0) {
      return reply
        .code(400)
        .send({ error: "amount must be a positive Daml Decimal string" });
    }
    // Optional merchant memo (PaymentRequirements.extra.memo): when present it
    // MUST be a non-empty string of at most 512 chars. It is stamped into the
    // transfer's `x402.memo` meta + recorded in the stash so /verify can enforce
    // it against the merchant's requirement.
    const rawMemo = req.body?.memo;
    let memo: string | undefined;
    if (rawMemo !== undefined) {
      if (typeof rawMemo !== "string") {
        return reply.code(400).send({ error: "memo must be a string" });
      }
      const trimmed = rawMemo.trim();
      if (trimmed.length === 0 || trimmed.length > 512) {
        return reply.code(400).send({
          error: "memo must be a non-empty string of at most 512 chars",
        });
      }
      memo = trimmed;
    }
    const requested = Number(req.body?.executeBeforeSeconds);
    const ebSeconds =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.trunc(requested), tfPay.maxExecuteBeforeSeconds)
        : tfPay.defaultExecuteBeforeSeconds;
    try {
      if (
        (await tfPay.stash.livePayerCount(party, new Date())) >=
        tfPay.capPerPayer
      ) {
        return reply
          .code(429)
          .send({ error: "too many pending pay submissions for this party" });
      }
      const dso = await getDso();
      const { cids, totalCc } = await selectPartyInputs(party, Number(amount));
      if (totalCc < Number(amount)) {
        return reply.code(400).send({
          error: `insufficient holdings: balance ${totalCc.toFixed(10)} CC < amount ${amount} CC`,
        });
      }
      const now = Date.now();
      const executeBefore = new Date(now + ebSeconds * 1000).toISOString();
      const transfer = {
        sender: party,
        receiver,
        amount,
        instrumentId: { admin: dso, id: "Amulet" },
        requestedAt: new Date(now - 1000).toISOString(),
        executeBefore,
        inputHoldingCids: cids,
        meta: {
          values: {
            ...(memo !== undefined ? { "x402.memo": memo } : {}),
          } as Record<string, string>,
        },
      };
      // Registry resolve with the REAL transfer (inputs included) — the same
      // envelope the faucet + e2e/fund.mjs use.
      const r = await scanFetchRetry(
        `/registry/transfer-instruction/v1/transfer-factory`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            choiceArguments: {
              expectedAdmin: dso,
              transfer,
              extraArgs: { context: { values: {} }, meta: { values: {} } },
            },
            excludeDebugFields: true,
          }),
        }
      );
      if (!r.ok) throw new Error(`transfer-factory HTTP ${r.status}`);
      const f = (await r.json()) as {
        factoryId: string;
        choiceContext: {
          choiceContextData: unknown;
          disclosedContracts: DisclosedContract[];
        };
      };
      const prepared = await svc.client.interactiveSubmissionPrepare({
        userId: svc.userId,
        commandId: `tfpay-${randomUUID()}`,
        actAs: [party],
        synchronizerId: svc.synchronizerId,
        disclosedContracts: f.choiceContext.disclosedContracts,
        commands: [
          {
            ExerciseCommand: {
              templateId:
                "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
              contractId: f.factoryId,
              choice: "TransferFactory_Transfer",
              choiceArgument: {
                expectedAdmin: dso,
                transfer,
                extraArgs: {
                  context: f.choiceContext.choiceContextData,
                  meta: { values: {} },
                },
              },
            },
          },
        ],
      });
      const submissionRef = await tfPay.stash.create({
        payer: party,
        receiver,
        amount,
        instrumentAdmin: dso,
        instrumentId: "Amulet",
        executeBefore,
        txHash: prepared.preparedTransactionHash,
        preparedTx: prepared.preparedTransaction,
        ...(memo !== undefined ? { memo } : {}),
      });
      return reply.send({
        submissionRef,
        preparedTransaction: prepared.preparedTransaction,
        txHash: prepared.preparedTransactionHash,
        executeBefore,
        sender: party,
        receiver,
        amount,
        instrumentId: { admin: dso, id: "Amulet" },
      });
    } catch (err) {
      return relayError(reply, "pay/prepare", err);
    }
  });

  // ── transfer-factory pay: attach the payer's signing bundle (NO execution) ──
  //   Accepts the SAME partySignatures/hashingSchemeVersion shape the client
  //   already produces for submit/execute; the relay stores it next to the
  //   prepared tx. /settle performs the actual ExecuteSubmission later.
  app.post<{
    Body: {
      party?: string;
      submissionRef?: string;
      hashingSchemeVersion?: InteractiveExecuteBody["hashingSchemeVersion"];
      partySignatures?: InteractiveExecuteBody["partySignatures"];
    };
  }>("/v1/wallet/pay/commit", async (req, reply) => {
    if (!authed(req, reply)) return;
    if (!tfPay) {
      return reply.code(503).send({ error: "transfer-factory pay disabled" });
    }
    const { party, submissionRef, partySignatures, hashingSchemeVersion } =
      req.body ?? {};
    if (
      !party ||
      !submissionRef ||
      !partySignatures?.signatures?.length ||
      !hashingSchemeVersion
    ) {
      return reply.code(400).send({
        error:
          "party, submissionRef, partySignatures, hashingSchemeVersion required",
      });
    }
    if (partySignatures.signatures[0]?.party !== party) {
      return reply
        .code(400)
        .send({ error: "partySignatures[0].party must equal party" });
    }
    try {
      const row = await tfPay.stash.get(submissionRef);
      if (!row || row.payer !== party) {
        // A wrong-payer probe reads the same as an unknown ref (no ref
        // enumeration oracle).
        return reply.code(404).send({ error: "submission not found" });
      }
      const bundle = JSON.stringify({ partySignatures, hashingSchemeVersion });
      const res = await tfPay.stash.attachSignature(submissionRef, bundle);
      if (res === "not_found") {
        return reply.code(404).send({ error: "submission not found" });
      }
      if (res === "already_signed") {
        return reply.code(409).send({ error: "submission already committed" });
      }
      if (res === "expired") {
        return reply.code(410).send({
          error: "submission expired (past executeBefore) — re-run pay/prepare",
        });
      }
      return reply.send({
        committed: true,
        submissionRef,
        executeBefore: row.executeBefore,
      });
    } catch (err) {
      return relayError(reply, "pay/commit", err);
    }
  });
}
