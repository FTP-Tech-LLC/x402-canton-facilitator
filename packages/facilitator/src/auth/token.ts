/**
 * Token minting for the Canton JSON Ledger API v2.
 *
 * Two issuers supported by the facilitator config:
 *   - `unsafe-hmac` — LocalNet / cn-quickstart. The participant
 *     accepts HS256-signed JWTs with the well-known secret
 *     `"unsafe"`. Tokens never expire
 *     (`max-token-lifetime=Inf` in cn-quickstart canton config).
 *   - `oidc` — DevNet/MainNet via Auth0/Keycloak client-credentials
 *     grant. `createOidcTokenProvider` returns a `TokenProvider`
 *     that fetches an access_token from the configured token
 *     endpoint and caches it until `refreshSkewMs` before expiry.
 *     The provider is passed to `CantonClient` (and optionally
 *     `ScanClient`) which call it before every request — only a
 *     fresh token ever hits the wire.
 *
 * The bug this module exists to fix: before, `services.ts` was
 * using the JWT SECRET directly as the bearer token. That fails
 * any participant that actually validates the signature — the
 * secret string is not a valid JWS.
 */

import { createHmac } from "node:crypto";
import type { TokenProvider } from "@ftptech/x402-canton-ledger";

const DEFAULT_AUDIENCE = "https://canton.network.global";

/** Refresh ~60s before the cached token expires so an in-flight
 *  request can never race expiry. Tunable via createOidcTokenProvider
 *  for testing — production stays at this default. */
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface UnsafeHmacJwtArgs {
  /** HMAC-SHA256 secret. cn-quickstart default: `"unsafe"`. */
  secret: string;
  /** `sub` claim — Canton ledger user id. */
  sub: string;
  /** `aud` claim. Defaults to the standard Canton API audience. */
  audience?: string;
}

/**
 * Mint an HS256 JWT for LocalNet participants. Never expires
 * (no `exp` claim is set — cn-quickstart's
 * `max-token-lifetime=Inf` accepts this).
 */
export function mintUnsafeHmacJwt(args: UnsafeHmacJwtArgs): string {
  const audience = args.audience ?? DEFAULT_AUDIENCE;
  const b64 = (s: string): string =>
    Buffer.from(s, "utf8").toString("base64url");

  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(JSON.stringify({ sub: args.sub, aud: audience }));
  const signature = createHmac("sha256", args.secret)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}

export interface OidcTokenProviderArgs {
  /** Full URL of the IdP's token endpoint. Auth0 form:
   *  `https://<tenant>.us.auth0.com/oauth/token`. */
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** `aud` claim the participant validates against. For Canton
   *  ledger API: `https://canton.network.global`. */
  audience: string;
  /** Optional `scope` claim. Canton participants ignore scopes for
   *  ledger API access, but Auth0 requires one if the API resource
   *  is configured with mandatory scopes — `daml_ledger_api` is the
   *  convention used by Splice operators. */
  scope?: string;
  /** Refresh this many ms before expiry. Defaults to 60s. */
  refreshSkewMs?: number;
  /** Give up on one token request after this many ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Override the clock (tests). */
  now?: () => number;
}

/**
 * Build a `TokenProvider` that mints OIDC tokens via the
 * `client_credentials` grant and caches them across calls.
 *
 * Concurrency: simultaneous calls during a refresh window share the
 * same in-flight `Promise<string>` so we only hit the IdP once per
 * renewal. If the in-flight fetch fails, the cached promise is
 * cleared so the next call retries — we never persist a rejected
 * Promise.
 *
 * Auth0 quirk: client_credentials responses come back as
 *   `{ access_token, scope, expires_in, token_type }`
 * with `expires_in` in seconds. Keycloak/Okta match.
 */
export function createOidcTokenProvider(
  args: OidcTokenProviderArgs
): TokenProvider {
  const fetchFn = args.fetch ?? globalThis.fetch;
  const now = args.now ?? Date.now;
  const skew = args.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const timeoutMs = args.timeoutMs ?? 10_000;
  // While a refresh runs, the cached token is answered only with at least
  // this much life left (15 s by default), so a request does not carry a token
  // that expires on its way to the participant. The one exception is a refresh
  // that failed: then a still-valid cached token beats no token at all.
  const minLeft = Math.floor(skew / 4);

  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const fetchToken = async (): Promise<string> => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: args.clientId,
      client_secret: args.clientSecret,
      audience: args.audience,
      ...(args.scope ? { scope: args.scope } : {}),
    });
    // BOUNDED. An IdP that accepts the connection and never answers held this
    // request until undici's default, about 300 s, and every ledger call waited
    // on it.
    let json: { access_token?: string; expires_in?: number };
    try {
      const res = await fetchFn(args.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(
          `OIDC token endpoint ${args.tokenEndpoint} returned ${res.status}: ${txt.slice(0, 400)}`
        );
      }
      json = (await res.json()) as typeof json;
    } catch (err) {
      // Named, so the ledger call that fails on it does not read as the
      // participant timing out.
      if ((err as { name?: string })?.name === "TimeoutError") {
        throw new Error(`OIDC token endpoint ${args.tokenEndpoint} did not answer within ${timeoutMs} ms`, {
          cause: err,
        });
      }
      throw err;
    }
    if (!json.access_token) {
      throw new Error(
        `OIDC token response missing access_token: ${JSON.stringify(json).slice(0, 200)}`
      );
    }
    // expires_in is seconds; default to 1h if absent (Auth0 always sends it).
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    cached = { token: json.access_token, expiresAt: now() + ttlMs };
    return json.access_token;
  };

  return async (): Promise<string> => {
    // Fast path: cached token is comfortably fresh (outside the skew
    // window). No await, no race.
    if (cached && cached.expiresAt - now() > skew) return cached.token;

    // Refresh needed (cold start, or within the skew window). Dedupe
    // concurrent refreshes onto one in-flight fetch.
    if (!inflight) {
      inflight = fetchToken().finally(() => {
        inflight = null;
      });
      // A refresh that fails is seen by whoever awaits it, or by the next
      // call, never as an unhandled rejection.
      inflight.catch(() => {});
    }

    // STILL VALID, SO ANSWER NOW. Within the skew window the refresh only
    // starts early; waiting on it made every ledger call (verify reads, the
    // settle execute, completions, markers) as slow as the IdP while the
    // cached token was still good, and a hung IdP held them all. The refresh
    // finishes in the background, and a failed one is retried by the next
    // call in the window. Near expiry, or with no token on a cold start, the
    // call waits for the IdP, at most timeoutMs; if that refresh fails while
    // the cached token still has life, the cached token is answered.
    if (cached && cached.expiresAt - now() > minLeft) return cached.token;
    const refresh = inflight;
    try {
      return await refresh;
    } catch (err) {
      if (cached && cached.expiresAt - now() > 0) return cached.token;
      throw err;
    }
  };
}
