/**
 * ONE OUTBOUND BUDGET FOR THE SV SCAN, WITH THE PAYMENT PATH FIRST.
 *
 * Every Scan request this process makes leaves from one address: the
 * validator's bridge, the only host DA admits (ops docker-compose, scan-bridge
 * services). DA meters that address, and measured live it lets about two rapid
 * requests through before answering 429 `local_rate_limited` (e33dc0e: twelve
 * rapid GETs, 200, 200, then ten 429s). The payment path reads the same Scan:
 * Rule 7's preapproval lookup on /verify and /settle, and the CC pay/prepare
 * factory resolve. Once DA refuses the address, an honest CC payment fails on
 * preapproval_missing like everything else.
 *
 * Nothing shared that budget before. Two kinds of read could spend it for free:
 *
 *   - relay Scan-tier reads (resolve/*, holdings-scan) from callers without a
 *     key, capped per IP only, so N addresses meant N times the load;
 *   - /verify Rule 7 lookups for a merchant party nobody has paid, because
 *     unsigned junk reaches Rule 7 before the signature is checked (it is
 *     checked last) and a fresh payTo is a fresh cache key.
 *
 * And each of them retried a 429 up to four times per SV and then failed over,
 * so while DA was already refusing us, one request became eight.
 *
 * So requests to an SV Scan host are counted in one window here: those of the
 * ScanClients services.ts builds (the main one, Rule 7's, the best-effort one
 * and the attribution ones) and the relay's raw Scan reads (wallet.ts). The
 * Scan hosts are the configured Scan URL, its fallbacks and the attribution
 * Scans. A request to any other host passes through untouched: ScanClient also
 * reaches a DA Registry Utility (resolveTransferKind for a registry token),
 * which is not DA's Scan and has limits of its own. The relay's own registry
 * reads (registryFetchRetry) never come here at all. Reads fall into two
 * classes:
 *
 *   priority     the payment path, our own background work, and callers with a
 *                trusted key. Never refused here, and retried as before. They
 *                still count, which is what gives them priority: the more of
 *                the window they use, the less is left for the rest.
 *   best-effort  everything above that an anonymous caller can multiply. Sent
 *                only while the window holds fewer than `maxPerWindow` requests
 *                of any class, and not within `cooldownMs` of a 429 from the
 *                SAME host. Refused reads fail at once without a Scan request,
 *                and a 429 is never retried or failed over: a 429 is DA saying
 *                the address is over its budget at that host, and every retry
 *                spends more of the budget the payment path needs.
 *
 * Process-local, like every limiter here (rate-limit.ts header).
 */
import { CantonError } from "@ftptech/x402-canton-ledger";

export interface ScanBudgetConfig {
  /** Scan requests per window, every class counted, at or above which
   *  best-effort reads are refused. `<= 0` turns the whole budget off: every
   *  read is sent, counted nowhere, and retried as before. */
  maxPerWindow: number;
  /** Window length in ms. Default 60 000. */
  windowMs?: number;
  /** After a 429 from a Scan host, best-effort reads to that host are refused
   *  for this long. Default 2 000 ms: DA's refusals cleared within a
   *  400-1600 ms backoff when measured (e33dc0e), so this lets priority retries
   *  land on a refilled budget alone. `<= 0`: no cooldown. */
  cooldownMs?: number;
  /** The SV Scan hosts (URLs or host names). Only requests to these are
   *  counted, refused or cooled down; any other host passes through untouched.
   *  Absent: every request counts as Scan. */
  scanHosts?: readonly string[];
  /** Told when a host's cooldown STARTS (not each time a 429 extends it). */
  onCooldown?: (host: string) => void;
  /** Gap between consecutive best-effort requests of one multi-request read
   *  (holdings-scan pages, migration probes). Default 500 ms, the pacing that
   *  kept the attribution worker under the same budget; without it a whale's
   *  page loop trips DA's burst limit by itself, and best-effort does not
   *  retry. */
  paceMs?: number;
}

export type ScanRefusalReason = "budget" | "cooldown" | "rate_limited";

/**
 * A best-effort Scan read that was not sent (or whose 429 was not retried).
 *
 * A CantonError with NO status, on purpose: ScanClient rethrows a CantonError
 * thrown by its fetch unchanged and retries only TIMEOUT / TRANSPORT_ERROR or a
 * transient status, so this one stops its retry loop and its failover at once.
 * Callers that turn a Scan failure into a verdict (Rule 7 answers
 * preapproval_missing) must let this one through instead: it says nothing about
 * the merchant, only that we chose not to ask.
 */
/** Added to a cooldown wait before asking again: a timer can fire a millisecond
 *  early, and a retry that lands inside the cooldown is refused a second time. */
export const COOLDOWN_WAIT_SLACK_MS = 25;

export class ScanBudgetRefusedError extends CantonError {
  constructor(
    readonly reason: ScanRefusalReason,
    readonly retryAfterMs: number
  ) {
    super(
      reason === "rate_limited"
        ? "Scan answered 429; a best-effort read is not retried"
        : `best-effort Scan read not sent (${reason}): the shared Scan budget is kept for the payment path`,
      "SCAN_BUDGET_REFUSED"
    );
    this.name = "ScanBudgetRefusedError";
  }

  /** Whole seconds for a Retry-After header, at least 1. */
  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1000));
  }
}

export interface ScanBudget {
  /** False when `maxPerWindow <= 0`: nothing is counted or refused. */
  readonly enabled: boolean;
  /** See {@link ScanBudgetConfig.paceMs}; 0 when disabled. */
  readonly paceMs: number;
  /** Is a request to `url` a Scan request this budget accounts for? Absent
   *  url: yes. */
  isScan(url?: string): boolean;
  /**
   * Account for one outbound request to `url` about to be sent. Priority is
   * always admitted. Best-effort is admitted below the line and outside its
   * host's cooldown. Returns undefined when admitted (counted, if a Scan
   * request), else the refusal to throw.
   */
  admit(priority: boolean, now: number, url?: string): ScanBudgetRefusedError | undefined;
  /** The Scan host of `url` answered 429, to any class: start (or extend) that
   *  host's cooldown. Returns the refusal a best-effort read throws in place of
   *  retrying. */
  noteRateLimited(now: number, url?: string): ScanBudgetRefusedError;
  /** Introspection for tests/metrics: requests counted in the window. */
  _inWindow(now: number): number;
}

/** `host[:port]` of a URL, or undefined when it does not parse. */
function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function createScanBudget(cfg: ScanBudgetConfig): ScanBudget {
  const max = cfg.maxPerWindow;
  const windowMs = cfg.windowMs ?? 60_000;
  const cooldownMs = cfg.cooldownMs ?? 2_000;
  const enabled = max > 0 && windowMs > 0;
  const hits: number[] = []; // ascending send times inside the window
  const scanHosts = cfg.scanHosts
    ? new Set(cfg.scanHosts.map((h) => (h.includes("://") ? hostOf(h) ?? h : h).toLowerCase()))
    : undefined;
  /** Scan host → end of its cooldown. "*" for a request with no URL. */
  const coolUntil = new Map<string, number>();
  const keyOf = (url: string | undefined): string => hostOf(url)?.toLowerCase() ?? "*";
  const isScan = (url?: string): boolean => {
    if (!scanHosts || url === undefined) return true;
    const h = hostOf(url)?.toLowerCase();
    return h !== undefined && scanHosts.has(h);
  };

  const prune = (now: number): void => {
    const cutoff = now - windowMs;
    let n = 0;
    while (n < hits.length && hits[n]! <= cutoff) n++;
    if (n > 0) hits.splice(0, n);
  };

  return {
    enabled,
    paceMs: enabled ? (cfg.paceMs ?? 500) : 0,
    isScan,
    admit(priority: boolean, now: number, url?: string): ScanBudgetRefusedError | undefined {
      if (!enabled || !isScan(url)) return undefined;
      prune(now);
      if (!priority) {
        const until = coolUntil.get(keyOf(url)) ?? 0;
        if (now < until) return new ScanBudgetRefusedError("cooldown", until - now);
        if (hits.length >= max) {
          // The window frees its oldest slot first.
          return new ScanBudgetRefusedError("budget", hits[0]! + windowMs - now);
        }
      }
      hits.push(now);
      return undefined;
    },
    noteRateLimited(now: number, url?: string): ScanBudgetRefusedError {
      const key = keyOf(url);
      if (enabled && cooldownMs > 0 && isScan(url)) {
        const prev = coolUntil.get(key) ?? 0;
        coolUntil.set(key, Math.max(prev, now + cooldownMs));
        if (prev <= now) cfg.onCooldown?.(key);
      }
      // DA sends no Retry-After; a second is the least worth suggesting.
      return new ScanBudgetRefusedError("rate_limited", Math.max((coolUntil.get(key) ?? 0) - now, 1_000));
    },
    _inWindow(now: number): number {
      prune(now);
      return hits.length;
    },
  };
}

/**
 * A `fetch` for a ScanClient (or any Scan caller) that spends `budget`.
 *
 * Priority: counted, and a 429 starts its host's cooldown; the response is
 * returned untouched, so the caller retries exactly as before. Best-effort: refused
 * before sending when the budget says so, and a 429 is turned into a
 * {@link ScanBudgetRefusedError} so ScanClient neither retries nor fails over.
 * With the budget off this is the plain fetch.
 *
 * `fetchImpl` is read at call time, so a test that stubs the global fetch
 * after construction is still the one called.
 */
export function scanBudgetFetch(
  budget: ScanBudget,
  priority: boolean,
  fetchImpl: () => typeof globalThis.fetch = () => globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Not a Scan host (a registry utility reached through ScanClient): this
    // budget has nothing to say about it.
    if (!budget.enabled || !budget.isScan(url)) return fetchImpl()(input, init);
    const refused = budget.admit(priority, Date.now(), url);
    if (refused) throw refused;
    const res = await fetchImpl()(input, init);
    if (res.status === 429) {
      const refusal = budget.noteRateLimited(Date.now(), url);
      if (!priority) {
        await res.body?.cancel().catch(() => undefined);
        throw refusal;
      }
    }
    return res;
  };
}

/**
 * Which merchants' Rule 7 lookups are the payment path.
 *
 * Rule 7 runs before the signature check, so the payTo of a /verify proves
 * nothing about who is paying whom. A merchant becomes priority only once a
 * payment to it has SETTLED (/settle, funds moved), or because the operator
 * listed it (the discovery Bazaar, the inline allowlist, recent settled
 * payments at startup), and stays priority while its last-read preapproval is
 * live. A valid /verify is not enough: anyone with a wallet can produce one for
 * any merchant that has a preapproval. A settle moves the attacker's own money
 * to that merchant and is held by /settle's own caps.
 *
 * A merchant whose preapproval lapsed drops back to best-effort: an expired
 * record is never cached (ScanClient re-reads it on every call), so junk quoting
 * such a merchant must not ride on the priority class.
 *
 * Bounded (least recently used goes first). A merchant pushed out simply waits
 * on the best-effort class until its next settled payment.
 */
export interface PaymentPathMerchants {
  /** Is a Rule 7 read for `party` on the payment path right now? */
  isPriority(party: string, now: number): boolean;
  /** A payment to `party` just settled (or the operator lists it). */
  markServed(party: string): void;
  /** A Rule 7 read for `party` returned this expiry (undefined: no record).
   *  Ignored for parties not tracked. */
  noteRecord(party: string, expiresAtMs: number | undefined): void;
  /** Introspection for tests. */
  _size(): number;
}

export function createPaymentPathMerchants(opts: {
  seed?: readonly string[];
  max?: number;
}): PaymentPathMerchants {
  const max = Math.max(1, opts.max ?? 256);
  // party -> the expiry of its last-read live preapproval; Infinity = not read
  // yet (assumed live until the first read says otherwise); 0 = known dead.
  const live = new Map<string, number>();
  const put = (party: string, until: number): void => {
    live.delete(party);
    live.set(party, until);
    while (live.size > max) {
      const oldest = live.keys().next().value;
      if (oldest === undefined) break;
      live.delete(oldest);
    }
  };
  for (const p of opts.seed ?? []) if (p) put(p, Infinity);

  return {
    isPriority(party: string, now: number): boolean {
      const until = live.get(party);
      return until !== undefined && until > now;
    },
    markServed(party: string): void {
      if (!party) return;
      const until = live.get(party);
      // A known expiry stays as read; a party that was not tracked, or was
      // known dead, is live as of this payment.
      put(party, until !== undefined && until > Date.now() ? until : Infinity);
    },
    noteRecord(party: string, expiresAtMs: number | undefined): void {
      if (!live.has(party)) return;
      put(party, expiresAtMs !== undefined && Number.isFinite(expiresAtMs) ? expiresAtMs : 0);
    },
    _size(): number {
      return live.size;
    },
  };
}
