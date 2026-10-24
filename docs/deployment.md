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

The facilitator is an app provider on a Canton participant. It does not
run its own node; it uses the JSON Ledger API v2 of a validator you (or a
host) operate. To stand it up you need:

1. **A Canton participant** reachable over the JSON Ledger API v2.
   DevNet, TestNet, or MainNet. Canton 3.6 (Splice 0.9) works with the
   ledger client in this repo (0.6.2). See [COMPATIBILITY.md](COMPATIBILITY.md).
2. **A facilitator party** on that participant, and a ledger user the
   facilitator authenticates as, with the rights in
   [Party and rights](#party-and-rights).
3. **A topology reader** beside the participant. It answers one question
   over HTTP: the signing keys of a party. The facilitator needs it to
   check the payer's signature. Without it every payment is refused. See
   [Topology reader](#topology-reader).
4. **An SV Scan URL** for the network. The facilitator reads AmuletRules,
   mining rounds and transfer factories there.
5. **A Postgres 16 database** for settle state, attribution, the faucet
   ledger and markers.
6. **Participant auth**: OIDC client credentials (Auth0, Keycloak) on
   DevNet, TestNet and MainNet, or unsafe HMAC for LocalNet only.
7. **Global Synchronizer traffic** on the participant. The facilitator
   relays every payment and pays its traffic.

No custom DAR. The `transfer-factory` path settles through Splice
token-standard interfaces plus the Amulet `TransferPreapproval`, resolved
at runtime by `#package-name`. Nothing project-specific is uploaded to
the participant.

## Prerequisites

- Docker with Compose v2, or Node 22 + pnpm 9 for a bare-metal run.
- A user with `ParticipantAdmin` on the participant, once, to allocate
  the party and grant rights.
- A reverse proxy for TLS (Caddy, nginx). The container serves plain
  HTTP.

## Party and rights

The facilitator party is a local party on the participant. The ledger
user the facilitator authenticates as (`CANTON_USER_ID`) needs:

| Right | When |
|---|---|
| `CanActAs` + `CanReadAs` on the facilitator party | always |
| `ParticipantAdmin` | when the agent-wallet relay is on (it allocates external parties for new wallets) |
| `CanActAs` on each onboarded wallet party | granted automatically by the relay on onboarding, unless `CANTON_GRANT_PARTY_RIGHTS=false` |

Each per-party grant counts against the participant's maximum rights per
user (1000 by default). A relay that onboards many wallets reaches it.
The alternative: give the user `CanReadAsAnyParty` + `CanExecuteAsAnyParty`
and set `CANTON_GRANT_PARTY_RIGHTS=false`.

**LocalNet (unsafe HMAC).** `scripts/bootstrap-facilitator.sh` allocates
the party and grants `CanActAs` + `CanReadAs`. It is idempotent. It
supports `JWT_ISSUER=unsafe-hmac` only.

**OIDC participants (DevNet, TestNet, MainNet).** Do it by hand with a
token for an admin user (`ParticipantAdmin`), for example the validator
operator's:

```bash
P=https://your-participant          # JSON Ledger API v2 base
T=<admin access token>

# 1. allocate the party
curl -sS -X POST "$P/v2/parties" -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' \
  -d '{"partyIdHint":"x402_facilitator","identityProviderId":""}'

# 2. grant rights to the facilitator's ledger user
curl -sS -X POST "$P/v2/users/<CANTON_USER_ID>/rights" -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{
    "userId": "<CANTON_USER_ID>",
    "identityProviderId": "",
    "rights": [
      {"kind":{"CanActAs":{"value":{"party":"<party id>"}}}},
      {"kind":{"CanReadAs":{"value":{"party":"<party id>"}}}}
    ]}'
```

The ledger user id is the token's `sub` (with Auth0 usually
`<client id>@clients`). Create that user on the participant if it does
not exist (`POST /v2/users`) and set the same value in `CANTON_USER_ID`.
Put the allocated party id in `CANTON_FACILITATOR_PARTY`.

## Topology reader

To verify a payment the facilitator checks the payer's Ed25519 signature
against the payer's signing key. That key is in Canton topology, which is
readable only through the participant's admin gRPC API. That API is
unauthenticated and also carries repair services, so the facilitator does
not get it. A small reader runs beside the participant instead, holds the
admin access, and serves one read-only route:

```
GET /v1/party/<party id>/signing-keys
Authorization: Bearer <token>
200 {"party":"...","keys":[{"derBase64":"...","usage":[...],"keySpec":"..."}]}
400 malformed party   401 bad token   503 topology unavailable
```

- It reads the synchronizer topology store, so it answers for parties
  the participant does not host.
- The topology route needs Canton 3.5.10 (Splice 0.6.14) or later. On an
  older participant it returns nothing and every payment is refused.
- Publish it only on a private interface. Never on `0.0.0.0`.
- The reader is not part of this repository.

Facilitator settings: `CANTON_X402_TOPOLOGY_READER_URL` (for example
`http://<private ip>:8099`) and `CANTON_X402_TOPOLOGY_READER_TOKEN`. If
either is unset, every payment fails with
`invalid_exact_canton_signature_invalid`.

## Configuration

Configuration is environment-only. Values live in a per-deployment
`.env` file that is never committed. Secrets are marked (secret).
Templates: [`ops/testnet/.env.example`](../ops/testnet/.env.example),
[`ops/devnet/.env.example`](../ops/devnet/.env.example),
[`ops/mainnet-standalone/.env.example`](../ops/mainnet-standalone/.env.example).

A numeric limit that is empty or not a number falls back to its default.
`0` disables a cap.

### Minimum

These are enough to settle Canton Coin payments:

```
CANTON_NETWORK  CANTON_PARTICIPANT_URL  CANTON_FACILITATOR_PARTY
CANTON_SYNCHRONIZER_ID  CANTON_SCAN_URL  CANTON_USER_ID
JWT_ISSUER=oidc  OIDC_TOKEN_ENDPOINT  OIDC_CLIENT_ID  OIDC_CLIENT_SECRET
LEDGER_API_AUDIENCE
CANTON_X402_TF_ENABLED=true
CANTON_X402_TOPOLOGY_READER_URL  CANTON_X402_TOPOLOGY_READER_TOKEN
DATABASE_URL (or POSTGRES_PASSWORD with the composes)
```

### Core

| Variable | Default | Purpose |
|---|---|---|
| `CANTON_NETWORK` | required | `canton:devnet`, `canton:testnet`, or `canton:mainnet` |
| `CANTON_PARTICIPANT_URL` | required | JSON Ledger API v2 base URL |
| `CANTON_FACILITATOR_PARTY` | required | the facilitator party id |
| `CANTON_SYNCHRONIZER_ID` | required | the global synchronizer id (see below) |
| `CANTON_USER_ID` | `ledger-api-user` | the ledger user the token maps to |
| `CANTON_SCAN_URL` | required | Scan host base URL, no path (the client adds `/api/scan/v0` or the validator proxy path) |
| `CANTON_SCAN_FLAVOR` | `sv` with OIDC, else `validator` | `sv` (SV Scan) or `validator` (the validator's scan proxy, same auth as the participant). Any other value stops the boot |
| `CANTON_SCAN_AUTH` | `false` | `true` sends the OIDC token to Scan |
| `CANTON_SCAN_FALLBACK_URLS` | empty | comma-separated SV Scan URLs tried when the primary keeps failing. No port in the URL |
| `CANTON_FACILITATOR_MEMBER_ID` | unset | participant member id, `PAR::<participant uid>`. Enables the traffic monitor. Required with markers on |
| `DATABASE_URL` (secret) | unset | Postgres connection string. Required for the faucet and markers |
| `PORT` | `4022` | listen port |
| `LOG_LEVEL` | `info` | pino level |

Synchronizer id: on MainNet it is
`global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc`.
On any network the SV Scan returns it as `amulet_rules_update.domain_id`:

```bash
curl -sS -X POST -H 'Content-Type: application/json' -d '{}' \
  https://<sv scan host>/api/scan/v0/amulet-rules | jq -r .amulet_rules_update.domain_id
```

MainNet SV Scans admit only allowlisted IPs, and some refuse a request
whose Host header carries a port. If your facilitator host is not
allowlisted, reach Scan through a host that is (for example your
validator, over the private link) and keep the Scan host name in
`CANTON_SCAN_URL`. A wrong Scan setting still passes `/health` and
`/supported`; payers then get 502. Check `/ready`.

### Participant auth

Static HMAC (LocalNet only):

| Variable | Purpose |
|---|---|
| `JWT_ISSUER` | `unsafe-hmac` (the code default) |
| `JWT_SECRET` (secret) | HMAC signing secret |

OIDC client credentials (DevNet, TestNet, MainNet):

| Variable | Purpose |
|---|---|
| `JWT_ISSUER` | `oidc` |
| `OIDC_TOKEN_ENDPOINT` | token endpoint |
| `OIDC_CLIENT_ID` | m2m client id |
| `OIDC_CLIENT_SECRET` (secret) | m2m client secret |
| `OIDC_SCOPE` | requested scope |
| `LEDGER_API_AUDIENCE` | audience the participant expects |

With `oidc`, the facilitator refuses to start if the token endpoint,
client id, client secret or audience is missing.

> The token's `sub` must equal `CANTON_USER_ID`, a user that exists on
> the participant, or the participant rejects the token.

### Settlement

| Variable | Default | Purpose |
|---|---|---|
| `CANTON_X402_TF_ENABLED` | `false` | master switch. Off: `/settle` refuses every payment and the relay pay routes answer 503 |
| `CANTON_X402_TOPOLOGY_READER_URL` / `_TOKEN` (secret) | unset | the topology reader. Unset: every payment is refused |
| `CANTON_X402_TF_DEFAULT_EXECUTE_BEFORE_S` / `_TF_MAX_EXECUTE_BEFORE_S` | `120` / `600` | executeBefore horizon when the client asks for none, and the ceiling |
| `CANTON_X402_INLINE_MERCHANT_POLICY` | `open` | which merchants this facilitator pays traffic for (below). An unknown value stops the boot |
| `CANTON_X402_INLINE_MERCHANT_ALLOWLIST` | empty | comma-separated merchant parties for the `allowlist` modes |
| `CANTON_X402_SETTLE_DISPATCH_MARK` | `off` | guard for a settle whose outcome never came back: `off`, `observe`, `enforce` (below) |
| `CANTON_X402_ACCEPTED_FEE_PAYERS` | empty | earlier facilitator parties still accepted as `extra.feePayer` after a party change. `/supported` shows only the current one |
| `CANTON_X402_ADVERTISE_TF` | `false` | no effect. `/supported` always advertises `transfer-factory` |

`/settle` is unauthenticated, so anyone can ask the facilitator to relay
a well-formed payment between two parties and pay its traffic. The
merchant policy limits that:

| Policy | Relays for |
|---|---|
| `open` | anyone |
| `provider` | merchants whose preapproval names this facilitator as provider |
| `allowlist` | merchants in `CANTON_X402_INLINE_MERCHANT_ALLOWLIST` |
| `provider-or-allowlist` | either |

Do not run bare `provider`: a self-provisioned preapproval names the
merchant itself as provider, so most honest payments would be refused.

The dispatch mark covers one case: the participant accepted a submission
but its outcome never came back. With `off` the payer is told the settle
failed, and a payer that pays again may pay twice. `observe` records the
case and counts it in `/metrics` without changing responses. `enforce`
answers `503 settle_outcome_unknown` with `Retry-After` until the outcome
resolves. Roll out in that order.

### CIP-56 registry tokens

Canton Coin needs no configuration. To settle other CIP-56 tokens (for
example USDCx or CBTC), configure each instrument admin. All values are
JSON keyed by the instrument admin party. Unset or invalid JSON means
Canton Coin only.

| Variable | Shape | Purpose |
|---|---|---|
| `CANTON_X402_TOKEN_REGISTRIES` | `{"<admin>":"<registry base URL>"}` | the token's registry (for example the DA Registry Utility). Its preapprovals are checked there, not on the SV Scan. Each admin listed is advertised in `/supported` `extra.instruments` |
| `CANTON_X402_TOKEN_INSTRUMENTS` | `{"<admin>":{"id":"<id>","symbol":"<SYM>"}}` | adds `instrumentId` and `symbol` to those `/supported` entries |
| `CANTON_X402_REGISTRY_TRUSTED_PARTIES` | `{"<admin>":["<registry operator>","<bridge operator>"]}` | infrastructure parties a real registry transfer names. Take them from the registry, never from a payload |

Every instrument uses 10 decimals on the wire (1 token = 10^10 atomic
units). A merchant needs a preapproval per token it accepts. Tokens are
an extension of this facilitator: the upstream spec covers Canton Coin,
and a 402 names the token in `asset` and `extra.instrumentId`.

### Bazaar discovery

`GET /discovery/resources` is the x402 "Bazaar": a discovery-driven agent
asks the facilitator what it can buy and gets back each resource URL plus
its `accepts[]`. Populate it with `CANTON_X402_DISCOVERY_RESOURCES`, a
JSON array where each entry is:

```json
{
  "resource": "https://api.example.com/inference",
  "type": "http",
  "accepts": [ /* the exact accepts[] the resource's own 402 returns */ ],
  "metadata": { "name": "Example API", "description": "..." }
}
```

Keep `accepts` identical to what the resource's live 402 returns. The
party ids in it are public already. Unset or empty is a valid empty
Bazaar; malformed JSON, or an entry without a `resource` string or a
non-empty `accepts` array, stops the boot.

### Rate limits and breaker

All windows slide. Rate limits key on the client IP, so set
`CANTON_X402_TRUST_PROXY` to match your proxy.

| Variable | Default | Purpose |
|---|---|---|
| `CANTON_X402_TRUST_PROXY` | `loopback` | which proxies' `X-Forwarded-For` to trust: `false`, `true` (unsafe), a hop count, or a comma list of IPs, CIDRs or keywords. Use `uniquelocal` when the proxy reaches the container over Docker networking, or every client shares one bucket |
| `CANTON_X402_SETTLE_RATE_MAX_PER_PAYER` | `10` | settles per payer per window |
| `CANTON_X402_SETTLE_RATE_MAX_PER_IP` | `100` | settles per caller IP per window (the caller is the merchant) |
| `CANTON_X402_SETTLE_RATE_MAX_GLOBAL` | `120` | settles per window, all callers |
| `CANTON_X402_SETTLE_RATE_WINDOW_MS` | `60000` | settle window |
| `CANTON_X402_VERIFY_RATE_MAX_PER_IP` | `120` | verifies per IP per window |
| `CANTON_X402_VERIFY_RATE_WINDOW_MS` | settle window | verify window |
| `CANTON_X402_SETTLE_BREAKER_THRESHOLD` | `3` | failures that open the breaker |
| `CANTON_X402_SETTLE_BREAKER_FAILURE_RATE` | `0.5` | failure fraction that opens it (with min samples) |
| `CANTON_X402_SETTLE_BREAKER_MIN_SAMPLES` | `10` | failures needed before the rate arm can trip |
| `CANTON_X402_SETTLE_BREAKER_WINDOW_MS` | `60000` | breaker window |
| `CANTON_X402_SETTLE_BREAKER_COOLDOWN_MS` | `60000` | how long an open breaker refuses settles |

The breaker and limits protect the facilitator's own traffic budget from
a retry storm or a griefing payer. Leave the defaults unless you have
measured a reason to change them.

### Agent-wallet relay

The relay prepares (never signs) transactions for self-custody agent
wallets such as `canton-agent-wallet`. Off by default.

| Variable | Default | Purpose |
|---|---|---|
| `CANTON_X402_ENABLE_AGENT_WALLET` | `false` | enable `/v1/wallet/*` |
| `CANTON_X402_AGENT_WALLET_KEY` (secret) | unset | when set, every relay call needs `X-Agent-Key`. Unset: the relay is open |
| `CANTON_X402_WALLET_SUBMIT_CHOICES` | `TransferFactory_Transfer,TransferInstruction_Accept` | choices `submit/prepare` will build. `*` allows any |
| `CANTON_X402_WALLET_SUBMIT_CREATE_TEMPLATES` | empty | templates `submit/prepare` may create directly |
| `CANTON_X402_WALLET_READ_IDS` | empty | template or interface ids `GET /v1/wallet/:party/contracts` may list. Empty: route off |
| `CANTON_X402_WALLET_SUBMIT_RATE_MAX` | `60` | relay submits per party and IP per minute |
| `CANTON_X402_WALLET_SUBMIT_RATE_MAX_PER_IP` | `240` | relay submits per IP per minute |
| `CANTON_X402_WALLET_ONBOARD_RATE_MAX_GLOBAL` | `60` | party allocations per minute, all callers |
| `CANTON_X402_WALLET_ONBOARD_DAILY_MAX` | `200` | party allocations per 24 h, all callers |
| `CANTON_X402_WALLET_PREPARE_WASTE_MAX` / `_WINDOW_MS` | `10` / `300000` | refused pay prepares a payer may cause before the route stops doing the expensive work for it |
| `CANTON_X402_ABUSE_STRIKES_TO_BAN` | `5` | refusals that ban a caller IP from relay money routes. `0` disables |
| `CANTON_X402_ABUSE_STRIKE_WINDOW_MS` / `_STRIKE_SPACING_MS` | `600000` / `60000` | strike window, and the gap below which refusals count as one strike |
| `CANTON_X402_ABUSE_BASE_BAN_MS` / `_BAN_MULTIPLIER` / `_MAX_BAN_MS` | `3600000` / `2` / `86400000` | first ban, growth per repeat, ceiling |
| `CANTON_GRANT_PARTY_RIGHTS` | `true` | grant the ledger user `CanActAs` on each new wallet. See [Party and rights](#party-and-rights) |

Tradecraft queued mode (`canton-agent-wallet tc`) needs all three of
`_SUBMIT_CHOICES`, `_SUBMIT_CREATE_TEMPLATES` and `_READ_IDS`; the values
are in [`ops/mainnet-standalone/.env.example`](../ops/mainnet-standalone/.env.example).

### Faucet and starter grant

The faucet sends Canton Coin from the facilitator party. It is one
env-gated feature on any network, not a test-network mode. It needs the
relay on and `DATABASE_URL` (the boot fails without it).

| Variable | Default | Purpose |
|---|---|---|
| `CANTON_X402_FAUCET_ENABLED` | `false` | enable the faucet |
| `CANTON_X402_FAUCET_ON_ONBOARD` | `false` | send one grant to every new wallet. Needs the faucet on |
| `CANTON_X402_FAUCET_INTERNAL_SECRET` (secret) | unset | when set, `POST /v1/wallet/faucet/claim` needs `X-Faucet-Secret`. Unset: anyone can claim |
| `CANTON_X402_FAUCET_AMOUNT_CC` | `0.02` | per grant |
| `CANTON_X402_FAUCET_MAX_PER_IP` | `5` | claims per IP per window |
| `CANTON_X402_FAUCET_DAILY_BUDGET_CC` | `1` | payout ceiling per window |
| `CANTON_X402_FAUCET_LIFETIME_CAP_CC` | `25` | all-time payout ceiling. `0` disables |
| `CANTON_X402_FAUCET_WINDOW_MS` | `86400000` | window for the IP cap and budget |
| `CANTON_X402_FAUCET_MAX_GLOBAL_PER_MIN` | `0` | claims per burst window, all callers. `0` disables |
| `CANTON_X402_FAUCET_BURST_WINDOW_MS` | `60000` | burst window |
| `CANTON_X402_FAUCET_IP_EXEMPT` | empty | IPs exempt from the per-IP and burst caps |

Set `CANTON_X402_FAUCET_INTERNAL_SECRET` whenever the faucet is on. The
starter grant does not use the claim route.

### Second participant

For moving parties to another participant (party replication). When set,
each relay and settle call for a party goes to the participant that hosts
it. Everything else stays on `CANTON_PARTICIPANT_URL`.

| Variable | Purpose |
|---|---|
| `CANTON_SECONDARY_PARTICIPANT_URL` | the other participant. Must differ from the primary |
| `CANTON_SECONDARY_USER_ID` | its ledger user. Required with the URL |
| `CANTON_SECONDARY_OIDC_TOKEN_ENDPOINT` / `_OIDC_CLIENT_ID` / `_OIDC_CLIENT_SECRET` (secret) / `_LEDGER_API_AUDIENCE` | required with OIDC |
| `CANTON_SECONDARY_OIDC_SCOPE` | optional |
| `CANTON_SECONDARY_GRANT_PARTY_RIGHTS` | as `CANTON_GRANT_PARTY_RIGHTS`, on that participant |
| `CANTON_X402_ONBOARD_CO_HOST_UID` | also host every new wallet there (its participant uid, no `PAR::`). Needs the secondary |

### Operator routes

| Variable | Default | Purpose |
|---|---|---|
| `CANTON_X402_OPERATOR_TOKEN` (secret) | unset | bearer token for the merchant registry, the preapproval provider route and `GET /attribution`. Unset: those routes answer 503 |
| `CANTON_X402_ENABLE_PREAPPROVAL_PROVIDER` | `false` | legacy facilitator-as-provider preapproval route. Merchants normally self-provision with `canton-agent-wallet preapproval` |
| `CANTON_X402_ENABLE_CLOSE_ROUTE` | `false` | `POST /close`: an unauthenticated process exit for the x402 conformance harness. Never enable it on a reachable host |

### Attribution and app-reward markers

Optional. Attribution records the traffic of each settled payment, read
from Scan. The marker worker emits one `FeaturedAppActivityMarker` per
mining round from a party that holds a `FeaturedAppRight`, weighted by the
participant's total Global Synchronizer traffic in that round. It skips a
round rather than emit twice, and clamps each round's weight.

| Variable | Default | Purpose |
|---|---|---|
| `CANTON_ATTRIBUTION_SCAN_URLS` | empty | SV Scan URLs for attribution. Empty: off |
| `CANTON_ATTRIBUTION_SCAN_AUTH` | `false` | send the OIDC token to those Scans |
| `CANTON_ATTRIBUTION_REQUIRED` | `false` | refuse to start, and fail a settle, without attribution |
| `CANTON_X402_ATTRIBUTION_RETRY_MS` | `60000` | retry tick (minimum 15000) |
| `CANTON_EXCLUDED_PARTICIPANTS` / `CANTON_EXCLUDED_PARTIES` | empty | traffic left out of `eligible_bytes` in `GET /attribution`. Reporting only: these block nothing |
| `CANTON_X402_MARKER_ENABLED` | `false` | enable markers. Needs `DATABASE_URL` and `CANTON_FACILITATOR_MEMBER_ID` |
| `CANTON_X402_MARKER_FTP_PARTY` | unset | the party holding the `FeaturedAppRight` |
| `CANTON_X402_MARKER_USER_ID` | unset | the ledger user that submits markers |
| `CANTON_X402_MARKER_BENEFICIARY` | marker party | who receives the reward |
| `CANTON_X402_MARKER_WEIGHT_MULTIPLIER` | `1.15` | weight multiplier |
| `CANTON_X402_MARKER_MAX_WEIGHT_PER_ROUND` | `1000` | per-round ceiling |
| `CANTON_X402_MARKER_FREE_BYTES_PER_ROUND` | `0` | free-base bytes added per round. Set only if the node's own free-base emission is off |

## Run with Docker Compose

Three layouts ship:

| Compose | Layout |
|---|---|
| `packages/facilitator/docker-compose.production.yml` | builds the image; facilitator + Postgres on one host, port 4022 on localhost |
| `ops/testnet/`, `ops/devnet/` | prebuilt image on the validator host, joined to the validator's docker network |
| `ops/mainnet-standalone/` | prebuilt image on a dedicated host with Caddy TLS; the participant over a private link |

The production compose:

1. Put a `.env` in `packages/facilitator/` with the [minimum](#minimum)
   variables and `POSTGRES_PASSWORD`. The whole file is forwarded.
2. Start:

   ```bash
   docker compose -f packages/facilitator/docker-compose.production.yml up -d --build
   ```

3. Verify:

   ```bash
   curl http://127.0.0.1:4022/ready
   curl http://127.0.0.1:4022/supported
   ```

The dedicated-host layout:

```bash
cd ops/mainnet-standalone
cp .env.example .env    # fill in
docker build -f ../../packages/facilitator/Dockerfile -t canton-x402-facilitator:<tag> ../..
docker compose up -d
docker compose exec facilitator wget -qO- http://127.0.0.1:4022/ready
curl https://$FACILITATOR_DOMAIN/supported
```

Its Caddyfile answers 404 for `/metrics` and `/ready` at the edge and
replaces `X-Forwarded-For` with the real peer. Keep the participant's
ledger API and the topology reader on a private network (VPN); never
expose them publicly.

All composes set `stop_grace_period: 70s`. A `/settle` can wait about a
minute on the ledger, and a shorter stop can cut a payment in half.

## Run bare-metal (Node)

```bash
pnpm install --frozen-lockfile
pnpm build
PORT=4022 \
CANTON_NETWORK=canton:testnet \
CANTON_PARTICIPANT_URL=https://your-participant \
CANTON_FACILITATOR_PARTY=x402_facilitator::1220... \
CANTON_SYNCHRONIZER_ID=global-domain::1220... \
CANTON_SCAN_URL=https://scan.your-sv \
CANTON_USER_ID=your-ledger-user \
DATABASE_URL=postgres://x402:x402@localhost:5432/x402 \
JWT_ISSUER=oidc OIDC_TOKEN_ENDPOINT=... OIDC_CLIENT_ID=... \
OIDC_CLIENT_SECRET=... LEDGER_API_AUDIENCE=... \
CANTON_X402_TF_ENABLED=true \
CANTON_X402_TOPOLOGY_READER_URL=http://... CANTON_X402_TOPOLOGY_READER_TOKEN=... \
node packages/facilitator/dist/server.js
```

`pnpm build` builds `core` and `ledger` first; the facilitator imports
them from their `dist/`.

## Reverse proxy and TLS

The container listens on plain HTTP (port 4022). Terminate TLS in front
of it. A minimal Caddy site:

```
facilitator.example.com {
    @ops path /metrics /ready
    respond @ops 404
    reverse_proxy 127.0.0.1:4022 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

Public: `/verify`, `/settle`, `/supported`, `/discovery/resources`,
`/health`, `/v1/merchants/:party/preapproval-status`, and `/v1/wallet/*`
when the relay is on. Keep `/metrics` and `/ready` private. Accept request
headers of at least 16 KiB: a payment header is about 8 to 10 KiB.

## Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/supported` | GET | none | scheme, network, `transferMethods`, `carriages`, `instruments`, signer |
| `/verify` | POST | none | validate a payment payload |
| `/settle` | POST | none | relay the payer-signed transfer in one transaction |
| `/discovery/resources` | GET | none | Bazaar listing |
| `/health` | GET | none | liveness |
| `/ready` | GET | none | readiness: ledger token, participant and Scan reachable |
| `/metrics` | GET | none | Prometheus metrics. Keep private |
| `/v1/merchants/:party/preapproval-status` | GET | none | whether a merchant holds a live preapproval. `?admin=<instrument admin>[&id=<id>]`, `id` defaults to `Amulet` |
| `/v1/merchants/:party` | GET | none | legacy merchant registry lookup |
| `/v1/merchants/register`, `/v1/merchants/:proposalCid/accept`, `/v1/merchants/:party/preapproval` | POST | operator token | legacy merchant registry and provider preapproval. Payments do not need them |
| `/attribution` | GET | operator token | attribution totals |
| `/v1/wallet/onboard/{prepare,finalize}` | POST | relay | create a wallet (external party) |
| `/v1/wallet/pay/prepare` | POST | relay | build the payment transfer for the wallet to sign |
| `/v1/wallet/submit/{prepare,execute}` | POST | relay | other wallet transactions |
| `/v1/wallet/resolve/{transfer-factory,allocation-factory,settlement-factory,accept}` | POST | relay | registry lookups |
| `/v1/wallet/preapproval/self/{prepare,commit}`, `/v1/wallet/preapproval/registry/self/prepare` | POST | relay | merchant self-provisioned preapproval |
| `/v1/wallet/:party/{balance,holdings,holdings-scan,pending,tx-amulets,contracts}` | GET | relay | wallet reads. `holdings` serves bounded slices (`?slice=1`) |
| `/v1/wallet/faucet/claim` | POST | `X-Faucet-Secret` when set | faucet |
| `/close` | POST | none | only with `CANTON_X402_ENABLE_CLOSE_ROUTE=true`. Off by default |

"relay": open, or `X-Agent-Key` when `CANTON_X402_AGENT_WALLET_KEY` is
set. The Docker image's `HEALTHCHECK` polls `/ready` every 30s.

## Networks

| Network | Auth | Notes |
|---|---|---|
| LocalNet | `unsafe-hmac` | smoke tests only |
| DevNet | OIDC | resets periodically |
| TestNet | OIDC | persistent test network |
| MainNet | OIDC | production |

The image is the same on every network; only `.env` changes.

## Upgrades and rollback

See [MAINTENANCE-PLAYBOOK.md](MAINTENANCE-PLAYBOOK.md). In short: build a
tagged image, `docker compose up -d` it, confirm `/ready` and one live
payment, and keep the previous `.env` and image tag so a rollback is a
one-line revert.

## Security checklist

- No secret is in the repo, the image, or logs. `.env` is the only place
  secrets live.
- The facilitator binds to localhost or an internal network; the reverse
  proxy is the only ingress. Do not publish port 4022 on `0.0.0.0` on
  MainNet.
- The participant ledger API, its admin API and the topology reader are
  reachable only on a private network.
- Postgres has no published port.
- `POSTGRES_PASSWORD`, `OIDC_CLIENT_SECRET` and all tokens are long and
  random.
- `/metrics` and `/ready` are private. `/close` is off.
- With the faucet on, `CANTON_X402_FAUCET_INTERNAL_SECRET` is set.
- `CANTON_X402_TRUST_PROXY` matches the proxy in front.
- The relay never signs. Agents hold their own keys.
