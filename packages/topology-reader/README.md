# canton-x402 topology reader

A narrow, read-only boundary in front of the Canton participant admin API.

## Why it exists

An inline x402 payment carries the payer's signature over the prepared
transaction. To verify it before relaying, the facilitator needs the payer's
protocol signing key. That key lives in Canton topology, reachable only through
the participant's **admin gRPC API** — which Canton ships unauthenticated and
all-or-nothing: the same port carries `ParticipantRepairService`
(`ExportAcs` / `ImportAcs`).

Giving that port to the facilitator, a process that serves an unauthenticated
`/settle` to the internet, would make a facilitator compromise a node
compromise. Canton has no per-method authorization, so the narrow boundary has
to be built. This is it: one read, one method, no write service imported.

It also keeps `@ftptech/x402-canton-ledger` free of a gRPC dependency. That
package is published and decodes protobuf by hand on purpose; this one is
operator-side and private, so it can take the dependency without touching the
SDK surface.

## Where the key actually lives

Measured against MainNet, not assumed:

| call | result for an external party |
|---|---|
| `ListNamespaceDelegation` | **empty** (both the pre- and post-LSU stores) |
| `ListPartyToKeyMapping` | **empty**, and deprecated in the proto |
| `ListPartyToParticipant` | **the key**, under `partySigningKeys.keys[]` |

The read uses the **broadcast synchronizer store**, so it answers for parties
this participant does not host — verified against the DSO party, which lives on
Digital-Asset, Cumberland and SV-Nodeops participants and still reads back in
full.

The key comes back as `CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO`,
which node's `createPublicKey({format:"der", type:"spki"})` consumes directly.
A test asserts exactly that against a real captured key, so if the format ever
moves the suite says so instead of production.

## Two things that are easy to get wrong

1. **`filter_party` is a PREFIX filter.** A request for a shortened id returns
   every party underneath it. The reader pins the returned `party` to the
   requested one exactly; without that pin a caller gets a stranger's key and
   then verifies a stranger's signature. Mutation-tested.
2. **200-with-empty is not 503.** `keys: []` means topology answered and this
   party publishes no usable key. `503` means topology could not be read. A
   verifier fails closed on both, but collapsing them turns "we could not
   check" into "there was nothing to check".

## Deploying it

Infra-as-code lives in `ops/topology-reader/docker-compose.yml`. It is a
SEPARATE compose project on purpose: the validator's bundle (compose.yaml +
start.sh) is replaced wholesale on every Splice upgrade, so anything added to
that file is lost at the next one.

```
docker build -t x402-topology-reader:<tag> packages/topology-reader
# on the validator box, beside the participant:
#   .env  ->  READER_TAG=<tag>
#             TOPOLOGY_READER_TOKEN=<generated secret>
docker compose -f ops/topology-reader/docker-compose.yml up -d
```

It joins the validator's docker network to reach the participant's admin gRPC by
service DNS, and publishes ONLY on the VPN interface (`10.8.0.1`), matching how
`x402-participant-bridge` is already exposed. Never on `0.0.0.0`: this endpoint
reads topology for any party on the network.

### Upgrade gotcha (inherited, not introduced)

The validator's `start.sh` RECREATES the network
`splice-validator_splice_validator` and fails with "network has active
endpoints" if containers from other projects are attached. That already applied
to `x402-participant-bridge`; this service is a second one. Order:

```
docker compose -f ops/topology-reader/docker-compose.yml down
docker network disconnect -f splice-validator_splice_validator x402-participant-bridge
./start.sh ...
docker network connect splice-validator_splice_validator x402-participant-bridge
docker restart x402-participant-bridge
docker compose -f ops/topology-reader/docker-compose.yml up -d
```

The reader itself needs no change across Splice upgrades: the topology protos
are byte-identical across 0.6.13, 0.6.14, 0.7.0 and 0.7.1 (verified by hashing
them in each participant image), and the synchronizer store is RESOLVED by
ranking `<protocolVersion>-<serial>`, so a logical synchronizer upgrade is
followed automatically.

## Running it directly

```
CANTON_ADMIN_API_ADDRESS=participant:5002 \
TOPOLOGY_READER_TOKEN=<shared secret> \
TOPOLOGY_READER_HOST=127.0.0.1 \
TOPOLOGY_READER_PORT=8099 \
node dist/cli.js
```

Deploy it beside the participant, on the participant's own docker network. It
binds loopback by default: it has no business being routable.

```
GET /v1/party/<party id>/signing-keys
Authorization: Bearer <token>
-> 200 {"party":"…","keys":[{"derBase64":"…","usage":[…],"keySpec":"…"}]}
-> 400 malformed party   401 bad token   503 topology unavailable
```

## The proto tree has one file the image does not ship

Canton's protos `import "scalapb/scalapb.proto"` for Scala codegen options. The
participant image ships only Canton's own tree; protoc there resolves scalapb
from a jar. So `proto/scalapb/scalapb.proto` is vendored separately from the
ScalaPB project. It affects nothing on the wire — and without it the import does
not resolve and the whole package definition fails to load, which is a crash on
first use rather than a wrong answer. The gRPC round-trip test exists because
unit tests over plain objects cannot see that.

## Refreshing the vendored protos

`proto/` is copied from the participant image we run; `proto/SOURCE` records
which one. To refresh:

```bash
docker run --rm --entrypoint sh <participant-image> \
  -c 'cd /app/protobuf/community && tar czf - .' | tar xzf - -C proto
```
