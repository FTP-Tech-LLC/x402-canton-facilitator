# Compatibility

Which runtime, Canton platform, wire protocol and package versions work with the facilitator in this repo. Re-check it before any platform upgrade.

## Runtime and toolchain

| Layer | Version |
| --- | --- |
| Node.js | 22 or later (root `engines`). The Docker image uses `node:22-alpine`. `@ftptech/canton-x402-mcp` and `@ftptech/canton-agent-wallet` need Node 20.18.1 or later (their `undici` 7 dependency) |
| Package manager | pnpm 9.12.0 (`packageManager`, installed by corepack) |
| PostgreSQL | 16 |
| Rust | 1.99.1, only in a build stage of the facilitator image |
| Daml SDK | 3.4.11, LF target 2.1, for the auxiliary DARs under `packages/daml*` and `daml/`. The money path uploads none |

## Canton and Splice

| Component | Version | Notes |
| --- | --- | --- |
| Canton participant | 3.6 works | needs `@ftptech/x402-canton-ledger` 0.6.2 or later |
| Topology reader | Splice 0.6.13 (Canton 3.5.9) to 0.7.1 | protos taken from 0.6.13, unchanged in later images |

Canton 3.6 changes this repo already handles:

- `POST /v2/state/active-contracts` rejects the top-level `filter` and `verbose` fields. Ledger 0.6.1 and later send `eventFormat`, which Canton accepts since 3.3.
- `POST /v2/updates/transaction-by-id` is disabled (3.7 removes it). Ledger 0.6.2 and later read through `POST /v2/updates/update-by-id`.

The money path uses no custom DAR. It settles through Splice token-standard interfaces and the Amulet `TransferPreapproval`, resolved at runtime by `#package-name`, so it survives Splice package upgrades without a rebuild:

| Interface or template | Used for |
| --- | --- |
| `Splice.Api.Token.TransferInstructionV1` (`TransferFactory_Transfer`) | the payment the payer signs and the facilitator relays |
| `Splice.AmuletRules:AmuletRules`, choice `AmuletRules_CreateTransferPreapproval` | the merchant's own Canton Coin preapproval |
| `Splice.AmuletRules:TransferPreapproval` | the live preapproval that pays the merchant in one transaction |
| `Splice.Amulet:Amulet` | payer holdings |

A CIP-56 registry token resolves its transfer factory and preapproval on its own registry (`CANTON_X402_TOKEN_REGISTRIES`).

## x402 wire protocol

| Property | Value |
| --- | --- |
| x402 version | 2. Headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`. The v1 `X-PAYMENT` header is not supported |
| Scheme | `exact` only |
| `assetTransferMethod` | `transfer-factory` only |
| Carriage | inline: the payload carries the signed transaction, so any facilitator can relay it |
| `requirements.extra` | `assetTransferMethod`, `feePayer`, `synchronizerId`, `instrumentId`, `executeBeforeSeconds`, optional `memo` |
| Asset | `CC`, or a CIP-56 token as `<admin>::<id>` with `extra.instrumentId` |
| Amount | atomic integer strings. 1 token = 10^10 for every instrument |
| Payment header | about 8 to 10 KiB. Servers must accept at least 16 KiB |

The upstream spec, [`specs/scheme_exact_canton.md`](../specs/scheme_exact_canton.md), covers Canton Coin. CIP-56 tokens are an extension of this facilitator.

`/supported` always advertises `transferMethods: ["transfer-factory"]` and `carriages: ["inline"]`. Settlement itself is gated by `CANTON_X402_TF_ENABLED`.

The merchant must hold a live `TransferPreapproval` for each instrument it accepts, renewed before it expires (`canton-agent-wallet preapproval` defaults to 30 days). Without it, `/settle` fails with `invalid_exact_canton_preapproval_missing`.

## Packages

All are under the `@ftptech` scope on npm, Apache-2.0. Internal dependencies use `workspace:^`, a caret range once published.

| Package | Depends on (internal) | Role |
| --- | --- | --- |
| `x402-canton-core` | none | wire types, amounts, verify-before-sign decoders |
| `x402-canton-ledger` | none | JSON Ledger API v2 and Scan client |
| `x402-canton-client` | core, ledger | payer-side `fetch` wrapper |
| `x402-canton-express` | core | merchant middleware for Express |
| `x402-canton-next` | core | merchant middleware for Next.js |
| `canton-agent-wallet` | core, client, ledger | self-custody wallet CLI and library |
| `canton-x402-mcp` | core, agent-wallet | MCP server around the wallet |

The facilitator (`@ftptech/x402-canton-facilitator`) is not on npm. It ships as a Docker image built from this repo.

### Versions that matter

| Client or merchant | With this facilitator |
| --- | --- |
| client and agent-wallet 1.0.0 or later | work (inline carriage) |
| client and agent-wallet before 1.0.0 | refused with `invalid_exact_canton_missing_proof` |
| agent-wallet 2.3.0 or later | `merge` and token holdings use `GET /v1/wallet/:party/holdings?slice=1` |
| agent-wallet `tc` (Tradecraft queued mode) | only with `CANTON_X402_WALLET_SUBMIT_CHOICES`, `_SUBMIT_CREATE_TEMPLATES` and `_READ_IDS` set |
| express before 0.2.9, next before 0.2.8 | need `CANTON_X402_SETTLE_ANSWERS=legacy`: their retry of the same payment depends on the legacy answers |

## JSON Ledger API v2 surface

| Endpoint | Used for |
| --- | --- |
| `/v2/state/ledger-end` | before an execute; readiness |
| `/v2/state/active-contracts` | holdings, preapprovals, fee inputs; `eventFormat` filter, `?limit=N` slices |
| `/v2/interactive-submission/prepare` | relay pay, submit and self-preapproval prepare |
| `/v2/interactive-submission/execute` | the settle relay and relay execute; requires `deduplicationPeriod` |
| `/v2/updates/update-by-id` | the settle check that funds moved, in the requesting party's projection |
| `/v2/updates` | the relay's Tradecraft fills feed, `/v1/wallet/:party/updates` |
| `/v2/events/events-by-contract-id` | relay reads of registry holdings beyond the first slice |
| `/v2/commands/submit-and-wait-for-transaction` | markers, the faucet, the legacy merchant registry and provider preapproval |
| `/v2/commands/completions` | a marker's outcome after a lost answer |
| `/v2/parties/external/generate-topology`, `/v2/parties/external/allocate` | relay onboarding |
| `/v2/users/{id}/rights` | relay onboarding grants |

Run the ledger API checklist in [MAINTENANCE-PLAYBOOK.md](MAINTENANCE-PLAYBOOK.md) before any participant upgrade.

## Upgrade policy

- Published packages follow semver.
- `@canton-network/core-tx-visualizer` is tilde-pinned (`~1.4.0`) in `ledger` and `agent-wallet`: patch updates only.
- The money path binds Splice interfaces by `#package-name`. Re-check only if a bound interface or choice signature changes.
- A scheme name or envelope field change is breaking: a major bump of `core` and a coordinated facilitator redeploy.
