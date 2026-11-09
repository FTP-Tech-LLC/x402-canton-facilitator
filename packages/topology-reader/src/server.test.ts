import { describe, it, expect } from "vitest";
import { buildServer } from "./server.js";
import { TopologyReaderError, type PartySigningKey } from "./topology-client.js";

const PARTY =
  "agent::1220e8e7295ce8601422a15c4e0e31ac90099fb309dac7cf80ea30b6f65add4c38a6";
const TOKEN = "s3cret-token-value";
const KEY: PartySigningKey = {
  derBase64: "MCowBQYDK2VwAyEA9gkgiwSF1eEITnqJsciQfXRplLi0z9Yw9KUrTnVTuE8=",
  usage: ["SIGNING_KEY_USAGE_PROTOCOL"],
  keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
};

async function app(
  getPartySigningKeys: (p: string) => Promise<PartySigningKey[]>,
  authToken = TOKEN
) {
  return buildServer({ reader: { getPartySigningKeys }, authToken });
}

function get(a: Awaited<ReturnType<typeof app>>, party: string, token?: string) {
  return a.inject({
    method: "GET",
    url: `/v1/party/${encodeURIComponent(party)}/signing-keys`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

describe("topology-reader service — who may ask", () => {
  it("refuses to start without a token", async () => {
    // This endpoint reads topology for ANY party on the network. Starting it
    // open would be a worse hole than the one it exists to close.
    await expect(app(async () => [], "")).rejects.toThrow(/auth token/);
  });

  it("401s without a bearer, and with the wrong one", async () => {
    const a = await app(async () => [KEY]);
    expect((await get(a, PARTY)).statusCode).toBe(401);
    expect((await get(a, PARTY, "wrong")).statusCode).toBe(401);
    // Same length as the real token, so this cannot pass on a length check
    // alone — it exercises the constant-time comparison itself.
    expect((await get(a, PARTY, "X".repeat(TOKEN.length))).statusCode).toBe(401);
    await a.close();
  });

  it("does not reach the reader at all when unauthorized", async () => {
    let called = false;
    const a = await app(async () => {
      called = true;
      return [];
    });
    await get(a, PARTY);
    expect(called).toBe(false);
    await a.close();
  });
});

describe("topology-reader service — the answer contract", () => {
  it("returns the keys for a known party", async () => {
    const a = await app(async (p) => (p === PARTY ? [KEY] : []));
    const res = await get(a, PARTY, TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ party: PARTY, keys: [KEY] });
    await a.close();
  });

  it("distinguishes 'no keys' from 'could not read' — 200 vs 503", async () => {
    // THE LOAD-BEARING DISTINCTION. A verifier fails closed on both, but it
    // must be able to tell them apart: collapsing them turns "we could not
    // check" into "there was nothing to check", which is how an unverified
    // payment gets treated as a verified one.
    const empty = await app(async () => []);
    const emptyRes = await get(empty, PARTY, TOKEN);
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json()).toEqual({ party: PARTY, keys: [] });
    await empty.close();

    const broken = await app(async () => {
      throw new TopologyReaderError("topology read failed");
    });
    const brokenRes = await get(broken, PARTY, TOKEN);
    expect(brokenRes.statusCode).toBe(503);
    expect(brokenRes.json()).toEqual({ error: "topology_unavailable" });
    await broken.close();
  });

  it("reports a malformed party as 400, not as an outage", async () => {
    // An operator debugging a 503 should not be sent to look at the node when
    // the caller simply sent a bad id.
    const a = await app(async () => {
      throw new TopologyReaderError(
        "party id is not a well-formed <hint>::<fingerprint>; refusing to issue a prefix query"
      );
    });
    const res = await get(a, "not-a-party", TOKEN);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "malformed_party" });
    await a.close();
  });

  it("never leaks the underlying error to the caller", async () => {
    // The message could carry the admin address or a topology internal.
    const a = await app(async () => {
      throw new Error("connect ECONNREFUSED 10.8.0.1:5002");
    });
    const body = JSON.stringify((await get(a, PARTY, TOKEN)).json());
    expect(body).not.toMatch(/ECONNREFUSED|5002|10\.8/);
    await a.close();
  });

  it("serves an unauthenticated health check and nothing else", async () => {
    const a = await app(async () => [KEY]);
    expect((await a.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    // No accidental second surface.
    expect(
      (await a.inject({ method: "GET", url: "/v1/party" })).statusCode
    ).toBe(404);
    await a.close();
  });
});

describe("URL decoding — exactly once, by the router", () => {
  const app = () =>
    buildServer({
      reader: { getPartySigningKeys: async (p: string) => {
        // The real reader refuses anything that is not <hint>::<fingerprint>.
        if (!/^[^:]+::[0-9a-f]{68}$/.test(p)) {
          throw new TopologyReaderError("party is not well-formed");
        }
        return [];
      } },
      authToken: "secret",
    });

  it("does not decode a second time and answer for a DIFFERENT party", async () => {
    // Measured against the real router: Fastify hands the handler `%2525`
    // here. A second decodeURIComponent turned that into `%25`, so the service
    // looked up a party the caller never asked about and answered 200 for it.
    // Answering the wrong question with a 200 is worse than any error.
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: "/v1/party/%252525/signing-keys",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "malformed_party" });
    await a.close();
  });

  it("answers 400, not an unhandled 500, for a party that decodes to a bare %", async () => {
    // Fastify hands us `%`. The second decode threw URIError from outside the
    // try and escaped to Fastify's default handler as a 500.
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: "/v1/party/%25/signing-keys",
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it("still lets an ordinary party through untouched", async () => {
    const a = await app();
    const party = "agent::1220" + "ab".repeat(32);
    const res = await a.inject({
      method: "GET",
      url: `/v1/party/${encodeURIComponent(party)}/signing-keys`,
      headers: { authorization: "Bearer secret" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().party).toBe(party);
    await a.close();
  });
});
