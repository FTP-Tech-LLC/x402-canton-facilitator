import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mintUnsafeHmacJwt, createOidcTokenProvider } from "./token.js";

describe("mintUnsafeHmacJwt", () => {
  it("produces a valid HS256 JWT with sub + aud claims", () => {
    const jwt = mintUnsafeHmacJwt({
      secret: "unsafe",
      sub: "ledger-api-user",
    });

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf8")
    );
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });

    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    );
    expect(payload).toEqual({
      sub: "ledger-api-user",
      aud: "https://canton.network.global",
    });

    // Signature must verify against the secret.
    const expectedSig = createHmac("sha256", "unsafe")
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    expect(sigB64).toBe(expectedSig);
  });

  it("respects a caller-supplied audience override", () => {
    const jwt = mintUnsafeHmacJwt({
      secret: "unsafe",
      sub: "ledger-api-user",
      audience: "https://canton.network.testnet",
    });
    const parts = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8")
    );
    expect(payload.aud).toBe("https://canton.network.testnet");
  });

  it("different secrets produce different signatures (no signature collision)", () => {
    const a = mintUnsafeHmacJwt({ secret: "unsafe", sub: "u" });
    const b = mintUnsafeHmacJwt({ secret: "different", sub: "u" });
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
  });
});

/**
 * createOidcTokenProvider tests.
 *
 * The provider is what stands between a multi-hour DevNet deploy and
 * its first 401 — getting caching, refresh, and concurrency right
 * here is the difference between zero outages and one outage per
 * Auth0 access_token TTL. Each test pins one behavior.
 */
describe("createOidcTokenProvider", () => {
  /** Build a mock fetch that returns an Auth0-shape response and
   *  records every call so tests can assert call counts + payloads. */
  function mockFetch(
    response: { access_token: string; expires_in: number },
    opts: { status?: number; body?: string } = {}
  ): typeof globalThis.fetch & { calls: Array<{ url: string; body: string }> } {
    const calls: Array<{ url: string; body: string }> = [];
    const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
      });
      if (opts.status && opts.status >= 400) {
        return new Response(opts.body ?? "", { status: opts.status });
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    return Object.assign(fn as unknown as typeof globalThis.fetch, { calls });
  }

  const baseArgs = {
    tokenEndpoint: "https://idp.example/oauth/token",
    clientId: "client-id",
    clientSecret: "client-secret",
    audience: "https://canton.network.global",
  };

  it("first call hits the IdP and returns the access_token", async () => {
    const fetch = mockFetch({ access_token: "tok-1", expires_in: 3600 });
    const provider = createOidcTokenProvider({ ...baseArgs, fetch });
    expect(await provider()).toBe("tok-1");
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe(baseArgs.tokenEndpoint);
    // Auth0 expects form-urlencoded grant_type=client_credentials.
    expect(fetch.calls[0]?.body).toContain("grant_type=client_credentials");
    expect(fetch.calls[0]?.body).toContain("client_id=client-id");
    expect(fetch.calls[0]?.body).toContain(
      "audience=https%3A%2F%2Fcanton.network.global"
    );
  });

  it("caches the token across calls until the refresh window opens", async () => {
    let now = 1_000_000_000_000;
    const fetch = mockFetch({ access_token: "tok-1", expires_in: 3600 });
    const provider = createOidcTokenProvider({
      ...baseArgs,
      fetch,
      now: () => now,
      refreshSkewMs: 60_000,
    });
    expect(await provider()).toBe("tok-1");
    // 30 minutes later — still cached, no second IdP call.
    now += 30 * 60_000;
    expect(await provider()).toBe("tok-1");
    expect(fetch.calls).toHaveLength(1);
  });

  it("refreshes when the cached token is within refreshSkewMs of expiry", async () => {
    let now = 1_000_000_000_000;
    let issued = 0;
    const fetch = vi.fn(async () => {
      issued += 1;
      return new Response(
        JSON.stringify({ access_token: `tok-${issued}`, expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      ...baseArgs,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
      refreshSkewMs: 60_000,
    });
    expect(await provider()).toBe("tok-1");
    // Advance to expiresAt - skew exactly → still in the cache window.
    now += 3600_000 - 60_000 - 1;
    expect(await provider()).toBe("tok-1");
    // Cross the skew boundary → refresh fires, tok-2 returned.
    now += 2;
    expect(await provider()).toBe("tok-2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("singleflight: concurrent calls during the refresh share one IdP request", async () => {
    let resolveFetch: (v: Response) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        })
    );
    const provider = createOidcTokenProvider({
      ...baseArgs,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    // Fire ten concurrent callers before the IdP responds.
    const inflight = Array.from({ length: 10 }, () => provider());
    // Now the IdP responds — exactly one fetch call should have been made.
    resolveFetch(
      new Response(JSON.stringify({ access_token: "tok-x", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const results = await Promise.all(inflight);
    expect(results.every((r) => r === "tok-x")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("includes scope in the body when provided", async () => {
    const fetch = mockFetch({ access_token: "tok", expires_in: 3600 });
    const provider = createOidcTokenProvider({
      ...baseArgs,
      scope: "daml_ledger_api",
      fetch,
    });
    await provider();
    expect(fetch.calls[0]?.body).toContain("scope=daml_ledger_api");
  });

  it("omits scope when not provided", async () => {
    const fetch = mockFetch({ access_token: "tok", expires_in: 3600 });
    const provider = createOidcTokenProvider({ ...baseArgs, fetch });
    await provider();
    expect(fetch.calls[0]?.body).not.toContain("scope=");
  });

  it("throws on non-2xx response from the IdP, surfacing status + body", async () => {
    const fetch = mockFetch(
      { access_token: "", expires_in: 0 },
      { status: 401, body: '{"error":"access_denied"}' }
    );
    const provider = createOidcTokenProvider({ ...baseArgs, fetch });
    await expect(provider()).rejects.toThrow(/401/);
    await expect(provider()).rejects.toThrow(/access_denied/);
  });

  it("throws when the response is 200 but missing access_token", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    const provider = createOidcTokenProvider({
      ...baseArgs,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(provider()).rejects.toThrow(/missing access_token/);
  });

  it("clears the in-flight promise on failure so the next call retries", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("boom", { status: 503 });
      }
      return new Response(
        JSON.stringify({ access_token: "tok-ok", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      ...baseArgs,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(provider()).rejects.toThrow(/503/);
    // Without the inflight clear, the rejected promise would be cached
    // and every subsequent call would re-reject — outage permanent.
    expect(await provider()).toBe("tok-ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("defaults expires_in to 1h when the IdP omits it", async () => {
    let now = 1_000_000_000_000;
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "tok-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    const provider = createOidcTokenProvider({
      ...baseArgs,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
      refreshSkewMs: 60_000,
    });
    expect(await provider()).toBe("tok-1");
    // 58 minutes later — comfortably inside the 1h - 60s skew window.
    now += 58 * 60_000;
    expect(await provider()).toBe("tok-1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ─── Additional mintUnsafeHmacJwt complex tests ──────────────────

describe("mintUnsafeHmacJwt — additional claims", () => {
  it("audience defaults to 'https://canton.network.global' when no aud is set", () => {
    const jwt = mintUnsafeHmacJwt({ secret: "test-secret", sub: "test-user" });
    const parts = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8")
    );
    expect(payload.aud).toBe("https://canton.network.global");
  });

  it("JWT header alg field is exactly 'HS256'", () => {
    const jwt = mintUnsafeHmacJwt({ secret: "s", sub: "u" });
    const parts = jwt.split(".");
    const header = JSON.parse(
      Buffer.from(parts[0] as string, "base64url").toString("utf8")
    );
    expect(header.alg).toBe("HS256");
  });

  it("no exp claim is present (cn-quickstart accepts no-expiry JWTs)", () => {
    const jwt = mintUnsafeHmacJwt({ secret: "s", sub: "u" });
    const parts = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8")
    );
    // mintUnsafeHmacJwt deliberately omits exp (max-token-lifetime=Inf in cn-quickstart)
    expect(payload.exp).toBeUndefined();
  });

  it("sub claim matches the provided sub parameter", () => {
    const sub = "my-ledger-user-42";
    const jwt = mintUnsafeHmacJwt({ secret: "s", sub });
    const parts = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8")
    );
    expect(payload.sub).toBe(sub);
  });
});

// ─── Additional mintUnsafeHmacJwt targeted tests ─────────────────

describe("mintUnsafeHmacJwt — structural and claim tests", () => {
  it("the JWT has exactly 3 parts separated by dots", () => {
    const jwt = mintUnsafeHmacJwt({ secret: "test-secret", sub: "ledger-user" });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    // No extra dots anywhere in the token
    expect(parts[0]).not.toContain(".");
    expect(parts[1]).not.toContain(".");
    expect(parts[2]).not.toContain(".");
  });

  it("iat claim behaviour: mintUnsafeHmacJwt omits iat (no-expiry LocalNet tokens don't need it)", () => {
    // cn-quickstart uses max-token-lifetime=Inf, so no iat/exp is required.
    // Document current behaviour: iat is NOT set by mintUnsafeHmacJwt.
    const jwt = mintUnsafeHmacJwt({ secret: "unsafe", sub: "ledger-user" });
    const parts = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8")
    );
    // iat is intentionally omitted — the token is valid indefinitely on LocalNet
    expect(payload.iat).toBeUndefined();
  });

  it("with custom audience parameter → aud claim matches custom value", () => {
    const customAud = "https://my-participant.example.com/api/v1";
    const jwt = mintUnsafeHmacJwt({
      secret: "unsafe",
      sub: "user",
      audience: customAud,
    });
    const parts = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8")
    );
    expect(payload.aud).toBe(customAud);
  });
});

// ─── Additional createOidcTokenProvider targeted tests ────────────

describe("createOidcTokenProvider — token_type and refreshSkewMs=0 scenarios", () => {
  const TOKEN_ENDPOINT = "https://idp.targeted.test/oauth/token";

  it("when IdP returns token_type='Bearer' (not 'bearer') → access_token is still used correctly", async () => {
    // The provider does not inspect token_type at all — it only cares
    // about access_token. A 'Bearer' token_type from a well-behaved IdP
    // must not interfere with the happy path.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "tok-bearer", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c", clientSecret: "s", audience: "a",
      fetch: fetchMock,
    });
    const token = await provider();
    expect(token).toBe("tok-bearer");
  });

  it("when refreshSkewMs=0, cached token is reused until natural expiry (no premature refresh)", async () => {
    // With skew=0, the cache condition is: expiresAt - now() > 0.
    // As long as the token is not yet expired, caching applies.
    let now = 1_000_000_000_000;
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      return new Response(
        JSON.stringify({ access_token: `tok-${callCount}`, token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c", clientSecret: "s", audience: "a",
      fetch: fetchMock,
      now: () => now,
      refreshSkewMs: 0,
    });
    const t1 = await provider();
    // Move 1 hour minus 1ms — still within the 3600s TTL with 0 skew
    now += 3600_000 - 1;
    const t2 = await provider();
    // Same token — cache is still valid
    expect(t1).toBe(t2);
    expect(callCount).toBe(1);
  });
});

// ─── Additional createOidcTokenProvider complex tests ────────────

describe("createOidcTokenProvider — edge cases", () => {
  const TOKEN_ENDPOINT = "https://idp.edge.test/oauth/token";

  it("when expires_in is 0, token is treated as immediately expired and IdP is called on every invocation", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      return new Response(
        JSON.stringify({ access_token: `tok-${callCount}`, token_type: "Bearer", expires_in: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "a",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      refreshSkewMs: 0,
    });
    const t1 = await provider();
    const t2 = await provider();
    // With expires_in=0 and refreshSkewMs=0, the cache expires immediately
    // so each call should hit the IdP
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(t1).not.toBe(t2);
  });

  it("concurrent calls after an error each trigger a fresh IdP call (no cached rejection)", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response("server error", { status: 503 });
      }
      return new Response(
        JSON.stringify({ access_token: "recovered-token", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "a",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    // First call fails
    await expect(provider()).rejects.toThrow();
    // Second call should retry (not return a cached rejection)
    await expect(provider()).rejects.toThrow();
    // Third call succeeds
    const token = await provider();
    expect(token).toBe("recovered-token");
  });

  it("token endpoint URL is used verbatim — no path modification", async () => {
    const customEndpoint = "https://auth.example.com/realms/canton/protocol/openid-connect/token";
    const capturedUrls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      capturedUrls.push(url);
      return new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: customEndpoint,
      clientId: "c",
      clientSecret: "s",
      audience: "a",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await provider();
    expect(capturedUrls[0]).toBe(customEndpoint);
  });

  it("audience is sent correctly in the request body when set to a non-default value", async () => {
    const customAud = "https://my-canton-participant.example.com/api";
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: customAud,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await provider();
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get("audience")).toBe(customAud);
  });
});

// ─── Additional complex token tests ──────────────────────────────

describe("mintUnsafeHmacJwt — bit-level and structural tests", () => {
  it("changing any single bit of the secret produces a different signature", () => {
    // Flip one byte in the secret and confirm the signature differs.
    // This exercises that HMAC is actually keyed on the secret, not just
    // producing a deterministic hash of the payload.
    const base = mintUnsafeHmacJwt({ secret: "secret-A", sub: "user" });
    const diff = mintUnsafeHmacJwt({ secret: "secret-B", sub: "user" }); // 1 char different
    expect(base.split(".")[2]).not.toBe(diff.split(".")[2]);
    // Same payload must produce the same signature when the secret is restored
    const same = mintUnsafeHmacJwt({ secret: "secret-A", sub: "user" });
    expect(base.split(".")[2]).toBe(same.split(".")[2]);
  });

  it("the payload (middle part) is base64url-decodable JSON", () => {
    // Verify that the middle segment is valid base64url and decodes to
    // a well-formed JSON object — guards against accidental double-encoding.
    const jwt = mintUnsafeHmacJwt({ secret: "s", sub: "payload-check-user" });
    const parts = jwt.split(".");
    const rawPayload = parts[1] as string;
    // Must not throw
    const decoded = Buffer.from(rawPayload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    // sub must be present and equal to what we passed
    expect(parsed.sub).toBe("payload-check-user");
  });
});

describe("createOidcTokenProvider — rate limit and timing tests", () => {
  const TOKEN_ENDPOINT = "https://idp.ratelimit.test/oauth/token";

  it("when IdP returns HTTP 429 (rate limit) → throws with status in message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"too_many_requests"}', {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "a",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await expect(provider()).rejects.toThrow(/429/);
  });

  it("when expires_in is very large (86400*365) → cached for ~1 year minus skew", async () => {
    const ONE_YEAR_SECONDS = 86400 * 365;
    let now = 1_000_000_000_000;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "long-lived-tok", expires_in: ONE_YEAR_SECONDS }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "a",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      now: () => now,
      refreshSkewMs: 60_000,
    });
    expect(await provider()).toBe("long-lived-tok");
    // Advance 6 months — still well within the 1-year TTL
    now += 180 * 24 * 60 * 60 * 1000;
    expect(await provider()).toBe("long-lived-tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("when provided now function is used for time → caching uses it, not Date.now()", async () => {
    // Pin time completely. If the provider uses Date.now() instead of
    // the injected now(), this test would be non-deterministic.
    let now = 1_000_000;
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      return new Response(
        JSON.stringify({ access_token: `tok-${callCount}`, expires_in: 60 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "a",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      now: () => now,
      refreshSkewMs: 0,
    });
    // First call at t=1_000_000
    expect(await provider()).toBe("tok-1");
    // Advance by 30s (half the TTL) — still cached
    now += 30_000;
    expect(await provider()).toBe("tok-1");
    expect(callCount).toBe(1);
    // Advance past the 60s TTL
    now += 31_000; // total +61s
    expect(await provider()).toBe("tok-2");
    expect(callCount).toBe(2);
  });
});

describe("createOidcTokenProvider — complex scenarios", () => {
  const TOKEN_ENDPOINT = "http://idp.test/oauth/token";

  function makeProvider(
    opts: {
      clientId?: string;
      clientSecret?: string;
      audience?: string;
      scope?: string;
      responseFactory?: () => object;
      expiresIn?: number;
    } = {}
  ) {
    
    const expiresIn = opts.expiresIn ?? 3600;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "tok-" + Math.random().toString(36).slice(2, 8),
          token_type: "Bearer",
          expires_in: expiresIn,
          ...(opts.responseFactory?.() ?? {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: opts.clientId ?? "client-1",
      clientSecret: opts.clientSecret ?? "secret-1",
      audience: opts.audience ?? "https://api.test",
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      fetch: fetchMock,
    });
    return { provider, fetchMock };
  }

  it("successive cache hits make zero IdP calls beyond the first", async () => {
    const { provider, fetchMock } = makeProvider({ expiresIn: 3600 });
    const t1 = await provider();
    const t2 = await provider();
    const t3 = await provider();
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes after token expires (expires_in = 1s, skew = default)", async () => {
    
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      return new Response(
        JSON.stringify({ access_token: `tok-${callCount}`, token_type: "Bearer", expires_in: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c", clientSecret: "s", audience: "a",
      fetch: fetchMock,
    });
    const first = await provider();
    // Force expiry by waiting >1s + refresh skew
    await new Promise((r) => setTimeout(r, 1200));
    const second = await provider();
    expect(second).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("scope is included in token request body when provided", async () => {
    const { provider, fetchMock } = makeProvider({ scope: "openid profile" });
    await provider();
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get("scope")).toBe("openid profile");
  });

  it("scope is absent when not configured", async () => {
    const { provider, fetchMock } = makeProvider();
    await provider();
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get("scope")).toBeNull();
  });

  it("grant_type is always client_credentials", async () => {
    const { provider, fetchMock } = makeProvider();
    await provider();
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("audience is sent in request body", async () => {
    const { provider, fetchMock } = makeProvider({ audience: "https://canton.network.global" });
    await provider();
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get("audience")).toBe("https://canton.network.global");
  });

  it("Content-Type header is application/x-www-form-urlencoded", async () => {
    const { provider, fetchMock } = makeProvider();
    await provider();
    const init = fetchMock.mock.calls[0][1];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
  });

  it("10 concurrent first-call requests share a single IdP request (singleflight)", async () => {
    
    let calls = 0;
    let resolver: (v: unknown) => void;
    const pending = new Promise((r) => (resolver = r));
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls++;
      await pending;
      return new Response(
        JSON.stringify({ access_token: "shared-token", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", audience: "a",
      fetch: fetchMock,
    });
    const promises = Array.from({ length: 10 }, () => provider());
    resolver!("go");
    const tokens = await Promise.all(promises);
    expect(calls).toBe(1); // Only ONE IdP request despite 10 concurrent callers
    expect(new Set(tokens).size).toBe(1); // All got the same token
  });

  it("error on one call does NOT poison the cache — next call retries IdP", async () => {
    
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(
        JSON.stringify({ access_token: "good-token", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT, clientId: "c", clientSecret: "s", audience: "a",
      fetch: fetchMock,
    });
    await expect(provider()).rejects.toThrow();
    // Second call must retry (not serve null/undefined from failed cache)
    const token = await provider();
    expect(token).toBe("good-token");
    expect(callCount).toBe(2);
  });
});

describe("createOidcTokenProvider — serve-stale-on-error (refresh resilience)", () => {
  const TOKEN_ENDPOINT = "https://idp.serve-stale.test/oauth/token";
  const ok = (token: string, expiresIn: number): Response =>
    new Response(
      JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: expiresIn }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  it("refresh fails within skew but token still valid → returns cached token", async () => {
    // Token issued with 100s TTL, 50s skew. Advance into the skew window
    // (token NOT yet expired) and make the refresh fail. The provider must
    // fall back to the still-valid cached token rather than rejecting — a
    // transient IdP blip must not reject otherwise-valid payments.
    let t = 1_000_000;
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) return ok("tok-good", 100);
      return new Response("temporarily unavailable", { status: 503 });
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "aud",
      refreshSkewMs: 50_000,
      now: () => t,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(await provider()).toBe("tok-good"); // expires at t+100s
    t += 60_000; // within 50s skew; token still valid (40s left)
    expect(await provider()).toBe("tok-good"); // refresh → 503 → serve stale
    expect(fetchImpl).toHaveBeenCalledTimes(2); // it DID attempt the refresh
  });

  it("refresh fails AND cached token truly expired → propagates (fail closed)", async () => {
    let t = 1_000_000;
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) return ok("tok-old", 100);
      return new Response("down", { status: 500 });
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "aud",
      refreshSkewMs: 10_000,
      now: () => t,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    await provider(); // tok-old, expires at t+100s
    t += 200_000; // well past expiry — no safe token to serve
    await expect(provider()).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serve-stale then recovers: later successful refresh swaps in the fresh token", async () => {
    let t = 1_000_000;
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) return ok("tok-1", 100);
      if (n === 2) return new Response("blip", { status: 503 });
      return ok("tok-3", 100);
    });
    const provider = createOidcTokenProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "c",
      clientSecret: "s",
      audience: "aud",
      refreshSkewMs: 50_000,
      now: () => t,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(await provider()).toBe("tok-1");
    t += 60_000; // within skew, still valid
    expect(await provider()).toBe("tok-1"); // refresh #2 fails → serve stale
    expect(await provider()).toBe("tok-3"); // refresh #3 succeeds → fresh token
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
