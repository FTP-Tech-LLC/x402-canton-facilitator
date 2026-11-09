# @ftptech/x402-canton-core

## 1.9.0

### Minor Changes

- 7f6f15b: `PreparedTransferExpectation` takes `meta`, the exact `transfer.meta.values` map, and `executeBeforeMaxMs`, the latest acceptable `transfer.executeBefore`. A caller that built the transfer pins both: the agent wallet's swap carries its slippage floor or buy token in meta.

### Patch Changes

- db1d351: The express and next middlewares understand the facilitator's scheme answers. A repeat of a settled payment, refused with its `updateId`, is served through the redeemed store: once, or again after a failed delivery gave the payment back. `settlement_pending`, as a 503 with its body or a 200, is retried with the same payment for about 7 s, then answered 502 "do NOT pay again", never 402. The client reads the reason from PAYMENT-RESPONSE on a 402, where a server on the official x402 SDK puts it, and stops without paying again on `settlement_pending`. A failed SettleResponse in core carries `transaction`, `network` and `payer`.
- fb41063: `assertPreparedTransferMatches` admits an `Archive` only of an input contract the instrument admin signs, or of a contract the same transaction created earlier. A root on a relay's own template runs with the sender's authority and could otherwise archive a contract the sender signs alone, such as its own registry TransferPreapproval. Every Archive on the MainNet transfer captures is an admin-signed input; a transient created and archived in one transaction still passes. `DecodedNode.create` now carries the created `contractId`.
- 672bf45: `assertPreparedTransferMatches` also checks who signs what a transfer creates. A create whose signatories include the sender must have the instrument admin among them too: the DSO for Canton Coin, the registrar for a registry token. A root on a relay's own template runs with the sender's authority and could otherwise create a contract the sender signs, with a choice someone else controls. When the pinned admin is the network's DSO, given as the new `dsoParty`, the transfer is Canton Coin and its root contract must also be signed by exactly that DSO, as the DSO's ExternalPartyAmuletRules is. The instrument id does not decide this, since a registry may name its token "Amulet". Measured on every MainNet transfer capture; honest transfers pass as before.
- cddefd2: `assertPreparedTransferMatches` checks what a one-step delivery pays against the root transfer. A tree that exercises a TransferPreapproval send must carry exactly one `TransferPreapproval_SendV2`, on the receiver's preapproval, for the transfer amount; a legacy `TransferPreapproval_Send` is refused. A `TransferRule_DirectTransfer` must move the root's sender, receiver, amount and instrument. Before, only the root's argument was checked, so a root on a relay's own template could deliver another amount. `templateQualifiedName` also takes a list of templates. Measured on the MainNet captures; honest transfers pass as before.

## 1.8.0

### Minor Changes

- `KNOWN_TRADECRAFT_PACKAGE_IDS` adds Tradecraft 1.3.17 (`cc7b9c85…`, from the
  official DAR), newest first, so a withdrawal request in the venue's current
  package passes verify-before-sign. `SupportedResponse` kinds may carry
  `feePayer`, which the official `@x402/canton` server reads.

## 1.7.0

### Minor Changes

- ebc4e5f: `assertPreparedAcceptMatches` holds a claim to the instruction's issuer, not
  only to template names (a relay that runs the agent's participant could vet a
  look-alike package reusing them). A registry claim: the accepted offer must be
  an input contract signed by the registrar whose signed transfer pays the agent,
  and every created Holding must be signed by the registrar and owned by the
  agent (the owner field, not any mention). A Canton Coin claim, when the new
  `dsoParty` is given: the accepted AmuletTransferInstruction must be signed by
  the DSO and pay the agent, and the agent must get a DSO-signed Amulet. Measured
  on the real MainNet accepts (USDCx offer, faucet CC instruction).

## 1.6.0

### Minor Changes

- dd08e38: `assertPreparedWithdrawMatches`: verify-before-sign for a wallet withdrawing its
  own registry offer (`TransferInstruction_Withdraw` on the registrar's
  `TransferOffer`), for taking back an offer the receiver never took. The root
  is pinned to the offer the wallet asked about, and that offer must be an input
  contract signed by the registrar whose signed transfer names the agent as
  sender, the expected registrar as admin, and an `executeBefore` already past
  (`onlyIfExpiredAt`). Every create must be a registry `Holding` signed by the
  registrar and owned by the agent, naming no party outside the registrar and
  the trusted registry parties, and at least one must come back. Measured on two
  live MainNet offers a swap venue left unaccepted (eXAG, cETH).

## 1.5.0

### Minor Changes

- 580bff2: Add `deliversViaAmuletPreapproval`, which proves from the signed bytes that an Amulet transfer delivers one-step through the receiver's TransferPreapproval.

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
