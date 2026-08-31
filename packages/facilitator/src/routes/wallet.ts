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
import { decimalToAtomicCC, sumLedgerDecimals } from "@ftptech/x402-canton-core";
import type {
  CantonClient,
  DisclosedContract,
  InteractivePrepareBody,
  InteractiveExecuteBody,
} from "@ftptech/x402-canton-ledger";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createSlidingWindowLimiter,
  provesNothingCommitted,
} from "../rate-limit.js";
import { clientIp } from "./common.js";
import { FaucetService, FaucetPreSubmitError } from "../canton/faucet.js";
import { UnfundedFeePartyError } from "../canton/preapproval.js";
import { SubmissionOutcomeUnknownError } from "../canton/transfer-factory.js";
import type { FaucetClaimStore } from "../db/faucet-store.js";

/** Constant-time string equality (length-checked first, then timingSafeEqual on
 *  equal-length buffers). Mirrors the attribution/registry token checks. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface WalletRelayServices {
  /** DAML choices `/v1/wallet/submit/prepare` will build. See
   *  {@link deniedChoice} and FacilitatorConfig.walletSubmitChoiceAllowlist. */
  walletSubmitChoices: readonly string[];
  /** Max /v1/wallet/submit/execute calls per (party, caller IP) per minute.
   *  `<= 0` disables. Each call is a real ledger submission. */
  submitRateMaxPerKey?: number;
  /** Per-CALLER ceiling; the per-key cap contains a caller-asserted party and
   *  therefore cannot bound a caller who varies it. */
  submitRateMaxPerIp?: number;
  /** Facilitator-wide ceiling on external-party allocations per minute. The
   *  per-IP caps are admission control and cannot bound a resource that is
   *  shared by everyone: a permanent party, our Global Synchronizer traffic,
   *  and a user-rights slot. `<= 0` disables. */
  onboardRateMaxGlobal?: number;
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
  /** Non-Amulet CIP-56 instrument registries: instrument admin party →
   *  DA Registry Utility base URL (see FacilitatorConfig.tokenRegistries).
   *  When `resolve/transfer-factory` is asked for an instrument whose admin is
   *  listed here, it resolves the factory on that utility (per-registrar path)
   *  instead of the SV Scan. Absent/empty → Amulet-only. */
  tokenRegistries?: Record<string, string>;
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
   *  /v1/wallet/pay/prepare returns 503 (disabled). The relay BUILDS the
   *  TransferFactory_Transfer itself (sender = the agent party) and
   *  interactive-PREPAREs it, then returns the prepared bytes + hash for the
   *  agent to sign; the agent carries the signed transaction INLINE in its
   *  payment payload, so the relay stores nothing. */
  tfPay?:
    | {
        /** Wasted prepares one payer may spend per window before the route
         *  stops doing the expensive part. `<= 0` disables. See config. */
        wasteMax?: number;
        wasteWindowMs?: number;
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

/**
 * First command whose choice is not allowed, or undefined if every command
 * passes.
 *
 * Deliberately strict about SHAPE as well as choice. The shipped client sends
 * `ExerciseCommand` and nothing else, so a `CreateCommand` or an
 * `ExerciseByKeyCommand` arriving here is already off the documented path and
 * is refused rather than inspected — an allowlist that only looks at a `choice`
 * field would wave through any command shape that has no `choice` at all,
 * which is the classic way this kind of check is defeated.
 *
 * `*` anywhere in the allowlist restores the old forward-anything behaviour for
 * an operator who wants it.
 */
export function deniedChoice(
  commands: readonly unknown[],
  allowed: readonly string[]
): string | undefined {
  if (allowed.includes("*")) return undefined;
  for (const cmd of commands) {
    if (typeof cmd !== "object" || cmd === null) return "(malformed command)";
    const keys = Object.keys(cmd as Record<string, unknown>);
    // A command is a single-key discriminated wrapper: {"ExerciseCommand": {…}}.
    // More than one key means the shape is not what the participant expects and
    // we should not be guessing which half is real.
    if (keys.length !== 1) return "(malformed command)";
    const kind = keys[0]!;
    if (kind !== "ExerciseCommand") return kind;
    const inner = (cmd as Record<string, unknown>)[kind];
    const choice =
      typeof inner === "object" && inner !== null
        ? (inner as Record<string, unknown>)["choice"]
        : undefined;
    if (typeof choice !== "string") return "(command without a choice)";
    if (!allowed.includes(choice)) return choice;
  }
  return undefined;
}

export async function registerWalletRoutes(
  app: FastifyInstance,
  svc: WalletRelayServices
): Promise<void> {
  if (!svc.enableAgentWallet) return; // routes simply do not exist when off

  // Fail at REGISTRATION, not per request. A missing or empty allowlist would
  // otherwise surface as a 500 on every prepare — or, worse, as a relay that
  // refuses everything while looking healthy. Boot is where a misconfigured
  // gate should be noticed.
  if (!svc.walletSubmitChoices || svc.walletSubmitChoices.length === 0) {
    throw new Error(
      "wallet relay: walletSubmitChoices must list at least one DAML choice " +
        "(or [\"*\"] to prepare anything); refusing to register submit/prepare " +
        "with no policy at all"
    );
  }

  // Shared API-key gate. Returns true if the request may proceed.
  const authed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!svc.agentWalletApiKey) return true;
    if (req.headers["x-agent-key"] === svc.agentWalletApiKey) return true;
    reply.code(401).send({ error: "missing or invalid X-Agent-Key" });
    return false;
  };

  /**
   * Distinct parties that the participant has refused to read for us recently.
   *
   * A 403 on an ACS read means our ledger user may not read THAT party. For a
   * party we do not host, that is the participant answering the caller's
   * question correctly — it is not our failure. But if our own read rights
   * actually broke, the refusals would not be confined to one party: they would
   * appear across everything we touch. So the count of DISTINCT refused parties
   * is the discriminator between "someone asked about a stranger" and "we are
   * broken", and it costs no extra request to compute.
   *
   * Bounded and self-clearing: entries age out of the window, and the map is
   * swept whenever it is consulted.
   */
  const refusedParties = new Map<string, number>();
  const REFUSED_WINDOW_MS = 300_000;
  /** Distinct parties within the window that make this OUR problem, not a
   *  caller's. Two is a coincidence; four is a pattern. */
  const REFUSED_DISTINCT_FOR_OURS = 4;

  /** Did the participant refuse to READ this party for us? */
  const isReadRefusal = (err: unknown): boolean =>
    (err as { code?: unknown })?.code === "HTTP_ERROR" &&
    (err as { status?: unknown })?.status === 403;

  const noteRefusal = (party: string, now: number): number => {
    for (const [k, at] of refusedParties) {
      if (now - at > REFUSED_WINDOW_MS) refusedParties.delete(k);
    }
    refusedParties.set(party, now);
    return refusedParties.size;
  };

  /**
   * 503 for a submission that WAS accepted by the participant but whose outcome
   * we could not read. Deliberately not a 502: a 5xx that reads as "it failed"
   * invites the caller to run the same money-moving command again over fresh
   * inputs. The submissionId goes in the body because it is the one thing that
   * makes the outcome recoverable — the caller can look the completion up rather
   * than guess.
   */
  const outcomeUnknown = (reply: FastifyReply, where: string, submissionId: string) =>
    reply.code(503).header("Retry-After", "3").send({
      error: "submission_outcome_unknown",
      where,
      submissionId,
      detail:
        "the submission was accepted and may commit; do NOT resubmit — look up this submissionId before retrying",
    });

  const relayError = (
    reply: FastifyReply,
    where: string,
    err: unknown,
    /** The party the caller named, when the route has one. Lets a read refusal
     *  be attributed instead of counted as our failure. */
    party?: string
  ) => {
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
    // A READ REFUSAL IS NOT OUR OUTAGE — until it is.
    //
    // `level:50` has to mean "something is wrong with US", or it stops being a
    // signal. A caller naming a party this participant does not host produced a
    // 502 and an error line, so a steady 1% of such requests buried everything
    // else. (Measured: 56 of 5575, all for one party that has never paid,
    // prepared or claimed here — checked against payment_burns and
    // faucet_claims.) That is the caller's question answered, not our failure:
    // 404 says so, and says something they can act on.
    //
    // The escalation keeps this from trading one blind spot for another. If our
    // own read rights broke, refusals would not stay confined to one party, so
    // once enough DISTINCT parties are refused inside the window it goes back
    // to 502 + error — which is exactly what a real rights outage looks like.
    if (party && isReadRefusal(err)) {
      const distinct = noteRefusal(party, Date.now());
      if (distinct < REFUSED_DISTINCT_FOR_OURS) {
        reply.log.warn(
          { where, party, distinctRefusedParties: distinct },
          "wallet relay: the participant will not read this party for us — " +
            "answering the caller 404 (not counted as our failure)"
        );
        return reply.code(404).send({
          error: "party not readable by this facilitator",
          detail:
            "This facilitator's participant does not host (or cannot read) " +
            "that party. Use a party hosted here.",
        });
      }
      reply.log.error(
        { err, where, party, distinctRefusedParties: distinct },
        "wallet relay: read refusals across MANY parties — our participant " +
          "read rights are probably broken"
      );
      return reply
        .code(502)
        .send({ error: `wallet relay ${where} failed`, detail });
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
    // SAME BUDGET AS /submit/execute, because this is the same act.
    //
    // Past this line the relay POSTs /v2/interactive-submission/execute with
    // caller-supplied bytes and spends our Global Synchronizer traffic — the
    // exact line the submit budget was written to bound. It was charged on one
    // route and not the other, so the 60/min cap bounded nothing: an anonymous
    // caller could take a prepared transaction from ANY prepare route and loop
    // it through here instead, each call costing a getLedgerEnd, a real
    // participant submission, and (on an accepted submission with no updateId)
    // a pollCompletionUpdateId that holds a connection open for ~52s.
    //
    // TWO keys, exactly like /submit/execute, and for the same reason.
    //
    // This route used the composite `submit:${party}|${ip}` key ALONE, with
    // `party` read straight off the body and never shape-checked. That is one
    // lesson short of where the sibling ended up: keying on the party alone
    // lets a stranger spend a victim's budget (which the pair does fix), but a
    // pair that CONTAINS a caller-asserted party still hands the caller a fresh
    // bucket per request — rotate `party` through "a", "b", "c" and the 60/min
    // cap never trips, while every admitted call costs a getLedgerEnd and a
    // real participant submission on our Global Synchronizer traffic. The
    // limiter carries no global arm either, so nothing else was holding.
    //
    // The IP key is the one a caller cannot vary from a single host, so it is
    // what actually holds; the party key stays because it is what keeps one
    // agent's traffic from spending another's budget behind a shared NAT. The
    // shape check keeps junk from becoming a Map key at all.
    //
    // Nothing here moves funds without the party's own key — the participant
    // validates partySignatures against topology — so this bounds resource
    // abuse, not theft. That is what the budget was always for.
    const submitParty = FAUCET_PARTY_RE.test(party) ? party : "unknown";
    const submitCap = svc.submitRateMaxPerKey ?? 60;
    const submitIpCap = svc.submitRateMaxPerIp ?? submitCap * 4;
    const submitKeys: Array<{ key: string; max: number }> = [];
    if (submitCap > 0) {
      submitKeys.push({
        key: `submit:${submitParty}|${clientIp(req)}`,
        max: submitCap,
      });
    }
    if (submitIpCap > 0) {
      submitKeys.push({ key: `submit-ip:${clientIp(req)}`, max: submitIpCap });
    }
    if (
      submitKeys.length > 0 &&
      !submitLimiter.allowKeys(submitKeys, Date.now(), false)
    ) {
      req.log.warn(
        { party: submitParty, cap: submitCap },
        "preapproval/self/commit rate-limited"
      );
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ error: "too many submissions" });
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
      // Accepted-but-unreadable is not "it failed" — same distinction the
      // submit/execute route above makes, and for the same reason: a 502 here
      // sends the merchant round the self-preapproval flow again and they pay a
      // second creation fee for a preapproval that committed.
      if (err instanceof SubmissionOutcomeUnknownError) {
        req.log.error(
          { party, err },
          "preapproval/self/commit: submission accepted but its completion could not be read; outcome UNKNOWN"
        );
        return reply.code(503).header("Retry-After", "3").send({
          error: "submission_outcome_unknown",
          where: "preapproval/self/commit",
          party,
          detail:
            "the preapproval submission was accepted and may commit; do NOT resubmit — check `preapproval status` for this party before retrying",
        });
      }
      return relayError(reply, "preapproval/self/commit", err);
    }
  });

  // ── REGISTRY self-preapproval: prepare (non-Amulet CIP-56, e.g. USDCx) ──
  // The DA Registry Utility analogue of the Amulet self-preapproval above. Lets a
  // self-custody wallet CREATE its own `Utility.Registry.App.V0.Model.TransferPreapproval`
  // so it can RECEIVE a registry token one-shot. A plain create (no fee, no mining
  // rounds), so this only fetches the registry operator + builds the create; the
  // wallet signs with its own key and commits via the SAME /preapproval/self/commit
  // route (that route just executes signed bytes — instrument-agnostic). The relay
  // builds the bytes, so the wallet MUST verify-before-sign
  // (assertPreparedRegistrySelfPreapproval) — never blind-sign.
  app.post<{
    Body: { party?: string; instrumentId?: { admin?: string; id?: string } };
  }>("/v1/wallet/preapproval/registry/self/prepare", async (req, reply) => {
    if (!authed(req, reply)) return;
    const party = req.body?.party?.trim();
    const admin = req.body?.instrumentId?.admin?.trim();
    const id = req.body?.instrumentId?.id?.trim();
    if (!party || !FAUCET_PARTY_RE.test(party)) {
      return reply.code(400).send({ error: "party required/malformed" });
    }
    if (!admin || !id) {
      return reply.code(400).send({ error: "instrumentId {admin,id} required" });
    }
    const registryBaseUrl = svc.tokenRegistries?.[admin];
    if (!registryBaseUrl) {
      return reply
        .code(400)
        .send({ error: "no registry configured for this instrument admin", admin });
    }
    try {
      // Operator (a signatory of the preapproval) from the registry's own
      // authoritative endpoint — NEVER caller-supplied.
      const opRes = await fetch(
        `${registryBaseUrl}/api/utilities/v0/operator`,
        { method: "GET", headers: { accept: "application/json" } }
      );
      if (!opRes.ok) throw new Error(`operator endpoint HTTP ${opRes.status}`);
      const operator = ((await opRes.json()) as { partyId?: string }).partyId;
      if (typeof operator !== "string" || operator.length === 0) {
        throw new Error("operator endpoint returned no partyId");
      }
      const create = {
        CreateCommand: {
          templateId:
            "#utility-registry-app-v0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval",
          createArguments: {
            operator,
            receiver: party,
            instrumentAdmin: admin,
            instrumentAllowances: [],
          },
        },
      };
      const prepared = await svc.client.interactiveSubmissionPrepare({
        userId: svc.userId,
        commandId: `registry-self-preapproval-${randomUUID()}`,
        actAs: [party],
        readAs: [party],
        synchronizerId: svc.synchronizerId,
        commands: [create],
        packageIdSelectionPreference: [],
        verboseHashing: false,
      });
      return reply.send({
        preparedTransaction: prepared.preparedTransaction,
        hash: prepared.preparedTransactionHash,
        synchronizerId: svc.synchronizerId,
        party,
        operator,
      });
    } catch (err) {
      return relayError(reply, "preapproval/registry/self/prepare", err);
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
    if (!onboardAllowed(req, reply, "onboard/prepare")) return;
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
    // BOUND IT. This route writes a topology transaction to the Global
    // Synchronizer under OUR participant and burns OUR sequencer traffic, and
    // the party it allocates is permanent. It is also reachable anonymously —
    // authed() is a no-op when CANTON_X402_AGENT_WALLET_KEY is unset, which is
    // how production runs, because an out-of-box agent has no key to present.
    // Every other mutating route in this file (submit/execute, pay/prepare,
    // faucet/claim, preapproval/self/commit) already carries a
    // limiter; these three did not, so the cheapest way to make us pay was the
    // one door with no lock on it.
    if (!onboardAllowed(req, reply, "onboard/finalize")) return;
    const { onboardingTransactions, multiHashSignatures } =
      req.body ?? ({} as never);
    if (!onboardingTransactions?.length || !multiHashSignatures?.length) {
      return reply
        .code(400)
        .send({ error: "onboardingTransactions and multiHashSignatures required" });
    }
    // THE LINE PAST WHICH WE SPEND. Everything above is cheap and refusable;
    // below, a permanent party exists and our traffic is gone.
    if (!onboardSpendAllowed(req, reply)) return;
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
      if (!onboardAllowed(req, reply, "submit/prepare")) return;
      const body = req.body;
      if (!body?.commands?.length || !body?.actAs?.length) {
        return reply.code(400).send({ error: "commands and actAs required" });
      }
      // WHAT we will build, not just for whom.
      //
      // This route is reachable without a credential, on purpose: it is how the
      // published agent wallet works with no signup. But open onboarding was
      // never meant to mean "build me any transaction you like" — `commands`
      // used to be forwarded verbatim, so anyone could point our participant at
      // arbitrary DAML and make it do unbounded work at our expense.
      //
      // Nobody could move someone else's funds that way: execute checks the
      // party's signature against topology, and the faucet has its own secret.
      // So this is resource abuse, not theft — which is why the answer is a
      // narrow allowlist rather than shutting the relay.
      const denied = deniedChoice(body.commands, svc.walletSubmitChoices);
      if (denied !== undefined) {
        req.log.warn(
          { denied, actAs: body.actAs },
          "wallet relay: refused submit/prepare for a choice outside the allowlist"
        );
        return reply.code(400).send({
          error: "choice_not_allowed",
          detail:
            `this relay prepares only: ${svc.walletSubmitChoices.join(", ")}. ` +
            `Refused: ${denied}`,
        });
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
      // Bound the submission BEFORE it happens — past this line we spend real
      // Global Synchronizer traffic on someone else's bytes.
      // The key must be a BOUNDED value. This one is read straight out of the
      // request body — an arbitrary caller string, as long as the body limit
      // allows — and went into the limiter's Map as a key, so a caller could
      // grow that Map by whatever it liked simply by varying the field. Keep
      // it only when it looks like a party; anything else shares one bucket.
      const claimedParty = body.partySignatures?.signatures?.[0]?.party;
      const submitParty =
        typeof claimedParty === "string" && FAUCET_PARTY_RE.test(claimedParty)
          ? claimedParty
          : "unknown";
      // TWO keys, exactly like /settle, and for the same reason. The party is
      // caller-asserted: the shape check above stops junk from becoming a Map
      // key, but a well-formed party is trivial to mint, so a composite key
      // that CONTAINS it still hands the caller a fresh bucket per request and
      // the per-key cap bounds nothing. The IP key is the one a caller cannot
      // vary from a single host, so it is what actually holds; the party key
      // stays because it is what keeps one agent's traffic from spending
      // another's budget behind a shared NAT.
      const submitCap = svc.submitRateMaxPerKey ?? 60;
      const submitIpCap = svc.submitRateMaxPerIp ?? submitCap * 4;
      const submitKeys: Array<{ key: string; max: number }> = [];
      if (submitCap > 0) {
        submitKeys.push({
          key: `submit:${submitParty}|${clientIp(req)}`,
          max: submitCap,
        });
      }
      if (submitIpCap > 0) {
        submitKeys.push({ key: `submit-ip:${clientIp(req)}`, max: submitIpCap });
      }
      if (
        submitKeys.length > 0 &&
        !submitLimiter.allowKeys(submitKeys, Date.now(), false)
      ) {
        req.log.warn(
          { party: submitParty, cap: submitCap },
          "submit/execute rate-limited"
        );
        return reply
          .code(429)
          .header("Retry-After", "60")
          .send({ error: "too many submissions" });
      }
      try {
        const submissionId = body.submissionId || randomUUID();
        const offset0 = (await svc.client.getLedgerEnd()).offset;
        const r = await svc.client.interactiveSubmissionExecute({ ...body, submissionId });
        // THE EXECUTE POST HAS RETURNED 200. The submission is accepted and will
        // be sequenced; /execute is async and normally answers `{}` with the
        // updateId arriving on the completion stream. Everything below READS the
        // outcome of something already in flight — it can classify that
        // submission, it can never unmake it.
        //
        // So a failure to read is not a failure to submit. pollCompletionUpdateId
        // gives up with INVALID_RESPONSE after ~12s and gets there on ANY failure
        // of the completion read (readCompletions turns a token-refresh 401, a
        // participant 5xx or a bridge 502/504 into an empty list). That escaped
        // into relayError as a 502 — a definite "your submission failed" — for a
        // transfer that then commits on-ledger. The caller (a `withdraw`, a
        // `claim`, a pay) reports failure and the operator runs it again, over
        // FRESH inputs: two transfers, one intended.
        //
        // The /settle twin of this bug is already fixed — see execute() in
        // canton/transfer-factory.ts, which this mirrors. SUBMISSION_FAILED keeps
        // its meaning in both: the completion ARRIVED carrying a non-zero status,
        // the participant refused it, nothing moved.
        let updateId = r.updateId;
        if (!updateId) {
          const party = body.partySignatures?.signatures?.[0]?.party;
          if (!party) {
            // Nothing to poll with, and the submission is already in flight. A
            // 200 carrying `{updateId: undefined}` would dress that unknown up
            // as a success the caller cannot verify.
            return outcomeUnknown(reply, "submit/execute", submissionId);
          }
          try {
            updateId = await svc.client.pollCompletionUpdateId(
              svc.userId,
              party,
              submissionId,
              offset0
            );
          } catch (err) {
            if ((err as { code?: unknown } | null)?.code === "SUBMISSION_FAILED") {
              throw err;
            }
            req.log.error(
              { party, submissionId, err },
              "submit/execute: submission accepted but its completion could not be read; outcome UNKNOWN"
            );
            return outcomeUnknown(reply, "submit/execute", submissionId);
          }
        }
        return reply.send({ updateId });
      } catch (err) {
        return relayError(reply, "submit/execute", err);
      }
    }
  );

  // ── Holdings: every instrument the party holds, via the HoldingV1 interface ──
  //
  // The primitive the registry-aware commands stand on. /balance answers
  // "how much Canton Coin" and nothing else, because it enumerates the Amulet
  // TEMPLATE; this answers "what does this party hold, per instrument", which
  // is the question balance/withdraw/merge need once a wallet can hold USDCx.
  //
  // Read-only, authed like the other wallet reads. `?admin=&id=` narrows to one
  // instrument; omitted, every instrument is listed. A registry admin that is
  // not configured is not an error here — reads are not gated on the registry
  // (there is nothing to route), only on what the ledger says the party owns.
  app.get<{ Params: { party: string }; Querystring: { admin?: string; id?: string } }>(
    "/v1/wallet/:party/holdings",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const party = req.params.party;
      const { admin, id } = req.query;
      if ((admin && !id) || (!admin && id)) {
        return reply.code(400).send({ error: "admin and id must be given together" });
      }
      try {
        const rows = await readHoldingsV1(party, admin && id ? { admin, id } : undefined);
        // Group per instrument so a caller sees totals without summing strings.
        const byInstrument = new Map<
          string,
          { admin: string; id: string; holdings: typeof rows }
        >();
        for (const h of rows) {
          const key = `${h.admin}|${h.id}`;
          const g = byInstrument.get(key) ?? { admin: h.admin, id: h.id, holdings: [] };
          g.holdings.push(h);
          byInstrument.set(key, g);
        }
        return reply.send({
          party,
          instruments: [...byInstrument.values()].map((g) => ({
            admin: g.admin,
            id: g.id,
            // Exact BigInt sum of the ledger Decimals, not a float.
            total: sumLedgerDecimals(g.holdings.map((h) => h.amount)),
            holdings: g.holdings.map((h) => ({
              cid: h.cid,
              amount: h.amount,
              locked: h.locked,
            })),
          })),
        });
      } catch (err) {
        return relayError(reply, "holdings", err, party);
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
        return relayError(reply, "balance", err, party);
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
  //    Amulet (default): resolved on the SV Scan registry root. A non-Amulet
  //    CIP-56 token (`instrumentId.admin` listed in `tokenRegistries`) is
  //    resolved on its DA Registry Utility (per-registrar path) instead —
  //    symmetric to ScanClient.resolveTransferKind on the settle side.
  app.post<{
    Body: {
      sender: string;
      receiver: string;
      amount: string;
      meta?: Record<string, string>;
      /** Non-Amulet CIP-56 instrument to resolve. Omit for Canton Coin. */
      instrumentId?: { admin: string; id: string };
      /** The holdings the caller intends to spend. The SV Scan accepts an empty
       *  list for an Amulet resolve; a DA Registry Utility answers 400
       *  "No holdings provided" to it, so a registry resolve must carry the
       *  real cids. Optional for Amulet; required in practice for a registry
       *  token. */
      inputHoldingCids?: string[];
    };
  }>("/v1/wallet/resolve/transfer-factory", async (req, reply) => {
    if (!authed(req, reply)) return;
    const { sender, receiver, amount, meta, instrumentId, inputHoldingCids } =
      req.body ?? ({} as never);
    if (!sender || !receiver || !amount) {
      return reply.code(400).send({ error: "sender, receiver, amount required" });
    }
    // A caller that names an instrument we have no registry for must get a hard
    // error, not a silent Amulet factory for the wrong asset.
    if (instrumentId?.admin && !svc.tokenRegistries?.[instrumentId.admin]) {
      return reply.code(400).send({
        error: "no registry configured for this instrument admin",
        admin: instrumentId.admin,
      });
    }
    try {
      const registryBaseUrl = instrumentId?.admin
        ? svc.tokenRegistries?.[instrumentId.admin]
        : undefined;
      // Amulet: admin = DSO, id = "Amulet". Non-Amulet: caller-supplied {admin,id}.
      const admin = registryBaseUrl ? instrumentId!.admin : await getDso();
      const id = registryBaseUrl ? instrumentId!.id : "Amulet";
      const now = Date.now();
      const reqBody = JSON.stringify({
        choiceArguments: {
          expectedAdmin: admin,
          transfer: {
            sender,
            receiver,
            amount,
            instrumentId: { admin, id },
            requestedAt: new Date(now).toISOString(),
            executeBefore: new Date(now + 3_600_000).toISOString(),
            // FORWARD THE CALLER'S HOLDINGS, DO NOT SEND AN EMPTY LIST.
            //
            // This was `inputHoldingCids: []` regardless of what the caller
            // had, and for Amulet that was invisible: the SV Scan resolves a
            // transfer kind without caring about inputs. A DA Registry Utility
            // does care — measured live, it answers 400 "No holdings provided"
            // — so every registry withdraw died here with a bare "transfer-
            // factory HTTP 400" and nothing in the log saying why. Same class
            // as the stash-probe defect found on /settle, in a second route.
            inputHoldingCids: Array.isArray(inputHoldingCids) ? inputHoldingCids : [],
            meta: { values: meta ?? {} },
          },
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
        excludeDebugFields: true,
      });
      let r: Response;
      if (registryBaseUrl) {
        // DA Registry Utility, per-registrar path. Bounded transient-retry,
        // mirroring scanFetchRetry (idempotent registry read).
        const url = `${registryBaseUrl}/api/token-standard/v0/registrars/${encodeURIComponent(
          admin
        )}/registry/transfer-instruction/v1/transfer-factory`;
        let res: Response | undefined;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          res = undefined; // reset so a throw on THIS attempt is not masked by a
          //                  stale Response from a previous one
          try {
            res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: reqBody,
            });
          } catch (err) {
            lastErr = err;
          }
          if (res?.ok) break;
          const transient = !res || res.status === 429 || res.status >= 500;
          if (transient && attempt < 3) {
            await new Promise((rr) =>
              setTimeout(rr, 400 * 2 ** attempt + Math.floor(Math.random() * 150))
            );
            continue;
          }
          break;
        }
        if (!res) throw lastErr ?? new Error("registry fetch failed");
        r = res;
      } else {
        r = await scanFetchRetry(
          `/registry/transfer-instruction/v1/transfer-factory`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: reqBody,
          }
        );
      }
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
        instrumentId: { admin, id },
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
  app.post<{ Body: { instructionCid: string; instrumentAdmin?: string } }>(
    "/v1/wallet/resolve/accept",
    async (req, reply) => {
      if (!authed(req, reply)) return;
      const cid = req.body?.instructionCid;
      if (!cid) return reply.code(400).send({ error: "instructionCid required" });
      // INBOUND MUST ROUTE LIKE OUTBOUND DOES.
      //
      // The choice-context for accepting a transfer instruction comes from the
      // registry that issued it. For Amulet that is the SV Scan, which is what
      // scanFetchRetry talks to; for a CIP-56 token it is that token's registry
      // utility, under the per-registrar path. Sending a USDCx instruction's
      // cid to the SV Scan asks the wrong registry and cannot succeed.
      //
      // The outbound half of this — resolve/transfer-factory — already routes by
      // `instrumentAdmin`; this side did not, so a wallet could SEND a registry
      // token and not ACCEPT one. `instrumentAdmin` is optional in the body:
      // omitted (or not a configured registry) keeps the SV Scan path exactly
      // as it was, so no existing caller changes behaviour.
      const acceptAdmin = req.body?.instrumentAdmin;
      // Route by registrar ONLY when the admin names a configured registry. The
      // DSO (Amulet) and any admin this facilitator does not know fall through
      // to the SV Scan — the path every pre-registry client took — so a row
      // that carries an instrumentId (every TransferInstructionV1 view does,
      // Amulet included) never turns a Canton Coin claim into a 400.
      const acceptRegistryBase = acceptAdmin
        ? svc.tokenRegistries?.[acceptAdmin]
        : undefined;
      if (acceptRegistryBase) {
        const url =
          `${acceptRegistryBase}/api/token-standard/v0/registrars/` +
          `${encodeURIComponent(acceptAdmin!)}/registry/transfer-instruction/v1/` +
          `${encodeURIComponent(cid)}/choice-contexts/accept`;
        try {
          const rr = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ meta: {} }),
          });
          if (!rr.ok) throw new Error(`registry choice-contexts/accept HTTP ${rr.status}`);
          const j = (await rr.json()) as {
            choiceContextData: unknown;
            disclosedContracts: unknown[];
          };
          return reply.send({
            choiceContextData: j.choiceContextData,
            disclosedContracts: j.disclosedContracts,
          });
        } catch (err) {
          return relayError(reply, "resolve/accept", err);
        }
      }
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
  app.get<{ Params: { party: string }; Querystring: { registry?: string } }>("/v1/wallet/:party/pending", async (req, reply) => {
    if (!authed(req, reply)) return;
    const party = req.params.party;
    // Registry-token rows are OPT-IN (`?registry=1`): a client that does not ask
    // for them is a pre-registry agent-wallet whose claim loop aborts on the
    // first accept it cannot route, so for it the answer stays what it was —
    // Canton Coin instructions only.
    const wantRegistry = req.query?.registry === "1" || req.query?.registry === "true";
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
                      includeInterfaceView: true,
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              },
            ],
          },
        },
      });
      // READ THE INTERFACE VIEW, NOT THE TEMPLATE NAME.
      //
      // The interface filter above already proves every row IS a
      // TransferInstruction — that is what an interface filter means. The old
      // code then re-checked by regex on the TEMPLATE name and read the
      // receiver out of createArgument. Both assume the Amulet implementation:
      // a DA Registry Utility names its template
      // `Utility.Registry.App.V0.Model.Transfer:TransferOffer`, which the regex
      // rejects, so an inbound USDCx offer was returned by the participant and
      // then dropped on this line. Measured: the participant returned 2, the
      // route answered []. The view is the one shape the standard guarantees;
      // createArgument is whatever the issuer chose.
      const pending: Array<{
        cid: string;
        amount: string | undefined;
        sender: string | undefined;
        instrumentId?: { admin: string; id: string };
        /** ISO instant after which the ledger refuses the accept. */
        executeBefore?: string;
      }> = [];
      for (const e of events) {
        const view = e.interfaceViews?.find((v) =>
          v.interfaceId.endsWith(":Splice.Api.Token.TransferInstructionV1:TransferInstruction")
        )?.viewValue as
          | {
              transfer?: {
                amount?: string;
                sender?: string;
                receiver?: string;
                executeBefore?: string;
                instrumentId?: { admin?: string; id?: string };
              };
              status?: { tag?: string };
            }
          | undefined;
        // Fall back to createArgument ONLY for a row with no view — an older
        // Amulet template that predates views. Never for a registry row.
        const t =
          view?.transfer ??
          (e.createArgument as { transfer?: { amount?: string; sender?: string; receiver?: string } } | undefined)
            ?.transfer;
        if (t?.receiver !== party) continue;
        const admin = view?.transfer?.instrumentId?.admin;
        const id = view?.transfer?.instrumentId?.id;
        const executeBefore = view?.transfer?.executeBefore;
        // Canton Coin = the Amulet instruction TEMPLATE (the same name test the
        // pre-registry route used, so a client that never asks for registry
        // rows sees exactly the class it always saw) carrying the Amulet id or
        // no view at all. The instrument id is written by the row itself, so
        // it alone cannot promote a row into the Canton Coin class: a registrar
        // naming a token "Amulet" stays a registry row.
        const amuletTemplate = /TransferInstruction/.test(e.templateId ?? "");
        const isAmulet = amuletTemplate && (id === undefined || id === "Amulet");
        // A registry row is listed only when asked for AND when this
        // facilitator can actually route its accept (a configured registry);
        // a row for a registrar we do not know would only send the client to
        // a dead end (the SV Scan has no context for it).
        if (!isAmulet && (!wantRegistry || !(admin && svc.tokenRegistries?.[admin]))) continue;
        pending.push({
          cid: e.contractId,
          amount: t.amount,
          sender: t.sender,
          ...(admin && id ? { instrumentId: { admin, id } } : {}),
          ...(executeBefore ? { executeBefore } : {}),
        });
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
          // RELEASE ONLY WHEN THE FAILURE PROVES NOTHING MOVED.
          //
          // The reservation is per-party-once — it is the only thing stopping
          // a second real CC payout to the same party. Releasing it on ANY
          // throw meant a submit that timed out AFTER the participant
          // committed (or any 5xx) looked identical to a clean refusal: the
          // party claims again, CC leaves twice, and the daily/lifetime budget
          // never sees the first payout at all.
          //
          // A definite 4xx from the participant means it processed the request
          // and refused it, so nothing changed and a retry is right. Anything
          // else is "I do not know", and on a money path that has to fail
          // closed: the reservation STANDS. The cost is an honest party losing
          // its one claim during our outage, which an operator can undo — the
          // other way round, the CC is simply gone.
          //
          // FaucetPreSubmitError is the other proof: the claim died in the Scan
          // read, the ACS query, or the registry resolve — all of them strictly
          // before anything was sent to the ledger. Treating those as ambiguous
          // charged an honest agent its one lifetime claim, and charged the
          // daily + lifetime budget, for CC that never left the building. Our
          // own registry timing out is not the agent's fault.
          if (err instanceof FaucetPreSubmitError || provesNothingCommitted(err)) {
            await faucetCfg.store.release(party).catch(() => {});
          } else {
            req.log.error(
              { err, party },
              "faucet claim failed AMBIGUOUSLY (may have committed) — keeping the " +
                "per-party reservation so it cannot pay out twice; release it by " +
                "hand only after checking the ledger"
            );
          }
          // Unwrap for the WIRE: the caller should see the upstream status
          // (a Scan 503 stays a 503), not our internal marker class.
          return relayError(
            reply,
            "faucet/claim",
            err instanceof FaucetPreSubmitError ? err.cause : err
          );
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

  // ── transfer-factory ("V3") pay: relay-build + prepare (inline carriage) ──
  //   The relay builds the token-standard transfer ITSELF (faucet-pattern
  //   build, but sender = the agent party and prepare is an interactive
  //   submission the agent will sign). It returns the prepared bytes + hash;
  //   the agent verifies them (assertPreparedTransferMatches), signs, and
  //   carries the signed transaction INLINE in its payment payload. The relay
  //   stores nothing — any facilitator can later relay the inline payload.
  const tfPay = svc.tfPay;
  /** Positive Daml Decimal (≤10 frac digits) — the ledger amount grammar. */
  const TF_AMOUNT_RE = /^\d{1,15}(\.\d{1,10})?$/;

  /**
   * WASTED-PREPARE BUDGET, per payer.
   *
   * A prepare that fails writes nothing and so costs nothing to repeat — and a
   * failed prepare is pure loss (a successful one is paid for by the payment it
   * produces). Pure loss is exactly what an unfunded client in a retry loop
   * generates. Measured on production: three payers with a balance of exactly
   * 0 CC, ~15 prepares a minute each, for three weeks — every one of them a DSO
   * lookup plus a full ACS query against the participant.
   *
   * So the budget is spent on the OUTCOME, not on arrival: a prepare that
   * succeeds costs nothing here and an honest busy client never sees this at
   * all. Only a refusal caused by the payer's OWN STATE is charged. Our own
   * failures — the participant erroring, Scan down — are NOT charged: the
   * client did nothing wrong and throttling them for our outage is the same
   * mistake as refusing a commit because our topology reader is unreachable.
   */
  /**
   * SUBMIT BUDGET. `/v1/wallet/submit/execute` hands bytes straight to
   * `interactiveSubmissionExecute` — a real ledger submission that spends our
   * Global Synchronizer traffic — behind nothing but a presence check and
   * `authed()`, which is a no-op unless the relay key is set (it is not on
   * this deployment). The choice allowlist guards submit/PREPARE, the cheap
   * step; the expensive one was open.
   *
   * Keyed on the pair (claimed party, caller IP) for the same reason the
   * wasted-prepare budget is: the party in the body is caller-asserted, so
   * keying on it alone would let a stranger spend a victim's budget. The cap
   * is deliberately generous — this bounds abuse, it is not a throttle on
   * honest use, and an agent doing more than this in a minute is not a shape
   * we have ever seen.
   */
  const submitLimiter = createSlidingWindowLimiter({
    maxPerPayer: svc.submitRateMaxPerKey ?? 60,
    maxGlobal: 0,
    windowMs: 60_000,
  });

  /**
   * Per-IP bound for the three routes that had none: onboard/prepare,
   * onboard/finalize and submit/prepare. They are anonymous in production
   * (authed() is inert without CANTON_X402_AGENT_WALLET_KEY, which an
   * out-of-box agent could not present anyway), and onboard/finalize writes
   * permanent topology under our participant on our traffic. Keyed on the
   * caller, not on a body field: every body field here is caller-asserted, so
   * a per-party key would be a budget a stranger could spend — the same
   * lesson the pay/prepare cap already learned.
   */
  const onboardLimiter = createSlidingWindowLimiter({
    maxPerPayer: svc.submitRateMaxPerKey ?? 60,
    // A GLOBAL arm, unlike the per-payer budgets elsewhere in this file.
    //
    // I added the per-IP cap above and stopped there, which bounds nothing
    // that matters: `onboard/finalize` allocates a PERMANENT party, writes
    // topology to the Global Synchronizer on our traffic, and takes a
    // user-rights slot — all shared, none of it per-caller. Per-IP admission
    // control over a shared resource costs an attacker one extra IP per
    // bucket and costs us one permanent allocation every time. The route is
    // anonymous in production, so that is the whole price.
    //
    // The per-payer limiters here genuinely must NOT have a global arm (one
    // payer looping would deny prepares to everyone). That reasoning does not
    // transfer: there is no payer here, and the resource is not divisible.
    // /settle already carries a global arm for exactly this reason.
    maxGlobal: svc.onboardRateMaxGlobal ?? 60,
    windowMs: 60_000,
  });
  /**
   * Charge the global allocation budget — called ONLY immediately before the
   * allocation itself, never at admission.
   *
   * That split is this file's existing rule, and it is load-bearing: charging
   * the scarce budget on arrival lets a stream of well-formed nonsense, which
   * costs us only a decode, exhaust the budget for the requests that actually
   * spend. Admission is the per-IP cap above; this is the spend.
   */
  const onboardSpendAllowed = (
    req: FastifyRequest,
    reply: FastifyReply
  ): boolean => {
    if (onboardLimiter.allowKeys([], Date.now())) return true;
    // Error, not warn: the per-IP caps refuse abusers long before this trips,
    // so reaching it means either a distributed attempt or a real surge — both
    // are things an operator wants to be told about, not a normal refusal.
    req.log.error(
      { cap: svc.onboardRateMaxGlobal },
      "wallet relay: GLOBAL party-allocation budget exhausted — no party allocated"
    );
    reply
      .code(429)
      .header("Retry-After", "60")
      .send({ error: "party allocation is rate-limited facilitator-wide" });
    return false;
  };
  const onboardAllowed = (
    req: FastifyRequest,
    reply: FastifyReply,
    where: string
  ): boolean => {
    const cap = svc.submitRateMaxPerKey ?? 60;
    if (cap <= 0) return true;
    if (
      onboardLimiter.allowKeys(
        [{ key: `${where}|${clientIp(req)}`, max: cap }],
        Date.now(),
        false
      )
    ) {
      return true;
    }
    req.log.warn({ where, cap }, "wallet relay: onboarding rate-limited");
    reply
      .code(429)
      .header("Retry-After", "60")
      .send({ error: "too many onboarding requests" });
    return false;
  };

  const prepareWasteLimiter = createSlidingWindowLimiter({
    maxPerPayer: tfPay?.wasteMax ?? 0,
    // No global arm: this budget is per payer by construction. One payer
    // looping must not be able to refuse prepares for everyone else — that
    // would hand any client a denial of service against the whole relay.
    maxGlobal: 0,
    windowMs: tfPay?.wasteWindowMs ?? 300_000,
  });

  /**
   * Input Amulets already handed to a prepare whose transfer can still execute:
   * cid -> the moment its executeBefore passes.
   *
   * Selection reads the ACS and remembered nothing, so two prepares for one
   * party that overlap in time picked the SAME holdings. Both callers got a
   * valid signed transfer over one Amulet; the ledger settles one and refuses
   * the other, and that refusal used to reach the client as the ambiguous
   * `invalid_exact_canton_execute_failed` — the code it stops dead on. A
   * collision the relay handed out itself became a payment that needed a human
   * to reconcile. (settle.ts now names the refusal for what it is, which makes
   * the loser retryable; this stops manufacturing the collision in the first
   * place.)
   *
   * Same shape as the client-side `reserveHolding` in agent-wallet, including
   * the property that matters most: when nothing free covers the amount it
   * FALLS BACK to the full set rather than refusing. A payer with one Amulet
   * behaves exactly as before — no prepare that succeeds today starts failing,
   * and an abandoned prepare never locks a funded wallet out of its own money.
   * The gain is the multi-holding case, where two concurrent payments now get
   * disjoint inputs and both settle.
   *
   * TTL = the prepare's own executeBefore horizon (≤ maxExecuteBeforeSeconds);
   * past it the transfer cannot settle. A settled transfer needs no release —
   * its input is archived and never comes back from queryActiveContracts.
   */
  /**
   * EVERY CIP-56 TOKEN'S HOLDINGS, READ THE ONE WAY THE STANDARD GUARANTEES.
   *
   * A registry token's concrete Holding template is the issuer's own, so it
   * cannot be pinned by name; what the token standard DOES guarantee is the
   * `Splice.Api.Token.HoldingV1:Holding` interface with its view. Query by the
   * interface, keep the view, and a single read serves any instrument.
   *
   * Shared on purpose. This is the read `pay` already makes inside
   * selectPartyInputs; `balance`, `withdraw` and `merge` used to get their
   * inputs from /balance instead, which enumerates `Splice.Amulet:Amulet` by
   * TEMPLATE — so an agent holding USDCx could pay with it and could not see
   * it. Four commands with one root cause, fixed in one place rather than four.
   *
   * `instrument` undefined returns every instrument's holdings (for a balance
   * listing); set, only that instrument's — unlocked, owned by the party.
   */
  const readHoldingsV1 = async (
    party: string,
    instrument?: { admin: string; id: string }
  ): Promise<
    Array<{ cid: string; amount: string; admin: string; id: string; locked: boolean }>
  > => {
    const events = await svc.client.queryActiveContracts({
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId:
                      "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",
                    includeInterfaceView: true,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });
    return events
      .map((e) => {
        const view = e.interfaceViews?.find((v) =>
          v.interfaceId.endsWith(":Splice.Api.Token.HoldingV1:Holding")
        )?.viewValue as
          | {
              owner?: string;
              instrumentId?: { admin?: string; id?: string };
              amount?: string;
              lock?: unknown;
            }
          | undefined;
        // Ledger Decimal kept as the STRING the view carries — a Number round
        // trip can read one atomic more than exists.
        const amountStr = typeof view?.amount === "string" ? view.amount : "0";
        let positive = false;
        try {
          positive = BigInt(decimalToAtomicCC(amountStr)) > 0n;
        } catch {
          positive = false;
        }
        return {
          cid: e.contractId,
          amount: amountStr,
          positive,
          admin: view?.instrumentId?.admin ?? "",
          id: view?.instrumentId?.id ?? "",
          owner: view?.owner,
          locked: view?.lock !== null && view?.lock !== undefined,
        };
      })
      .filter(
        (h) =>
          Boolean(h.cid) &&
          h.positive &&
          h.owner === party &&
          h.admin.length > 0 &&
          (instrument === undefined ||
            (h.admin === instrument.admin && h.id === instrument.id))
      )
      .map(({ cid, amount, admin, id, locked }) => ({ cid, amount, admin, id, locked }));
  };

  const reservedInputs = new Map<string, number>();

  /** Largest-first Amulet selection for the AGENT party, with the same fee
   *  headroom the faucet uses. Returns everything selected plus the party's
   *  scanned total so the route can report an honest insufficient error. */
  const selectPartyInputs = async (
    party: string,
    wantCc: number,
    reserveForMs: number,
    /** Non-Amulet CIP-56 instrument to spend. When set, holdings are read via
     *  the HoldingV1 interface view and filtered to this {admin,id}; otherwise
     *  the Amulet template path (unchanged) is used. */
    instrument?: { admin: string; id: string }
  ): Promise<{ cids: string[]; totalCc: number }> => {
    let holdings: Array<{ cid: string; amount: number }>;
    if (instrument) {
      // One read for every registry token — see readHoldingsV1. Unlocked only:
      // a locked holding cannot be an input.
      holdings = (await readHoldingsV1(party, instrument))
        .filter((h) => !h.locked)
        // Number only for ORDERING and the insufficient-funds message; the
        // exact amounts never leave this selection.
        .map((h) => ({ cid: h.cid, amount: Number(h.amount) }))
        .sort((a, b) => b.amount - a.amount);
    } else {
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
      holdings = events
        .map((e) => ({
          cid: e.contractId,
          amount: Number(
            (e.createArgument as { amount?: { initialAmount?: string } } | undefined)
              ?.amount?.initialAmount ?? 0
          ),
        }))
        .filter((h) => Boolean(h.cid) && h.amount > 0)
        .sort((a, b) => b.amount - a.amount);
    }
    // Amulet carries a per-transfer fee, so the selection needs a little
    // headroom over the exact amount; a generic CIP-56 token has no such fee in
    // the standard, so pick to the exact amount.
    const headroom = instrument ? 0 : 0.01;
    // FROM HERE TO THE RETURN THERE IS NO `await`, AND THAT IS THE POINT.
    //
    // Reading the reservations and writing them back has to be one indivisible
    // step. Both concurrent requests already share this ACS snapshot; if the
    // second could suspend between "these look free" and "they are mine now",
    // it would re-derive the first one's answer and we would be back to two
    // transfers over one Amulet. Node runs a synchronous block to completion,
    // so keeping the read-modify-write synchronous makes it atomic — no lock,
    // no ordering assumption.
    const now = Date.now();
    for (const [cid, until] of reservedInputs) {
      if (until <= now) reservedInputs.delete(cid);
    }
    const total = holdings.reduce((sum, h) => sum + h.amount, 0);
    // `covered` is what decides whether the reservation-aware answer is usable;
    // the cid list itself keeps the pre-existing shape (accumulate largest-first
    // until the amount plus fee headroom is met, or until the holdings run out —
    // the short case is rejected by the caller's insufficient-holdings check).
    const pick = (
      from: typeof holdings
    ): { cids: string[]; covered: boolean } => {
      const cids: string[] = [];
      let selected = 0;
      for (const h of from) {
        if (selected >= wantCc + headroom) break;
        cids.push(h.cid as string);
        selected += h.amount;
      }
      return { cids, covered: selected >= wantCc + headroom };
    };
    // Prefer holdings no sibling prepare is already spending; fall back to the
    // full set when those cannot cover the amount, which is exactly the
    // pre-existing behaviour.
    const free = pick(holdings.filter((h) => !reservedInputs.has(h.cid as string)));
    if (free.covered) {
      const until = now + reserveForMs;
      for (const cid of free.cids) reservedInputs.set(cid, until);
      return { cids: free.cids, totalCc: total };
    }
    return { cids: pick(holdings).cids, totalCc: total };
  };

  app.post<{
    Body: {
      party?: string;
      receiver?: string;
      amount?: string;
      executeBeforeSeconds?: number;
      memo?: unknown;
      /** Payer-supplied venue-attribution meta (keys ending in `/venue`). Bounded
       *  + validated below; merged into the prepared transfer meta so an issuer's
       *  incentive program can attribute the payment. Cannot clobber x402.memo. */
      venueMeta?: unknown;
      /** Non-Amulet CIP-56 instrument to pay in. Omit for Canton Coin — the
       *  relay then uses admin=DSO, id="Amulet". Its admin must be present in
       *  CANTON_X402_TOKEN_REGISTRIES or the request is rejected. */
      instrumentId?: { admin: string; id: string };
    };
  }>("/v1/wallet/pay/prepare", async (req, reply) => {
    if (!authed(req, reply)) return;
    // A named instrument with no configured registry is a hard error, not a
    // silent Amulet payment for the wrong asset (mirrors resolve/transfer-factory).
    const reqInstrument = req.body?.instrumentId;
    if (reqInstrument?.admin && !svc.tokenRegistries?.[reqInstrument.admin]) {
      return reply.code(400).send({
        error: "no registry configured for this instrument admin",
        admin: reqInstrument.admin,
      });
    }
    if (!tfPay) {
      return reply.code(503).send({ error: "transfer-factory pay disabled" });
    }
    // NAME THE REJECT IN THE LOG, not only in the response body.
    //
    // These branches were silent, and silence made a live signal
    // undiagnosable: on production this route answers 400 several times more
    // often than 200 — a handful of clients looping on input we refuse — and
    // the only way to learn WHICH branch was to redeploy for the answer. The
    // body already tells the client; the operator deserves the same sentence.
    // Info, not warn: a rejected input is normal traffic, and the reason to
    // log it is that the SHAPE of the rejections over time is the diagnosis.
    const badInput = (reason: string) => {
      req.log.info(
        { reason, party: party ?? null, receiver: receiver ?? null },
        "pay/prepare rejected: bad input"
      );
      return reply.code(400).send({ error: reason });
    };
    const party = req.body?.party?.trim();
    const receiver = req.body?.receiver?.trim();
    const amount = req.body?.amount?.trim();
    if (!party || !receiver || !amount) {
      return badInput("party, receiver, amount required");
    }
    if (!FAUCET_PARTY_RE.test(party) || !FAUCET_PARTY_RE.test(receiver)) {
      return badInput("party or receiver is malformed");
    }
    if (party === receiver) {
      return badInput("receiver must differ from party (self-payment)");
    }
    if (!TF_AMOUNT_RE.test(amount) || Number(amount) <= 0) {
      return badInput("amount must be a positive Daml Decimal string");
    }
    // Optional merchant memo (PaymentRequirements.extra.memo): when present it
    // MUST be a non-empty string of at most 512 chars. It is stamped into the
    // transfer's `x402.memo` meta, which the payer signs, so the inline verify
    // can enforce it against the merchant's requirement.
    const rawMemo = req.body?.memo;
    let memo: string | undefined;
    if (rawMemo !== undefined) {
      if (typeof rawMemo !== "string") {
        return badInput("memo must be a string");
      }
      const trimmed = rawMemo.trim();
      if (trimmed.length === 0 || trimmed.length > 512) {
        return badInput("memo must be a non-empty string of at most 512 chars");
      }
      memo = trimmed;
    }
    // Optional venue-attribution meta: the PAYER's self-attested `/venue` tag(s),
    // merged into the prepared transfer meta below so a token issuer's incentive
    // program can attribute this payment. BOUNDED on this shared service so
    // pay/prepare can never become an arbitrary-meta injection vector: a small map
    // whose keys MUST end in `/venue` (which also structurally excludes x402.memo,
    // and the merge below puts the merchant memo last so it always wins).
    const rawVenue = req.body?.venueMeta;
    let venueMeta: Record<string, string> | undefined;
    if (rawVenue !== undefined) {
      if (typeof rawVenue !== "object" || rawVenue === null || Array.isArray(rawVenue)) {
        return badInput("venueMeta must be an object of string values");
      }
      const entries = Object.entries(rawVenue as Record<string, unknown>);
      if (entries.length > 4) return badInput("venueMeta may carry at most 4 keys");
      const out: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (k.length === 0 || k.length > 64 || !k.endsWith("/venue")) {
          return badInput("each venueMeta key must be a string ending in '/venue' (<=64 chars)");
        }
        if (typeof v !== "string" || v.trim().length === 0 || v.length > 128) {
          return badInput("each venueMeta value must be a non-empty string (<=128 chars)");
        }
        out[k] = v;
      }
      if (Object.keys(out).length > 0) venueMeta = out;
    }
    const requested = Number(req.body?.executeBeforeSeconds);
    // FLOOR AT ONE SECOND. `Math.trunc(0.5)` is 0, which would produce a transfer
    // whose executeBefore is already in the past at the instant it is prepared —
    // dead on arrival. A fractional horizon is worth a floor rather than a
    // rounding so the prepared transfer is always settleable for at least a
    // second.
    const ebSeconds =
      Number.isFinite(requested) && requested > 0
        ? Math.min(
            Math.max(1, Math.trunc(requested)),
            tfPay.maxExecuteBeforeSeconds
          )
        : tfPay.defaultExecuteBeforeSeconds;
    // Budget check BEFORE the expensive part — that is the whole point. A
    // payer who has already burned its waste budget is refused without a DSO
    // lookup or an ACS query, so the loop stops costing participant work.
    // Retry-After names the window so a client that reads it can back off
    // instead of guessing.
    const wasteMax = tfPay.wasteMax ?? 0;
    const wasteWindowMs = tfPay.wasteWindowMs ?? 300_000;
    // KEY ON THE PAIR (party, caller IP) — never on the party alone.
    //
    // `party` is req.body.party: unauthenticated (authed() is a no-op unless
    // CANTON_X402_AGENT_WALLET_KEY is set, and it is not set on this
    // deployment) and validated for SHAPE only. Party ids are public — they
    // are the sender on every on-ledger payment. And TF_AMOUNT_RE accepts
    // fifteen integer digits, so `amount: "999999999999999"` reaches the
    // insufficient-holdings branch for ANY party, funded or not.
    //
    // Keyed on the party alone, that let a stranger spend a victim's budget
    // and lock the victim's own funded agent out of pay/prepare — which is the
    // only way the V3 path obtains a prepared transaction, so out of the money
    // path entirely, for ~nothing. I introduced that today; this removes it.
    //
    // Two SEPARATE buckets (party OR ip) would not fix it: the attacker fills
    // the party bucket and the victim is refused on that arm regardless of
    // their own IP. Only the composite lands the abuse in a bucket the victim
    // never touches, while a genuinely stuck client — one party looping from
    // one host, which is the case actually observed in production — still
    // fills its own.
    const wasteKey = `prepare-waste:${party}|${clientIp(req)}`;
    if (!prepareWasteLimiter.peek(wasteKey, Date.now(), wasteMax)) {
      req.log.warn(
        { party, receiver, wasteMax, wasteWindowMs },
        "pay/prepare refused: payer exhausted its wasted-prepare budget"
      );
      return reply
        .code(429)
        .header("Retry-After", String(Math.ceil(wasteWindowMs / 1000)))
        .send({
          error:
            "too many failed pay/prepare attempts for this party — fund the wallet, then retry",
        });
    }
    try {
      // Amulet (default): admin=DSO, id="Amulet", resolved on the SV Scan.
      // Non-Amulet CIP-56 token: caller-supplied {admin,id}, resolved on its DA
      // Registry Utility (per-registrar path), inputs read via the HoldingV1
      // interface. The 400 guard above already rejected an admin with no registry.
      const registryBaseUrl = reqInstrument?.admin
        ? svc.tokenRegistries?.[reqInstrument.admin]
        : undefined;
      const admin = registryBaseUrl ? reqInstrument!.admin : await getDso();
      const id = registryBaseUrl ? reqInstrument!.id : "Amulet";
      const { cids, totalCc } = await selectPartyInputs(
        party,
        Number(amount),
        ebSeconds * 1000,
        ...(registryBaseUrl ? ([{ admin, id }] as const) : ([] as const))
      );
      if (totalCc < Number(amount)) {
        // LOG IT. This is the single most common answer this route gives on
        // production — measured: 1241 of 1259 prepares in one eight-minute
        // window — and it was invisible, so the traffic read as "clients
        // sending us garbage" when the truth is agents retrying a payment
        // their wallet cannot fund.
        //
        // It is also the expensive refusal. Unlike the input checks above it
        // costs a DSO lookup and a full ACS query against the payer party
        // before it can be reached (~60ms of participant work per attempt), and
        // a client looping on an unfunded wallet would drive unlimited
        // participant queries. Making it visible is the first half; the
        // wasted-prepare budget charged just below is the bound.
        // CHARGE. This refusal is the payer's own state, and reaching it cost
        // real participant work — exactly the waste the budget exists to bound.
        prepareWasteLimiter.allowKeys(
          [{ key: wasteKey, max: wasteMax }],
          Date.now(),
          false
        );
        req.log.info(
          { party, receiver, balanceCc: totalCc.toFixed(10), amountCc: amount },
          "pay/prepare rejected: insufficient holdings"
        );
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
        instrumentId: { admin, id },
        requestedAt: new Date(now - 1000).toISOString(),
        executeBefore,
        inputHoldingCids: cids,
        meta: {
          values: {
            // Venue tag(s) FIRST, merchant memo LAST: x402.memo can never be
            // clobbered by a payer-supplied venue key (they are also disjoint by
            // the `/venue` suffix rule, so this is belt-and-suspenders).
            ...(venueMeta ?? {}),
            ...(memo !== undefined ? { "x402.memo": memo } : {}),
          } as Record<string, string>,
        },
      };
      // Registry resolve with the REAL transfer (inputs included). Amulet → SV
      // Scan; a non-Amulet token → its DA Registry Utility per-registrar path
      // (bounded transient-retry, mirroring resolve/transfer-factory).
      const resolveBody = JSON.stringify({
        choiceArguments: {
          expectedAdmin: admin,
          transfer,
          extraArgs: { context: { values: {} }, meta: { values: {} } },
        },
        excludeDebugFields: true,
      });
      let r: Response;
      if (registryBaseUrl) {
        const url = `${registryBaseUrl}/api/token-standard/v0/registrars/${encodeURIComponent(
          admin
        )}/registry/transfer-instruction/v1/transfer-factory`;
        let res: Response | undefined;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          res = undefined;
          try {
            res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: resolveBody,
            });
          } catch (err) {
            lastErr = err;
          }
          if (res?.ok) break;
          const transient = !res || res.status === 429 || res.status >= 500;
          if (transient && attempt < 3) {
            await new Promise((rr) =>
              setTimeout(rr, 400 * 2 ** attempt + Math.floor(Math.random() * 150))
            );
            continue;
          }
          break;
        }
        if (!res) throw lastErr ?? new Error("registry fetch failed");
        r = res;
      } else {
        r = await scanFetchRetry(
          `/registry/transfer-instruction/v1/transfer-factory`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: resolveBody,
          }
        );
      }
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
                expectedAdmin: admin,
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
      // The relay stores nothing: the agent carries the signed transaction
      // INLINE in its payment payload, so everything it needs is right here —
      // the prepared transaction and its hash for verify-before-sign.
      return reply.send({
        preparedTransaction: prepared.preparedTransaction,
        txHash: prepared.preparedTransactionHash,
        executeBefore,
        sender: party,
        receiver,
        amount,
        instrumentId: { admin, id },
      });
    } catch (err) {
      return relayError(reply, "pay/prepare", err, party);
    }
  });

}