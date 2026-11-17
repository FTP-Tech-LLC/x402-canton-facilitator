import type { ReadinessCheckResult } from "../readiness.js";
import type { LastKnownKeys } from "./last-known-keys.js";
import type { PayerSigningKeyLookup } from "./payer-proof.js";
import { TopologyLookupError } from "./topology-reader-client.js";

/**
 * Readiness of the topology reader.
 *
 * It asks about a payer whose signature verified recently, so a reader that
 * answers "no key" for everyone (a wrong store, a broken filter) shows as down
 * instead of green. Before the first verified payment, or after a quiet
 * `maxStaleMs`, it asks about our own party, which publishes no protocol key, so
 * there `no_key` is the healthy answer. Anything else that throws is mapped to
 * not ready by the probe.
 */
export async function checkTopologyReader(
  lookup: PayerSigningKeyLookup,
  ownParty: string,
  lastKnown: LastKnownKeys | undefined
): Promise<ReadinessCheckResult> {
  const canary = lastKnown?.recentParty();
  try {
    await lookup(canary ?? ownParty);
    return { ok: true };
  } catch (err) {
    const noKey = err instanceof TopologyLookupError && err.reason === "no_key";
    if (!noKey) throw err;
    if (canary === undefined) return { ok: true };
    // That payer no longer publishes a key, or the reader is wrong. Either way
    // its copy goes, and the next probe asks about another payer.
    lastKnown!.forget(canary);
    return { ok: false, detail: "the reader says a recently verified payer has no key" };
  }
}
