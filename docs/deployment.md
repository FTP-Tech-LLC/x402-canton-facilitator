# Facilitator Deployment

How to build, configure, and run the Canton x402 facilitator in
production. The facilitator is the server-side `/verify` and `/settle`
service that resource servers delegate payment validation and settlement
to. It is a stateless Fastify process plus a Postgres database, shipped as
a Docker image and licensed Apache-2.0.

For the protocol itself see [`specs/scheme_exact_canton.md`](../specs/scheme_exact_canton.md).
For the runtime and dependency matrix see [COMPATIBILITY.md](COMPATIBILITY.md).
For upgrades, incident response, and the ledger-API compat checklist see
[MAINTENANCE-PLAYBOOK.md](MAINTENANCE-PLAYBOOK.md).

## What the facilitator needs

The facilitator is an app-provider on a Canton participant. It does not
run its own node; it consumes the JSON Ledger API v2 of a validator you
(or a host) operate. To stand it up you need:

1. **A Canton participant** (validator) reachable over the JSON Ledger
   API v2, with external-party hosting enabled (PartyToParticipant
   topology). DevNet, TestNet, or MainNet.
2. **A facilitator party** allocated on that participant, with
   `CanActAs` + `CanReadAs` granted to the ledger-API user the
   facilitator authenticates as.
3. **No custom DAR.** The `transfer-factory` path settles entirely
   through Splice token-standard interfaces plus the Amulet
   `TransferPreapproval`, resolved at runtime via `#package-name`
   references — there is nothing project-specific to vet on the
   participant.
4. **An SV Scan URL** for the network (registry resolution of the
   transfer factory and, for the Scan-read verify path, a free public
   read).
5. **A Postgres 16 database** for attribution and idempotency state.
6. **Participant auth**: OIDC client-credentials (Auth0 / Keycloak) for
   DevNet and MainNet, or unsafe HMAC for LocalNet smoke tests only.

## Prerequisites

- Docker with Compose v2, or Node 22 + pnpm 9 for a bare-metal run.
- Shell access to the participant to allocate the party and grant rights
  once (`scripts/bootstrap-facilitator.sh`).
- A reverse proxy for TLS termination (Caddy, nginx, or cloudflared).
  The container serves plain HTTP so the operator picks the proxy.

## Configuration

Configuration is environment-only. Values live in a per-deployment
`.env` file that is never committed. Secrets are marked (secret) and must
not appear in logs or version control.

### Core

| Variable | Purpose |
|---|---|
| `CANTON_NETWORK` | `canton:devnet`, `canton:testnet`, or `canton:mainnet` |
| `CANTON_PARTICIPANT_URL` | JSON Ledger API v2 base URL |
| `CANTON_FACILITATOR_PARTY` | the allocated facilitator party id |
| `CANTON_SYNCHRONIZER_ID` | the global synchronizer id |
| `CANTON_SCAN_URL` | SV Scan base URL |
| `CANTON_SCAN_FLAVOR` | Scan API flavor (`sv` or `validator-proxy`) |
| `CANTON_SCAN_FALLBACK_URLS` | comma-separated backup Scan URLs |
| `DATABASE_URL` (secret) | Postgres connection string |
| `PORT` | listen port (default 4022) |
| `LOG_LEVEL` | pino level (default `info`) |
| `CANTON_FACILITATOR_MEMBER_ID` | optional; enables the GS traffic-budget monitor |

### Participant auth

Static HMAC (LocalNet only):

| Variable | Purpose |
|---|---|
| `JWT_ISSUER` | set to `unsafe-hmac` |
| `JWT_SECRET` (secret) | HMAC signing secret |

OIDC client-credentials (DevNet / MainNet):

| Variable | Purpose |
|---|---|
| `JWT_ISSUER` | set to `oidc` |
| `OIDC_TOKEN_ENDPOINT` | token endpoint |
| `OIDC_CLIENT_ID` | m2m client id |
| `OIDC_CLIENT_SECRET` (secret) | m2m client secret |
| `OIDC_SCOPE` | requested scope |
| `LEDGER_API_AUDIENCE` | audience claim the participant expects |

> Auth0 gotcha: the m2m token `sub` must be rewritten to the
> ledger-API user (e.g. via an Auth0 Action) or the participant rejects
> the token.

### Payment behavior

| Variable | Purpose |
|---|---|
| `CANTON_X402_TF_ENABLED` | enable the `transfer-factory` (1-tx) settle path — the sole `exact` method; default OFF (relay pay routes 503, `/settle` fail-closes) |
| `CANTON_X402_ADVERTISE_TF` | advertise `transfer-factory` in `/supported` (requires `TF_ENABLED`) |
| `CANTON_X402_TF_STASH_CAP_PER_PAYER` / `_TF_DEFAULT_EXECUTE_BEFORE_S` / `_TF_MAX_EXECUTE_BEFORE_S` | transfer-factory stash cap + executeBefore horizons (default 8 / 120 / 600) |
| `CANTON_X402_ENABLE_PREAPPROVAL_PROVIDER` | enable the legacy facilitator-as-provider `TransferPreapproval` route (merchants normally self-provision with `canton-agent-wallet preapproval`); gated by the operator token |
| `CANTON_X402_ENABLE_CLOSE_ROUTE` | enable the `/close` admin route |
| `CANTON_X402_OPERATOR_TOKEN` (secret) | bearer token gating operator endpoints |
| `CANTON_X402_DISCOVERY_RESOURCES` | JSON array of Bazaar resources served at `GET /discovery/resources` (see below) |

### Bazaar discovery

`GET /discovery/resources` is the x402 "Bazaar": a discovery-driven agent asks
the facilitator what it can buy and gets back each resource URL plus the
`accepts[]` payment schema for it. Populate it with
`CANTON_X402_DISCOVERY_RESOURCES`, a JSON array where each entry is:

```json
{
  "resource": "https://api.example.com/inference",
  "type": "http",
  "accepts": [ /* the exact accepts[] the resource's own 402 returns */ ],
  "metadata": { "name": "Example API", "description": "..." }
}
```

Keep `accepts` byte-identical to what the resource's live 402 emits, so
discovery never drifts from the real payment path. The party ids inside
`accepts` are on-ledger public (the merchant's own 402 already broadcasts them),
so the listing is safe to serve publicly. Unset or empty is a valid empty
Bazaar; malformed JSON or an entry without a `resource` string or a non-empty
`accepts` array fails fast at startup.

### Settle protection

| Variable | Purpose |
|---|---|
| `CANTON_X402_SETTLE_RATE_MAX_GLOBAL` | global settle rate ceiling |
| `CANTON_X402_SETTLE_BREAKER_THRESHOLD` | consecutive-failure trip count |
| `CANTON_X402_SETTLE_BREAKER_FAILURE_RATE` | failure-rate trip threshold |
| `CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES` | minimum samples before rate trips |
| `CANTON_X402_SETTLE_BREAKER_WINDOW_MS` | rolling window for the breaker |
| `CANTON_X402_SETTLE_BREAKER_COOLDOWN_MS` | cooldown before half-open |
| `CANTON_EXCLUDED_PARTICIPANTS` | participant ids to refuse settling for |
| `CANTON_EXCLUDED_PARTIES` | party ids to refuse settling for |

The circuit breaker and rate limiter protect the facilitator's own
Global-Synchronizer traffic budget from a retry storm or a griefing
payer. Leave the defaults unless you have measured a reason to change
them.

### Optional: agent-wallet relay and faucet

The facilitator can expose a relay surface that *prepares* (but never
signs) transactions for self-custody agent wallets, plus a rate-limited
faucet on test networks. Both are off by default.

| Variable | Purpose |
|---|---|
| `CANTON_X402_ENABLE_AGENT_WALLET` | enable the relay routes |
| `CANTON_X402_AGENT_WALLET_KEY` (secret) | optional `X-Agent-Key` the relay requires |
| `CANTON_X402_FAUCET_ENABLED` | enable the test-network faucet |
| `CANTON_X402_FAUCET_AMOUNT_CC` | per-claim amount |
| `CANTON_X402_FAUCET_DAILY_BUDGET_CC` | daily faucet budget |
| `CANTON_X402_FAUCET_MAX_PER_IP` | per-IP claim cap |
| `CANTON_X402_FAUCET_LIFETIME_CAP_CC` | per-party lifetime cap |
| `CANTON_X402_FAUCET_WINDOW_MS` | rate-limit window |

A full annotated template lives in
[`ops/testnet/.env.example`](../ops/testnet/.env.example).

## Bootstrap (one-time)

Allocate the facilitator party and grant it rights on the participant:

```bash
bash scripts/bootstrap-facilitator.sh
```

The script is idempotent: party allocation and `CanActAs` + `CanReadAs`
grants can be re-run safely. Copy the party id it prints into
`CANTON_FACILITATOR_PARTY`. (No custom DAR to upload — `transfer-factory`
settles through the Splice token-standard interfaces.)

## Run with Docker Compose (recommended)

The production compose file enforces strict env validation (missing
secrets fail at `docker compose up`, not at the first ledger call), sets
CPU and memory limits, rotates logs, and binds the facilitator to
localhost so your reverse proxy is the only ingress.

1. Drop a `.env` file next to the compose file with the required
   variables above (at minimum `CANTON_PARTICIPANT_URL`,
   `CANTON_FACILITATOR_PARTY`, `CANTON_SYNCHRONIZER_ID`,
   `CANTON_SCAN_URL`, the OIDC set, and `POSTGRES_PASSWORD`).

2. Start the stack:

   ```bash
   docker compose -f packages/facilitator/docker-compose.production.yml up -d --build
   ```

3. Verify readiness:

   ```bash
   curl http://127.0.0.1:4022/ready
   curl http://127.0.0.1:4022/supported
   ```

`/ready` returns 200 only once the participant, Scan, and Postgres are
all reachable. `/supported` lists the advertised payment methods.

## Run bare-metal (Node)

```bash
pnpm install --frozen-lockfile
pnpm --filter @ftptech/x402-canton-facilitator build
PORT=4022 \
CANTON_NETWORK=canton:testnet \
CANTON_PARTICIPANT_URL=https://your-participant/ledger-api \
CANTON_FACILITATOR_PARTY=ftp_facilitator::1220... \
CANTON_SYNCHRONIZER_ID=global-domain::1220... \
CANTON_SCAN_URL=https://scan.your-sv/api/scan \
DATABASE_URL=postgres://x402:x402@localhost:5432/x402 \
JWT_ISSUER=oidc OIDC_TOKEN_ENDPOINT=... OIDC_CLIENT_ID=... \
OIDC_CLIENT_SECRET=... LEDGER_API_AUDIENCE=... \
node packages/facilitator/dist/server.js
```

## Reverse proxy and TLS

The container listens on plain HTTP (port 4022). Terminate TLS in front
of it. A minimal Caddy site:

```
facilitator.example.com {
    reverse_proxy 127.0.0.1:4022
}
```

Only expose `/verify`, `/settle`, `/supported`, `/discovery/resources`,
`/health`, and `/ready` publicly. Keep `/metrics` and any operator
routes on a private interface or behind the operator token.

## Operational endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | liveness; process is up |
| `/ready` | GET | readiness; participant + Scan + Postgres reachable |
| `/metrics` | GET | Prometheus metrics (verify/settle counters, latency histogram, breaker state) |
| `/supported` | GET | advertised payment methods and networks |
| `/verify` | POST | validate a payment payload |
| `/settle` | POST | execute settlement (facilitator submits the tx) |
| `/discovery/resources` | GET | resource discovery listing |
| `/close` | POST | operator-gated admin route (optional) |

The Docker image ships a `HEALTHCHECK` that polls `/ready` every 30s.

## Networks

| Network | Auth | Notes |
|---|---|---|
| LocalNet | `unsafe-hmac` | smoke tests only; never a real deployment |
| DevNet | OIDC | resets quarterly; self-serve validator onboarding |
| TestNet | OIDC | persistent test network |
| MainNet | OIDC | production; serves `transfer-factory` |

## Upgrades and rollback

Image build, deploy, and rollback are covered in
[MAINTENANCE-PLAYBOOK.md](MAINTENANCE-PLAYBOOK.md). In short: build a
tagged image, `docker compose up -d` it, confirm `/ready` plus one live
settle, and keep the previous `.env` and image tag so a rollback is a
one-line revert.

## Security checklist

- No secret has a value in the repo, in the image, or in logs. `.env`
  is the only place secrets live.
- The facilitator binds to localhost; the reverse proxy is the only
  ingress. Do not publish port 4022 on `0.0.0.0` on MainNet.
- Postgres has no published port; only the facilitator container reaches
  it over the internal docker network.
- `POSTGRES_PASSWORD` and `OIDC_CLIENT_SECRET` are long and random.
- Operator routes (`/metrics`, `/close`) are private or token-gated.
- The relay never signs. Agents hold their own keys; the relay only
  prepares transactions.
