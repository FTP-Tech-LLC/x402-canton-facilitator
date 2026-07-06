# canton-x402-facilitator

The open-source facilitator for the x402 payment protocol on Canton
Network: the server-side `/verify` and `/settle` service that resource
servers delegate payment validation and settlement to. Scheme `exact`,
asset Canton Coin (CC), method `transfer-factory` (Canton Token
Standard): the payer signs a relay-prepared `TransferFactory_Transfer`
naming the merchant as receiver; the facilitator relays it in a single
sponsored-gas transaction. The merchant holds a `TransferPreapproval`
(self-provisioned once via `canton-agent-wallet preapproval`) so the
transfer resolves direct. No custody, no client-managed nonce; the payer
pays no gas.

Apache-2.0. Built for the Canton ecosystem under a Canton Foundation
Dev Fund grant ([canton-foundation/canton-dev-fund PR #78](https://github.com/canton-foundation/canton-dev-fund/pull/78)).

## Layout

| Path | What |
|---|---|
| `packages/facilitator` | the Fastify service (routes, Canton settle/verify, ops endpoints) |
| `packages/core` | wire types for the `exact` scheme (shared with client SDKs) |
| `packages/ledger` | JSON Ledger API v2 + SV Scan client |
| `specs/scheme_exact_canton.md` | the protocol spec |
| `docs/deployment.md` | how to stand it up (Docker Compose or bare-metal) |
| `docs/COMPATIBILITY.md` | runtime / Canton / Daml / wire compatibility matrix |
| `docs/MAINTENANCE-PLAYBOOK.md` | upgrades, ledger-API compat checklist, incident response |

## Quick start

Prereqs: a Canton participant (JSON Ledger API v2), an allocated
facilitator party, an SV Scan URL, Postgres 16. Full walkthrough in
[docs/deployment.md](docs/deployment.md).

```bash
# one-time party + rights bootstrap on your participant
bash scripts/bootstrap-facilitator.sh

# configure (.env next to the compose file), then:
docker compose -f packages/facilitator/docker-compose.production.yml up -d --build
curl http://127.0.0.1:4022/ready
curl http://127.0.0.1:4022/supported
```

Develop:

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

## Endpoints

`/verify`, `/settle`, `/supported`, `/discovery/resources` (Bazaar
listing of payable resources), `/health`, `/ready`, `/metrics`
(Prometheus), plus an optional agent-wallet relay surface (prepares but
never signs; agents hold their own keys).

## Related packages (npm, `@ftptech` scope)

`x402-canton-client` (buyer-side scheme), `x402-canton-express` /
`x402-canton-next` (merchant middleware), `canton-agent-wallet`
(self-custody wallet CLI), `canton-x402-mcp` (MCP server for agent
hosts). See [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) for the
version matrix.
