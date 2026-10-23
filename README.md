# canton-x402-facilitator

The open-source facilitator for the x402 payment protocol on Canton
Network: the server-side `/verify` and `/settle` service that resource
servers delegate payment validation and settlement to. Scheme `exact`,
method `transfer-factory` (Canton Token Standard). Assets: Canton Coin
(CC) and any CIP-56 registry token the operator configures.

The payer signs a relay-prepared `TransferFactory_Transfer` naming the
merchant as receiver and carries the signed transaction in the payment.
The facilitator checks it and relays it in a single transaction, paying
the network traffic. The merchant holds a `TransferPreapproval` per
accepted token, self-provisioned with `canton-agent-wallet preapproval`
and renewed before it expires (30 days by default), so the transfer
resolves direct. No custody, no client-managed nonce; the payer pays no
traffic.

Apache-2.0. Built for the Canton ecosystem under a Canton Foundation
Dev Fund grant ([canton-foundation/canton-dev-fund PR #78](https://github.com/canton-foundation/canton-dev-fund/pull/78)).

## Layout

| Path | What |
|---|---|
| `packages/facilitator` | the Fastify service (routes, Canton settle/verify, agent-wallet relay) |
| `packages/core` | wire types and verify-before-sign decoders for the `exact` scheme (npm `@ftptech/x402-canton-core`) |
| `packages/ledger` | JSON Ledger API v2 + Scan client (npm `@ftptech/x402-canton-ledger`) |
| `specs/scheme_exact_canton.md` | the protocol spec, as merged upstream in [x402-foundation/x402](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md) |
| `docs/deployment.md` | how to stand it up, and every setting |
| `docs/COMPATIBILITY.md` | runtime, Canton, wire and package compatibility |
| `docs/MAINTENANCE-PLAYBOOK.md` | upgrades, ledger-API checklist, incident response |
| `ops/` | compose and env templates: `testnet/`, `devnet/` (on the validator host), `mainnet-standalone/` (dedicated host with Caddy) |

The upstream spec covers Canton Coin. CIP-56 tokens are an extension of
this facilitator: a 402 names the token in `asset` and
`extra.instrumentId`, and `/supported` lists configured tokens in
`extra.instruments`.

## Quick start

You need:

- a Canton participant (JSON Ledger API v2) with Global Synchronizer
  traffic, a facilitator party on it, and a ledger user with the rights
  in [docs/deployment.md](docs/deployment.md#party-and-rights);
- a topology reader beside the participant. Without it every payment is
  refused ([details](docs/deployment.md#topology-reader));
- an SV Scan URL and Postgres 16.

```bash
# configure packages/facilitator/.env (minimum: docs/deployment.md#minimum), then:
docker compose -f packages/facilitator/docker-compose.production.yml up -d --build
curl http://127.0.0.1:4022/ready
curl http://127.0.0.1:4022/supported
```

Develop:

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

## Endpoints

`/verify`, `/settle`, `/supported`, `/discovery/resources` (Bazaar
listing of payable resources), `/health`, `/ready`, `/metrics`
(Prometheus, keep private), `/v1/merchants/:party/preapproval-status`,
plus an optional agent-wallet relay (`/v1/wallet/*`) that prepares but
never signs; agents hold their own keys. Full table with auth in
[docs/deployment.md](docs/deployment.md#endpoints).

## Related packages (npm, `@ftptech` scope)

`x402-canton-client` (buyer-side scheme), `x402-canton-express` /
`x402-canton-next` (merchant middleware), `canton-agent-wallet`
(self-custody wallet CLI), `canton-x402-mcp` (MCP server for agent
hosts). See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the
version matrix.

Synced from the FTP canton-x402 monorepo at `9784c34` on 2026-10-23.
