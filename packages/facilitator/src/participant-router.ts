/**
 * Which of our participants hosts a party.
 *
 * While parties move from one participant to another (party replication), the
 * facilitator talks to two: the primary, where new wallets are onboarded and
 * the moved parties live, and a secondary that still hosts everyone not moved
 * yet. Every relay operation on a party must go to a participant that hosts
 * it — the other one cannot read its ACS, and its prepare/execute/completions
 * would refuse or come back empty.
 *
 * Asked of the participants themselves (GET /v2/parties/{party}, `isLocal`),
 * primary first, and remembered for a while: hosting changes only when a party
 * is replicated, which is an operator event. A party hosted on both resolves to
 * the primary.
 *
 * A lookup that fails never moves a party. The secondary is asked only after
 * the primary has answered that it does not host the party; when an answer
 * is missing, the party keeps the host it last resolved to, or goes to the
 * primary if it never resolved (the single-participant behaviour). A
 * co-hosted party therefore cannot be sent to one participant by one request
 * and to the other by a concurrent one just because the primary blipped.
 * A participant whose lookup failed is not asked again for a short while, so
 * a hung participant costs one short timeout per window, not one per request.
 */
import type { CantonClient } from "@ftptech/x402-canton-ledger";

export type ParticipantName = "primary" | "secondary";

export interface RoutedLedger<C = CantonClient> {
  name: ParticipantName;
  /** Stable identity of this participant (its normalized Ledger API URL, see
   *  `participantId`). Unlike `name` it survives a primary/secondary swap, so
   *  it is what a settle intent row records. */
  id: string;
  client: C;
  /** The ledger user this facilitator acts as on that participant. */
  userId: string;
}

export interface ParticipantRouter<C = CantonClient> {
  primary: RoutedLedger<C>;
  secondary: RoutedLedger<C> | undefined;
  /** The participant hosting `party`; the primary when neither says it hosts
   *  it (the call then fails there as it always did) or it never resolved. */
  forParty(party: string): Promise<RoutedLedger<C>>;
  /** Whether either participant hosts `party`; undefined when it could not be
   *  resolved (not evidence of a stranger). */
  hosts(party: string): Promise<boolean | undefined>;
  byName(name: ParticipantName): RoutedLedger<C> | undefined;
  /** The configured participant with this `id`; undefined when none is. */
  byId(id: string): RoutedLedger<C> | undefined;
}

/** A participant's identity for `RoutedLedger.id`: its Ledger API base URL
 *  without trailing slashes or a default port, host lower-cased. */
export function participantId(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

type HostLookup = { getPartyDetails(party: string): Promise<{ isLocal: boolean } | undefined> };

/** A lookup error that says the participant, not this one party, is the
 *  problem: no answer, a 5xx or a 429. */
function participantUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  if (e?.code === "TIMEOUT" || e?.code === "TRANSPORT_ERROR") return true;
  if (e?.code === "HTTP_ERROR" && typeof e.status === "number") {
    return e.status >= 500 || e.status === 429;
  }
  return false;
}

export function createParticipantRouter<C extends HostLookup>(opts: {
  primary: RoutedLedger<C>;
  secondary?: RoutedLedger<C> | undefined;
  ttlMs?: number;
  maxEntries?: number;
  /** Per-lookup deadline. The ledger client's own timeout is sized for
   *  submissions (45s); a host lookup that takes this long is a hung
   *  participant, and every settle for a party behind it would wait too. */
  lookupTimeoutMs?: number;
  /** How long an unavailable participant is not asked again. */
  unavailableMs?: number;
  now?: () => number;
}): ParticipantRouter<C> {
  const ttlMs = opts.ttlMs ?? 600_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const lookupTimeoutMs = opts.lookupTimeoutMs ?? 3_000;
  const unavailableMs = opts.unavailableMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const { primary, secondary } = opts;
  const cache = new Map<string, { host: ParticipantName | "none"; at: number }>();
  const unavailableUntil = new Map<ParticipantName, number>();

  const remember = (party: string, host: ParticipantName | "none"): void => {
    cache.delete(party);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(party, { host, at: now() });
  };

  /** Does `p` host `party`? undefined when it could not say. */
  const ask = async (p: RoutedLedger<C>, party: string): Promise<boolean | undefined> => {
    const until = unavailableUntil.get(p.name);
    if (until !== undefined && now() < until) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const d = await Promise.race([
        p.client.getPartyDetails(party),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error("host lookup timed out"), { code: "TIMEOUT" })),
            lookupTimeoutMs
          );
        }),
      ]);
      return d?.isLocal === true;
    } catch (err) {
      if (participantUnavailable(err)) unavailableUntil.set(p.name, now() + unavailableMs);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  /** undefined when a participant that had to answer could not. */
  const lookup = async (party: string): Promise<ParticipantName | "none" | undefined> => {
    const onPrimary = await ask(primary, party);
    if (onPrimary === undefined) return undefined;
    if (onPrimary) return "primary";
    if (!secondary) return "none";
    const onSecondary = await ask(secondary, party);
    if (onSecondary === undefined) return undefined;
    return onSecondary ? "secondary" : "none";
  };

  const resolve = async (party: string): Promise<ParticipantName | "none" | undefined> => {
    const hit = cache.get(party);
    if (hit && now() - hit.at < ttlMs) return hit.host;
    const host = await lookup(party);
    if (host !== undefined) {
      remember(party, host);
      return host;
    }
    // No answer: keep the last one (not refreshed, so the next request asks
    // again), never a guess.
    return hit?.host;
  };

  const byName = (name: ParticipantName): RoutedLedger<C> | undefined =>
    name === "primary" ? primary : secondary;

  return {
    primary,
    secondary,
    byName,
    byId: (id) => [primary, secondary].find((p) => p?.id === id),
    async forParty(party) {
      // One participant: nothing to choose, and no lookup on the hot path.
      if (!secondary) return primary;
      const host = await resolve(party);
      return (host === "primary" || host === "secondary" ? byName(host) : undefined) ?? primary;
    },
    async hosts(party) {
      const host = await resolve(party);
      if (host === undefined) return undefined;
      return host !== "none";
    },
  };
}
