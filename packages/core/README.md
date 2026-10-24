# @ftptech/x402-canton-core

Shared TypeScript types and helpers for the Canton x402 protocol
stack. Used by the facilitator, `@ftptech/x402-canton-client`,
`@ftptech/x402-canton-express`, `@ftptech/x402-canton-next` and
`@ftptech/canton-agent-wallet`.

## Install

```bash
npm i @ftptech/x402-canton-core
```

## What's in here

- Wire types per x402 v2: `PaymentRequirements`, `CantonPaymentPayload`,
  `VerifyResponse`, `SettleResponse`, `SupportedResponse`,
  `CantonErrorCode` and friends.
- Network ids: `canton:devnet`, `canton:testnet`, `canton:mainnet`
  (`buildNetworkId`, `isCantonNetwork`, `parseNetworkReference`).
- Headers: `encodeBase64Json` / `decodeBase64Json` and the v2 header
  names `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`. The
  v1 `X-PAYMENT` header is not supported.
- Amounts: atomic units, 1 token = 10^10 (`decimalToAtomicCC`,
  `atomicToDecimalCC`, `wireAmountToLedgerDecimal` and the ledger
  decimal helpers).
- Inline payload: `encodeInlinePaymentPayload` /
  `decodeInlinePaymentPayload` (gzip, bounded decode) and the lower
  level `encodeInlinePayload` / `decodeInlinePayload`.
- Verify-before-sign: `decodePrepared` and the asserts a signer or a
  facilitator runs on prepared bytes, such as
  `assertPreparedTransferMatches`, `assertPreparedAcceptMatches`,
  `assertPreparedRegistrySelfPreapproval`,
  `assertPreparedAmuletSelfPreapproval` and the Tradecraft
  `assertPreparedTc*` family.
- Merchant replay guard: `RedeemedStore` and
  `createInMemoryRedeemedStore`.

See [CHANGELOG.md](CHANGELOG.md) for changes per version.

## Project

Source: [FTP-Tech-LLC/x402-canton-facilitator](https://github.com/FTP-Tech-LLC/x402-canton-facilitator).
Scheme spec: [`specs/scheme_exact_canton.md`](../../specs/scheme_exact_canton.md).
