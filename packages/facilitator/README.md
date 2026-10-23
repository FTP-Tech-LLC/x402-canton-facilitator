# @ftptech/x402-canton-facilitator

Canton x402 facilitator: the server-side `/verify` and `/settle`
service that resource servers delegate payment validation and
settlement to. Implements the `exact` scheme over the JSON
Ledger API v2. The sole payment method is **`transfer-factory`**: the
payer signs a relay-prepared `TransferFactory_Transfer` (it does not
submit) and the facilitator relays it in one transaction.

Not published to npm. It ships as a Docker image built from this repo.

## Payment path

**`transfer-factory` (the only method).** Enable settlement with
`CANTON_X402_TF_ENABLED=true`. `/supported` always advertises it.

The payer signs a relay-prepared `TransferFactory_Transfer` (sender =
payer, receiver = merchant) and carries the signed transaction inline in
the payment payload. The facilitator decodes it, checks it against the
payment requirements, recomputes its hash, verifies the payer's
signature with the key from the topology reader, then **relays** it in a
**single** transaction (`ExecuteSubmission`), paying the traffic so the
payer pays none. Because the merchant holds a live `TransferPreapproval`
(self-provisioned with `canton-agent-wallet preapproval`), the transfer
resolves `direct` and pays the merchant in that one transaction. No
custody, no client-managed nonce, no custom DAR. Without a merchant
preapproval `/settle` fails with `invalid_exact_canton_preapproval_missing`.

Canton Coin works out of the box. CIP-56 registry tokens (for example
USDCx) need `CANTON_X402_TOKEN_REGISTRIES`, `_TOKEN_INSTRUMENTS` and
`_REGISTRY_TRUSTED_PARTIES`.

Optional app-reward markers: with `CANTON_X402_MARKER_ENABLED=true` a
worker emits one `FeaturedAppActivityMarker` per mining round from the
party holding the `FeaturedAppRight`, weighted by the participant's total
Global Synchronizer traffic. It emits at most once per round and clamps
the weight.

## What's in here

- Fastify server: `/verify`, `/settle`, `/supported`, `/discovery/resources`, `/health`, `/ready`, `/metrics`.
- The agent-wallet relay (`/v1/wallet/*`, off unless `CANTON_X402_ENABLE_AGENT_WALLET=true`): onboards wallets and prepares their transactions, never signs.
- `GET /v1/merchants/:party/preapproval-status`: public merchant readiness check.
- The optional marker worker.

The Canton clients live in `@ftptech/x402-canton-ledger`.

## Run

Full guide and every setting: [docs/deployment.md](../../docs/deployment.md).
LocalNet example:

```bash
PORT=4022 \
CANTON_NETWORK=canton:testnet \
CANTON_PARTICIPANT_URL=http://localhost:3975 \
CANTON_FACILITATOR_PARTY=x402_facilitator::1220... \
CANTON_SYNCHRONIZER_ID=global-domain::1220... \
CANTON_SCAN_URL=http://localhost:3903 \
DATABASE_URL=postgres://x402:x402@localhost:5432/x402 \
JWT_ISSUER=unsafe-hmac \
JWT_SECRET=unsafe \
CANTON_USER_ID=ledger-api-user \
CANTON_X402_TF_ENABLED=true \
CANTON_X402_TOPOLOGY_READER_URL=http://localhost:8099 \
CANTON_X402_TOPOLOGY_READER_TOKEN=... \
node dist/server.js
```

On LocalNet, `scripts/bootstrap-facilitator.sh` allocates the party and
grants `ledger-api-user` `CanActAs` + `CanReadAs`. For OIDC
participants, see [Party and rights](../../docs/deployment.md#party-and-rights).

## Status

FTP runs a build of this code on MainNet at `facilitator.ftptech.xyz`.
This repo is synced from the FTP canton-x402 monorepo.

Protocol spec: [`specs/scheme_exact_canton.md`](../../specs/scheme_exact_canton.md).

## Project

Canton Foundation Dev Fund [PR #78](https://github.com/canton-foundation/canton-dev-fund/pull/78).
