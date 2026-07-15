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
    const res = await fetchFn(args.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `OIDC token endpoint ${args.tokenEndpoint} returned ${res.status}: ${txt.slice(0, 400)}`
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
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
    }

    try {
      return await inflight;
    } catch (err) {
      // Serve-stale-on-error: the refresh failed, but if we still hold a
      // token that hasn't ACTUALLY expired we were only refreshing early
      // (within the skew window) — a transient IdP blip must not reject
      // otherwise-valid payments. Return the still-valid cached token and
      // let the next call retry the refresh. Only propagate the error
      // once the cached token is truly expired (or never existed, e.g.
      // cold start), where there is no safe token to fall back on.
      if (cached && cached.expiresAt - now() > 0) {
        return cached.token;
      }
      throw err;
    }
  };
}
