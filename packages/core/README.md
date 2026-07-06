# @ftptech/x402-canton-core

Shared TypeScript types and helpers for the Canton x402 protocol
stack. Used by `@ftptech/x402-canton-facilitator`,
`@ftptech/x402-canton-client`, `@ftptech/x402-canton-express`, and
`@ftptech/x402-canton-next`.

## Install

```bash
npm i @ftptech/x402-canton-core
```

> Note: the `@ftp` npm scope is not final and may change before the
> first public release (see [`docs/PUBLISHING.md`](https://github.com/sunstrike228/canton-x402/blob/main/docs/PUBLISHING.md)).
> Pin the version you install and check the README for the current
> package name.

## What's in here

- `X402ResourceInfo`, `PaymentRequirements`, `CantonPaymentPayload`,
  `FacilitatorRequest`, `VerifyResponse`, `SettleResponse`,
  `SupportedResponse`, `CantonErrorCode` types per x402 v2.
- `CantonNetwork` CAIP-2-style identifiers (`canton:devnet`,
  `canton:mainnet`, `canton:<global-synchronizer-id>`).
- `encodeBase64Json` / `decodeBase64Json` + v1/v2 header-name
  constants (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`,
  `PAYMENT-RESPONSE`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`).

## Project

See [github.com/sunstrike228/canton-x402](https://github.com/sunstrike228/canton-x402)
and the scheme spec at
[`specs/scheme_exact_canton.md`](https://github.com/sunstrike228/canton-x402/blob/main/specs/scheme_exact_canton.md).
