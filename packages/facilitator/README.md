# @ftptech/x402-canton-facilitator

Canton x402 facilitator: the `/verify` and `/settle` service a merchant's middleware calls. It implements the `exact` scheme with one method, `transfer-factory`. The payer signs a relay-prepared `TransferFactory_Transfer` and carries it inline in the payment. The facilitator checks it and relays it in one transaction, paying the traffic.

It is not published to npm. It ships as a Docker image built from this repo.

## How a payment settles

- `/verify` decodes the signed transaction, checks it against the payment requirements, recomputes its hash and verifies the payer's signature. The payer's key comes from a topology reader beside the participant.
- `/settle` relays the transaction (`ExecuteSubmission`) and pays the Global Synchronizer traffic, so the payer pays none. There is no custody, no nonce and no custom DAR.
- The merchant holds a live `TransferPreapproval` (`canton-agent-wallet preapproval`), so the transfer pays the merchant in that one transaction. Without one, `/settle` fails with `invalid_exact_canton_preapproval_missing`.
- A repeat of a settled payment is answered from the facilitator's record and never relayed twice. When the outcome of a relayed payment is not known yet, `/settle` answers `settlement_pending` (with `legacy` answers, `settle_outcome_unknown`); the merchant retries with the same payment.

Canton Coin works out of the box. A CIP-56 registry token needs `CANTON_X402_TOKEN_REGISTRIES` and `CANTON_X402_REGISTRY_TRUSTED_PARTIES`; `CANTON_X402_TOKEN_INSTRUMENTS` adds its id and symbol to `/supported`.

## What's in here

- Fastify server: `/verify`, `/settle`, `/supported`, `/discovery/resources`, `/health`, `/ready`, `/metrics`.
- The agent-wallet relay, `/v1/wallet/*`, off unless `CANTON_X402_ENABLE_AGENT_WALLET=true`. It onboards wallets and prepares their transactions. It never signs. Per-party reads carry an `X-Canton-Read-Proof` signature; `CANTON_X402_WALLET_READ_PROOF` (`off`, `observe` by default, `enforce`) sets whether a missing or bad proof is only counted or refused.
- `GET /v1/merchants/:party/preapproval-status`: a public check that a merchant can be paid.
- Optional workers: traffic attribution per payment, and app-reward markers (`CANTON_X402_MARKER_ENABLED=true`), one `FeaturedAppActivityMarker` per mining round weighted by the participant's traffic.

The Canton clients live in `@ftptech/x402-canton-ledger`.

## Run

The steps are in [docs/deployment.md](../../docs/deployment.md). Every setting is in the annotated `.env.example` and `docker-compose.yml` of [`ops/mainnet-standalone/`](../../ops/mainnet-standalone/). A LocalNet example:

```bash
PORT=4022 \
CANTON_NETWORK=canton:testnet \
CANTON_PARTICIPANT_URL=http://localhost:3975 \
CANTON_FACILITATOR_PARTY=x402_facilitator::1220... \
CANTON_SYNCHRONIZER_ID=global-domain::1220... \
CANTON_SCAN_URL=http://localhost:3903 \
DATABASE_URL=postgres://x402:x402@localhost:5432/x402 \
JWT_ISSUER=unsafe-hmac JWT_SECRET=unsafe CANTON_USER_ID=ledger-api-user \
CANTON_X402_TF_ENABLED=true \
CANTON_X402_TOPOLOGY_READER_URL=http://localhost:8099 \
CANTON_X402_TOPOLOGY_READER_TOKEN=... \
node dist/server.js
```

- `CANTON_X402_TF_ENABLED=true` turns settlement on. It is off by default.
- Without the topology reader URL and token, every payment is refused.
- On LocalNet, `scripts/bootstrap-facilitator.sh` allocates the party and grants `ledger-api-user` `CanActAs` and `CanReadAs`. For OIDC participants see [Party and rights](../../docs/deployment.md#party-and-rights).

## Status

FTP runs this code on MainNet at `facilitator.ftptech.xyz`. Protocol spec: [`specs/scheme_exact_canton.md`](../../specs/scheme_exact_canton.md). Canton Foundation Dev Fund [PR #78](https://github.com/canton-foundation/canton-dev-fund/pull/78).
