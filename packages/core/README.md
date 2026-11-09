# @ftptech/x402-canton-core

Shared types and helpers for the Canton x402 stack. The client, the agent wallet and the Express and Next.js middleware build on it.

## Install

```bash
npm install @ftptech/x402-canton-core
```

## What's in here

- x402 v2 types for the `exact` scheme on Canton: `PaymentRequirements`, `CantonPaymentPayload`, `X402ResourceInfo`, `FacilitatorRequest`, `VerifyResponse`, `SettleResponse`, `SupportedResponse`, `CantonErrorCode`.
- Network ids `canton:mainnet`, `canton:testnet` and `canton:devnet`. Copy the value from the facilitator's `/supported`.
- `encodeBase64Json`, `decodeBase64Json` and the v2 header names `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE`. The v1 `X-PAYMENT` header is not supported.
- Amounts: 1 token = 10^10 atomic units for every instrument (`decimalToAtomicCC`, `atomicToDecimalCC`).
- Verify-before-sign: `decodePrepared` and `assertPreparedTransferMatches` check a prepared transaction against what the payer agreed to, before the payer signs its hash.
- Merchant guards the middleware uses: `selectServerRequirements`, `assertAssetInstrumentConsistency` and `RedeemedStore`.

## Docs

- [x402 on Canton](https://x402-docs.ftptech.xyz) on the FTP docs site.
- Scheme spec: [`scheme_exact_canton.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_canton.md).
