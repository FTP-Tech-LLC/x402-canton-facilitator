# Facilitator deployment

How to stand up the Canton x402 facilitator, the `/verify` and `/settle` service that merchants' middleware calls. It is a Fastify process with a Postgres database, shipped as a Docker image under Apache-2.0. Every setting, with a comment, is in the annotated [`ops/mainnet-standalone/.env.example`](../ops/mainnet-standalone/.env.example) and its [`docker-compose.yml`](../ops/mainnet-standalone/docker-compose.yml).

Protocol: [`specs/scheme_exact_canton.md`](../specs/scheme_exact_canton.md). Versions: [COMPATIBILITY.md](COMPATIBILITY.md). Upgrades and incidents: [MAINTENANCE-PLAYBOOK.md](MAINTENANCE-PLAYBOOK.md).

## What you need

- A Canton participant you operate, reachable over the JSON Ledger API v2, on DevNet, TestNet or MainNet. It needs Global Synchronizer traffic: the facilitator pays the traffic of every payment it relays.
- A facilitator party on it and a ledger user with the rights below.
- A topology reader beside the participant.
- An SV Scan URL for the network. MainNet SV Scans admit only allowlisted IPs.
- Postgres 16.
- OIDC client credentials (Auth0, Keycloak) for the participant. Unsafe HMAC is for LocalNet only.

There is no custom DAR to upload: payments settle through Splice token-standard interfaces and the Amulet `TransferPreapproval`.

## Party and rights

The ledger user the facilitator authenticates as (`CANTON_USER_ID`; set it explicitly: the code and the bootstrap script default to `ledger-api-user`, each compose to its own id) needs `CanActAs` and `CanReadAs` on the facilitator party. With the agent-wallet relay on, it also needs `ParticipantAdmin` to allocate wallets, and the relay grants it `CanActAs` on each new wallet. Those grants count against the participant's 1000 rights per user. For a busy relay, give the user `CanReadAsAnyParty` and `CanExecuteAsAnyParty` instead and set `CANTON_GRANT_PARTY_RIGHTS=false`.

- LocalNet: `bash scripts/bootstrap-facilitator.sh` allocates the party and grants the rights. It is idempotent.
- OIDC participant: with an admin (`ParticipantAdmin`) token, allocate the party with `POST /v2/parties` and grant the rights with `POST /v2/users/<CANTON_USER_ID>/rights`. The bootstrap script shows both request bodies. Create the user first with `POST /v2/users` if it does not exist.

The user id must be the OIDC token's `sub`, with Auth0 usually `<client id>@clients`. Put the party id in `CANTON_FACILITATOR_PARTY`.

## Topology reader

The facilitator checks the payer's signature against the payer's key in Canton topology. Only the participant's admin gRPC API can read that key, and that API is unauthenticated and also carries repair services, so the facilitator does not get it. A small reader (`packages/topology-reader`, compose in `ops/topology-reader/`) runs beside the participant and serves `GET /v1/party/<party id>/signing-keys` behind a bearer token.

- Its protos come from the Splice 0.6.13 participant image (Canton 3.5.9) and are the same through Splice 0.7.1.
- Publish it on a private interface only.

## Configure

Copy the template and fill it in. The facilitator refuses to start without the network, participant URL, facilitator party, synchronizer id and Scan URL. Set `DATABASE_URL` as well (the composes build it from `POSTGRES_PASSWORD`): without it the settle records live in memory and a restart loses them. On MainNet the synchronizer id is `global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc`; on any network an SV Scan returns it as `amulet_rules_update.domain_id` from `POST /api/scan/v0/amulet-rules`.

Payments fail when one of these is wrong, so check each:

- **Settlement:** `CANTON_X402_TF_ENABLED=true`. It is off by default, and then `/settle` refuses every payment.
- **Topology reader:** `CANTON_X402_TOPOLOGY_READER_URL` and `CANTON_X402_TOPOLOGY_READER_TOKEN`. If either is unset, every payment fails with `invalid_exact_canton_signature_invalid`.
- **OIDC:** `JWT_ISSUER=oidc` with `OIDC_TOKEN_ENDPOINT`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `LEDGER_API_AUDIENCE`, for the user that holds the rights above. The boot fails if one is missing.
- **Settle answers:** `CANTON_X402_SETTLE_ANSWERS` defaults to `spec`. Under `spec` the dispatch mark defaults to `enforce`, and the facilitator refuses to start if `CANTON_X402_SETTLE_DISPATCH_MARK` is `off` or `observe`. Merchants on express older than 0.2.9 or next older than 0.2.8 need `legacy`. The `ops/mainnet-standalone` template sets `spec` with the mark `enforce`.
- **Merchant policy:** `CANTON_X402_INLINE_MERCHANT_POLICY` (default `open`) sets which merchants the facilitator pays traffic for. Do not run bare `provider`: a merchant's own preapproval names the merchant as provider, so most honest payments would be refused.
- **Token registries:** Canton Coin needs nothing. A CIP-56 token needs its registry URL in `CANTON_X402_TOKEN_REGISTRIES`, or the facilitator settles Canton Coin only, and the registry's own parties in `CANTON_X402_REGISTRY_TRUSTED_PARTIES`, or its transfers are refused. `CANTON_X402_TOKEN_INSTRUMENTS` adds the token's id and symbol to `/supported`.

The rest (rate limits, the agent-wallet relay and its read proofs, the faucet, attribution, markers, a second participant) has defaults or is off. See the template and the compose.

## Run

| Compose | Layout |
| --- | --- |
| `packages/facilitator/docker-compose.production.yml` | builds the image; facilitator and Postgres on one host, port 4022 on localhost |
| `ops/testnet/`, `ops/devnet/` | prebuilt image on the validator host, on the validator's Docker network |
| `ops/mainnet-standalone/` | prebuilt image on a dedicated host with Caddy TLS; the participant over a private link |

On a dedicated host:

```bash
cd ops/mainnet-standalone
cp .env.example .env    # fill it in
docker build -f ../../packages/facilitator/Dockerfile -t canton-x402-facilitator:<tag> ../..
docker compose up -d
```

With the production compose, put the `.env`, including `POSTGRES_PASSWORD`, in `packages/facilitator/` and run `docker compose -f packages/facilitator/docker-compose.production.yml up -d --build`. Without Docker, run `pnpm install --frozen-lockfile && pnpm build`, then `node packages/facilitator/dist/server.js` with the same environment.

The `ops/` composes set `stop_grace_period: 70s`; set it in the production compose too. A `/settle` can wait about a minute on the ledger, and a shorter stop can cut a payment off midway.

## Reverse proxy

The container serves plain HTTP on port 4022. Terminate TLS in front of it; the `ops/mainnet-standalone` Caddyfile does.

- Public: `/verify`, `/settle`, `/supported`, `/discovery/resources`, `/health`, `/v1/merchants/:party/preapproval-status`, and `/v1/wallet/*` when the relay is on.
- Private: `/metrics` and `/ready`.
- Accept request headers of at least 16 KiB: a payment header is about 8 to 10 KiB.
- Rate limits key on the client IP. Set `CANTON_X402_TRUST_PROXY` to match the proxy, `uniquelocal` when it reaches the container over Docker networking.
- Wallets sign the host and the full path of each relay read (`X-Canton-Read-Proof`). Pass the original `Host` and keep any path prefix, or a relay with `CANTON_X402_WALLET_READ_PROOF=enforce` refuses those reads. The default, `observe`, only counts them.

## Check the deploy

1. `docker compose exec facilitator wget -qO- http://127.0.0.1:4022/ready` (with the production compose, `curl http://127.0.0.1:4022/ready` on the host) answers 200 with `"ready": true`. A failing check is named: `token`, `participant` or `scan`. A wrong Scan setting still passes `/health` and `/supported`, so trust `/ready`.
2. `curl https://<your host>/supported` shows your network, your party as `feePayer`, the synchronizer id and the configured tokens under `instruments`.
3. For a merchant you serve, `GET /v1/merchants/<party>/preapproval-status?admin=<DSO party>` answers `hasPreapproval: true`.
4. Make one live payment through that merchant. The paid response carries `PAYMENT-RESPONSE` with a `transaction`.

## Security checklist

- Secrets live only in `.env`, never in the repo, the image or the logs.
- The facilitator binds to localhost or an internal network, and the proxy is the only way in. Do not publish port 4022 on `0.0.0.0` on MainNet.
- The participant's ledger and admin APIs and the topology reader are reachable only on a private network. Postgres has no published port.
- Passwords, client secrets and tokens are long and random.
- `/metrics` and `/ready` are private. `POST /close` (`CANTON_X402_ENABLE_CLOSE_ROUTE`) stays off.
- With the faucet on, `CANTON_X402_FAUCET_INTERNAL_SECRET` is set.
- The relay never signs. Agents hold their own keys.

## Upgrades and rollback

See [MAINTENANCE-PLAYBOOK.md](MAINTENANCE-PLAYBOOK.md). In short: build a tagged image, `docker compose up -d` it, confirm `/ready` and one live payment, and keep the previous `.env` and image tag so a rollback is a one-line revert.
