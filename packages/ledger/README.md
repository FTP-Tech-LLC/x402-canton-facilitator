# @ftptech/x402-canton-ledger

Canton ledger primitives for the x402 stack: a JSON Ledger API v2 client, Ed25519 external-party signing and a Scan API client. The client, the agent wallet and the FTP facilitator use it.

## Install

```bash
npm install @ftptech/x402-canton-ledger
```

## Compatibility

Canton 3.6 participants need 0.6.2 or later. Canton 3.6 rejects the old ACS filter fields and disables `/v2/updates/transaction-by-id`; this package sends `eventFormat` and reads through `/v2/updates/update-by-id`.

## What's in here

- `CantonClient`: JSON Ledger API v2 calls with the right body shape for each endpoint. `submitAndWaitForTransaction`, `submitAndWait`, `queryActiveContracts`, `getLedgerEnd`, `getTransactionById`, `findCommandCompletions`, and `interactiveSubmissionPrepare` with `interactiveSubmissionExecute` for external-party signing.
- Bounded ACS reads for parties with more contracts than the participant lists in one response: `queryActiveContractsSlice`, `queryActiveContractsBounded`, `ACS_DEFAULT_LIST_LIMIT`.
- `CantonExternalPartySigner`, `ed25519KeyFromNodeKeyPair` and `signPreparedTransactionHash`: the agent keeps its own key and signs the prepared transaction hash.
- `recomputeHash`: recomputes a prepared transaction's hash, so a payer can check what it signs.
- `ScanClient`: AmuletRules, mining rounds, `getUpdateById`, `resolveTransferKind` and traffic status, against an SV Scan or a validator's Scan proxy.
- CIP-56 token helpers and app-reward helpers (`createX402ProviderContext`, `recordX402Payment`, `claimAppRewards`).

## Docs

[x402 on Canton](https://x402-docs.ftptech.xyz) on the FTP docs site.
