/**
 * The narrow boundary in front of Canton's admin API.
 *
 * Runs beside the participant, holds the node-local admin access, and exposes
 * exactly one read: "what are this party's protocol signing keys". The
 * facilitator calls it over HTTP with a bearer token and never learns the admin
 * port, which is what keeps a facilitator compromise from becoming a node
 * compromise.
 *
 * THE RESPONSE CONTRACT'S LOAD-BEARING DISTINCTION: 200 with `keys: []` means
 * topology answered and this party publishes no usable key. 503 means topology
 * could not be read. A verifier must fail closed on BOTH, but it must be able
 * to tell them apart — collapsing them is how "we could not check" turns into
 * "there was nothing to check".
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  createTopologyReader,
  TopologyReaderError,
  type TopologyReader,
} from "./topology-client.js";

export interface TopologyReaderServiceOptions {
  reader: Pick<TopologyReader, "getPartySigningKeys">;
  /** Shared secret the facilitator presents. REQUIRED: this endpoint reads
   *  topology for any party on the network, so it is not left open. */
  authToken: string;
}

/** Constant-time bearer check. A length-varying comparison would leak the
 *  token a byte at a time to anyone who can time the endpoint. */
function authorized(req: FastifyRequest, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

export async function buildServer(
  opts: TopologyReaderServiceOptions
): Promise<FastifyInstance> {
  if (!opts.authToken) {
    throw new Error(
      "topology-reader refuses to start without an auth token: it can read " +
        "topology for any party on the network"
    );
  }
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  app.get<{ Params: { party: string } }>(
    "/v1/party/:party/signing-keys",
    async (req, reply) => {
      if (!authorized(req, opts.authToken)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      // Fastify has ALREADY decoded this param, and decoding it a second time
      // was wrong twice over. Measured, by driving the real router:
      //
      //   /v1/party/%252525/…  ->  Fastify gives us `%2525`, the second decode
      //                            turned it into `%25`, and we looked up a
      //                            DIFFERENT party than the caller named — 200,
      //                            silently answering the wrong question.
      //   /v1/party/%25/…      ->  Fastify gives us `%`, the second decode
      //                            threw URIError from outside the try and
      //                            escaped to Fastify's default handler as a
      //                            500, where this route deliberately answers
      //                            400 `malformed_party`.
      //
      // Genuinely invalid escapes never get this far: the router rejects
      // `%zz` itself with FST_ERR_BAD_URL. So the second decode defended
      // against nothing and caused both defects. One decode, done by Fastify.
      const party = req.params.party;
      try {
        const keys = await opts.reader.getPartySigningKeys(party);
        return reply.code(200).send({ party, keys });
      } catch (err) {
        if (
          err instanceof TopologyReaderError &&
          /well-formed/.test(err.message)
        ) {
          return reply.code(400).send({ error: "malformed_party" });
        }
        // 503, never 200-with-empty: the caller must be able to tell "could not
        // read" from "read fine, no keys".
        return reply.code(503).send({ error: "topology_unavailable" });
      }
    }
  );

  return app;
}

export interface StartOptions {
  /** Participant admin API, node-local. */
  adminAddress: string;
  authToken: string;
  /** Defaults to loopback: this service has no business being routable. */
  host?: string;
  port?: number;
}

export async function start(opts: StartOptions): Promise<FastifyInstance> {
  const reader = createTopologyReader({ adminAddress: opts.adminAddress });
  const app = await buildServer({ reader, authToken: opts.authToken });
  await app.listen({ host: opts.host ?? "127.0.0.1", port: opts.port ?? 8099 });
  return app;
}
