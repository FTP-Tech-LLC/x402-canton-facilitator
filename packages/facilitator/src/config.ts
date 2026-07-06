/**
 * Facilitator configuration. All env-driven so the same binary runs
 * for DevNet, TestNet, and MainNet by changing CANTON_NETWORK +
 * CANTON_PARTICIPANT_URL.
 */

export interface FacilitatorConfig {
  port: number;
  /**
   * Fastify `trustProxy` value controlling how `req.ip` is derived from the
   * X-Forwarded-For chain. This is SECURITY-sensitive: `req.ip` is the
   * rate-limit key for the public /verify endpoint and the second key for the
   * /settle per-payer cap, so a forgeable `req.ip` defeats both limiters.
   *
   * With `trustProxy: true` Fastify trusts the WHOLE forwarded chain and
   * `req.ip` becomes the LEFTMOST (client-supplied, forgeable) XFF entry. We
   * therefore default to trusting only the loopback proxy: a fronting
   * Caddy/Nginx on 127.0.0.1 appends the real client to the right of XFF, and
   * trusting just loopback makes `req.ip` resolve to that real rightmost entry
   * while any client-forged left-hand entries are truncated away. A direct
   * (un-proxied) attacker's forged XFF is ignored entirely — `req.ip` is its
   * real socket peer.
   *
   * Derived from `CANTON_X402_TRUST_PROXY`:
   *   - unset            → `"loopback"` (127.0.0.1/8 + ::1/128) — safe default.
   *   - `"false"`        → no proxy trusted (`req.ip` = socket peer).
   *   - `"true"`         → trust the whole chain (UNSAFE; logs a startup warn).
   *   - an integer `"N"` → trust N hops (proxy-addr hop count).
   *   - anything else    → comma-separated IP/CIDR/keyword list of trusted
   *                        proxies (e.g. `"10.0.0.0/8"` or `"loopback,10.1.2.3"`).
   */
  trustProxy: boolean | number | string | string[];
  network: "canton:devnet" | "canton:testnet" | "canton:mainnet";
  participantUrl: string;            // JSON Ledger API v2 base URL
  facilitatorParty: string;          // our facilitator party id
  /** Participant MEMBER id (e.g. `PAR::ftp-validator-1::1220abc`) used by the
   *  GS traffic-budget monitor's getTrafficStatus call. OPTIONAL: the
   *  facilitator does not otherwise need its own member id. When unset the
   *  traffic monitor logs once and stays inert (nothing else depends on it).
   *  Set via CANTON_FACILITATOR_MEMBER_ID. */
  facilitatorMemberId: string | undefined;
  synchronizerId: string;            // Global Synchronizer id we settle on
  scanUrl: string;                   // SV Scan or validator-local Scan proxy
  /** Alternate SV Scan base URLs (comma-separated `CANTON_SCAN_FALLBACK_URLS`),
   *  tried in order when the primary keeps returning a transient 5xx/429 after
   *  its bounded retry. Use a DIFFERENT-operator SV (real independent failure
   *  domain). Empty by default; verify the alternate is reachable +
   *  unauthenticated from the deploy host before setting it. */
  scanFallbackUrls: string[];
  /** `sv` (public SV Scan, no auth) or `validator` (validator-local
   *  scan-proxy, needs same auth as the participant). DevNet defaults
   *  to `sv` since the SV Scan is unauthenticated and removes one
   *  audience-juggling step. LocalNet/cn-quickstart uses `validator`. */
  scanFlavor: "validator" | "sv";
  /** Send the OIDC token to the SV Scan. Mainnet SV scans are RBAC-gated and
   *  require an authenticated read; testnet/devnet public scans do not. */
  scanAuth: boolean;
  /** transfer-factory ("V3", 1-tx meta-transaction) settle-path master switch.
   *  DEFAULT false on every network: a deploy with TF off never prepares,
   *  stashes, verifies, or settles a transfer-factory payment (routes 503 /
   *  fail-closed with invalid_exact_canton_transfer_factory_disabled). Set via
   *  CANTON_X402_TF_ENABLED=true. Mirrors the DIRECT gate pattern. */
  tfEnabled: boolean;
  /** Advertise `transfer-factory` in /supported transferMethods alongside the
   *  primary. Requires `tfEnabled` (advertised ⟹ enabled — /supported can
   *  never advertise an inert path). Set via CANTON_X402_ADVERTISE_TF=true. */
  advertiseTf: boolean;
  /** Max live (unsettled, unexpired) tf stash rows per payer — bounds the
   *  relay-side storage a single agent can occupy. */
  tfStashCapPerPayer: number;
  /** executeBefore horizon (seconds) when the client does not request one. */
  tfDefaultExecuteBeforeSeconds: number;
  /** Hard ceiling on a client-requested executeBefore horizon (seconds) —
   *  also bounds how long a stashed signed submission can sit unexecuted. */
  tfMaxExecuteBeforeSeconds: number;
  /** Operational guards for /settle (v1 settlement pays the GS traffic fee, so
   *  /settle is a cost + griefing surface). Per-payer + global sliding-window
   *  caps over `settleRateWindowMs`; a cap of 0 disables it. The circuit breaker
   *  trips after `settleBreakerThreshold` consecutive traffic failures and
   *  refuses settles for `settleBreakerCooldownMs`; threshold 0 disables it. */
  settleRateMaxPerPayer: number;
  /** Sliding-window (ms) over which the breaker counts BOTH failures (for its
   *  decaying count arm) and successes (for its failure-rate arm). Failures
   *  older than this age out, so a slow drip across windows never accumulates.
   *  Default 60s. `CANTON_X402_SETTLE_BREAKER_WINDOW_MS`. */
  settleBreakerWindowMs: number;
  /** RATE arm of the breaker: trip when the windowed failure FRACTION reaches
   *  this (0..1) AND `settleBreakerMinSamples` failures are in the window. The
   *  paced-attacker fix — an attacker who follows every billed-but-zero-funds
   *  burn with one cheap success keeps the decaying COUNT arm near zero, but a
   *  sustained ~50% failure fraction still trips this arm. Default 0.5; `<= 0`
   *  disables the rate arm (count arm only). `CANTON_X402_SETTLE_BREAKER_FAILURE_RATE`. */
  settleBreakerFailureRate: number;
  /** RATE arm guard: minimum windowed failures before the rate arm can trip, so
   *  one early failure at 100% fraction cannot trip it. Default 10.
   *  `CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES`. */
  settleBreakerMinSamples: number;
  /** Per-client-IP /settle cap. SEPARATE from per-payer because /settle is
   *  called by the MERCHANT, so one IP aggregates every agent paying through it
   *  — capping it at the per-payer value throttles a whole merchant to one
   *  payer's budget (the multi-agent 429→502). Default 100: well above a single
   *  payer (10) so a merchant fronting many agents is not throttled, yet below
   *  global (120) so it stays a real per-merchant backstop. Raise it for more
   *  multi-agent headroom; `<= 0` disables the IP cap. */
  settleRateMaxPerIp: number;
  settleRateMaxGlobal: number;
  settleRateWindowMs: number;
  settleBreakerThreshold: number;
  settleBreakerCooldownMs: number;
  /** Rate limit for the PUBLIC /verify endpoint. /verify is unauthenticated and
   *  drives Scan/ACS reads under the facilitator's OIDC identity, so an
   *  unthrottled /verify is a read-amplification + DoS surface (confirmed live:
   *  a 15-request burst was never limited). Sliding-window cap keyed by CLIENT
   *  IP over `verifyRateWindowMs`. A SEPARATE limiter instance from /settle so
   *  /verify throttling never consumes the settle traffic budget. A cap of 0
   *  disables it. Per-IP only (no global cap) — a global /verify cap would let
   *  one noisy IP deny verification to everyone. */
  verifyRateMaxPerIp: number;
  verifyRateWindowMs: number;
  jwtIssuer: "unsafe-hmac" | "oidc"; // unsafe-hmac for LocalNet only
  jwtSecret: string | undefined;     // for unsafe-hmac
  oidcTokenEndpoint: string | undefined;
  oidcClientId: string | undefined;
  oidcClientSecret: string | undefined;
  oidcScope: string | undefined;
  ledgerApiAudience: string | undefined;
  dbUrl: string | undefined;         // Postgres connection string (wired in M1.2)
  logLevel: "debug" | "info" | "warn" | "error";
  /** Register POST /close (graceful-shutdown route). Default false:
   *  /close is an UNAUTHENTICATED process.exit, so it stays OFF in
   *  production and is enabled only for the x402 conformance harness via
   *  CANTON_X402_ENABLE_CLOSE_ROUTE=true. */
  enableCloseRoute: boolean;
  /** Enable the facilitator-as-provider preapproval route
   *  (POST /v1/merchants/:party/preapproval). Default false: it submits a
   *  money-path AmuletRules_CreateTransferPreapproval and needs live DevNet
   *  validation before production. CANTON_X402_ENABLE_PREAPPROVAL_PROVIDER=true. */
  enablePreapprovalProvider: boolean;
  /** Agent-wallet relay (skill, Phase 1). OFF by default. */
  enableAgentWallet: boolean;
  agentWalletApiKey: string | undefined;
  /** Agent CC faucet (out-of-box e2e). OFF by default on EVERY network incl.
   *  mainnet; the caps below are the guardrail when enabled. The faucet sends a
   *  tiny one-time CC seed from the facilitator's OWN party to an agent party
   *  (the same TransferFactory_Transfer the funder uses — see e2e/fund.mjs), so
   *  an agent can run a real x402 payment with no human funding step. It only
   *  works when the agent-wallet relay is also on. CANTON_X402_FAUCET_ENABLED=true. */
  faucetEnabled: boolean;
  /** Per-claim CC amount (Daml Decimal string). Default "0.02" — enough for one
   *  end-to-end test, no more. CANTON_X402_FAUCET_AMOUNT_CC. */
  faucetAmountCc: string;
  /** Max faucet claims per client IP within faucetWindowMs. Default 5; `<=0`
   *  disables the per-IP cap. CANTON_X402_FAUCET_MAX_PER_IP. */
  faucetMaxPerIp: number;
  /** Rolling-window CC payout ceiling: the faucet refuses (503) once the sum of
   *  payouts within faucetWindowMs would exceed this. Hard bound on worst-case
   *  spend ≈ this value per window. Default "1". CANTON_X402_FAUCET_DAILY_BUDGET_CC. */
  faucetDailyBudgetCc: string;
  /** ALL-TIME (no-window) CC payout ceiling: once the sum of EVERY faucet payout
   *  ever recorded would exceed this, the faucet latches closed (503) until the
   *  claim rows are pruned/reset. Bounds the lifetime bounty even though the
   *  daily budget recurs every window. Default "25"; "0" disables the lifetime
   *  cap (rely on the daily budget alone). CANTON_X402_FAUCET_LIFETIME_CAP_CC. */
  faucetLifetimeCapCc: string;
  /** Window (ms) for BOTH the per-IP cap and the budget sum. Default 24h.
   *  CANTON_X402_FAUCET_WINDOW_MS. */
  faucetWindowMs: number;
  /** Bearer token required for merchant-registry MUTATIONS
   *  (POST /v1/merchants/register and /:cid/accept). These make the
   *  facilitator party submit on-ledger writes, so they must not be
   *  anonymous. When UNSET, the mutation routes are disabled (503) —
   *  fail-secure. The read-only GET lookup stays public. Set via
   *  CANTON_X402_OPERATOR_TOKEN. */
  operatorToken: string | undefined;
  /** SV Scan URLs for attribution traffic fetching (comma-separated).
   *  Empty → attribution disabled even when DATABASE_URL is set.
   *  Always used with flavor:"sv". */
  attributionScanUrls: string[];
  /** Pass OIDC token to attribution ScanClients (RBAC-gated mainnet SVs). */
  attributionScanAuth: boolean;
  /** When true, /settle returns error if attribution.record() fails.
   *  buildServices throws on startup if required but DB or scan URLs absent. */
  attributionRequired: boolean;
  /** Participant UIDs whose traffic is excluded from eligible_bytes. */
  excludedParticipants: string[];
  /** Parties whose transactions are excluded from eligible_bytes. */
  excludedParties: string[];
  /** Paid marker worker. When enabled, emits one FeaturedAppActivityMarker per
   *  mining round with weight = Σ traffic bytes / 1e6 * $60/MB. Requires
   *  DATABASE_URL (same DB as attribution). */
  markerEnabled: boolean;
  /** FTP party that holds the FeaturedAppRight and receives the app reward. */
  markerFtpParty: string | undefined;
  /** Ledger userId for the FeaturedAppRight_CreateActivityMarker submission. */
  markerUserId: string | undefined;
  /** Marker weight multiplier (`CANTON_X402_MARKER_WEIGHT_MULTIPLIER`). Scales
   *  the per-round marker weight relative to the directly-attributed bytes (Send +
   *  CreateTransferCommand). Values >1 uplift to cover x402-driven txs the
   *  attribution table never sees (observed live ~1 AmuletRules_Transfer per ~10
   *  payments on top of the attributed pair); values <1 deliberately discount the
   *  weight. Env-driven so it can be re-tuned with a restart, no image rebuild.
   *  Default 1.35; any non-numeric or non-positive value falls back to the
   *  default. */
  markerWeightMultiplier: number;
  /** Attribution retry-worker tick interval in ms
   *  (`CANTON_X402_ATTRIBUTION_RETRY_MS`). Controls how quickly settled rows
   *  get their traffic bytes after Scan indexes the update — and therefore how
   *  fresh the per-round marker weights are (half a mining round is ~5 min, so
   *  the old fixed 5-minute tick could miss a round's window). Default 60s;
   *  clamped to ≥15s so a misconfig cannot hammer Scan. The worker is
   *  overlap-guarded, so a long tick (many pending rows × 500ms pacing) simply
   *  delays the next tick instead of stacking. */
  attributionRetryIntervalMs: number;
  /**
   * Bazaar discovery listing served at `GET /discovery/resources`. Each entry
   * advertises a payable resource URL plus the `accepts[]` payment-requirements
   * (the "input schema") an agent needs to pay for it. Operator-supplied via
   * `CANTON_X402_DISCOVERY_RESOURCES` (a JSON array); empty by default so the
   * endpoint stays a valid empty Bazaar until resources are registered.
   */
  discoveryResources: DiscoveryResource[];
}

/**
 * One entry in the `GET /discovery/resources` Bazaar listing. `accepts` mirrors
 * the `accepts[]` a 402 response for `resource` would carry, so a
 * discovery-driven agent gets the endpoint and the exact payment schema in one
 * read. `accepts` is a structural pass-through (shape-checked, not deeply
 * validated) so the registry survives PaymentRequirements evolution without a
 * config-parser change.
 */
export type DiscoveryResource = {
  /** The payable resource URL (e.g. `https://api.example.com/inference`). */
  resource: string;
  /** Resource transport type. Defaults to `"http"`. */
  type: string;
  /** Payment-requirements entries a client can satisfy to unlock `resource`. */
  accepts: unknown[];
  /** Optional free-form metadata (title, description, docs URL, ...). */
  metadata?: Record<string, unknown>;
  /** Optional ISO-8601 timestamp of the last registry update. */
  lastUpdated?: string;
};

/**
 * Parse `CANTON_X402_TRUST_PROXY` into a Fastify `trustProxy` value. See the
 * doc on {@link FacilitatorConfig.trustProxy} for the security rationale and the
 * accepted forms. Exported for unit testing.
 */
export function parseTrustProxy(
  raw: string | undefined
): boolean | number | string[] {
  // Default: trust only the loopback proxy (the documented Caddy/Nginx deploys
  // front the facilitator from 127.0.0.1). This is the SAFE default — a
  // client-forged XFF left of the proxy's appended real-client entry is
  // truncated, and a direct attacker's XFF is ignored entirely.
  if (raw === undefined || raw.trim() === "") return ["loopback"];
  const v = raw.trim();
  if (v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return true; // UNSAFE; warned at startup.
  // A bare non-negative integer → hop count.
  if (/^\d+$/.test(v)) return Number(v);
  // Otherwise a comma-separated IP/CIDR/keyword list of trusted proxies.
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

/**
 * Parse `CANTON_X402_DISCOVERY_RESOURCES` (a JSON array of {@link DiscoveryResource})
 * into the Bazaar listing. Unset or empty → `[]` (a valid empty Bazaar).
 * Malformed JSON, a non-array, or an entry missing a `resource` string or a
 * non-empty `accepts` array is a fail-fast startup error, so a bad registration
 * is caught at deploy rather than silently dropping the resource. Exported for
 * unit testing.
 */
export function parseDiscoveryResources(
  raw: string | undefined
): DiscoveryResource[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `CANTON_X402_DISCOVERY_RESOURCES is not valid JSON: ${(e as Error).message}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `CANTON_X402_DISCOVERY_RESOURCES must be a JSON array of resource entries`
    );
  }
  return parsed.map((item, i) => {
    const o = (item ?? {}) as Partial<DiscoveryResource>;
    if (typeof o.resource !== "string" || o.resource.trim() === "") {
      throw new Error(
        `CANTON_X402_DISCOVERY_RESOURCES[${i}] is missing a non-empty "resource" string`
      );
    }
    if (!Array.isArray(o.accepts) || o.accepts.length === 0) {
      throw new Error(
        `CANTON_X402_DISCOVERY_RESOURCES[${i}] ("${o.resource}") must have a non-empty "accepts" array`
      );
    }
    return {
      resource: o.resource,
      type:
        typeof o.type === "string" && o.type.trim() !== "" ? o.type : "http",
      accepts: o.accepts,
      ...(o.metadata !== undefined ? { metadata: o.metadata } : {}),
      ...(typeof o.lastUpdated === "string"
        ? { lastUpdated: o.lastUpdated }
        : {}),
    };
  });
}

export function loadConfig(): FacilitatorConfig {
  const network = required("CANTON_NETWORK");
  if (
    network !== "canton:devnet" &&
    network !== "canton:testnet" &&
    network !== "canton:mainnet"
  ) {
    throw new Error(
      `CANTON_NETWORK must be canton:devnet, canton:testnet, or canton:mainnet`
    );
  }
  const jwtIssuer = (process.env.JWT_ISSUER ?? "unsafe-hmac") as
    | "unsafe-hmac"
    | "oidc";

  // Fail fast on misconfiguration so a production facilitator can't
  // boot with an empty OIDC client_id that 401s on the first ledger
  // call. For unsafe-hmac the validation in services.ts (mintUnsafeHmacJwt)
  // is sufficient.
  if (jwtIssuer === "oidc") {
    for (const v of [
      "OIDC_TOKEN_ENDPOINT",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "LEDGER_API_AUDIENCE",
    ]) {
      if (!process.env[v]) {
        throw new Error(
          `JWT_ISSUER=oidc requires ${v}. Set it in the facilitator env, ` +
            `or switch to JWT_ISSUER=unsafe-hmac for LocalNet testing.`
        );
      }
    }
  }

  const scanFlavor = (process.env.CANTON_SCAN_FLAVOR ??
    (jwtIssuer === "oidc" ? "sv" : "validator")) as "validator" | "sv";
  if (scanFlavor !== "validator" && scanFlavor !== "sv") {
    throw new Error(
      `CANTON_SCAN_FLAVOR must be "validator" or "sv" (got ${scanFlavor})`
    );
  }

  // transfer-factory ("V3") gate — the sole settlement method now runs behind a
  // rounds-safe rollout gate: DEFAULT OFF everywhere; the advertise knob requires
  // the master switch so /supported can never advertise an inert path.
  const tfEnabled = process.env.CANTON_X402_TF_ENABLED === "true";
  const advertiseTf =
    tfEnabled && process.env.CANTON_X402_ADVERTISE_TF === "true";

  // Faucet gives away REAL CC when enabled, so fail fast on a footgun config:
  // a non-positive amount, or a budget that cannot cover even one payout (which
  // would 503 every claim). The caps themselves are the runtime guardrail.
  const faucetEnabled = process.env.CANTON_X402_FAUCET_ENABLED === "true";
  const faucetAmountCc = process.env.CANTON_X402_FAUCET_AMOUNT_CC ?? "0.02";
  const faucetDailyBudgetCc = process.env.CANTON_X402_FAUCET_DAILY_BUDGET_CC ?? "1";
  const faucetLifetimeCapCc =
    process.env.CANTON_X402_FAUCET_LIFETIME_CAP_CC ?? "25";
  if (faucetEnabled) {
    const amt = Number(faucetAmountCc);
    const budget = Number(faucetDailyBudgetCc);
    const lifetime = Number(faucetLifetimeCapCc);
    if (!(amt > 0)) {
      throw new Error(
        `CANTON_X402_FAUCET_AMOUNT_CC must be a positive number when the faucet ` +
          `is enabled (got ${JSON.stringify(faucetAmountCc)})`
      );
    }
    if (!(budget >= amt)) {
      throw new Error(
        `CANTON_X402_FAUCET_DAILY_BUDGET_CC (${budget}) must be >= ` +
          `CANTON_X402_FAUCET_AMOUNT_CC (${amt}) — a budget below one payout ` +
          `would reject every claim`
      );
    }
    // Lifetime cap: "0" (disabled) is exempt; any positive value must cover at
    // least one payout, else the faucet would 503 from the very first claim.
    if (lifetime > 0 && !(lifetime >= amt)) {
      throw new Error(
        `CANTON_X402_FAUCET_LIFETIME_CAP_CC (${lifetime}) must be 0 (disabled) ` +
          `or >= CANTON_X402_FAUCET_AMOUNT_CC (${amt}) — a positive cap below ` +
          `one payout would reject every claim`
      );
    }
    // The faucet dispenses REAL CC and its per-party-once + lifetime guards are
    // only durable on Postgres. The in-memory fallback re-opens every party (and
    // resets the lifetime total) on restart, so NEVER run the money faucet
    // without a database. Fail fast rather than silently spend.
    if (!process.env.DATABASE_URL) {
      throw new Error(
        `CANTON_X402_FAUCET_ENABLED=true requires DATABASE_URL: the faucet sends ` +
          `real CC and its per-party-once + lifetime caps must be durable across ` +
          `restarts (the in-memory store re-opens every party on restart). Set ` +
          `DATABASE_URL, or disable the faucet.`
      );
    }
  }

  return {
    port: Number(process.env.PORT ?? 4022),
    trustProxy: parseTrustProxy(process.env.CANTON_X402_TRUST_PROXY),
    network,
    participantUrl: required("CANTON_PARTICIPANT_URL"),
    facilitatorParty: required("CANTON_FACILITATOR_PARTY"),
    facilitatorMemberId: process.env.CANTON_FACILITATOR_MEMBER_ID || undefined,
    synchronizerId: required("CANTON_SYNCHRONIZER_ID"),
    scanUrl: required("CANTON_SCAN_URL"),
    scanFallbackUrls: (process.env.CANTON_SCAN_FALLBACK_URLS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
    scanFlavor,
    scanAuth: process.env.CANTON_SCAN_AUTH === "true",
    tfEnabled,
    advertiseTf,
    tfStashCapPerPayer: (() => {
      const raw = Number(process.env.CANTON_X402_TF_STASH_CAP_PER_PAYER);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 8;
    })(),
    tfDefaultExecuteBeforeSeconds: (() => {
      const raw = Number(process.env.CANTON_X402_TF_DEFAULT_EXECUTE_BEFORE_S);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 120;
    })(),
    tfMaxExecuteBeforeSeconds: (() => {
      const raw = Number(process.env.CANTON_X402_TF_MAX_EXECUTE_BEFORE_S);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 600;
    })(),
    settleRateMaxPerPayer: Number(
      process.env.CANTON_X402_SETTLE_RATE_MAX_PER_PAYER ?? 10
    ),
    settleRateMaxPerIp: (() => {
      const raw = Number(process.env.CANTON_X402_SETTLE_RATE_MAX_PER_IP);
      return Number.isFinite(raw) && raw >= 0 ? raw : 100;
    })(),
    settleRateMaxGlobal: Number(
      process.env.CANTON_X402_SETTLE_RATE_MAX_GLOBAL ?? 120
    ),
    settleRateWindowMs: Number(
      process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS ?? 60000
    ),
    settleBreakerThreshold: Number(
      process.env.CANTON_X402_SETTLE_BREAKER_THRESHOLD ?? 3
    ),
    settleBreakerCooldownMs: Number(
      process.env.CANTON_X402_SETTLE_BREAKER_COOLDOWN_MS ?? 60000
    ),
    settleBreakerWindowMs: Number(
      process.env.CANTON_X402_SETTLE_BREAKER_WINDOW_MS ?? 60000
    ),
    // Clamp to [0,1]: a fraction outside that range is a misconfig; a value > 1
    // would make the rate arm un-trippable, < 0 would trip on the first failure.
    settleBreakerFailureRate: (() => {
      const raw = Number(process.env.CANTON_X402_SETTLE_BREAKER_FAILURE_RATE);
      const v = Number.isFinite(raw) ? raw : 0.5;
      return Math.min(1, Math.max(0, v));
    })(),
    settleBreakerMinSamples: (() => {
      const raw = Number(process.env.CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES);
      return Number.isFinite(raw) && raw >= 1 ? raw : 10;
    })(),
    verifyRateMaxPerIp: Number(
      // 120 (was 60): /verify is also keyed on the MERCHANT IP, so a merchant
      // fronting many agents shares one /verify bucket. Raised to match the
      // settle per-IP cap so /verify does not become the new bottleneck once
      // the settle IP cap is lifted. Each settle is preceded by one verify.
      process.env.CANTON_X402_VERIFY_RATE_MAX_PER_IP ?? 120
    ),
    verifyRateWindowMs: Number(
      process.env.CANTON_X402_VERIFY_RATE_WINDOW_MS ??
        process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS ??
        60000
    ),
    jwtIssuer,
    jwtSecret: process.env.JWT_SECRET,
    oidcTokenEndpoint: process.env.OIDC_TOKEN_ENDPOINT,
    oidcClientId: process.env.OIDC_CLIENT_ID,
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET,
    oidcScope: process.env.OIDC_SCOPE,
    ledgerApiAudience: process.env.LEDGER_API_AUDIENCE,
    dbUrl: process.env.DATABASE_URL,
    logLevel: (process.env.LOG_LEVEL ?? "info") as FacilitatorConfig["logLevel"],
    enableCloseRoute: process.env.CANTON_X402_ENABLE_CLOSE_ROUTE === "true",
    enablePreapprovalProvider:
      process.env.CANTON_X402_ENABLE_PREAPPROVAL_PROVIDER === "true",
    enableAgentWallet:
      process.env.CANTON_X402_ENABLE_AGENT_WALLET === "true",
    agentWalletApiKey: process.env.CANTON_X402_AGENT_WALLET_KEY,
    faucetEnabled,
    faucetAmountCc,
    faucetMaxPerIp: (() => {
      const raw = Number(process.env.CANTON_X402_FAUCET_MAX_PER_IP);
      return Number.isFinite(raw) && raw >= 0 ? raw : 5;
    })(),
    faucetDailyBudgetCc,
    faucetLifetimeCapCc,
    faucetWindowMs: (() => {
      const raw = Number(process.env.CANTON_X402_FAUCET_WINDOW_MS);
      return Number.isFinite(raw) && raw > 0 ? raw : 86_400_000;
    })(),
    operatorToken: process.env.CANTON_X402_OPERATOR_TOKEN,
    attributionScanUrls: (process.env.CANTON_ATTRIBUTION_SCAN_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    attributionScanAuth: process.env.CANTON_ATTRIBUTION_SCAN_AUTH === "true",
    attributionRequired: process.env.CANTON_ATTRIBUTION_REQUIRED === "true",
    excludedParticipants: (process.env.CANTON_EXCLUDED_PARTICIPANTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    excludedParties: (process.env.CANTON_EXCLUDED_PARTIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    markerEnabled: process.env.CANTON_X402_MARKER_ENABLED === "true",
    markerFtpParty: process.env.CANTON_X402_MARKER_FTP_PARTY,
    markerUserId: process.env.CANTON_X402_MARKER_USER_ID,
    markerWeightMultiplier: (() => {
      const raw = Number(process.env.CANTON_X402_MARKER_WEIGHT_MULTIPLIER);
      return Number.isFinite(raw) && raw > 0 ? raw : 1.35;
    })(),
    attributionRetryIntervalMs: (() => {
      const raw = Number(process.env.CANTON_X402_ATTRIBUTION_RETRY_MS);
      const v = Number.isFinite(raw) && raw > 0 ? raw : 60_000;
      return Math.max(15_000, v);
    })(),
    discoveryResources: parseDiscoveryResources(
      process.env.CANTON_X402_DISCOVERY_RESOURCES
    ),
  };
}
