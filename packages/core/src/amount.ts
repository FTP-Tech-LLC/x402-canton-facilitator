/**
 * Canton Coin amount-unit conversion (x402-ENVELOPE upstream convention).
 *
 * The x402 v2 wire field `PaymentRequirements.maxAmountRequired` (this scheme's
 * `amount`) travels in ATOMIC UNITS as an integer string, while the on-ledger
 * Daml `Decimal` the Token Standard / TransferCommand uses is a fixed-scale
 * decimal string. The conversion boundary is fixed across CIP-56 by the Daml
 * `Decimal` scale: **1 CC = 10^10 atomic units** (10 decimal places).
 *
 * The wire `amount` under scheme `"exact"` (the only scheme) is ATOMIC integer
 * units; the on-ledger Daml Decimal is derived EXACTLY at the boundary via these
 * helpers. The maths is pure BigInt/string so the round-trip never drifts by
 * 10^10 (the off-by-scale footgun) and never goes through float.
 *
 * Mirrors `packages/pay-proxy/src/spend-budget-store.ts`'s `toAtomic` (the same
 * "compare as BigInt atomic, never Number()" guardrail) but adds the inverse and
 * a strict integer-atomic parser, and lives in core so client + facilitator
 * share one implementation.
 */

/** Daml Decimal scale for Canton Coin / Amulet — 10 fractional digits. */
export const CC_ATOMIC_SCALE = 10;

const SCALE_FACTOR = 10n ** BigInt(CC_ATOMIC_SCALE);

/**
 * Convert a Daml Decimal CC string (e.g. `"0.1"`, `"1.0000000000"`) to integer
 * atomic units as a decimal string (e.g. `"1000000000"`, `"10000000000"`).
 *
 * Fail-CLOSED: throws on a non-numeric value, a negative value, or a fractional
 * part with MORE than `CC_ATOMIC_SCALE` significant digits (which would lose
 * precision) — a malformed amount must never silently produce a wrong integer.
 * Trailing zeros within the scale are fine (`"0.1"` and `"0.1000000000"` both
 * → `"1000000000"`).
 */
export function decimalToAtomicCC(dec: string): string {
  if (typeof dec !== "string") {
    throw new Error(`invalid CC decimal amount: ${JSON.stringify(dec)}`);
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(dec.trim());
  if (!m) {
    throw new Error(`invalid CC decimal amount: ${JSON.stringify(dec)}`);
  }
  const whole = m[1] ?? "0";
  const fracRaw = m[2] ?? "";
  // Reject any significant digit past the scale (lossy). Trailing zeros that
  // exceed the scale are NOT significant, so trim them before the length check.
  const fracTrimmed = fracRaw.replace(/0+$/, "");
  if (fracTrimmed.length > CC_ATOMIC_SCALE) {
    throw new Error(
      `CC decimal amount ${JSON.stringify(dec)} has more than ${CC_ATOMIC_SCALE} ` +
        `fractional digits — converting to atomic units would lose precision`
    );
  }
  const frac = fracRaw.slice(0, CC_ATOMIC_SCALE).padEnd(CC_ATOMIC_SCALE, "0");
  const atomic = BigInt(whole) * SCALE_FACTOR + BigInt(frac || "0");
  return atomic.toString();
}

/**
 * Convert integer atomic units (decimal string, e.g. `"1"`, `"10000000000"`) to
 * a fixed-scale Daml Decimal CC string with exactly `CC_ATOMIC_SCALE` fractional
 * digits (e.g. `"0.0000000001"`, `"1.0000000000"`).
 *
 * Fail-CLOSED: throws on a non-integer / non-numeric / negative input. The
 * output is the canonical fixed-scale form the Token Standard ledger uses, so
 * `decimalToAtomicCC(atomicToDecimalCC(x)) === x` and
 * `atomicToDecimalCC(decimalToAtomicCC(d))` is `d` normalized to 10 dp.
 */
export function atomicToDecimalCC(atomic: string): string {
  if (typeof atomic !== "string" || !/^\d+$/.test(atomic.trim())) {
    throw new Error(`invalid CC atomic amount: ${JSON.stringify(atomic)}`);
  }
  const v = BigInt(atomic.trim());
  const whole = v / SCALE_FACTOR;
  const frac = v % SCALE_FACTOR;
  const fracStr = frac.toString().padStart(CC_ATOMIC_SCALE, "0");
  return `${whole.toString()}.${fracStr}`;
}

/* ------------------------------------------------------------------------- *
 * Wire amount boundary (x402-ENVELOPE atomic units).
 *
 * The amount on the x402 WIRE (PaymentRequirements.amount / the accepted.amount
 * in a PaymentPayload) under scheme "exact" (the only scheme) is ATOMIC integer
 * units (1 CC = 10^10), e.g. "100000000" = 0.01 CC. The on-ledger Daml Decimal
 * is derived EXACTLY via the BigInt converters above.
 *
 * The on-ledger Daml `transferLeg.amount` / `Holding.amount` is ALWAYS a
 * fixed-scale Decimal. These functions are the SINGLE place the wire->ledger
 * unit decision is made, so every comparison site (facilitator verify arms,
 * selectServerRequirements, client builder, verify-before-sign) converts
 * identically — the off-by-10^10 firewall.
 * ------------------------------------------------------------------------- */

/** True iff this x402 scheme string carries the amount in ATOMIC integer units
 *  on the wire. The only scheme is "exact", which is atomic; any other string is
 *  not recognized (and the validated path never reaches here with one). */
export function schemeIsAtomic(scheme: string): boolean {
  return scheme === "exact";
}

/**
 * Convert an x402 WIRE amount to the on-ledger Daml **Decimal** it denotes.
 * Under scheme "exact" (atomic) this is `atomicToDecimalCC`; any unrecognized
 * scheme falls through to passthrough (defensive — the validated path only ever
 * passes "exact"). Fail-CLOSED via the underlying converter (a non-integer
 * atomic value throws rather than silently mis-comparing). Use this at EVERY
 * site that compares a wire amount against an on-ledger Decimal.
 */
export function wireAmountToLedgerDecimal(
  scheme: string,
  wireAmount: string
): string {
  return schemeIsAtomic(scheme) ? atomicToDecimalCC(wireAmount) : wireAmount;
}

/**
 * Inverse of `wireAmountToLedgerDecimal`: given an on-ledger Daml Decimal,
 * produce the WIRE amount. Under scheme "exact" (atomic) => `decimalToAtomicCC`;
 * any unrecognized scheme => passthrough. Used by the client builder / signer
 * seam when emitting the wire amount.
 */
export function ledgerDecimalToWireAmount(
  scheme: string,
  decimal: string
): string {
  return schemeIsAtomic(scheme) ? decimalToAtomicCC(decimal) : decimal;
}

/**
 * Canonical VALUE-equality of two on-ledger Daml CC Decimal strings: compares
 * by BigInt atomic units so "0.1" ≡ "0.1000000000" and a 10x/0.1x difference
 * provably never folds. Fail-CLOSED: a malformed Decimal on either side throws
 * (via `decimalToAtomicCC`), so a comparison can never silently pass on junk.
 * This is the exactness guarantee the spec asks for at every amount-compare site
 * (replaces a raw string `!==`).
 */
export function ledgerDecimalEquals(a: string, b: string): boolean {
  return decimalToAtomicCC(a) === decimalToAtomicCC(b);
}

/**
 * Non-throwing, FAIL-CLOSED variant of `ledgerDecimalEquals` for the
 * facilitator amount-validation arms: returns `true` only when both inputs are
 * well-formed Daml CC Decimals of equal value; a malformed/junk value on either
 * side returns `false` (→ amount_mismatch) instead of throwing. Use this at the
 * pure validator sites (validateTransferCommand / validateAllocation /
 * validateCip56*) that must map to a discriminated reject, never a 5xx.
 */
export function ledgerDecimalsMatch(a: string, b: string): boolean {
  try {
    return ledgerDecimalEquals(a, b);
  } catch {
    return false;
  }
}
