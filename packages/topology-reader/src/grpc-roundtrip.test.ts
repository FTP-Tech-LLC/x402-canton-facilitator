/**
 * The gRPC round trip, against a real server built from the SAME vendored
 * protos.
 *
 * The unit tests exercise `extractKeys` and `selectCurrentStore` on plain
 * objects, which proves the logic but proves nothing about the wire: whether
 * the protos load, whether the request field names survive proto-loader's
 * camelCasing, whether `headState` is encoded as the oneof the server expects,
 * and whether the response decodes into the shape the extractor assumes.
 *
 * Every one of those is a way to be green here and 500 against a real node —
 * which is exactly the failure mode that has already cost this project once.
 * So this test starts an actual grpc-js server, serves the real message types,
 * and drives the real client through it.
 */
import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createTopologyReader } from "./topology-client.js";

const PROTO_ROOT = fileURLToPath(new URL("../proto", import.meta.url));
const READ_SERVICE =
  "com/digitalasset/canton/topology/admin/v30/topology_manager_read_service.proto";

const NS = "1220e8e7295ce8601422a15c4e0e31ac90099fb309dac7cf80ea30b6f65add4c38a6";
const PARTY = `agent::${NS}`;
const DOMAIN =
  "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const CURRENT = `${DOMAIN}::35-5`;
const RETIRED = `${DOMAIN}::34-0`;
const DER = Buffer.from(
  "MCowBQYDK2VwAyEA9gkgiwSF1eEITnqJsciQfXRplLi0z9Yw9KUrTnVTuE8=",
  "base64"
);

/** What the server SAW, so the request encoding can be asserted rather than
 *  assumed. */
interface Seen {
  storePhysicalId?: string;
  filterParty?: string;
  headStateSet?: boolean;
}

async function startFakeParticipant(seen: Seen, extraParties: string[] = []) {
  const def = protoLoader.loadSync(READ_SERVICE, {
    includeDirs: [PROTO_ROOT],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
    bytes: Buffer,
  });
  const loaded = grpc.loadPackageDefinition(def) as never;
  const svc = (
    loaded as unknown as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>
  )["com"]!["digitalasset"]!["canton"]!["topology"]!["admin"] as unknown as Record<
    string,
    Record<string, { service: grpc.ServiceDefinition }>
  >;
  const TopologyManagerReadService =
    svc["v30"]!["TopologyManagerReadService"]!.service;

  const party = (id: string) => ({
    context: { serial: 1 },
    item: {
      party: id,
      threshold: 1,
      participants: [
        {
          participantUid: "FTP-validator-1::1220c065",
          permission: "PARTICIPANT_PERMISSION_CONFIRMATION",
        },
      ],
      partySigningKeys: {
        keys: [
          {
            format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
            publicKey: DER,
            usage: [
              "SIGNING_KEY_USAGE_NAMESPACE",
              "SIGNING_KEY_USAGE_PROTOCOL",
            ],
            keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
          },
        ],
      },
    },
  });

  const server = new grpc.Server();
  server.addService(TopologyManagerReadService, {
    ListAvailableStores: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => {
      // Deliberately not in order, and with the retired store first: the client
      // must RANK, not take the first.
      cb(null, {
        storeIds: [
          { synchronizer: { physicalId: RETIRED } },
          { authorized: {} },
          { synchronizer: { physicalId: CURRENT } },
        ],
      });
    },
    ListPartyToParticipant: (
      call: { request: Record<string, never> },
      cb: grpc.sendUnaryData<unknown>
    ) => {
      const req = call.request as unknown as {
        baseQuery?: {
          store?: { synchronizer?: { physicalId?: string } };
          headState?: unknown;
          timeQuery?: string;
        };
        filterParty?: string;
      };
      seen.storePhysicalId = req.baseQuery?.store?.synchronizer?.physicalId;
      seen.filterParty = req.filterParty;
      seen.headStateSet = req.baseQuery?.timeQuery === "headState";
      // A real Canton answers a PREFIX match, so the fake does too — that is
      // what makes the client's exact-party pin meaningful here.
      const results = [party(PARTY), ...extraParties.map(party)].filter((r) =>
        r.item.party.startsWith(req.filterParty ?? "")
      );
      cb(null, { results });
    },
  } as never);

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (err, p) => (err ? reject(err) : resolve(p))
    );
  });
  return { server, address: `127.0.0.1:${port}` };
}

const started: Array<{ server: grpc.Server }> = [];
afterAll(() => started.forEach((s) => s.server.forceShutdown()));

describe("topology reader — real gRPC against the vendored protos", () => {
  it("loads the protos, encodes the query, and decodes the key", async () => {
    const seen: Seen = {};
    const fake = await startFakeParticipant(seen);
    started.push(fake);
    const reader = createTopologyReader({ adminAddress: fake.address });

    const keys = await reader.getPartySigningKeys(PARTY);

    // The response decoded into the shape the extractor expects.
    expect(keys).toHaveLength(1);
    expect(Buffer.from(keys[0]!.derBase64, "base64")).toEqual(DER);

    // And the REQUEST went out the way a real participant needs it: the current
    // store, the exact party, and head_state as the time-query oneof. A wrong
    // field name here is green in a unit test and a 400 against a real node.
    expect(seen.storePhysicalId).toBe(CURRENT);
    expect(seen.filterParty).toBe(PARTY);
    expect(seen.headStateSet).toBe(true);
    reader.close();
  });

  it("ranks the store rather than taking the one served first", async () => {
    // The fake lists the RETIRED store first on purpose.
    const seen: Seen = {};
    const fake = await startFakeParticipant(seen);
    started.push(fake);
    const reader = createTopologyReader({ adminAddress: fake.address });
    await reader.getPartySigningKeys(PARTY);
    expect(seen.storePhysicalId).not.toBe(RETIRED);
    reader.close();
  });

  it("drops the prefix neighbours a real server would include", async () => {
    // End-to-end version of the guard: the server answers a prefix match, so
    // without the exact pin a longer-id impostor would come back too.
    const seen: Seen = {};
    const fake = await startFakeParticipant(seen, [`${PARTY}deadbeef`]);
    started.push(fake);
    const reader = createTopologyReader({ adminAddress: fake.address });
    const keys = await reader.getPartySigningKeys(PARTY);
    expect(keys).toHaveLength(1);
    reader.close();
  });

  it("refuses a short id instead of issuing the prefix query", async () => {
    const seen: Seen = {};
    const fake = await startFakeParticipant(seen);
    started.push(fake);
    const reader = createTopologyReader({ adminAddress: fake.address });
    await expect(reader.getPartySigningKeys("agent::1220ab")).rejects.toThrow(
      /well-formed/
    );
    // And it never reached the wire.
    expect(seen.filterParty).toBeUndefined();
    reader.close();
  });

  it("surfaces an unreachable participant as a throw, never as 'no keys'", async () => {
    const reader = createTopologyReader({
      adminAddress: "127.0.0.1:1",
      deadlineMs: 1_500,
    });
    await expect(reader.getPartySigningKeys(PARTY)).rejects.toThrow();
    reader.close();
  });
});
