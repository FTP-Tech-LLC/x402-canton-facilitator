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
  /** Non-Amulet CIP-56 instrument registries: instrument admin party →
   *  DA Registry Utility base URL. JSON object in
   *  `CANTON_X402_TOKEN_REGISTRIES`, e.g.
   *  `{"decentralized-usdc-interchain-rep::1220...":"https://registry.example"}`.
   *  An instrument whose `admin` is listed here has its preapproval resolved on
   *  that utility (per-registrar path) instead of the SV Scan; Amulet is never
   *  listed and stays on the SV Scan. Empty {} by default. */
  tokenRegistries: Record<string, string>;
  /** Instrument identity per registry admin, advertised in `/supported` so a
   *  merchant can read the full `instrumentId` ({admin,id}) plus a display symbol
   *  rather than hardcoding it. JSON object in `CANTON_X402_TOKEN_INSTRUMENTS`,
   *  e.g. `{"decentralized-usdc-interchain-rep::1220...":{"id":"USDCx","symbol":"USDCx"}}`.
   *  Independent of `tokenRegistries` (which stays {admin:url}); an admin absent
   *  here is still advertised by admin alone. Empty {} by default. */
  tokenInstruments: Record<string, { id: string; symbol?: string }>;
  /** OUT-OF-BAND-trusted registry infrastructure parties per instrument admin, for
   *  non-Amulet CIP-56 tokens. JSON object in `CANTON_X402_REGISTRY_TRUSTED_PARTIES`,
   *  e.g. `{"decentralized-usdc-interchain-rep::1220...":["<operator>","<bridge>"]}`.
   *  A real registry `TransferFactory_Transfer` names the registry operator (and,
   *  for a bridged token, the bridge operator) as signatories/observers, so the
   *  facilitator's inline foreign-party backstop must admit them for that admin.
   *  Sourced out-of-band (operator config / registry `/operator` endpoint), never
   *  from the payload. Empty {} by default → Amulet-identical. */
  registryTrustedParties: Record<string, string[]>;
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
   *  verifies, or settles a transfer-factory payment (routes 503 /
   *  fail-closed with invalid_exact_canton_transfer_factory_disabled). Set via
   *  CANTON_X402_TF_ENABLED=true. Mirrors the DIRECT gate pattern. */
  tfEnabled: boolean;
  /** Advertise `transfer-factory` in /supported transferMethods alongside the
   *  primary. Requires `tfEnabled` (advertised ⟹ enabled — /supported can
   *  never advertise an inert path). Set via CANTON_X402_ADVERTISE_TF=true. */
  advertiseTf: boolean;
  /** executeBefore horizon (seconds) when the client does not request one. */
  tfDefaultExecuteBeforeSeconds: number;
  /** Hard ceiling on a client-requested executeBefore horizon (seconds) —
   *  also bounds how long a payer-signed submission stays settleable. */
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
  /**
   * Topology reader (packages/topology-reader): where the inline arm gets a
   * payer's protocol signing key so it can verify the payment's signature.
   *
   * The key is only reachable through the participant's admin gRPC API, which
   * Canton ships unauthenticated and all-or-nothing — the same port carries
   * ParticipantRepairService. This process serves an unauthenticated /settle to
   * the internet, so it must NOT hold that access; the reader does, beside the
   * participant, and answers exactly one question over HTTP.
   *
   * Absent → no key source → the verifier refuses every inline payment. That is
   * the correct fail-closed default and is what a deploy does today.
   */
  topologyReaderUrl: string | undefined;
  topologyReaderToken: string | undefined;
  /**
   * Which merchants the INLINE carriage will burn our own traffic for.
   *
   * /settle is unauthenticated. The inline carriage lets a stranger post a
   * well-formed transaction between two parties we have no relationship with
   * and make us pay to relay it; the feePayer rule only confirms we were named.
   *
   *   open                  today's behaviour exactly. THE DEFAULT.
   *   provider              the merchant's preapproval names US as its app
   *                         provider — an on-ledger fact that requires the
   *                         named provider's own authority to create.
   *   allowlist             the operator declared this merchant.
   *   provider-or-allowlist either proof; the mode to actually run.
   *
   * Do NOT run bare `provider`: a self-provisioned merchant's preapproval names
   * the MERCHANT as provider, and self-provisioning is this repo's documented
   * onboarding route, so `provider` alone would refuse most honest traffic.
   * An unrecognised value THROWS at boot. Falling back to `open` would let a
   * typo silently disable the gate while the operator reads their own .env and
   * believes it is on.
   */
  inlineMerchantPolicy: "open" | "provider" | "allowlist" | "provider-or-allowlist";
  /** Merchant parties accepted by the `allowlist` arms above. */
  inlineMerchantAllowlist: string[];
  /** Rollout stage for the /settle unknown-outcome guard: off (default,
   *  identical to the pre-guard build) | observe (record + metric, response
   *  unchanged) | enforce (503 on an unresolved mark). */
  settleDispatchMarkMode: "off" | "observe" | "enforce";
  /** Max relay submit/execute calls per (party, caller IP) per minute. Each is
   *  a real ledger submission that spends Global Synchronizer traffic. */
  walletSubmitRateMaxPerKey: number;
  /** Per-CALLER ceiling on relay submissions per minute. The per-key cap above
   *  contains a caller-asserted party, so it alone bounds nothing: minting a
   *  fresh well-formed party per request mints a fresh bucket. Default 4x the
   *  per-key cap, so an honest host running several agents is unaffected. */
  walletSubmitRateMaxPerIp: number;
  /**
   * Ceiling on external-party ALLOCATIONS per minute across the whole
   * facilitator, regardless of who asks. 0 disables it.
   *
   * The per-IP cap next to this one is admission control, and admission
   * control cannot bound a GLOBAL resource: `onboard/finalize` writes a
   * permanent topology transaction to the Global Synchronizer under our
   * participant, on our traffic, and consumes a user-rights slot
   * (TOO_MANY_USER_RIGHTS is a limit this participant has already met). The
   * route is anonymous in production, so "per IP" costs an attacker one more
   * IP per bucket and costs us a permanent allocation each time.
   *
   * Default 60/min — deliberately generous: measured production onboarding is
   * ~2 per HOUR with a busiest minute of 2, so this is thirty times the
   * observed peak, and it still turns "unbounded × however many IPs you have"
   * into a hard ceiling the operator can lower.
   */
  walletOnboardRateMaxGlobal: number;
  /**
   * How many pay/prepare attempts one payer may WASTE per window before the
   * route stops doing the expensive part at all, and the window length.
   *
   * Only refusals caused by the PAYER'S OWN STATE are charged — today that is
   * `insufficient holdings`, the answer that costs a DSO lookup and a full ACS
   * query to reach. A prepare that succeeds costs nothing here, so a busy
   * honest client never sees this budget at all.
   *
   * The point: a failed prepare writes nothing and costs nothing to repeat,
   * which is backwards — successful work is paid for by the resulting payment
   * while failed work is pure loss, and an unfunded client in a retry loop
   * generates only the latter. Charging the loss bounds it.
   *
   * `<= 0` on the count disables the budget entirely.
   */
  walletPrepareWasteMax: number;
  walletPrepareWasteWindowMs: number;
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
  /**
   * Which DAML choices `/v1/wallet/submit/prepare` will build a transaction
   * for.
   *
   * The relay is deliberately open — that is how the published agent wallet
   * onboards an agent with no credential, and locking it would break every
   * shipped integrator. But "open onboarding" was never meant to imply "build
   * me any transaction you like": the route forwarded `commands` verbatim with
   * no restriction, so anyone could make our participant do unbounded work.
   *
   * They could not MOVE anyone's money that way — execute verifies the party's
   * signature against topology, and the faucet has its own secret — so this is
   * resource abuse rather than theft. It is still ours to pay for.
   *
   * The default is the exact set the shipped client uses, measured from its
   * only call site rather than guessed. `*` disables the check for an operator
   * who knowingly wants the old behaviour.
   */
  walletSubmitChoiceAllowlist: readonly string[];
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
  /** When set, the raw faucet route (POST /v1/wallet/faucet/claim) requires a
   *  matching `X-Faucet-Secret` header (constant-time) and 403s otherwise —
   *  locking it to the trusted internal caller (the pay-proxy quest flow) so the
   *  public internet cannot curl the faucet directly. UNSET (default) → no gate
   *  (dev/back-compat). CANTON_X402_FAUCET_INTERNAL_SECRET. */
  faucetInternalSecret: string | undefined;
  /** GLOBAL burst cap: max faucet claims per `faucetBurstWindowMs` across ALL
   *  non-exempt callers. The daily budget bounds the 24h total but NOT a fast
   *  burst (a 500-claims-in-10-min flood fits under a big daily budget); this
   *  throttles the burst itself so nobody can hammer the public faucet. It is
   *  IP-independent (one shared bucket), so it works even when abusers rotate IPs
   *  or legit callers share one. Low-rate legit callers (a dev running auto_fund
   *  once) never hit it. `0` (default) disables it. CANTON_X402_FAUCET_MAX_GLOBAL_PER_MIN. */
  faucetMaxGlobalPerMin: number;
  /** Rolling window (ms) for the global burst cap. Default 60000 (1 min).
   *  CANTON_X402_FAUCET_BURST_WINDOW_MS. */
  faucetBurstWindowMs: number;
  /** Client IPs EXEMPT from the per-IP + global-burst faucet caps — trusted
   *  internal callers that do their OWN limiting. In prod this is the pay-proxy's
   *  internal docker IP (the quest funds only in STEP 2 after a real payment and
   *  is bounded by its own budget, so it must not be throttled by the raw-faucet
   *  burst cap). The per-party-once guard + daily budget still apply to exempt
   *  callers. Comma-separated; empty (default) → no exemptions.
   *  CANTON_X402_FAUCET_IP_EXEMPT. */
  faucetIpExempt: string[];
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
  /** Marker weight multiplier (`CANTON_X402_MARKER_WEIGHT_MULTIPLIER`) — the
   *  overuse / cost-recovery coefficient applied to the round's total GS traffic
   *  weight (target 1.15 = +15%). Env-driven, re-tunable with a restart and no
   *  image rebuild; tune down if live overuse approaches the FA cap. Default 1.15;
   *  any non-numeric or non-positive value falls back to the default. */
  markerWeightMultiplier: number;
  /** Hard per-round FA marker weight ceiling in USD
   *  (`CANTON_X402_MARKER_MAX_WEIGHT_PER_ROUND`). Clamps an abuse/anomaly traffic
   *  spike so a single round can never be amplified into an overuse-cap breach.
   *  Default 1000; non-numeric/non-positive falls back to the default. */
  markerMaxWeightPerRound: number;
  /** Per-round free-base traffic grant in bytes added to the paid delta before
   *  pricing (`CANTON_X402_MARKER_FREE_BYTES_PER_ROUND`). Default 0 — claim only
   *  the purchased delta. Set it ONLY if the node's own built-in free-base FA
   *  emission is off; with that emission on, a non-zero value double-counts the
   *  free base and over-emits markers. Unlike the other marker knobs 0 is a
   *  MEANINGFUL value, so only negative/non-numeric falls back to the default. */
  markerFreeBytesPerRound: number;
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

/**
 * A non-negative number from an env var, or the documented default.
 *
 * These fields are COST CAPS. A bare `Number()` turns a typo into NaN, and
 * every `>=` comparison against NaN is false — so a misspelled value does not
 * fall back, it REMOVES the cap, while the operator reads their own .env and
 * believes the limit is on. Silent removal of a limit is the one outcome worth
 * writing a helper to prevent.
 *
 * The helper did it anyway, through a door it did not look at. `??` only
 * substitutes for null/undefined, so a variable that is SET BUT EMPTY passed
 * straight through — and `Number("")` is 0, which satisfies `n >= 0`. Zero is
 * not a small cap here, it is the DISABLED sentinel for every consumer:
 * `<= 0 disables this cap` (rate-limit.ts) for the settle/verify/wallet
 * limiters, `<= 0 disables the breaker entirely` for the traffic breaker, and
 * a window of 0 makes the sliding window drop every hit it just recorded.
 *
 * `KEY=` with nothing after it is this repo's own house style for a placeholder
 * in the ops .env.example files, and the compose files pass those keys through bare —
 * so the shape that removes every cap is the shape an operator is invited to
 * write. Empty and whitespace now mean exactly what unset means.
 *
 * A non-empty value that is merely WRONG still falls back, which is this file's
 * existing, tested decision and a safe one: the fallback is the documented cap,
 * not "no cap". Only the empty case had to change.
 */
function numericEnv(raw: string | undefined, fallback: number): number {
  // EMPTY MEANS UNSET. Everything below already handled a typo correctly; this
  // line is the one that was missing, and it is the dangerous one.
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
    tokenRegistries: (() => {
      const raw = process.env.CANTON_X402_TOKEN_REGISTRIES;
      if (!raw || !raw.trim()) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const out: Record<string, string> = {};
          for (const [admin, url] of Object.entries(
            parsed as Record<string, unknown>
          )) {
            if (typeof url === "string" && url.trim()) {
              out[admin] = url.trim().replace(/\/$/, "");
            }
          }
          return out;
        }
      } catch {
        /* fall through to empty — an unparseable value must not settle CC on a
           registry the operator did not actually configure */
      }
      console.warn(
        "CANTON_X402_TOKEN_REGISTRIES is set but not a valid JSON object of {admin: url}; ignoring (Amulet-only)"
      );
      return {};
    })(),
    tokenInstruments: (() => {
      const raw = process.env.CANTON_X402_TOKEN_INSTRUMENTS;
      if (!raw || !raw.trim()) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const out: Record<string, { id: string; symbol?: string }> = {};
          for (const [admin, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") {
              const id = (v as { id: string }).id.trim();
              const symbolRaw = (v as { symbol?: unknown }).symbol;
              if (!id) continue;
              out[admin] = {
                id,
                ...(typeof symbolRaw === "string" && symbolRaw.trim()
                  ? { symbol: symbolRaw.trim() }
                  : {}),
              };
            }
          }
          return out;
        }
      } catch {
        /* fall through — an unparseable value just means no id/symbol enrichment */
      }
      console.warn(
        "CANTON_X402_TOKEN_INSTRUMENTS is set but not a valid JSON object of {admin:{id,symbol}}; ignoring"
      );
      return {};
    })(),
    registryTrustedParties: (() => {
      const raw = process.env.CANTON_X402_REGISTRY_TRUSTED_PARTIES;
      if (!raw || !raw.trim()) return {};
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const out: Record<string, string[]> = {};
          for (const [admin, parties] of Object.entries(
            parsed as Record<string, unknown>
          )) {
            if (Array.isArray(parties)) {
              const ps = parties.filter(
                (p): p is string => typeof p === "string" && p.trim().length > 0
              );
              if (ps.length > 0) out[admin] = ps;
            }
          }
          return out;
        }
      } catch {
        /* fall through to empty — a malformed trust set must not silently widen
           the foreign-party backstop */
      }
      console.warn(
        "CANTON_X402_REGISTRY_TRUSTED_PARTIES is set but not a valid JSON object of {admin: string[]}; ignoring"
      );
      return {};
    })(),
    tfEnabled,
    advertiseTf,
    tfDefaultExecuteBeforeSeconds: (() => {
      const raw = Number(process.env.CANTON_X402_TF_DEFAULT_EXECUTE_BEFORE_S);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 120;
    })(),
    tfMaxExecuteBeforeSeconds: (() => {
      const raw = Number(process.env.CANTON_X402_TF_MAX_EXECUTE_BEFORE_S);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 600;
    })(),
    settleRateMaxPerPayer: numericEnv(
      process.env.CANTON_X402_SETTLE_RATE_MAX_PER_PAYER,
      10
    ),
    // Through `numericEnv`, not a hand-rolled copy. The copy read `Number("")`
    // as 0, and 0 is the DISABLE value for this cap — so blanking the line in
    // .env (how an operator comments a knob out, and how it appears in
    // .env.example) removed the cap instead of restoring the default. An
    // explicit `0` still disables, which is the documented switch.
    settleRateMaxPerIp: numericEnv(
      process.env.CANTON_X402_SETTLE_RATE_MAX_PER_IP,
      100
    ),
    settleRateMaxGlobal: numericEnv(
      process.env.CANTON_X402_SETTLE_RATE_MAX_GLOBAL,
      120
    ),
    settleRateWindowMs: numericEnv(
      process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS,
      60000
    ),
    settleBreakerThreshold: numericEnv(
      process.env.CANTON_X402_SETTLE_BREAKER_THRESHOLD,
      3
    ),
    settleBreakerCooldownMs: numericEnv(
      process.env.CANTON_X402_SETTLE_BREAKER_COOLDOWN_MS,
      60000
    ),
    settleBreakerWindowMs: numericEnv(
      process.env.CANTON_X402_SETTLE_BREAKER_WINDOW_MS,
      60000
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
    topologyReaderUrl: process.env.CANTON_X402_TOPOLOGY_READER_URL,
    topologyReaderToken: process.env.CANTON_X402_TOPOLOGY_READER_TOKEN,
    inlineMerchantPolicy: (() => {
      const raw = process.env.CANTON_X402_INLINE_MERCHANT_POLICY;
      if (raw === undefined || raw.trim() === "") return "open" as const;
      const v = raw.trim();
      // THROW on a value we do not recognise rather than falling back.
      //
      // This gate is the only thing standing between an unauthenticated
      // /settle and a stranger making us burn our own Global Synchronizer
      // traffic. Every other spelling of "be safe on bad input" would be
      // wrong here: falling back to the MOST permissive setting means a typo
      // silently disables the protection while the operator reads their own
      // .env and believes it is on. A boot that refuses is loud and cheap; a
      // gate that is quietly off is neither.
      if (v !== "open" && v !== "provider" && v !== "allowlist" && v !== "provider-or-allowlist") {
        throw new Error(
          `CANTON_X402_INLINE_MERCHANT_POLICY must be one of open|provider|allowlist|provider-or-allowlist, got ${JSON.stringify(v)}`
        );
      }
      return v;
    })(),
    walletSubmitRateMaxPerKey: numericEnv(
      process.env.CANTON_X402_WALLET_SUBMIT_RATE_MAX,
      60
    ),
    walletOnboardRateMaxGlobal: numericEnv(
      process.env.CANTON_X402_WALLET_ONBOARD_RATE_MAX_GLOBAL,
      60
    ),
    walletSubmitRateMaxPerIp: numericEnv(
      process.env.CANTON_X402_WALLET_SUBMIT_RATE_MAX_PER_IP,
      240
    ),
    walletPrepareWasteMax: numericEnv(
      process.env.CANTON_X402_WALLET_PREPARE_WASTE_MAX,
      10
    ),
    walletPrepareWasteWindowMs: numericEnv(
      process.env.CANTON_X402_WALLET_PREPARE_WASTE_WINDOW_MS,
      300_000
    ),
    // HOW THE UNKNOWN-OUTCOME GUARD ROLLS OUT, and why it is not simply "on".
    //
    // The guard changes a MERCHANT-VISIBLE response class: a retry of a
    // submission we dispatched and never resolved gets 503 instead of a settle
    // verdict. Measured against the running build, that class does not exist
    // there at all — so switching it on in a deploy would change what every
    // integrator sees, in one step, on the strength of unit tests alone.
    //
    // Nobody knows how often the unknown outcome actually happens in
    // production. `observe` is how we find out: the mark is written, the
    // metric and the log line fire, and the response stays byte-for-byte what
    // it is today. It does NOT resolve — resolving is a ledger read, and
    // observe is supposed to cost nothing observable. The counter alone
    // answers the question the flip depends on: how often, on real traffic.
    // Then that number decides, and deciding is one environment variable, no
    // rebuild.
    //
    //   off      (default) nothing is written, nothing is read. Identical to
    //            the build running today.
    //   observe  mark + metric, response unchanged, no resolve.
    //   enforce  an unresolved mark answers 503 settle_outcome_unknown.
    //
    // A staged-rollout knob: off (default) → observe → enforce.
    settleDispatchMarkMode: (() => {
      const raw = process.env.CANTON_X402_SETTLE_DISPATCH_MARK;
      if (raw === undefined || raw.trim() === "") return "off" as const;
      const v = raw.trim();
      if (v !== "off" && v !== "observe" && v !== "enforce") {
        throw new Error(
          `CANTON_X402_SETTLE_DISPATCH_MARK must be one of off|observe|enforce, ` +
            `got ${JSON.stringify(v)}`
        );
      }
      return v;
    })(),
    inlineMerchantAllowlist: (
      process.env.CANTON_X402_INLINE_MERCHANT_ALLOWLIST ?? ""
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // 120 (was 60): /verify is also keyed on the MERCHANT IP, so a merchant
    // fronting many agents shares one /verify bucket. Raised to match the
    // settle per-IP cap so /verify does not become the new bottleneck once the
    // settle IP cap is lifted. Each settle is preceded by one verify.
    verifyRateMaxPerIp: numericEnv(
      process.env.CANTON_X402_VERIFY_RATE_MAX_PER_IP,
      120
    ),
    verifyRateWindowMs: numericEnv(
      process.env.CANTON_X402_VERIFY_RATE_WINDOW_MS ??
        process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS,
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
    walletSubmitChoiceAllowlist: (() => {
      const raw = process.env.CANTON_X402_WALLET_SUBMIT_CHOICES;
      if (raw === undefined || raw.trim() === "") {
        // agent-wallet's prepareSignExecute has exactly one call site, and it
        // builds exactly these two. Anything else has never been part of the
        // documented path.
        return ["TransferFactory_Transfer", "TransferInstruction_Accept"] as const;
      }
      return Object.freeze(
        raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      );
    })(),
    faucetEnabled,
    faucetAmountCc,
    // Same reason as settleRateMaxPerIp above: empty must mean UNSET, because
    // here 0 means uncapped and this one gates a faucet that sends real CC.
    faucetMaxPerIp: numericEnv(process.env.CANTON_X402_FAUCET_MAX_PER_IP, 5),
    faucetDailyBudgetCc,
    faucetLifetimeCapCc,
    faucetWindowMs: (() => {
      const raw = Number(process.env.CANTON_X402_FAUCET_WINDOW_MS);
      return Number.isFinite(raw) && raw > 0 ? raw : 86_400_000;
    })(),
    faucetInternalSecret:
      process.env.CANTON_X402_FAUCET_INTERNAL_SECRET?.trim() || undefined,
    faucetMaxGlobalPerMin: (() => {
      const raw = Number(process.env.CANTON_X402_FAUCET_MAX_GLOBAL_PER_MIN);
      return Number.isFinite(raw) && raw >= 0 ? raw : 0;
    })(),
    faucetBurstWindowMs: (() => {
      const raw = Number(process.env.CANTON_X402_FAUCET_BURST_WINDOW_MS);
      return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
    })(),
    faucetIpExempt: (process.env.CANTON_X402_FAUCET_IP_EXEMPT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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
      return Number.isFinite(raw) && raw > 0 ? raw : 1.15;
    })(),
    markerMaxWeightPerRound: (() => {
      const raw = Number(process.env.CANTON_X402_MARKER_MAX_WEIGHT_PER_ROUND);
      return Number.isFinite(raw) && raw > 0 ? raw : 1000;
    })(),
    markerFreeBytesPerRound: (() => {
      // 0 is meaningful here (claim nothing extra) and is also the default, so
      // the guard is >= 0, not > 0 — a `0` must survive, not fall back.
      const raw = Number(process.env.CANTON_X402_MARKER_FREE_BYTES_PER_ROUND);
      return Number.isFinite(raw) && raw >= 0 ? raw : 0;
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
