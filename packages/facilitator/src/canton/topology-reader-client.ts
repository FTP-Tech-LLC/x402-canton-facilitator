/**
 * Client for the topology reader (packages/topology-reader).
 *
 * The facilitator does NOT hold participant admin access: that API is
 * unauthenticated and all-or-nothing, and this process serves an
 * unauthenticated /settle to the internet. The reader runs beside the
 * participant, holds the admin access, and answers exactly one question.
 *
 * FAIL-CLOSED IN EVERY DIRECTION. Any outcome other than a clean 200 with keys
 * throws, and the verifier treats a throw as "cannot verify" — which refuses
 * the payment. The distinction the reader draws (200-with-empty means "asked
 * and there are none", 503 means "could not ask") is preserved in the thrown
 * message so an operator can tell an unonboarded payer from a broken node,
 * but neither one ever becomes an acceptance.
 */
import type { PayerSigningKeyLookup } from "./payer-proof.js";

export interface TopologyReaderClientOptions {
  /**
   * Base URL of the reader, e.g. http://10.8.0.1:8099, or several in order of
   * preference. Topology is the synchronizer's, so any participant's reader
   * answers the same question; a second one only matters when the first is down.
   */
  baseUrl: string | readonly string[];
  /** Shared secret. The reader refuses to start without one. */
  token: string;
  /** Per-lookup timeout. A hung topology read must not hold a /verify. */
  timeoutMs?: number;
  /**
   * After this many `unavailable` answers in a row a reader is skipped for
   * `cooldownMs`, then tried again by one lookup. Without it a reader that
   * drops packets costs every payment the full timeout. Default 3.
   */
  failuresToOpen?: number;
  /** How long an open reader is skipped. Default 10 s. */
  cooldownMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * WHY THE REASON IS A FIELD AND NOT A SENTENCE.
 *
 * One error type used to cover four mutually opposite conditions, and the two
 * places that need to tell them apart both had to guess. The metric re-derived
 * it with a regex over the message (services.ts), and the pay/commit enforce
 * gate could not tell them apart at all — every throw set `keyLookupFailed`,
 * the ONE exemption from that gate. So a reader answering 401 after a token
 * rotation, or topology answering definitively that a party publishes no
 * signing key, took the outage exemption: enforce silently degraded to observe
 * and every signature was accepted, indefinitely, while the operator log said
 * the reader was merely "unavailable".
 *
 *   unavailable   the reader could not read topology (503 / unreachable /
 *                 stalled mid-response). Proof is genuinely unavailable; this
 *                 is the only reason that earns the outage exemption.
 *   no_key        topology ANSWERED: this party publishes no protocol signing
 *                 key. A definitive disproof — a party with no published key
 *                 cannot have produced a verifying signature.
 *   reader_error  our reader is misconfigured or broken: 401/404/400/5xx other
 *                 than 503, or a 200 whose body is not the JSON we specified.
 *                 Permanent, not a blip, and pointing at us. (A reader that
 *                 STALLS mid-body is `unavailable` instead — that one is the
 *                 node not answering, not the reader answering wrongly.)
 *
 * Only `unavailable` is treated as "we could not look", which is what the
 * exemption was written for. The other two refuse — matching the way an
 * UNCONFIGURED lookup already refuses everything, so a misconfigured reader can
 * no longer be the one path that accepts everything.
 */
export type TopologyLookupReason = "unavailable" | "no_key" | "reader_error";

export class TopologyLookupError extends Error {
  readonly reason: TopologyLookupReason;
  constructor(message: string, reason: TopologyLookupReason = "unavailable") {
    super(message);
    this.name = "TopologyLookupError";
    this.reason = reason;
  }
}

/**
 * Build the `fetchPayerSigningKey` the payer-proof verifier consumes.
 *
 * Returns X.509 SubjectPublicKeyInfo DER buffers. The verifier pins the exact
 * Ed25519 SPKI header before use, so a reader that returned something else is
 * rejected there rather than trusted here — two independent checks on the one
 * value that decides whether a signature is believed.
 */
export function createTopologyReaderLookup(
  opts: TopologyReaderClientOptions
): PayerSigningKeyLookup {
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const failuresToOpen = opts.failuresToOpen ?? 3;
  const cooldownMs = opts.cooldownMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const bases = (typeof opts.baseUrl === "string" ? [opts.baseUrl] : [...opts.baseUrl])
    .map((b) => b.trim().replace(/\/+$/, ""))
    .filter((b) => b.length > 0);
  if (bases.length === 0) {
    throw new Error("topology reader: at least one base URL is required");
  }
  // Per reader: `unavailable` answers in a row, and until when it is skipped.
  const state = new Map(bases.map((b) => [b, { failures: 0, openUntil: 0 }]));

  return async (party: string): Promise<Buffer[]> => {
    let firstOutage: unknown;
    let readerError: unknown;
    let asked = 0;
    for (const base of bases) {
      const s = state.get(base)!;
      if (s.failures >= failuresToOpen) {
        if (now() < s.openUntil) continue;
        // Half-open: this lookup probes the reader, and the others keep
        // skipping it until the probe has had its full timeout.
        s.openUntil = now() + timeoutMs;
      }
      asked++;
      try {
        const keys = await lookupOne(base, party);
        s.failures = 0;
        return keys;
      } catch (err) {
        const reason = err instanceof TopologyLookupError ? err.reason : undefined;
        if (reason === "no_key") {
          // Topology ANSWERED. Another reader reads the same synchronizer
          // topology, so asking it would be a delay, not a second opinion.
          s.failures = 0;
          throw err;
        }
        if (reason === "unavailable") {
          s.failures++;
          if (s.failures >= failuresToOpen) s.openUntil = now() + cooldownMs;
          firstOutage ??= err;
        } else {
          readerError ??= err;
        }
      }
    }
    if (asked === 0) {
      throw new TopologyLookupError(
        "every topology reader is cooling down after repeated failures; cannot verify this payer",
        "unavailable"
      );
    }
    // `unavailable` is the one reason the pay/commit gate exempts, so it is
    // thrown only when no reader answered at all. A misconfigured reader next
    // to a down one is still our own breakage, never an outage.
    throw readerError ?? firstOutage;
  };

  async function lookupOne(base: string, party: string): Promise<Buffer[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // The timer is cleared in ONE outer finally, after the body is consumed.
    // Clearing it as soon as the headers arrive would leave the body read
    // unbounded: a reader that answers 200 and then stalls mid-stream would
    // hold this request for the HTTP client's own default rather than the
    // timeoutMs this option promises, and since every inline /verify and
    // /settle waits here, a single stalled reader would pin request handlers
    // instead of failing fast and closed.
    try {
      return await lookupWithin(base, party, ac);
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookupWithin(
    base: string,
    party: string,
    ac: AbortController
  ): Promise<Buffer[]> {
    const url = `${base}/v1/party/${encodeURIComponent(party)}/signing-keys`;
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: ac.signal,
      });
    } catch (err) {
      throw new TopologyLookupError(
        `topology reader unreachable: ${err instanceof Error ? err.message : String(err)}`,
        "unavailable"
      );
    }

    if (res.status === 503) {
      // The reader asked and could not get an answer. Distinct from "no keys"
      // on purpose: this one points at the node, not at the payer.
      throw new TopologyLookupError(
        "topology unavailable at the reader; cannot verify this payer",
        "unavailable"
      );
    }
    if (!res.ok) {
      throw new TopologyLookupError(
        `topology reader returned ${res.status}`,
        "reader_error"
      );
    }

    let body: { keys?: Array<{ derBase64?: string }> };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      // Now that the deadline covers the body read, a stalled reader lands
      // HERE, and calling that "unparseable JSON" would point the operator at
      // the wrong thing entirely. Name what actually happened.
      if (ac.signal.aborted) {
        throw new TopologyLookupError(
          `topology reader stalled mid-response after ${timeoutMs}ms; cannot verify this payer`,
          "unavailable"
        );
      }
      throw new TopologyLookupError(
        `topology reader returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
        "reader_error"
      );
    }
    const keys = body.keys ?? [];
    if (keys.length === 0) {
      // Topology answered: this party publishes no protocol signing key. Still
      // a refusal, but an honest one about the PAYER rather than the node.
      throw new TopologyLookupError(
        "party publishes no protocol signing key; cannot verify this payer",
        "no_key"
      );
    }
    const out: Buffer[] = [];
    for (const k of keys) {
      if (typeof k.derBase64 !== "string" || k.derBase64.length === 0) continue;
      out.push(Buffer.from(k.derBase64, "base64"));
    }
    if (out.length === 0) {
      throw new TopologyLookupError(
        "topology reader returned no usable key material",
        "no_key"
      );
    }
    return out;
  }
}
