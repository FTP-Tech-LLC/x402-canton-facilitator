# @ftptech/x402-canton-ledger

Shared Canton ledger primitives used by both
`@ftptech/x402-canton-facilitator` (server side) and
`@ftptech/x402-canton-client` (payer side).

## Install

```bash
npm i @ftptech/x402-canton-ledger
```

> Note: the `@ftp` npm scope is not final and may change before the
> first public release (see [`docs/PUBLISHING.md`](https://github.com/sunstrike228/canton-x402/blob/main/docs/PUBLISHING.md)).
> Pin the version you install and check the README for the current
> package name.

## What's in here

- **`CantonClient`**: JSON Ledger API v2 wrapper. Encodes the
  documented gotchas (template id `#package:Module:Entity`, wrapped
  vs flat body shapes per endpoint, `disclosedContracts`, Daml
  `Int` as JSON string). Includes `submitAndWaitForTransaction`,
  `submitAndWait`, `queryActiveContracts`, `getLedgerEnd`, and the
  `interactiveSubmissionPrepare` + `interactiveSubmissionExecute`
  pair used for external-party signing.
- **`CantonExternalPartySigner`** + `ed25519KeyFromNodeKeyPair`
  + `signPreparedTransactionHash`: Ed25519 signing primitives over
  `/v2/interactive-submission/prepare` + `/execute`. Lets an agent
  hold its own key and authorize commands without surrendering it
  to a participant.
- **`ScanClient`**: Scan API reader for AmuletRules,
  open-and-issuing mining rounds, completed transfers via
  `getUpdateById`, transfer-kind resolution (`resolveTransferKind`),
  and traffic-status. Validator-proxy + SV-direct flavors.

## Why a separate package

Facilitator-side domain wrappers (`Cip56InstructionService`,
`MerchantContractService`, `PreapprovalService`) live in
`@ftptech/x402-canton-facilitator` because they encode the facilitator's
role (Scan-read verify, MerchantContract template, preapproval
provider). The lower-level Canton plumbing in this package is reusable
by anyone, including the client SDK's `Cip56KeyfileSigner`, which uses
`CantonExternalPartySigner` to submit a `TransferFactory_Transfer` from
the agent's own participant.

## Project

[github.com/sunstrike228/canton-x402](https://github.com/sunstrike228/canton-x402).
