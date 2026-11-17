/**
 * Last known signing keys, for when no topology reader gives a usable answer.
 *
 * The reader runs beside one participant. When that participant, its host or
 * the tunnel to it is down, every inline payment would be refused as
 * `signature_invalid`, including payers we verified a minute ago. This keeps the
 * keys a payer's signature verified against, and uses them only when the
 * lookup fails for a reason other than topology answering.
 *
 * Why this is safe:
 * - It never invents a key. A signature still has to verify against a key
 *   topology published for this party, just a recent copy of it.
 * - Only keys that verified a real payment are kept, so nobody can fill the
 *   store by sending unsigned /verify requests for other parties.
 * - Topology answering `no_key` drops the copy and refuses: the party no longer
 *   publishes a key, and that answer wins over memory.
 * - The participant checks the external party's signature again when the
 *   transaction is executed, so a key that was rotated in the meantime can at
 *   worst make a settle fail. It cannot move money on a forged signature.
 * - Copies older than `maxStaleMs` are not used.
 */
import type { PayerSigningKeyLookup } from "./payer-proof.js";

export interface LastKnownKeysOptions {
  /** Oldest copy that may stand in for a failed lookup. Must be > 0. */
  maxStaleMs: number;
  /** Parties remembered; the least recently verified is dropped first. Default 20 000. */
  maxEntries?: number;
  now?: () => number;
  /** Called each time a copy is used instead of a failed lookup. */
  onServedStale?: (party: string, ageMs: number, err: unknown) => void;
}

export interface LastKnownKeys {
  /** The reader lookup, falling back to a usable copy when it fails (not on `no_key`). */
  wrap(lookup: PayerSigningKeyLookup): PayerSigningKeyLookup;
  /** Keep the keys a payer's signature just verified against. */
  remember(party: string, keys: readonly Buffer[]): void;
  /** Drop a payer's copy. */
  forget(party: string): void;
  /** The most recently verified payer whose copy is still usable, if any. */
  recentParty(): string | undefined;
}

export function createLastKnownKeys(opts: LastKnownKeysOptions): LastKnownKeys {
  if (!(opts.maxStaleMs > 0)) {
    throw new Error("last known keys: maxStaleMs must be > 0");
  }
  const maxEntries = opts.maxEntries ?? 20_000;
  const now = opts.now ?? Date.now;
  // base64 strings, not Buffers: a small Buffer is a slice of a shared pool
  // slab, and keeping thousands of them would keep the slabs alive.
  const known = new Map<string, { keys: string[]; at: number }>();

  const usable = (party: string) => {
    const hit = known.get(party);
    if (hit === undefined) return undefined;
    const age = now() - hit.at;
    if (age > opts.maxStaleMs) {
      known.delete(party);
      return undefined;
    }
    return { keys: hit.keys, age };
  };

  return {
    wrap(lookup) {
      return async (party: string): Promise<Buffer[]> => {
        try {
          return await lookup(party);
        } catch (err) {
          if ((err as { reason?: unknown } | null)?.reason === "no_key") {
            known.delete(party);
            throw err;
          }
          const hit = usable(party);
          if (hit === undefined) throw err;
          opts.onServedStale?.(party, hit.age, err);
          return hit.keys.map((k) => Buffer.from(k, "base64"));
        }
      };
    },
    remember(party, keys) {
      if (keys.length === 0) return;
      // Re-insert so Map order is "least recently verified first".
      known.delete(party);
      known.set(party, { keys: keys.map((k) => k.toString("base64")), at: now() });
      while (known.size > maxEntries) {
        const oldest = known.keys().next().value;
        if (oldest === undefined) break;
        known.delete(oldest);
      }
    },
    forget(party) {
      known.delete(party);
    },
    recentParty() {
      let last: string | undefined;
      for (const party of known.keys()) last = party;
      return last !== undefined && usable(last) !== undefined ? last : undefined;
    },
  };
}
