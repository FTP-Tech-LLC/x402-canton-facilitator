/**
 * Resource-URL on-ledger privacy stamp (x402-ENVELOPE upstream convention,
 * PR #2634 review point 7).
 *
 * The client binds the payment to the gated resource by stamping the resource
 * URL into the on-ledger Transfer/allocation `meta["x402.resourceUrl"]`, which
 * the facilitator's /verify reproduces and compares (the binding guarantee that
 * stops a transfer for resource A unlocking resource B). Committing the
 * PLAINTEXT URL on-ledger is a privacy concern — it identifies which API the
 * agent is paying for, visible to every stakeholder + in Scan. The convention
 * is therefore to stamp an UNSALTED SHA-256 hash (lowercase hex of the digest of
 * the exact UTF-8 URL string) instead of the plaintext, preserving the binding
 * while hiding the URL.
 *
 * BACK-COMPAT: the facilitator MUST accept EITHER the stamped plaintext URL OR
 * its hash (compare the on-ledger value against both `url` and
 * `hashResourceUrl(url)`), so deployed clients that still stamp plaintext keep
 * verifying while new clients stamp the hash. Absence stays tolerated (existing
 * behavior). See `resourceUrlMatchesStamp`.
 */
import { createHash } from "node:crypto";

/** Lowercase-hex unsalted SHA-256 of the exact UTF-8 URL string. */
export function hashResourceUrl(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/**
 * True when an on-ledger `x402.resourceUrl` stamp binds to the expected URL —
 * accepting BOTH the new hashed form `H(url)` and the legacy plaintext `url`
 * (back-compat with deployed plaintext-stamping clients). Callers only invoke
 * this when a stamp is PRESENT; an absent stamp is tolerated by the caller
 * (the documented residual), exactly as before.
 */
export function resourceUrlMatchesStamp(stamp: string, expectedUrl: string): boolean {
  return stamp === expectedUrl || stamp === hashResourceUrl(expectedUrl);
}
