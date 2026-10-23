# @ftptech/x402-canton-ledger

Shared Canton ledger primitives used by both
`@ftptech/x402-canton-facilitator` (server side) and
`@ftptech/x402-canton-client` (payer side).

## Install

```bash
npm i @ftptech/x402-canton-ledger
```

Canton 3.6 (Splice 0.9) needs 0.6.2 or later.

## What's in here

- **`CantonClient`**: JSON Ledger API v2 wrapper. Encodes the
  documented gotchas (template id `#package:Module:Entity`, wrapped
  vs flat body shapes per endpoint, `disclosedContracts`, Daml
  `Int` as JSON string). Includes `submitAndWaitForTransaction`,
  `submitAndWait`, `queryActiveContracts` (filter in `eventFormat`),
  `queryActiveContractsSlice` (bounded `?limit=N` read),
  `getTransactionById` (through `update-by-id`), `findCommandCompletions`,
  `getLedgerEnd`, and the `interactiveSubmissionPrepare` +
  `interactiveSubmissionExecute` pair used for external-party signing.
- **ACS limits**: `queryActiveContractsBounded`, `isAcsLimitExceeded`,
  `ACS_DEFAULT_LIST_LIMIT` (200), `MAX_TRANSFER_INPUTS_AMULET` (70),
  `MAX_TRANSFER_INPUTS_REGISTRY` (90).
- **`CantonExternalPartySigner`** + `ed25519KeyFromNodeKeyPair`
  + `signPreparedTransactionHash`: Ed25519 signing over
  `/v2/interactive-submission/prepare` + `/execute`. Lets an agent hold
  its own key and authorize commands without surrendering it to a
  participant.
- **`recomputeHash`**: recomputes the Canton hash of a prepared
  transaction, so a signer or verifier can check the hash it is given.
- **`ScanClient`**: Scan API reader for AmuletRules, open and issuing
  mining rounds, updates by id, transfer-kind resolution
  (`resolveTransferKind`), transfer preapprovals and traffic status.
  Validator-proxy and SV flavors.
- **Markers**: `emitX402RoundMarker` and `x402RoundMarkerCommandId` for
  `FeaturedAppActivityMarker` emission with deduplication fields;
  `cantonErrorId` to read the Canton error id from an error body.

## Why a separate package

Facilitator-side domain wrappers (`MerchantContractService`,
`PreapprovalService`, the transfer-factory relay) live in the
facilitator because they encode its role. The lower-level Canton
plumbing here is reusable by anyone. In the `exact` scheme a payer only
signs: a client-side signer prepares and signs the
`TransferFactory_Transfer`, and the facilitator submits it.

See [CHANGELOG.md](CHANGELOG.md) for changes per version.

## Project

Source: [FTP-Tech-LLC/x402-canton-facilitator](https://github.com/FTP-Tech-LLC/x402-canton-facilitator).
