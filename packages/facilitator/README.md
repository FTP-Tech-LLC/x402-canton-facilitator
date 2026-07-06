# @ftptech/x402-canton-facilitator

Canton x402 facilitator: the server-side `/verify` and `/settle`
service that resource servers delegate payment validation and
settlement to. Implements the `exact` scheme over the JSON
Ledger API v2. The sole payment method is **`transfer-factory`**: the
payer signs a relay-prepared `TransferFactory_Transfer` (it does not
submit) and the facilitator relays it in one transaction.

## Payment path

**`transfer-factory` (the only method).** Enable it with
`CANTON_X402_TF_ENABLED=true` (advertise with `CANTON_X402_ADVERTISE_TF=true`).
The payer signs a relay-prepared `TransferFactory_Transfer` (sender =
payer, receiver = merchant) as an interactive submission but does **not**
submit it; it hands the payer-signed submission to the facilitator in the
payment payload. The facilitator re-verifies, then **relays** (submits)
the payer-signed transfer in a **single** transaction (`ExecuteSubmission`),
paying the GS traffic fee so the payer pays no gas. Because the merchant
holds a live `TransferPreapproval` (self-provisioned with
`canton-agent-wallet preapproval`), the transfer resolves `direct` and
pays the merchant in that one tx. No custody, no client-managed nonce, and
no custom DAR. Without a merchant preapproval the transfer would resolve
to a two-step Pending and `/settle` fail-closes with
`invalid_exact_canton_preapproval_missing`.

App-reward markers, if any, are emitted integrator-side from the
merchant's own `FeaturedAppRight`, not by the facilitator.

## What's in here

- Fastify server with `/verify`, `/settle`, `/supported`,
  `/discovery/resources`, `/health`, `/close` per the x402-foundation
  facilitator protocol contract.
- `routes/{verify,settle,common}.ts`: request handlers + the
  shared validation pipeline. `/settle` **relays** the payer-signed
  `TransferFactory_Transfer` in one transaction (`ExecuteSubmission`).
- `routes/wallet.ts`: the agent-wallet relay surface
  (`POST /v1/wallet/onboard/{prepare,finalize}`,
  `POST /v1/wallet/submit/{prepare,execute}`,
  `GET /v1/wallet/:party/{balance,pending}`,
  `POST /v1/wallet/resolve/{transfer-factory,accept}`). The relay can
  *prepare* but never *sign*; the agent holds its own key. Gated off by
  default; enable with `CANTON_X402_ENABLE_AGENT_WALLET=true` and
  optionally require an `X-Agent-Key` header via
  `CANTON_X402_AGENT_WALLET_KEY`.
- `canton/transfer-factory.ts`: domain wrapper for the transfer-factory
  path (resolve the `TransferFactory`, build/validate the transfer,
  relay the payer-signed submission).
- `canton/preapproval.ts`: facilitator-as-provider `TransferPreapproval`
  allocation — the LEGACY fallback for a merchant that delegated
  `CanActAs`; merchants normally self-provision (`canton-agent-wallet
  preapproval`). Gated by `CANTON_X402_ENABLE_PREAPPROVAL_PROVIDER`.
- `canton/merchant-contract.ts`: wrapper for the
  `MerchantContract` + `MerchantRegistrationProposal` templates
  shipped in the `canton-x402` Daml package.
- `registry/routes.ts`: `POST /v1/merchants/register`,
  `GET /v1/merchants/:party`, and
  `GET /v1/merchants/:party/preapproval-status` (read-only Scan resolve
  to detect whether a merchant already has a `TransferPreapproval`).

The underlying Canton primitives (`CantonClient`, `ScanClient`,
`CantonExternalPartySigner`, Ed25519 helpers) live in
`@ftptech/x402-canton-ledger` and are shared with `@ftptech/x402-canton-client`.
(`CantonExternalPartySigner` drives the prepare/sign/execute flow.)

## Run

```bash
PORT=4022 \
CANTON_NETWORK=canton:testnet \
CANTON_PARTICIPANT_URL=http://localhost:3975 \
CANTON_FACILITATOR_PARTY=ftp_facilitator::1220... \
CANTON_SYNCHRONIZER_ID=global-domain::1220... \
CANTON_SCAN_URL=http://localhost:3903 \
DATABASE_URL=postgres://x402:x402@localhost:5432/x402 \
JWT_ISSUER=unsafe-hmac \
JWT_SECRET=unsafe \
CANTON_USER_ID=ledger-api-user \
node dist/server.js
```

The participant party (`CANTON_FACILITATOR_PARTY`) must be
allocated and `ledger-api-user` must have `CanActAs` + `CanReadAs`
for it. Use the bootstrap script in the monorepo root:

```bash
bash scripts/bootstrap-facilitator.sh
```

For OIDC-authenticated production participants (Auth0 / Keycloak
client-credentials grant), the facilitator mints its own m2m token.
Set `JWT_ISSUER=oidc` plus the `OIDC_*` vars (token endpoint, client id,
client secret, scope) and `LEDGER_API_AUDIENCE`. See
[`ops/testnet/.env.example`](../../ops/testnet/.env.example) for the full
template.

## Status

**Live on Canton TestNet and MainNet.** The facilitator serves
`transfer-factory` as the sole advertised method: it relays each
payer-signed `TransferFactory_Transfer` in a single sponsored-gas
transaction (proven on-ledger). Full test suite green plus live e2e
scripts under [`e2e/`](../../e2e/).

See [`docs/quickstart.md`](https://github.com/sunstrike228/canton-x402/blob/main/docs/quickstart.md)
for the full demo flow (mock facilitator → real facilitator) and
[`specs/scheme_exact_canton.md`](https://github.com/sunstrike228/canton-x402/blob/main/specs/scheme_exact_canton.md)
for the protocol spec.

## Project

[github.com/sunstrike228/canton-x402](https://github.com/sunstrike228/canton-x402).
Canton Foundation Dev Fund [PR #78](https://github.com/canton-foundation/canton-dev-fund/pull/78).
