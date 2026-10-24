# @ftptech/x402-canton-core

## 1.4.0

### Minor Changes

- 068b32d: Tradecraft queued mode: trade through committed allocations and batched orders
  instead of a pool-address transfer. The wallet's new `tc` command (`setup`,
  `orders`, `status`, `cancel`, `withdraw`) and the local MCP's `tradecraft_queued_*`
  tools create a SwapOrderBatcher and one committed token-standard V2 allocation
  per pool instrument (topped up on later setups), queue exact-input orders with
  per-order minimums in one transaction, and ask the venue to release funded
  allocations back to the wallet.
  Core adds verify-before-sign for the six shapes: the venue is the sole
  executor, every allocation and holding they create is the agent's, pool
  metadata, amounts and minimums are pinned, and the withdrawal request (the
  only create the agent authorizes alone) is pinned to Tradecraft's package.
  Needs a relay with the queued surface enabled (see the facilitator's
  `CANTON_X402_WALLET_SUBMIT_CREATE_TEMPLATES` and `CANTON_X402_WALLET_READ_IDS`).
  Pool-address swaps are unchanged.

## 1.3.1

### Patch Changes

- 0668ea1: CBTC transfers sign again. BitSafe replaced CBTC's reward beneficiary
  (`cbtc-beneficiary` → `cbtc-beneficiary-2`) in its `InstrumentConfiguration`,
  and verify-before-sign refused every CBTC transfer as naming an unexpected
  party. The foreign-party backstop now admits the parties of the pinned
  registrar's own `InstrumentConfiguration` (the input contract signed by the
  instrument admin) inside that contract only, so a registrar changing its
  reward beneficiaries or credential issuers no longer breaks its token. Such a
  party anywhere else, and every party of an unpinned or other registrar's
  configuration, is still refused. Canton Coin is unaffected. The wallet drops
  its hard-coded `cbtc-beneficiary` entry, which the rule replaces.

## 1.3.0

### Minor Changes

- d9cd495: ledger: `CantonClient.queryActiveContractsSlice(filter, limit)` — a bounded ACS read (`?limit=N`) for parties with more contracts than the participant lists in one response; reports `complete` and retries once at the cap the node names.

  core: `assertPreparedAmuletSelfPreapproval` — full verify-before-sign for a merchant's Amulet self-preapproval: root template pinned, consequences and creates whitelisted from MainNet captures, receiver/provider/expiry bound, party backstop of {merchant, DSO}.

## 1.2.1

### Patch Changes

- verify-before-sign admits `EventLog_HoldingsChange` on the DA Registry Utility
  `Holding` template. After the registry-utility 0.14.4 bundle (holding-v0 0.3.2)
  every registry-token transfer emits this token-standard accounting event on the
  registrar's Holding, and the whitelist refused to sign every registry send
  (token→CC swaps, registry withdrawals, USDCx/CBTC x402 payments) with
  `unexpected exercise(s) "EventLog_HoldingsChange"`. Inspected on real MainNet
  prepared bytes: the node is a leaf with no creates, archives or nested
  exercises, so admitting it cannot move or re-own funds; amount, receiver,
  instrument, inputs and every create stay pinned exactly as before.

## 1.2.0

### Minor Changes

- Verify-before-sign learns the shapes a Tradecraft swap needs, and pins who owns
  what a transfer creates.

  - `allowRegistryOffer` (opt-in, never inferred from the relay) admits the DA
    Registry Utility two-step offer shape — `AllocationFactory_TransferInternal`
    plus exactly one `TransferOffer` create — which is how a registry transfer to a
    receiver with no preapproval settles, and therefore how a swap to a pool
    settles. Callers that do not opt in keep the strict behaviour byte for byte.
  - A party minted under a TRUSTED instrument admin's key-fingerprint namespace is
    admitted alongside the enumerated trusted parties. Registrars operate their
    tokens through such parties (onRails puts per-user identities inside otherwise
    ordinary holdings), and a relay cannot forge one.
  - Ownership is pinned separately from that trust: every registry `Holding` a
    transfer creates is either the receiver's delivery or the sender's change, and
    must name one of them. Without this the namespace admission alone would let a
    relay re-own the sender's change — everything the transfer did not send.
  - The accept path admits the value-less `ExecutedTransfer` receipt some registrar
    versions create, without relaxing the owner pin on the holding beside it.

  The merchant SDK READMEs document the payment header's real size: a server must
  accept at least 16 KiB end to end.

## 1.1.0

### Minor Changes

- f8d2c33: Verify-before-sign admits a DA Registry Utility SELF-transfer — the `merge`
  shape for a CIP-56 token such as USDCx. The registry settles a self-transfer
  through `AllocationFactory_TransferInternal` (pinned to the registrar's
  `AllocationFactory`), which is also the delivery node of its two-step
  pending-offer shape, so the rule is consulted only when the caller intends a
  self-transfer (sender == receiver, proven against the signed bytes) and only
  when every create in the tree is the registry `Holding` template. A foreign
  receiver never reaches the rule; a pending-offer create under a self receiver is
  refused. No existing shape changes — the general consequence whitelist is
  byte-identical.

## 1.0.0

### Major Changes

- 6428700: Remove the legacy stash (`submissionRef`) carriage — inline is now the only carriage.

  BREAKING: a `transfer-factory` payment carries the payer-signed transaction
  INLINE (`preparedTransaction` + `preparedTxHash` + `signature`), so any
  facilitator can relay it. The `submissionRef` pointer form, the two-call
  `pay/prepare` + `pay/commit` relay dance, and the server-side `tf_stash` table
  are gone. This is the shape upstream x402-foundation adopted, and it serves both
  Canton Coin and any CIP-56 registry token (they differ only by
  `instrumentId.admin`).

  - core: `CantonPaymentPayload` is now `CantonInlinePayload` only
    (`CantonSubmissionRefPayload` removed); `SupportedResponse.extra.carriages` is
    `["inline"]`; the now-unreachable error codes
    `invalid_exact_canton_submission_not_found` and
    `invalid_exact_canton_signature` are removed.
  - client: `SignedTransferFactory` no longer carries `submissionRef`; a
    `CantonSigner.signTransferFactory` MUST return the inline bundle
    (`preparedTransactionBytes` + `signatureB64`), and `ExactCantonScheme` emits
    only the inline payload.

  Clients that defaulted to the stash carriage stop working: upgrade to a client
  that emits the inline payload. The facilitator (`/settle` accepts inline only,
  `pay/commit` removed) and `@ftptech/canton-agent-wallet` (inline is the sole
  signer path) carry the same breaking change; they are versioned outside
  changesets and must take a matching major bump.

## 0.7.1

### Patch Changes

- Ship the fixes the registry never got.

  Four packages carried changed code under a version number npm already had, so
  `changeset publish` skipped them silently and no consumer could ever receive the
  fix. Verified by unpacking the published tarballs and hashing every `dist/*.js`
  against the local build: core differs in 2 files, client in 1, express in 1,
  next in 1; ledger is byte-identical and needs nothing.

  **core** — the published 0.7.0 decoder reads protobuf tags and lengths with the
  64-bit varint reader. The bound that refuses an over-32-bit tag (`readVarint32`,
  `> 0xffffffff`) exists only in the working tree, and that module IS
  verify-before-sign: agent-wallet re-exports `assertPreparedTransferMatches` from
  here. A participant's `readRawVarint32` and protobufjs both truncate such a tag
  and parse the field, so bytes the agent's validator skips as an unknown field are
  fully effective on execute and covered by the hash it signs. Every payer
  installed from npm runs without that bound today.

  The published 0.7.0 also ships no `network-failure.js` at all, while express and
  next now import `connectionNeverEstablished` from it — so this bump is a
  prerequisite for publishing them, not an optional companion.

  **client** — the ambiguity fixes in `fetch.ts`: the guard ordered ahead of the
  retry-budget branch, and the machine-readable `PAYMENT_UNCONFIRMED` code.

  **express** — the payment gate now covers every spelling the router will serve:
  `baseUrl + path` as well as the mount-relative path, and both the app's own
  normalisation and the loosest one (an `express.Router()` does not inherit the
  app's `strict routing` / `case sensitive routing`). Each of those gaps served a
  paid resource for free, silently. The default redeemed store is now one per
  process rather than one per middleware instance, and a settle reported successful
  without a transaction id is refused rather than deduped under a shared empty key.

  **next** — the same unidentifiable-settle refusal, so the twins stay in step.
