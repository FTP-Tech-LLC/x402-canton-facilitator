import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, parseTrustProxy } from "./config.js";

/**
 * Config defaults matter for first-run UX — if a fresh dev sets
 * the minimum required env vars and starts the server, it should
 * speak the LocalNet protocol (unsafe-hmac, well-known port). These
 * tests pin those defaults so we don't accidentally regress to
 * "OIDC by default" (which silently uses the secret string as the
 * token and fails at first ledger call).
 */

const REQUIRED = [
  "CANTON_NETWORK",
  "CANTON_PARTICIPANT_URL",
  "CANTON_FACILITATOR_PARTY",
  "CANTON_SYNCHRONIZER_ID",
  "CANTON_SCAN_URL",
] as const;

const OPTIONAL = [
  "PORT",
  "JWT_ISSUER",
  "JWT_SECRET",
  "OIDC_TOKEN_ENDPOINT",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_SCOPE",
  "LEDGER_API_AUDIENCE",
  "CANTON_SCAN_FLAVOR",
  "LOG_LEVEL",
  "DATABASE_URL",
  "CANTON_X402_TRUST_PROXY",
  "CANTON_X402_MARKER_WEIGHT_MULTIPLIER",
  "CANTON_X402_SETTLE_RATE_MAX_PER_IP",
  "CANTON_X402_VERIFY_RATE_MAX_PER_IP",
  "CANTON_SCAN_FALLBACK_URLS",
  "CANTON_X402_FAUCET_ENABLED",
  "CANTON_X402_FAUCET_AMOUNT_CC",
  "CANTON_X402_FAUCET_MAX_PER_IP",
  "CANTON_X402_FAUCET_DAILY_BUDGET_CC",
  "CANTON_X402_FAUCET_LIFETIME_CAP_CC",
  "CANTON_X402_FAUCET_WINDOW_MS",
] as const;

describe("loadConfig", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of [...REQUIRED, ...OPTIONAL]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function minimal(): void {
    process.env.CANTON_NETWORK = "canton:devnet";
    process.env.CANTON_PARTICIPANT_URL = "http://localhost:3975";
    process.env.CANTON_FACILITATOR_PARTY = "ftp_facilitator::1220";
    process.env.CANTON_SYNCHRONIZER_ID = "global-domain::1220";
    process.env.CANTON_SCAN_URL = "http://localhost:3903";
    process.env.DATABASE_URL = "postgres://x:x@localhost/x";
  }

  it("returns sensible defaults with minimum required env", () => {
    minimal();
    const c = loadConfig();
    expect(c.port).toBe(4022);
    expect(c.jwtIssuer).toBe("unsafe-hmac"); // LocalNet default
    expect(c.logLevel).toBe("info");
    expect(c.network).toBe("canton:devnet");
  });

  /** Set the four OIDC env vars to non-empty values so loadConfig
   *  passes the JWT_ISSUER=oidc validation. */
  function oidcEnv(): void {
    process.env.OIDC_TOKEN_ENDPOINT = "https://idp.example/oauth/token";
    process.env.OIDC_CLIENT_ID = "client-id";
    process.env.OIDC_CLIENT_SECRET = "client-secret";
    process.env.LEDGER_API_AUDIENCE = "https://canton.network.global";
  }

  it("honors JWT_ISSUER=oidc when explicitly set with all OIDC vars present", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    expect(loadConfig().jwtIssuer).toBe("oidc");
  });

  for (const missing of [
    "OIDC_TOKEN_ENDPOINT",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "LEDGER_API_AUDIENCE",
  ]) {
    it(`hard-fails fast when JWT_ISSUER=oidc but ${missing} is missing`, () => {
      minimal();
      oidcEnv();
      process.env.JWT_ISSUER = "oidc";
      delete process.env[missing];
      expect(() => loadConfig()).toThrow(new RegExp(missing));
    });
  }

  it("defaults CANTON_SCAN_FLAVOR to 'validator' under unsafe-hmac", () => {
    minimal();
    expect(loadConfig().scanFlavor).toBe("validator");
  });

  it("defaults CANTON_SCAN_FLAVOR to 'sv' under oidc (public SV Scan, no auth)", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    expect(loadConfig().scanFlavor).toBe("sv");
  });

  it("honors an explicit CANTON_SCAN_FLAVOR override", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.CANTON_SCAN_FLAVOR = "validator";
    expect(loadConfig().scanFlavor).toBe("validator");
  });

  it("rejects an invalid CANTON_SCAN_FLAVOR", () => {
    minimal();
    process.env.CANTON_SCAN_FLAVOR = "garbage";
    expect(() => loadConfig()).toThrow(/CANTON_SCAN_FLAVOR/);
  });

  it("rejects an invalid CANTON_NETWORK", () => {
    minimal();
    process.env.CANTON_NETWORK = "ethereum:mainnet";
    expect(() => loadConfig()).toThrow(/CANTON_NETWORK must be/);
  });

  it("accepts canton:testnet", () => {
    minimal();
    process.env.CANTON_NETWORK = "canton:testnet";
    expect(loadConfig().network).toBe("canton:testnet");
  });

  it("LOG_LEVEL defaults to 'info' when not set", () => {
    minimal();
    expect(loadConfig().logLevel).toBe("info");
  });

  it("PORT defaults to 4022 when not set", () => {
    minimal();
    expect(loadConfig().port).toBe(4022);
  });

  it("trustProxy defaults to loopback-only (safe; NOT true) when unset", () => {
    // Adversarial-review HIGH fix: the default must NOT be `true` (whole-chain
    // trust, which makes req.ip client-forgeable). Loopback-only matches the
    // documented Caddy/Nginx-on-127.0.0.1 deploys.
    minimal();
    delete process.env.CANTON_X402_TRUST_PROXY;
    expect(loadConfig().trustProxy).toEqual(["loopback"]);
  });

  it("CANTON_X402_TRUST_PROXY=true is honoured (explicit opt-in to the unsafe mode)", () => {
    minimal();
    process.env.CANTON_X402_TRUST_PROXY = "true";
    expect(loadConfig().trustProxy).toBe(true);
  });

  it("CANTON_X402_TRUST_PROXY accepts a CIDR list for a non-loopback proxy", () => {
    minimal();
    process.env.CANTON_X402_TRUST_PROXY = "10.0.0.0/8, 192.168.1.1";
    expect(loadConfig().trustProxy).toEqual(["10.0.0.0/8", "192.168.1.1"]);
  });

  it("markerWeightMultiplier defaults to 1.35 when unset", () => {
    minimal();
    delete process.env.CANTON_X402_MARKER_WEIGHT_MULTIPLIER;
    expect(loadConfig().markerWeightMultiplier).toBe(1.35);
  });

  it("CANTON_X402_MARKER_WEIGHT_MULTIPLIER overrides the uplift", () => {
    minimal();
    process.env.CANTON_X402_MARKER_WEIGHT_MULTIPLIER = "1.5";
    expect(loadConfig().markerWeightMultiplier).toBe(1.5);
  });

  it("markerWeightMultiplier honors a fractional value below 1.0 (discount)", () => {
    minimal();
    process.env.CANTON_X402_MARKER_WEIGHT_MULTIPLIER = "0.5";
    expect(loadConfig().markerWeightMultiplier).toBe(0.5);
  });

  it("markerWeightMultiplier falls back to 1.35 on a non-numeric / non-positive value", () => {
    minimal();
    process.env.CANTON_X402_MARKER_WEIGHT_MULTIPLIER = "not-a-number";
    expect(loadConfig().markerWeightMultiplier).toBe(1.35);
    process.env.CANTON_X402_MARKER_WEIGHT_MULTIPLIER = "0";
    expect(loadConfig().markerWeightMultiplier).toBe(1.35);
  });

  it("verifyRateMaxPerIp defaults to 120; window inherits the settle window default", () => {
    minimal();
    delete process.env.CANTON_X402_VERIFY_RATE_MAX_PER_IP;
    delete process.env.CANTON_X402_VERIFY_RATE_WINDOW_MS;
    delete process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS;
    const c = loadConfig();
    // Raised 60 -> 120: /verify is keyed on the merchant IP too, so it must not
    // become the bottleneck once the settle per-IP cap is lifted.
    expect(c.verifyRateMaxPerIp).toBe(120);
    expect(c.verifyRateWindowMs).toBe(60000); // ultimate default
  });

  it("settleRateMaxPerIp defaults to 100 (above per-payer, below global) and overrides via env", () => {
    minimal();
    delete process.env.CANTON_X402_SETTLE_RATE_MAX_PER_IP;
    expect(loadConfig().settleRateMaxPerIp).toBe(100);
    process.env.CANTON_X402_SETTLE_RATE_MAX_PER_IP = "500";
    expect(loadConfig().settleRateMaxPerIp).toBe(500);
    process.env.CANTON_X402_SETTLE_RATE_MAX_PER_IP = "0"; // 0 = disable IP cap
    expect(loadConfig().settleRateMaxPerIp).toBe(0);
    process.env.CANTON_X402_SETTLE_RATE_MAX_PER_IP = "garbage";
    expect(loadConfig().settleRateMaxPerIp).toBe(100); // invalid -> default
  });

  it("settle breaker window/rate/min-samples default and override (rate clamped to 0..1, min-samples floored at 1)", () => {
    minimal();
    delete process.env.CANTON_X402_SETTLE_BREAKER_WINDOW_MS;
    delete process.env.CANTON_X402_SETTLE_BREAKER_FAILURE_RATE;
    delete process.env.CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES;
    let c = loadConfig();
    expect(c.settleBreakerWindowMs).toBe(60000);
    expect(c.settleBreakerFailureRate).toBe(0.5);
    expect(c.settleBreakerMinSamples).toBe(10);
    // Valid overrides.
    process.env.CANTON_X402_SETTLE_BREAKER_WINDOW_MS = "30000";
    process.env.CANTON_X402_SETTLE_BREAKER_FAILURE_RATE = "0.8";
    process.env.CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES = "20";
    c = loadConfig();
    expect(c.settleBreakerWindowMs).toBe(30000);
    expect(c.settleBreakerFailureRate).toBe(0.8);
    expect(c.settleBreakerMinSamples).toBe(20);
    // Failure-rate clamped into [0,1]; a >1 value would make the rate arm
    // un-trippable and <0 would trip on the first failure.
    process.env.CANTON_X402_SETTLE_BREAKER_FAILURE_RATE = "5";
    expect(loadConfig().settleBreakerFailureRate).toBe(1);
    process.env.CANTON_X402_SETTLE_BREAKER_FAILURE_RATE = "-2";
    expect(loadConfig().settleBreakerFailureRate).toBe(0);
    process.env.CANTON_X402_SETTLE_BREAKER_FAILURE_RATE = "garbage";
    expect(loadConfig().settleBreakerFailureRate).toBe(0.5); // invalid -> default
    // min-samples floored at 1 (0/negative/garbage -> default 10).
    process.env.CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES = "0";
    expect(loadConfig().settleBreakerMinSamples).toBe(10);
    delete process.env.CANTON_X402_SETTLE_BREAKER_WINDOW_MS;
    delete process.env.CANTON_X402_SETTLE_BREAKER_FAILURE_RATE;
    delete process.env.CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES;
  });

  it("scanFallbackUrls parses a comma list (trim, strip trailing slash, drop empties); empty by default", () => {
    minimal();
    delete process.env.CANTON_SCAN_FALLBACK_URLS;
    expect(loadConfig().scanFallbackUrls).toEqual([]);
    process.env.CANTON_SCAN_FALLBACK_URLS =
      " https://a.test/ , https://b.test ,, ";
    expect(loadConfig().scanFallbackUrls).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("CANTON_X402_VERIFY_RATE_MAX_PER_IP overrides the per-IP cap", () => {
    minimal();
    process.env.CANTON_X402_VERIFY_RATE_MAX_PER_IP = "5";
    expect(loadConfig().verifyRateMaxPerIp).toBe(5);
    delete process.env.CANTON_X402_VERIFY_RATE_MAX_PER_IP;
  });

  it("verifyRateWindowMs falls back to the settle window when its own var is unset", () => {
    minimal();
    delete process.env.CANTON_X402_VERIFY_RATE_WINDOW_MS;
    process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS = "12345";
    expect(loadConfig().verifyRateWindowMs).toBe(12345);
    delete process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS;
  });

  it("CANTON_X402_VERIFY_RATE_WINDOW_MS takes precedence over the settle window", () => {
    minimal();
    process.env.CANTON_X402_VERIFY_RATE_WINDOW_MS = "777";
    process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS = "12345";
    expect(loadConfig().verifyRateWindowMs).toBe(777);
    delete process.env.CANTON_X402_VERIFY_RATE_WINDOW_MS;
    delete process.env.CANTON_X402_SETTLE_RATE_WINDOW_MS;
  });

  it("loads a valid mainnet config correctly", () => {
    minimal();
    oidcEnv();
    process.env.CANTON_NETWORK = "canton:mainnet";
    process.env.CANTON_PARTICIPANT_URL = "https://participant.canton.network";
    process.env.CANTON_FACILITATOR_PARTY = "ftp_facilitator::mainnet1220";
    process.env.CANTON_SYNCHRONIZER_ID = "global-domain::mainnet1220";
    process.env.CANTON_SCAN_URL = "https://scan.sv-1.canton.network";
    process.env.JWT_ISSUER = "oidc";
    const c = loadConfig();
    expect(c.network).toBe("canton:mainnet");
    expect(c.jwtIssuer).toBe("oidc");
    expect(c.participantUrl).toBe("https://participant.canton.network");
    expect(c.facilitatorParty).toBe("ftp_facilitator::mainnet1220");
    expect(c.synchronizerId).toBe("global-domain::mainnet1220");
    expect(c.scanUrl).toBe("https://scan.sv-1.canton.network");
    expect(c.scanFlavor).toBe("sv"); // oidc defaults to sv
  });

  for (const key of REQUIRED) {
    it(`throws when ${key} is missing`, () => {
      minimal();
      delete process.env[key];
      expect(() => loadConfig()).toThrow(new RegExp(`missing required env: ${key}`));
    });
  }

  it("honors custom PORT=9999", () => {
    minimal();
    process.env.PORT = "9999";
    expect(loadConfig().port).toBe(9999);
  });

  it("honors custom LOG_LEVEL=debug", () => {
    minimal();
    process.env.LOG_LEVEL = "debug";
    expect(loadConfig().logLevel).toBe("debug");
  });

  it("JWT_SECRET env var is passed through to jwtSecret field", () => {
    minimal();
    process.env.JWT_SECRET = "my-super-secret-key";
    expect(loadConfig().jwtSecret).toBe("my-super-secret-key");
  });

  it("OIDC_SCOPE is passed through to oidcScope field", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.OIDC_SCOPE = "openid profile";
    expect(loadConfig().oidcScope).toBe("openid profile");
  });

  it("all OIDC fields are mapped correctly when JWT_ISSUER=oidc", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.OIDC_SCOPE = "openid offline_access";
    const c = loadConfig();
    expect(c.jwtIssuer).toBe("oidc");
    expect(c.oidcTokenEndpoint).toBe("https://idp.example/oauth/token");
    expect(c.oidcClientId).toBe("client-id");
    expect(c.oidcClientSecret).toBe("client-secret");
    expect(c.oidcScope).toBe("openid offline_access");
    expect(c.ledgerApiAudience).toBe("https://canton.network.global");
  });

  it("CANTON_PARTICIPANT_URL is stored verbatim in participantUrl", () => {
    minimal();
    process.env.CANTON_PARTICIPANT_URL = "https://participant.example.com:7575";
    expect(loadConfig().participantUrl).toBe("https://participant.example.com:7575");
  });

  it("CANTON_FACILITATOR_PARTY is stored verbatim in facilitatorParty", () => {
    minimal();
    process.env.CANTON_FACILITATOR_PARTY = "ftp_facilitator::122012345abc";
    expect(loadConfig().facilitatorParty).toBe("ftp_facilitator::122012345abc");
  });

  it("CANTON_SYNCHRONIZER_ID is stored verbatim in synchronizerId", () => {
    minimal();
    process.env.CANTON_SYNCHRONIZER_ID = "global-domain::122099xyz";
    expect(loadConfig().synchronizerId).toBe("global-domain::122099xyz");
  });

  it("PORT=0 (zero) is loaded as port:0", () => {
    minimal();
    process.env.PORT = "0";
    expect(loadConfig().port).toBe(0);
  });

  it("LOG_LEVEL=warn is honored", () => {
    minimal();
    process.env.LOG_LEVEL = "warn";
    expect(loadConfig().logLevel).toBe("warn");
  });

  it("LOG_LEVEL=error is honored", () => {
    minimal();
    process.env.LOG_LEVEL = "error";
    expect(loadConfig().logLevel).toBe("error");
  });

  it("JWT_SECRET=undefined (not set) → jwtSecret is undefined in config", () => {
    minimal();
    // JWT_SECRET is already deleted in beforeEach via OPTIONAL list
    const c = loadConfig();
    expect(c.jwtSecret).toBeUndefined();
  });

  it("OIDC_TOKEN_ENDPOINT with trailing slash is preserved verbatim", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.OIDC_TOKEN_ENDPOINT = "https://idp.example/oauth/token/";
    expect(loadConfig().oidcTokenEndpoint).toBe("https://idp.example/oauth/token/");
  });

  it("CANTON_SCAN_FLAVOR=validator explicitly set → scanFlavor=validator even under oidc", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.CANTON_SCAN_FLAVOR = "validator";
    expect(loadConfig().scanFlavor).toBe("validator");
  });

  it("CANTON_SCAN_FLAVOR=sv explicitly set → scanFlavor=sv even under unsafe-hmac", () => {
    minimal();
    process.env.CANTON_SCAN_FLAVOR = "sv";
    expect(loadConfig().scanFlavor).toBe("sv");
  });

  it("CANTON_PARTICIPANT_URL with path component is stored verbatim (no stripping)", () => {
    minimal();
    process.env.CANTON_PARTICIPANT_URL = "http://localhost:3975/some/path";
    expect(loadConfig().participantUrl).toBe("http://localhost:3975/some/path");
  });

  it("PORT=65535 → port:65535 (max valid port)", () => {
    minimal();
    process.env.PORT = "65535";
    expect(loadConfig().port).toBe(65535);
  });

  it("OIDC_CLIENT_ID is stored verbatim in oidcClientId", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.OIDC_CLIENT_ID = "my-exact-client-id-with-dashes_and.dots";
    expect(loadConfig().oidcClientId).toBe("my-exact-client-id-with-dashes_and.dots");
  });

  it("OIDC_CLIENT_SECRET is stored verbatim in oidcClientSecret", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.OIDC_CLIENT_SECRET = "s3cr3t!@#$%^&*()-_=+verbatim";
    expect(loadConfig().oidcClientSecret).toBe("s3cr3t!@#$%^&*()-_=+verbatim");
  });

  it("network=canton:mainnet with all required vars → loads cleanly", () => {
    minimal();
    oidcEnv();
    process.env.CANTON_NETWORK = "canton:mainnet";
    process.env.JWT_ISSUER = "oidc";
    const c = loadConfig();
    expect(c.network).toBe("canton:mainnet");
    expect(c.jwtIssuer).toBe("oidc");
    expect(c.scanFlavor).toBe("sv"); // oidc defaults to sv
  });

  it("CANTON_SCAN_URL stored verbatim in scanUrl", () => {
    minimal();
    process.env.CANTON_SCAN_URL = "https://scan.example.canton.network:9001/path";
    expect(loadConfig().scanUrl).toBe("https://scan.example.canton.network:9001/path");
  });

  it("PORT=1 → port:1 (minimum meaningful port)", () => {
    minimal();
    process.env.PORT = "1";
    expect(loadConfig().port).toBe(1);
  });

  it("CANTON_SCAN_FLAVOR=sv + JWT_ISSUER=unsafe-hmac → scanFlavor='sv'", () => {
    minimal();
    process.env.CANTON_SCAN_FLAVOR = "sv";
    // Even under unsafe-hmac the explicit override must be honored
    const c = loadConfig();
    expect(c.scanFlavor).toBe("sv");
    expect(c.jwtIssuer).toBe("unsafe-hmac");
  });

  it("all required env vars plus all optional env vars → loads without error", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.PORT = "8080";
    process.env.LOG_LEVEL = "debug";
    process.env.OIDC_SCOPE = "openid";
    process.env.CANTON_SCAN_FLAVOR = "sv";
    // Should not throw
    expect(() => loadConfig()).not.toThrow();
    const c = loadConfig();
    expect(c.port).toBe(8080);
    expect(c.logLevel).toBe("debug");
    expect(c.oidcScope).toBe("openid");
    expect(c.scanFlavor).toBe("sv");
  });

  it("oidcClientId and oidcClientSecret are both undefined when JWT_ISSUER=unsafe-hmac", () => {
    minimal();
    // OIDC env vars are cleaned in beforeEach — only minimal() is set
    const c = loadConfig();
    expect(c.jwtIssuer).toBe("unsafe-hmac");
    expect(c.oidcClientId).toBeUndefined();
    expect(c.oidcClientSecret).toBeUndefined();
  });

  it("LEDGER_API_AUDIENCE stored verbatim in ledgerApiAudience", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    process.env.LEDGER_API_AUDIENCE = "https://my-exact-audience.canton.network";
    expect(loadConfig().ledgerApiAudience).toBe("https://my-exact-audience.canton.network");
  });

  it("jwt_secret is undefined when JWT_ISSUER=oidc and JWT_SECRET not set", () => {
    minimal();
    oidcEnv();
    process.env.JWT_ISSUER = "oidc";
    // JWT_SECRET is already deleted in beforeEach (in OPTIONAL list)
    const c = loadConfig();
    expect(c.jwtIssuer).toBe("oidc");
    expect(c.jwtSecret).toBeUndefined();
  });

  it("faucet is OFF by default with safe default caps", () => {
    minimal();
    const c = loadConfig();
    expect(c.faucetEnabled).toBe(false);
    expect(c.faucetAmountCc).toBe("0.02");
    expect(c.faucetMaxPerIp).toBe(5);
    expect(c.faucetDailyBudgetCc).toBe("1");
    expect(c.faucetLifetimeCapCc).toBe("25");
    expect(c.faucetWindowMs).toBe(86_400_000);
  });

  it("faucetLifetimeCapCc honours the env override and 0 (disabled)", () => {
    minimal();
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    process.env.CANTON_X402_FAUCET_LIFETIME_CAP_CC = "50";
    expect(loadConfig().faucetLifetimeCapCc).toBe("50");
    process.env.CANTON_X402_FAUCET_LIFETIME_CAP_CC = "0"; // 0 = disabled
    expect(loadConfig().faucetLifetimeCapCc).toBe("0");
  });

  it("rejects an enabled faucet whose lifetime cap is below one payout (but > 0)", () => {
    // A positive lifetime cap that cannot cover even one payout would 503 every
    // claim — same footgun guard as the daily budget. 0 (disabled) is exempt.
    minimal();
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    process.env.CANTON_X402_FAUCET_AMOUNT_CC = "0.5";
    process.env.CANTON_X402_FAUCET_LIFETIME_CAP_CC = "0.1";
    expect(() => loadConfig()).toThrow(/CANTON_X402_FAUCET_LIFETIME_CAP_CC/);
  });

  it("allows an enabled faucet with lifetime cap 0 (disabled) regardless of amount", () => {
    minimal();
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    process.env.CANTON_X402_FAUCET_AMOUNT_CC = "0.5";
    process.env.CANTON_X402_FAUCET_LIFETIME_CAP_CC = "0";
    expect(() => loadConfig()).not.toThrow();
  });

  it("hard-fails when the faucet is enabled without DATABASE_URL (no in-memory money faucet)", () => {
    // The faucet dispenses REAL CC; on the non-durable in-memory store a restart
    // re-opens every party (per-party-once + lifetime cap both reset), so a
    // production faucet MUST have a durable DB. Fail fast at startup.
    minimal();
    delete process.env.DATABASE_URL;
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it("an enabled faucet WITH DATABASE_URL loads cleanly (durable store)", () => {
    minimal(); // minimal() sets DATABASE_URL
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    expect(() => loadConfig()).not.toThrow();
  });

  it("does NOT require DATABASE_URL when the faucet is OFF", () => {
    minimal();
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).not.toThrow();
  });

  it("faucet enabled with the defaults loads cleanly", () => {
    minimal();
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().faucetEnabled).toBe(true);
  });

  it("faucet env overrides are honoured (incl. 0 to disable the per-IP cap)", () => {
    minimal();
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    process.env.CANTON_X402_FAUCET_AMOUNT_CC = "0.05";
    process.env.CANTON_X402_FAUCET_MAX_PER_IP = "0";
    process.env.CANTON_X402_FAUCET_DAILY_BUDGET_CC = "2";
    process.env.CANTON_X402_FAUCET_WINDOW_MS = "3600000";
    const c = loadConfig();
    expect(c.faucetAmountCc).toBe("0.05");
    expect(c.faucetMaxPerIp).toBe(0);
    expect(c.faucetDailyBudgetCc).toBe("2");
    expect(c.faucetWindowMs).toBe(3_600_000);
  });

  it("faucetMaxPerIp falls back to 5 on a non-numeric / negative value", () => {
    minimal();
    process.env.CANTON_X402_FAUCET_MAX_PER_IP = "garbage";
    expect(loadConfig().faucetMaxPerIp).toBe(5);
    process.env.CANTON_X402_FAUCET_MAX_PER_IP = "-1";
    expect(loadConfig().faucetMaxPerIp).toBe(5);
  });

  it("rejects an enabled faucet with a non-positive amount", () => {
    minimal();
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    process.env.CANTON_X402_FAUCET_AMOUNT_CC = "0";
    expect(() => loadConfig()).toThrow(/CANTON_X402_FAUCET_AMOUNT_CC/);
  });

  it("rejects an enabled faucet whose daily budget is below one payout", () => {
    minimal();
    process.env.CANTON_X402_FAUCET_ENABLED = "true";
    process.env.CANTON_X402_FAUCET_AMOUNT_CC = "0.5";
    process.env.CANTON_X402_FAUCET_DAILY_BUDGET_CC = "0.1";
    expect(() => loadConfig()).toThrow(/CANTON_X402_FAUCET_DAILY_BUDGET_CC/);
  });

  it("does NOT validate faucet amount/budget when the faucet is OFF", () => {
    minimal();
    // Footgun values are tolerated while disabled (nothing reads them).
    process.env.CANTON_X402_FAUCET_AMOUNT_CC = "0";
    process.env.CANTON_X402_FAUCET_DAILY_BUDGET_CC = "0";
    expect(() => loadConfig()).not.toThrow();
  });
});

describe("parseTrustProxy (security: forgeable req.ip mitigation)", () => {
  it("unset / empty → loopback-only (the SAFE default, not whole-chain trust)", () => {
    expect(parseTrustProxy(undefined)).toEqual(["loopback"]);
    expect(parseTrustProxy("")).toEqual(["loopback"]);
    expect(parseTrustProxy("   ")).toEqual(["loopback"]);
  });

  it("'false' → false (no proxy trusted; req.ip = socket peer)", () => {
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  it("'true' → true (explicit, documented-unsafe opt-in)", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("True")).toBe(true);
  });

  it("a bare integer → hop count (number)", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("0")).toBe(0);
  });

  it("a single CIDR/IP/keyword → one-element trust list", () => {
    expect(parseTrustProxy("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
    expect(parseTrustProxy("loopback")).toEqual(["loopback"]);
    expect(parseTrustProxy("127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("a comma list → trimmed, empties dropped", () => {
    expect(parseTrustProxy("loopback, 10.1.2.3 , 192.168.0.0/16")).toEqual([
      "loopback",
      "10.1.2.3",
      "192.168.0.0/16",
    ]);
    expect(parseTrustProxy("10.0.0.1, ,10.0.0.2,")).toEqual([
      "10.0.0.1",
      "10.0.0.2",
    ]);
  });
});
