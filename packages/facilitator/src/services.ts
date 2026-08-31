/**
 * Service composition root. Builds the canton/* services from a
 * FacilitatorConfig so that the Fastify route handlers can be tested
 * against mocks of this same Services shape.
 *
 * Constructing here (not inside server.ts) keeps server.ts a thin
 * orchestrator and gives route tests a precise dependency surface.
 */

import type { CantonNetwork } from "@ftptech/x402-canton-core";
import type { FacilitatorConfig } from "./config.js";
import { CantonClient, type TokenProvider, ScanClient } from "@ftptech/x402-canton-ledger";
import { MerchantContractService } from "./canton/merchant-contract.js";
import { mintUnsafeHmacJwt, createOidcTokenProvider } from "./auth/token.js";
import { createConsumedStore, type ConsumedPaymentStore } from "./db/consumed-store.js";
import {
  createInlineSettleStore,
  type InlineSettleStore,
} from "./db/inline-settle-store.js";
import { createFaucetStore, type FaucetClaimStore } from "./db/faucet-store.js";
import { TransferFactoryService } from "./canton/transfer-factory.js";
import { PreapprovalService } from "./canton/preapproval.js";
import type { SlidingWindowConfig, CircuitBreakerConfig } from "./rate-limit.js";
import {
  createAttributionStore,
  type AttributionStore,
} from "./db/attribution-store.js";
import {
  createMarkerStore,
  type MarkerStore,
} from "./db/marker-store.js";
import {
  createFacilitatorPool,
  poolExecutor,
  type PgExecutor,
} from "./db/pool.js";
import { createMetrics, type FacilitatorMetrics } from "./metrics.js";
import {
  createReadinessProbe,
  type ReadinessProbe,
  type ReadinessCheckResult,
} from "./readiness.js";
import { createPayerProofVerifier } from "./canton/payer-proof.js";
import { createTopologyReaderLookup } from "./canton/topology-reader-client.js";

export interface Services {
  client: CantonClient;
  scan: ScanClient;
  merchantContract: MerchantContractService;
  facilitatorParty: string;
  synchronizerId: string;
  scanUrl: string;
  /** Alternate SV Scan bases for the relay's raw-fetch resolves to fail over to
   *  (mirrors ScanClient.fallbackUrls; see FacilitatorConfig.scanFallbackUrls). */
  scanFallbackUrls: string[];
  /** Non-Amulet CIP-56 instrument registries: admin party → DA Registry Utility
   *  base URL (see FacilitatorConfig.tokenRegistries). */
  tokenRegistries: Record<string, string>;
  /** CAIP-2-style network id echoed back in /supported and SettleResponse. */
  network: CantonNetwork;
  /** Ledger user id the facilitator submits commands as. */
  userId: string;
  /** Operator bearer token gating registry mutations (audit H3); unset → 503. */
  operatorToken: string | undefined;
  /** Single-use payment store (replay protection, audit M2). */
  consumed: ConsumedPaymentStore;
  /** Inline-carriage settle idempotency. Always constructed; degrades to an
   *  in-memory map when no database is configured. */
  inlineSettles: InlineSettleStore;
  /** Facilitator-as-provider preapproval (instant CC settle, Phase 2). */
  preapproval: PreapprovalService;
  /** Same PreapprovalService instance-shape, consumed by registerWalletRoutes
   *  for the SELF-PROVIDER preapproval path (merchant provisions its own). */
  selfPreapproval: PreapprovalService;
  /** Gate for the preapproval-provider route; OFF by default (money-path,
   *  needs DevNet validation). */
  enablePreapprovalProvider: boolean;
  enableAgentWallet: boolean;
  agentWalletApiKey: string | undefined;
  /** DAML choices the wallet relay's submit/prepare will build. */
  walletSubmitChoices: readonly string[];
  submitRateMaxPerKey: number;
  /** Facilitator-wide ceiling on external-party allocations per minute. */
  onboardRateMaxGlobal: number;
  submitRateMaxPerIp: number;
  /** Agent CC faucet config + store. undefined when CANTON_X402_FAUCET_ENABLED
   *  is off → the faucet route 503s. Consumed by registerWalletRoutes. */
  faucet:
    | {
        store: FaucetClaimStore;
        amountCc: string;
        maxPerIp: number;
        dailyBudgetCc: string;
        lifetimeCapCc: string;
        windowMs: number;
        internalSecret?: string | undefined;
        maxGlobalPerMin?: number | undefined;
        burstWindowMs?: number | undefined;
        ipExempt?: readonly string[] | undefined;
      }
    | undefined;
  /** transfer-factory ("V3") master switch (config.tfEnabled). Threaded to the
   *  body validator + the /verify + /settle tf branches (fail-closed when off). */
  tfEnabled: boolean;
  /** transfer-factory relay-pay surface (inline-prepare knobs). undefined when
   *  tfEnabled is off → the pay/prepare route 503s. Consumed by
   *  registerWalletRoutes. */
  tfPay:
    | {
        /** Wasted-prepare budget per payer (config.walletPrepareWaste*). */
        wasteMax: number;
        wasteWindowMs: number;
        defaultExecuteBeforeSeconds: number;
        maxExecuteBeforeSeconds: number;
      }
    | undefined;
  /** Inline-carriage payer proof (scheme Rule 3). Always present; it answers
   *  false until a participant topology read supplies the payer's signing key,
   *  so an inline payload is rejected by a real check rather than by a missing
   *  one. */
  inline: {
    /** Ceiling (seconds) on the transfer's executeBefore — the relay path's
     *  clamp, handed to the carriage that skips prepare. */
    maxExecuteBeforeSeconds?: number;
    verifySignature: ReturnType<typeof createPayerProofVerifier>;
    fetchPreapproval: (party: string) => Promise<{
      receiver: string;
      dso: string;
      expiresAt: string;
      provider?: string;
      validFrom?: string;
    } | null>;
    merchantPolicy?:
      | "open"
      | "provider"
      | "allowlist"
      | "provider-or-allowlist";
    merchantAllowlist?: readonly string[];
    fetchOwnedHoldingAmounts?: (
      party: string
    ) => Promise<Map<string, string> | undefined>;
    /** Non-Amulet CIP-56 registries (admin → utility base URL); routes inline
     *  Rule 7 to a utility for a listed instrument admin. */
    tokenRegistries?: Record<string, string>;
    /** OUT-OF-BAND-trusted registry infra parties (admin → party[]) admitted by
     *  the inline foreign-party backstop for registry tokens. */
    registryTrustedParties?: Record<string, string[]>;
  };
  /** transfer-factory settle primitive (preapproval resolve + ExecuteSubmission
   *  + funds-moved confirm). undefined when tfEnabled off. */
  transferFactory: TransferFactoryService | undefined;
  /** Rollout stage for the /settle unknown-outcome guard (config). */
  settleDispatchMark: "off" | "observe" | "enforce";
  /** /settle operational guards (sliding-window rate limit + traffic breaker). */
  settleRateLimit?: SlidingWindowConfig;
  settleBreaker?: CircuitBreakerConfig;
  /** /verify rate limit (separate limiter instance, keyed by client IP). */
  verifyRateLimit?: SlidingWindowConfig;
  /** Attribution store. undefined when DATABASE_URL or CANTON_ATTRIBUTION_SCAN_URLS is absent. */
  attribution: AttributionStore | undefined;
  attributionScanClients: ScanClient[];
  attributionRequired: boolean;
  /** Retry-worker tick interval (ms); see FacilitatorConfig.attributionRetryIntervalMs. */
  attributionRetryIntervalMs: number;
  excludedParticipants: string[];
  excludedParties: string[];
  /** Paid marker worker store. undefined when marker worker is disabled. */
  markerStore: MarkerStore | undefined;
  markerFtpParty: string | undefined;
  markerUserId: string | undefined;
  /** Per-round marker weight multiplier; see FacilitatorConfig.markerWeightMultiplier. */
  markerWeightMultiplier: number;
  /** Prometheus metrics surface (settle outcomes, breaker trips, rate-limit
   *  rejections, settle latency). Threaded into /verify, /settle, and the GET
   *  /metrics route. */
  metrics: FacilitatorMetrics;
  /** Readiness probe backing GET /ready (token mint + participant + Scan
   *  reachability, short-TTL cached). */
  readiness: ReadinessProbe;
  /** Participant MEMBER id for the GS traffic-budget monitor; undefined → the
   *  monitor stays inert (logs once, skips). */
  facilitatorMemberId: string | undefined;
}

export function buildServices(config: FacilitatorConfig): Services {
  const userId = process.env.CANTON_USER_ID ?? "ledger-api-user";

  // One hardened Postgres pool shared by BOTH the consumed-payments store and
  // the attribution store (audit HIGH): bounded `max`, statement/query
  // timeouts, and a connection-acquire timeout so a slow/hung DB surfaces as a
  // catchable error instead of pinning connections and wedging /settle. Built
  // once here and threaded into both store factories; undefined when no
  // DATABASE_URL (in-memory consumed store, attribution disabled).
  const dbExecutor: PgExecutor | undefined = config.dbUrl
    ? poolExecutor(createFacilitatorPool(config.dbUrl))
    : undefined;

  // Token source:
  //   - unsafe-hmac → mint a static HS256 JWT (cn-quickstart accepts
  //     it; `max-token-lifetime=Inf` means no expiry).
  //   - oidc → fetch + cache an Auth0/Keycloak access_token via
  //     client_credentials, refresh ~60s before expiry. Each ledger
  //     call awaits the provider, which returns the cached token in
  //     the steady state and triggers a single in-flight refresh
  //     across concurrent callers.
  //
  // The provider/string split is type-checked by CantonClient's
  // `token: string | TokenProvider`.
  let token: string | TokenProvider;
  if (config.jwtIssuer === "unsafe-hmac") {
    token = mintUnsafeHmacJwt({
      secret: config.jwtSecret ?? "unsafe",
      sub: userId,
    });
  } else {
    // config.ts validated these are non-empty for jwtIssuer=oidc.
    // Conditional spread keeps `scope` out of the args object when
    // undefined — required under tsconfig `exactOptionalPropertyTypes`.
    token = createOidcTokenProvider({
      tokenEndpoint: config.oidcTokenEndpoint!,
      clientId: config.oidcClientId!,
      clientSecret: config.oidcClientSecret!,
      audience: config.ledgerApiAudience!,
      ...(config.oidcScope ? { scope: config.oidcScope } : {}),
    });
  }

  const client = new CantonClient({
    participantUrl: config.participantUrl,
    token,
    packageName: "canton-x402",
    // submit-and-wait-for-transaction can take 30s+ on mainnet under load.
    // 10s (default) is too tight; 45s gives headroom without making the
    // client-side x402 flow feel broken (the caller already has a
    // maxTimeoutSeconds budget from the PaymentRequirements).
    timeoutMs: 45_000,
  });

  // Scan API authentication:
  //   - flavor="sv"        → public SV Scan, no token (DevNet default)
  //   - flavor="validator" → validator-local scan-proxy, needs same
  //                          token as the participant (LocalNet default)
  // The token used here MUST match the audience the scan endpoint
  // validates. For the validator-local proxy that's the same as the
  // ledger API; for the public SV it's no token at all.
  // Conditional spread keeps `token` out of the options object when
  // we want the public-SV (no-auth) path, under exactOptionalPropertyTypes.
  const scan = new ScanClient({
    scanUrl: config.scanUrl,
    fallbackUrls: config.scanFallbackUrls,
    flavor: config.scanFlavor,
    // Pass the OIDC token to the Scan when it is RBAC-gated (mainnet sv) or for
    // the validator scan-proxy; testnet public sv scans take no token.
    ...(config.scanAuth || config.scanFlavor !== "sv" ? { token } : {}),
  });

  const metrics = createMetrics();

  // ONE payer-proof verifier, shared by both carriages. The inline arm and the
  // legacy pay/commit must judge a signature by exactly the same rule; two
  // instances built from the same arguments would be the same today and drift
  // the first time one is changed.
  const payerProof = createPayerProofVerifier({
        // Rule 3's second half. The key comes from the TOPOLOGY READER, a
        // node-local service that holds the participant's admin access so this
        // process does not have to.
        //
        // It is NOT the JSON Ledger API's /v2/jose/jwks route: that route does
        // not exist in what Splice ships (measured against the 0.6.13 and
        // 0.6.14 participant images and their bundled Canton jars), so wiring
        // it here only ever produced a 404 and a refusal.
        //
        // Unconfigured → no lookup → the verifier refuses every inline payment.
        // Fail-closed, and the state a deploy is in until the reader is up.
        ...(config.topologyReaderUrl && config.topologyReaderToken
          ? {
              fetchPayerSigningKey: createTopologyReaderLookup({
                baseUrl: config.topologyReaderUrl,
                token: config.topologyReaderToken,
              }),
            }
          : {}),
        // A reader outage refuses every inline payment as
        // `signature_invalid`, which on the wire is indistinguishable from
        // someone forging signatures at us. Counted, not logged: during an
        // outage this fires once per payment, and a per-request log line would
        // bury the incident in its own noise. `unavailable` is our reader
        // failing; `no_key` is topology answering that the payer publishes
        // none — same refusal to the client, opposite thing to go fix.
        // Read the reason the error carries. This used to be a regex over the
        // message — a second copy of a rule that lives in
        // topology-reader-client.ts, which would have gone silently wrong the
        // first time anyone reworded a sentence.
        onLookupError: (_party, err) =>
          metrics.recordInlineKeyLookup(
            (err as { reason?: unknown } | null)?.reason === "no_key"
              ? "no_key"
              : "unavailable"
          ),
      });

  // Readiness probe (GET /ready): can this facilitator settle right now? The
  // three checks mirror the settle prerequisites — a mintable ledger token, a
  // reachable participant, and reachable Scan DSO-state. Each is wrapped so a
  // failure surfaces as { ok:false, detail } rather than throwing (the route
  // logs `detail` server-side and only exposes a generic status on the wire);
  // the probe itself caches results for a short TTL so a HEALTHCHECK/scrape
  // storm cannot turn /ready into a load source on these deps. The scan check
  // uses getAmuletRulesFresh() (cache-bypass): a true readiness probe must hit
  // Scan LIVE, otherwise a long-dead Scan would still read "ready" off the
  // ScanClient TTL cache. The probe's own TTL (not the ScanClient cache) is what
  // bounds how often this live read fires.
  const readiness = createReadinessProbe({
    token: async (): Promise<ReadinessCheckResult> => {
      // A string token (unsafe-hmac/LocalNet) is statically valid — nothing to
      // mint or refresh. For the OIDC provider, calling it forces a mint/refresh
      // and throws if the IdP/client_credentials grant is broken.
      if (typeof token === "string") return { ok: true };
      await token();
      return { ok: true };
    },
    participant: async (): Promise<ReadinessCheckResult> => {
      await client.getLedgerEnd();
      return { ok: true };
    },
    scan: async (): Promise<ReadinessCheckResult> => {
      // Cache-bypass: a readiness probe must hit Scan live, not read a stale
      // "ok" off the ScanClient AmuletRules TTL cache.
      await scan.getAmuletRulesFresh();
      return { ok: true };
    },
  });

  // Hoisted so the inline Rule 7 (registry-utility arm) can reuse the SAME
  // registry-aware preapproval probe as the settle gate, with no second copy of
  // the routing logic to drift.
  const transferFactory = config.tfEnabled
    ? new TransferFactoryService({
        client,
        scan,
        facilitatorParty: config.facilitatorParty,
        userId,
        tokenRegistries: config.tokenRegistries,
      })
    : undefined;

  return {
    metrics,
    readiness,
    facilitatorMemberId: config.facilitatorMemberId,
    client,
    scan,
    merchantContract: new MerchantContractService(client, config.facilitatorParty),
    facilitatorParty: config.facilitatorParty,
    synchronizerId: config.synchronizerId,
    network: config.network,
    userId,
    operatorToken: config.operatorToken,
    consumed: createConsumedStore({ dbUrl: config.dbUrl, executor: dbExecutor }),
    inlineSettles: createInlineSettleStore({
      ...(config.dbUrl !== undefined ? { dbUrl: config.dbUrl } : {}),
      ...(dbExecutor ? { executor: dbExecutor } : {}),
    }),
    preapproval: new PreapprovalService({
      client,
      scan,
      facilitatorParty: config.facilitatorParty,
      userId,
    }),
    // Same PreapprovalService capability, consumed by registerWalletRoutes as
    // the SELF-PROVIDER preapproval service (merchant provisions its own,
    // single-controller — no facilitator CanActAs). Stateless, so a second
    // instance is fine.
    selfPreapproval: new PreapprovalService({
      client,
      scan,
      facilitatorParty: config.facilitatorParty,
      userId,
    }),
    enablePreapprovalProvider: config.enablePreapprovalProvider,
    scanUrl: config.scanUrl,
    scanFallbackUrls: config.scanFallbackUrls,
    tokenRegistries: config.tokenRegistries,
    enableAgentWallet: config.enableAgentWallet,
    walletSubmitChoices: config.walletSubmitChoiceAllowlist,
    submitRateMaxPerKey: config.walletSubmitRateMaxPerKey,
    onboardRateMaxGlobal: config.walletOnboardRateMaxGlobal,
    submitRateMaxPerIp: config.walletSubmitRateMaxPerIp,
    agentWalletApiKey: config.agentWalletApiKey,
    faucet: config.faucetEnabled
      ? {
          store: createFaucetStore({
            dbUrl: config.dbUrl,
            ...(dbExecutor ? { executor: dbExecutor } : {}),
          }),
          amountCc: config.faucetAmountCc,
          maxPerIp: config.faucetMaxPerIp,
          dailyBudgetCc: config.faucetDailyBudgetCc,
          lifetimeCapCc: config.faucetLifetimeCapCc,
          windowMs: config.faucetWindowMs,
          ...(config.faucetInternalSecret !== undefined
            ? { internalSecret: config.faucetInternalSecret }
            : {}),
          maxGlobalPerMin: config.faucetMaxGlobalPerMin,
          burstWindowMs: config.faucetBurstWindowMs,
          ipExempt: config.faucetIpExempt,
        }
      : undefined,
    tfEnabled: config.tfEnabled,
    // Inline-prepare knobs for the pay/prepare relay route. undefined when the
    // TF path is disabled (default) → pay/prepare 503s.
    tfPay: config.tfEnabled
      ? {
          wasteMax: config.walletPrepareWasteMax,
          wasteWindowMs: config.walletPrepareWasteWindowMs,
          defaultExecuteBeforeSeconds: config.tfDefaultExecuteBeforeSeconds,
          maxExecuteBeforeSeconds: config.tfMaxExecuteBeforeSeconds,
        }
      : undefined,
    // Inline carriage, scheme Rule 3. The verifier is ALWAYS wired, so the
    // rejection an inline payload gets today comes from the real proof check
    // (hash binding passes, the signature half has no key source) rather than
    // from an absent dependency. Completing Rule 3 is one argument here —
    // `fetchPayerSigningKey` — once a participant topology read exists.
    inline: {
      // The relay path has always clamped this at prepare time; the inline
      // carriage bypasses prepare by construction, so it needs the same
      // ceiling handed to it explicitly or the payer sets its own.
      maxExecuteBeforeSeconds: config.tfMaxExecuteBeforeSeconds,
      verifySignature: payerProof,
      // Rule 7 reads the merchant's live TransferPreapproval from Scan. That
      // read is TTL-cached per merchant and single-flighted, so a burst of
      // payments to one merchant collapses to a single lookup — and an expired
      // record is never served from the cache, since this is the field the
      // /settle gate refuses payments on.
      // The WHOLE record — the arm binds receiver and issuer, not just expiry.
      fetchPreapproval: async (party: string) => {
        const r = await scan.getTransferPreapprovalByParty(party);
        return r
          ? {
              receiver: r.receiver,
              dso: r.dso,
              expiresAt: r.expiresAt,
              // LOAD-BEARING for the served-merchant policy: drop this and any
              // non-open policy sees an undefined provider and refuses every
              // merchant, taking the inline money path down.
              provider: r.provider,
              ...(r.validFrom !== undefined ? { validFrom: r.validFrom } : {}),
            }
          : null;
      },
      merchantPolicy: config.inlineMerchantPolicy,
      merchantAllowlist: config.inlineMerchantAllowlist,
      // Registry-utility (non-Amulet) Rule 7 on the inline arm: reuse the settle
      // gate's registry-aware probe so a USDCx/cBTC merchant's preapproval is
      // detected the same way on /verify and /settle.
      tokenRegistries: config.tokenRegistries,
      // OUT-OF-BAND-trusted registry infra parties per admin, so the foreign-party
      // backstop admits the operator/bridge a real registry transfer names. Empty
      // {} → Amulet-identical.
      registryTrustedParties: config.registryTrustedParties,
      // Rule 13's sum, answered from the PARTICIPANT'S LIVE ACS — the same
      // query pay/prepare uses to SELECT the inputs, so the two see one truth.
      //
      // It is deliberately NOT Scan's public snapshot, which this repo's own
      // comment (routes/wallet.ts) describes as lagging by hours. Checking live
      // contract ids against a stale view refuses any payer spending change
      // from its previous payment or a fresh faucet claim: the common case, not
      // an edge one, and an over-strict money path is an outage.
      //
      // WHO THIS CAN ANSWER FOR: only parties this participant hosts, because
      // reading a party's active contracts requires rights on that party. For
      // everyone else the query fails and we return undefined, which the arm
      // treats as "no authoritative view" and SKIPS the sum — exactly what the
      // scheme makes conditional on hosting the payer. So the sum becomes real
      // for our own agent wallets and stays honestly unanswered for the rest,
      // rather than being answered wrongly for everyone.
      fetchOwnedHoldingAmounts: async (party: string) => {
        const events = await client.queryActiveContracts({
          filtersByParty: {
            [party]: {
              cumulative: [
                {
                  identifierFilter: {
                    // Template-scoped, NOT a wildcard. A party with a large ACS
                    // trips Canton's element cap on a wildcard query and the
                    // read 502s; scoping keeps the result O(amulets).
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
        const owned = new Map<string, string>();
        for (const e of events) {
          const amt = (
            e.createArgument as { amount?: { initialAmount?: string } }
          )?.amount?.initialAmount;
          if (typeof amt === "string" && amt.length > 0) {
            owned.set(e.contractId, amt);
          }
        }
        return owned;
      },
    },
    transferFactory,
    settleDispatchMark: config.settleDispatchMarkMode,
    settleRateLimit: {
      maxPerPayer: config.settleRateMaxPerPayer,
      maxPerIp: config.settleRateMaxPerIp,
      maxGlobal: config.settleRateMaxGlobal,
      windowMs: config.settleRateWindowMs,
    },
    settleBreaker: {
      threshold: config.settleBreakerThreshold,
      cooldownMs: config.settleBreakerCooldownMs,
      windowMs: config.settleBreakerWindowMs,
      failureRate: config.settleBreakerFailureRate,
      minSamples: config.settleBreakerMinSamples,
    },
    verifyRateLimit: {
      // Per-IP cap only; maxGlobal 0 so one IP can never deny /verify to all.
      maxPerPayer: config.verifyRateMaxPerIp,
      maxGlobal: 0,
      windowMs: config.verifyRateWindowMs,
    },
    ...buildAttributionServices(config, token, dbExecutor),
    ...buildMarkerServices(config, dbExecutor),
  };
}

function buildMarkerServices(
  config: FacilitatorConfig,
  dbExecutor: PgExecutor | undefined
): Pick<Services, "markerStore" | "markerFtpParty" | "markerUserId" | "markerWeightMultiplier"> {
  const enabled =
    config.markerEnabled &&
    !!config.dbUrl &&
    !!config.markerFtpParty &&
    !!config.markerUserId;

  if (config.markerEnabled && !enabled) {
    console.warn(
      "[marker-worker] CANTON_X402_MARKER_ENABLED=true but DATABASE_URL," +
        " CANTON_X402_MARKER_FTP_PARTY, or CANTON_X402_MARKER_USER_ID is missing" +
        " — worker disabled"
    );
  }

  return {
    markerStore: enabled
      ? createMarkerStore(config.dbUrl!, ...(dbExecutor ? [{ executor: dbExecutor }] : []))
      : undefined,
    markerFtpParty: enabled ? config.markerFtpParty : undefined,
    markerUserId: enabled ? config.markerUserId : undefined,
    markerWeightMultiplier: config.markerWeightMultiplier,
  };
}

function buildAttributionServices(
  config: FacilitatorConfig,
  token: string | TokenProvider,
  dbExecutor: PgExecutor | undefined
): Pick<
  Services,
  | "attribution"
  | "attributionScanClients"
  | "attributionRequired"
  | "attributionRetryIntervalMs"
  | "excludedParticipants"
  | "excludedParties"
> {
  const scanUrls = config.attributionScanUrls ?? [];
  const enabled = !!config.dbUrl && scanUrls.length > 0;

  if (!enabled) {
    if (config.attributionRequired) {
      throw new Error(
        "CANTON_ATTRIBUTION_REQUIRED=true requires both DATABASE_URL and" +
          " CANTON_ATTRIBUTION_SCAN_URLS"
      );
    }
    if (config.dbUrl && scanUrls.length === 0) {
      console.warn(
        "[attribution] DATABASE_URL is set but CANTON_ATTRIBUTION_SCAN_URLS" +
          " is empty — attribution disabled"
      );
    }
  }

  return {
    attribution: enabled
      ? createAttributionStore(config.dbUrl!, { executor: dbExecutor })
      : undefined,
    attributionScanClients: enabled
      ? scanUrls.map(
          (url) => new ScanClient({ scanUrl: url, flavor: "sv", ...(config.attributionScanAuth ? { token } : {}) })
        )
      : [],
    attributionRequired: config.attributionRequired ?? false,
    attributionRetryIntervalMs: config.attributionRetryIntervalMs,
    excludedParticipants: config.excludedParticipants ?? [],
    excludedParties: config.excludedParties ?? [],
  };
}
