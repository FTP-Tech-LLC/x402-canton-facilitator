# Compatibility Matrix

What versions of the runtime, the Canton platform, the x402 wire
protocol, and the published packages work with the facilitator in this
repo. Re-check it before any platform upgrade.

Snapshot date: 2026-10-23. Code: core 1.4.0, ledger 0.6.2, facilitator
0.0.12.

## 1. Runtime and toolchain

| Layer | Required |
|---|---|
| Node.js | `>=22` (root `engines`); the Docker image uses `node:22-alpine` |
| Package manager | pnpm 9.12.0 (`packageManager`, installed by corepack) |
| PostgreSQL | 16.x |
| TypeScript | 5.x |
| Test runner | vitest 2.1 |
| Lint | eslint 9 / typescript-eslint 8, `--max-warnings 0` |

## 2. Canton platform and Splice

| Component | Version | Notes |
|---|---|---|
| Canton participant | 3.6 (Splice 0.9.x) | needs ledger 0.6.2 or later, included here. On an older line, run the checklist in the playbook first |
| Splice Scan | 0.9.x | Splice 0.9 removed Scan v0/v1 `holdings/state`; the relay reads v2 |
| Topology reader route | Canton 3.5.10 / Splice 0.6.14 or later | older participants return no keys, so every payment is refused |

Canton 3.6 changes this repo already handles:

- `POST /v2/state/active-contracts` rejects the top-level `filter` and
  `verbose` fields. Ledger 0.6.1+ sends `eventFormat`, which Canton
  accepts since 3.3.
- `POST /v2/updates/transaction-by-id` is disabled (3.7 removes it).
  Ledger 0.6.2 reads through `POST /v2/updates/update-by-id`.

### Daml packages

The money path uses **no custom DAR**. It settles through Splice
token-standard interfaces plus the Amulet `TransferPreapproval`, resolved
at runtime by `#package-name`, so it survives Splice package upgrades
without a rebuild.

| Interface (via `#package-name`) | Used for |
|---|---|
| `Splice.Api.Token.TransferInstructionV1` (`TransferFactory_Transfer`) | the payment the payer signs and the facilitator relays |
| `Splice.AmuletRules:AmuletRules`, choice `AmuletRules_CreateTransferPreapproval` | merchant self-provisioned Canton Coin preapproval |
| `Splice.Amulet:Amulet` | payer holdings |
| `Splice.AmuletRules:TransferPreapproval` | the live merchant preapproval that makes the transfer resolve `direct` |

CIP-56 registry tokens resolve their transfer factory and preapproval on
the token's registry (`CANTON_X402_TOKEN_REGISTRIES`).

## 3. x402 wire protocol

| Property | Value |
|---|---|
| x402 version | 2. Headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`. The v1 `X-PAYMENT` header is not supported |
| Scheme | `exact` (only) |
| `assetTransferMethod` | `transfer-factory` (only) |
| `requirements.extra` | `assetTransferMethod`, `feePayer`, `synchronizerId`, `instrumentId`, `executeBeforeSeconds`, `memo` (optional) |
| `payload` | `assetTransferMethod`, `preparedTransaction` (base64 gzip), `preparedTxHash`, `signature`, `hashingSchemeVersion`. No `payer`: the facilitator reads it from the signed transaction |
| Asset | `CC`, or a CIP-56 token as `<admin>::<id>` with `extra.instrumentId` |
| Amount encoding | atomic integer strings; 1 token = 10^10 for every instrument |
| Payment header size | about 8 to 10 KiB; servers must accept at least 16 KiB |

The upstream spec ([`specs/scheme_exact_canton.md`](../specs/scheme_exact_canton.md),
merged in x402-foundation/x402) covers Canton Coin. CIP-56 tokens are an
extension of this facilitator.

### Breaking boundaries

| Change | Date | Package boundary |
|---|---|---|
| scheme `exact-canton` renamed to `exact` | 2026-06-29 | core/client 0.3.0 |
| `allocation-direct`, `external-party-amulet-rules`, `cip56-transfer-factory` removed | 2026-07-05 | |
| `payload.payer` removed | 2026-07-09 | |
| stash carriage (`submissionRef`, `pay/commit`) removed; inline only | 2026-08-23 | core, client, agent-wallet 1.0.0 |

## 4. Payment method

The facilitator speaks one method: **`transfer-factory`**. The payer
signs a relay-prepared `TransferFactory_Transfer` (sender = payer,
receiver = merchant) and carries the signed transaction in the payload.
The facilitator verifies it and relays it in one transaction
(`ExecuteSubmission`), paying the traffic. No nonce: replay is blocked
because the input holdings are consumed, and `executeBefore` bounds the
signature's life.

The merchant MUST hold a live `TransferPreapproval` per instrument it
accepts, renewed before expiry (`canton-agent-wallet preapproval`
defaults to 30 days). Without it `/settle` fails with
`invalid_exact_canton_preapproval_missing`.

`/supported` always advertises `["transfer-factory"]` and
`carriages: ["inline"]`. Settlement itself is gated by
`CANTON_X402_TF_ENABLED`. `CANTON_X402_ADVERTISE_TF` has no effect.

## 5. Networks

| Network | Auth | Faucet |
|---|---|---|
| LocalNet | unsafe HMAC | env-gated |
| DevNet | OIDC | env-gated |
| TestNet | OIDC | env-gated |
| MainNet | OIDC | env-gated; keep the claim route behind `CANTON_X402_FAUCET_INTERNAL_SECRET` |

The faucet is one feature (`CANTON_X402_FAUCET_ENABLED`, default off) on
any network, not a per-network branch.

## 6. Packages

All under the `@ftptech` scope on npm, Apache-2.0. Versions as published
on 2026-10-23.

| Package | npm | Depends on (internal) | Role |
|---|---|---|---|
| `x402-canton-core` | 1.4.0 | (none) | wire types, amounts, verify-before-sign decoders (in this repo) |
| `x402-canton-ledger` | 0.6.2 | (none) | JSON Ledger API v2 + Scan client (in this repo) |
| `x402-canton-client` | 1.2.2 | core ^1.4.0, ledger ^0.6.0 | buyer-side payment scheme |
| `x402-canton-express` | 0.2.6 | core ^1.2.0 | merchant middleware for Express |
| `x402-canton-next` | 0.2.6 | core ^1.2.0 | merchant middleware for Next.js |
| `canton-agent-wallet` | 2.4.0 | core, client, ledger | self-custody wallet CLI |
| `canton-x402-mcp` | 2.3.0 | agent-wallet | MCP server wrapping the wallet |

The facilitator (`@ftptech/x402-canton-facilitator`) is not on npm. It
ships as a Docker image built from this repo. Its third-party pins:
`fastify ^5.1.0`, `pg ^8.21.0`, `undici ^7.1.0`, `pino ^9.5.0`,
`prom-client ^15.1.3`.

### Client to facilitator

| Client | Works with this facilitator |
|---|---|
| client, agent-wallet 1.0.0 or later | yes (inline carriage) |
| client, agent-wallet before 1.0.0 | no: `invalid_exact_canton_missing_proof` |
| core/client before 0.3.0 (`exact-canton`) | no |
| agent-wallet 2.3.0 or later, `merge` and token holdings | yes; uses `GET /v1/wallet/:party/holdings?slice=1` |
| agent-wallet 2.4.0 `tc` (Tradecraft queued mode) | only with `CANTON_X402_WALLET_SUBMIT_CHOICES`, `_SUBMIT_CREATE_TEMPLATES` and `_READ_IDS` set |

The middleware packages (`express`, `next`) follow the `exact` boundary
through `core`.

## 7. JSON Ledger API v2 surface

| Endpoint | Note | Used for |
|---|---|---|
| `/v2/state/ledger-end` | offset read | before an execute; readiness |
| `/v2/state/active-contracts` | `eventFormat` filter by template or interface; `?limit=N` slices | holdings, preapprovals, fee inputs |
| `/v2/interactive-submission/prepare` | | relay pay, submit and self-preapproval prepare |
| `/v2/interactive-submission/execute` | requires `deduplicationPeriod` | settle relay; relay execute |
| `/v2/updates/update-by-id` | the requesting party's projection | the settle funds-moved check |
| `/v2/commands/submit-and-wait-for-transaction` | wrapped `{commands: {...}}` | markers; legacy provider preapproval |
| `/v2/commands/completions` | | marker outcome after a lost answer |
| `/v2/parties/external/{generate-topology,allocate}` | | relay onboarding |
| `/v2/users/{id}/rights` | | relay onboarding grants |

Scan reads: AmuletRules and mining rounds (`/api/scan/v0`, POST on SV
Scans), transfer preapprovals by party, the token-standard transfer
factory, and `/api/scan/v2/holdings/state` for the relay's
`holdings-scan`.

Run the ledger-API checklist in
[MAINTENANCE-PLAYBOOK.md](MAINTENANCE-PLAYBOOK.md) before any
participant upgrade.

## 8. Support and upgrade policy

- Published packages follow semver. Internal dependencies use
  `workspace:^` (a caret range at publish).
- `@canton-network/core-tx-visualizer` is tilde-pinned (`~1.4.0`) in
  `ledger`: patch drift only.
- The money path binds Splice interfaces by `#package-name`. Re-check
  only if a bound interface or choice signature changes.
- A scheme-name or envelope-field change is breaking: a major bump of
  `core` and a coordinated facilitator redeploy.
