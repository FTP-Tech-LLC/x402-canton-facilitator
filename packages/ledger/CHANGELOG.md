# @ftptech/x402-canton-ledger

## 0.6.5

### Patch Changes

- d418335: `recomputeHash` refuses a transaction that takes more than 100,000 hashing steps (strings, list and record elements, parts of dotted names, identifiers) or nests deeper than 1,024 object levels, with `PreparedTransactionBudgetError`, which is also a `PreparedTransactionGraphError`. The hasher blocks the event loop for about 2 to 5 µs a step, so a transaction stuffed with dotted names could hold it for seconds. It also refuses more node seeds than nodes. Real transactions take at most about 8,000 steps and 45 levels. Pass `{ maxSteps }` to set another budget.

## 0.6.4

### Patch Changes

- fb3fec7: `recomputeHash` checks the node graph before hashing. It throws the new `PreparedTransactionGraphError` when a node is reached twice, a child is missing, a node id repeats, or the transaction is over `MAX_HASHED_NODES` (10,000 nodes) or `MAX_HASHED_NODE_DEPTH` (100 levels). A cycle used to send the hasher into endless recursion, and a shared child made it hash a subtree once per path. The limits match `@canton-network/core-tx-hashing`.

## 0.6.3

### Patch Changes

- `CantonClient.getUpdatesPage` reads one bounded page of `/v2/updates` in the
  ledger-effects shape and refuses any row or event it cannot read, so a
  caller's cursor never moves past one. `CreatedEvent` and the new
  `LedgerExercisedEvent` carry the participant's `acsDelta`.

## 0.6.2

### Patch Changes

- `getTransactionById` reads through `POST /v2/updates/update-by-id` in both
  modes. Canton 3.6 disables `POST /v2/updates/transaction-by-id`
  (DEPRECATED_API_DISABLED; 3.7 removes it). The default narrow projection —
  each requesting party's own creates and archives, no exercises — is now the
  `TRANSACTION_SHAPE_ACS_DELTA` shape with a wildcard filter per party;
  `fullEffects` keeps `TRANSACTION_SHAPE_LEDGER_EFFECTS`.

## 0.6.1

### Patch Changes

- 6fa7337: `queryActiveContracts` / `queryActiveContractsSlice` send the filter inside
  `eventFormat` instead of the deprecated top-level `filter` + `verbose`. Canton
  3.6 rejects those fields with HTTP 400 unless the participant enables
  `features.deprecated.enable-deprecated-parameters-34`, and 3.7 removes them;
  `eventFormat` is accepted since Canton 3.3, so older participants read it too.

## 0.6.0

### Minor Changes

- 7fa848e: Marker emission can no longer double-count a round when a submit's answer is lost.

  - `emitX402RoundMarker` takes an optional `submissionId` and `deduplicationOffset`; `x402RoundMarkerCommandId` exposes its commandId.
  - `JsCommandsBody` accepts `submissionId` and `deduplicationPeriod`.
  - New `CantonClient.findCommandCompletions` (every completion for a commandId after an offset) and `cantonErrorId` (the Canton error id from a JSON Ledger API error body, needed because 409 covers both "already committed" and "still in flight").

## 0.5.1

### Patch Changes

- 137b4c5: ledger: `queryActiveContractsBounded(client, filter, limit?)` — one bounded ACS read (the slice when the client has it, else the plain read) instead of "plain read, then a slice after its 413"; `isAcsLimitExceeded(err)`; the shared limits `ACS_DEFAULT_LIST_LIMIT` (200), `MAX_TRANSFER_INPUTS_AMULET` (70) and `MAX_TRANSFER_INPUTS_REGISTRY` (90). `CantonClient.queryActiveContractsSlice` remembers a lower cap the node named, for the life of that client, so later slices are not refused again (a node cap raised later is picked up by a new client). `CantonClient.getEventsByContractId` takes `interfaceViews` to read a contract through those interfaces, views included.

## 0.5.0

### Minor Changes

- d9cd495: ledger: `CantonClient.queryActiveContractsSlice(filter, limit)` — a bounded ACS read (`?limit=N`) for parties with more contracts than the participant lists in one response; reports `complete` and retries once at the cap the node names.

  core: `assertPreparedAmuletSelfPreapproval` — full verify-before-sign for a merchant's Amulet self-preapproval: root template pinned, consequences and creates whitelisted from MainNet captures, receiver/provider/expiry bound, party backstop of {merchant, DSO}.
