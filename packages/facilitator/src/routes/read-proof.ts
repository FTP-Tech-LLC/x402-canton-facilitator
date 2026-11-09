/**
 * Signed relay reads (audit M-5, step 1).
 *
 * The wallet relay answers `GET /v1/wallet/:party/...` for anyone who knows the
 * party id. A wallet can prove it is that party by signing the request with the
 * party's own Ed25519 key; the key is read from synchronizer topology through
 * the same lookup the payer proof uses.
 *
 * Header: `X-Canton-Read-Proof: v1.<timestampMs>.<signature base64url>`.
 *
 * Signed bytes (UTF-8), one field per line:
 *   canton-x402 relay read v1
 *   <METHOD>
 *   <host, lowercased: the Host the client connects to>
 *   <decoded URL pathname>
 *   <raw query string exactly as sent, without "?" ("" when none)>
 *   <party>
 *   <timestampMs>
 *
 * The query is raw, not decoded, so `%26` cannot stand in for `&`. The host
 * stops a proof captured on one relay from being replayed against another. The
 * message is far longer than 34 bytes, so a signature made for it can never be
 * mistaken for a signature over a 32-byte transaction hash (or its 34-byte
 * multihash form), and the fixed first line keeps it apart from everything else
 * a party key signs.
 *
 * Modes: `off` does nothing. `observe` verifies in the background when a header
 * is present and counts; the read never waits and is never refused. `enforce`
 * waits (bounded) and refuses a missing, invalid, expired or unverifiable
 * proof. A request carrying a trusted X-Agent-Key (the hosted MCP) is exempt in
 * every mode: it reads for many users and holds none of their keys.
 *
 * COST ON THE TOPOLOGY READER. The reader also serves the payer proof on every
 * inline payment and has no cache or limit of its own, so this module protects
 * it: a malformed party never reaches it; uncached lookups share a process-wide
 * budget that the payer proof does not touch and that does not touch it; a
 * failed or hung lookup pauses further lookups for a few seconds; and answers
 * (keys, and briefly "no key") are cached in a bounded LRU.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PayerSigningKeyLookup } from "../canton/payer-proof.js";

export const READ_PROOF_HEADER = "x-canton-read-proof";
export const READ_PROOF_DOMAIN = "canton-x402 relay read v1";
/** The per-party GETs of the relay that carry a proof. The client keeps the
 *  same list; a test holds the two, and the registered routes, equal. */
export const READ_PROOF_ROUTES = [
  "holdings",
  "balance",
  "holdings-scan",
  "contracts",
  "tradecraft-updates",
  "tx-amulets",
  "pending",
  "outgoing",
] as const;
/** Accepted clock skew either way. */
export const READ_PROOF_WINDOW_MS = 120_000;
/** How long a party's published keys are reused. A key rotated or revoked in
 *  topology is still accepted, and a new one refused, for up to this long. */
const KEY_TTL_MS = 5 * 60_000;
/** A key that verified once stays usable this long after its last good lookup
 *  when a refresh is refused (budget, breaker) or fails. A cheap flood of junk
 *  proofs can use up the lookup budget, but cannot make honest, proven reads
 *  unverifiable: those keep verifying against the key they already had. */
const KEY_STALE_TTL_MS = 24 * 60 * 60_000;
/** "No key published" is remembered only briefly: a new wallet's key reaches
 *  topology moments after its first read and must verify soon after. */
const NO_KEY_TTL_MS = 20_000;
const KEY_CACHE_MAX = 10_000;
const NO_KEY_CACHE_MAX = 1_000;
/** After a failed lookup the same party is not asked again for this long, so a
 *  hung reader costs one read per party the full lookup timeout. */
const LOOKUP_BACKOFF_MS = 5_000;
const BACKOFF_MAX = 1_000;
const STAGED_KEY_TTL_MS = 10 * 60_000;
const STAGED_KEY_MAX = 1_000;
/** Uncached lookups per minute, all parties together. Separate from the payer
 *  proof's lookups, which have no budget here. */
const LOOKUP_BUDGET_PER_MINUTE = 120;
/** One source (IPv4 address, IPv6 /64) may use this many of them per minute,
 *  so one address cannot spend the shared budget. */
const LOOKUP_BUDGET_PER_SOURCE_PER_MINUTE = 10;
const BUDGET_WINDOW_MS = 60_000;
/** The breaker opens when lookups for this many DISTINCT parties fail within
 *  BREAKER_FAILURE_WINDOW_MS (one party's error says nothing about the reader),
 *  and then pauses lookups for BREAKER_MS. */
const BREAKER_MS = 10_000;
const BREAKER_DISTINCT_PARTIES = 3;
const BREAKER_FAILURE_WINDOW_MS = 30_000;
const SOURCE_TABLE_MAX = 10_000;
const LOOKUP_TIMEOUT_MS = 4_000;
/** Longest an enforced read waits for the verdict. */
const ENFORCE_WAIT_MS = 5_000;
const RETRY_AFTER_SECONDS = 5;
const SIGNATURE_BYTES = 64;
/** The topology reader's own party-id rule (topology-reader/src/topology-client.ts). */
export const PARTY_RE = /^[A-Za-z0-9:_.\- ]{1,180}::[0-9a-f]{16,140}$/;

/** DER SPKI header for an Ed25519 public key; the raw 32 bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type ReadProofMode = "off" | "observe" | "enforce";
export type ReadProofResult =
  | "absent"
  | "valid"
  | "invalid"
  | "expired"
  /** The signature fits the same request under the host in X-Forwarded-Host:
   *  a proxy that rewrites Host. Diagnostic only; nothing is granted. */
  | "wrong_host"
  | "unverifiable";
/** Why a proof could not be verified. */
export type UnverifiableReason = "budget" | "breaker" | "backoff" | "error";

export function parseReadProofMode(raw: string | undefined): ReadProofMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "observe";
  if (v === "off" || v === "observe" || v === "enforce") return v;
  throw new Error(`CANTON_X402_WALLET_READ_PROOF must be off, observe or enforce (got "${raw}")`);
}

export function readProofMessage(input: {
  method: string;
  host: string;
  pathname: string;
  query: string;
  party: string;
  timestampMs: number;
}): Buffer {
  return Buffer.from(
    [
      READ_PROOF_DOMAIN,
      input.method,
      input.host.toLowerCase(),
      input.pathname,
      input.query,
      input.party,
      String(input.timestampMs),
    ].join("\n"),
    "utf8"
  );
}

/** Path (decoded) and raw query of a request URL, as the client signed them. */
function splitUrl(rawUrl: string): { pathname: string; query: string } | null {
  const q = rawUrl.indexOf("?");
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  try {
    return { pathname: decodeURIComponent(path), query: q === -1 ? "" : rawUrl.slice(q + 1) };
  } catch {
    return null;
  }
}

function parseHeader(value: string): { timestampMs: number; signature: Buffer } | null {
  const m = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!m) return null;
  const signature = Buffer.from(m[2]!, "base64url");
  if (signature.length !== SIGNATURE_BYTES) return null;
  return { timestampMs: Number(m[1]), signature };
}

type KeyAnswer =
  | { kind: "keys"; keys: KeyObject[] }
  | { kind: "no_key" }
  | { kind: "error"; why: UnverifiableReason };

type KeyEntry = { keys: KeyObject[]; freshUntil: number; staleUntil: number; refreshing: boolean };

/** LRU of published keys. A `Map` keeps insertion order, so re-inserting on a
 *  hit makes the first entry the least recently used. A hit only reorders: it
 *  never changes when an entry stops being fresh. Only parties that published a
 *  key live here: "no key" answers, in-flight lookups and failures are kept
 *  elsewhere, so junk cannot push an honest party's stale key out. */
class KeyCache {
  private readonly entries = new Map<string, KeyEntry>();
  constructor(
    private readonly now: () => number,
    private readonly max: number
  ) {}

  get(party: string): KeyEntry | undefined {
    const e = this.entries.get(party);
    if (!e) return undefined;
    if (e.staleUntil <= this.now()) {
      this.entries.delete(party);
      return undefined;
    }
    this.entries.delete(party);
    this.entries.set(party, e);
    return e;
  }

  set(party: string, e: KeyEntry): void {
    this.entries.delete(party);
    this.entries.set(party, e);
    if (this.entries.size <= this.max) return;
    // Expired entries first; only if none are, the least recently used.
    const t = this.now();
    for (const [p, v] of this.entries) if (v.staleUntil <= t) this.entries.delete(p);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

/** A small bounded map of party to expiry time, oldest insertion out first. */
class ExpiryMap {
  private readonly m = new Map<string, number>();
  constructor(
    private readonly now: () => number,
    private readonly max: number
  ) {}
  has(party: string): boolean {
    const until = this.m.get(party);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.m.delete(party);
      return false;
    }
    return true;
  }
  set(party: string, ttlMs: number): void {
    this.m.delete(party);
    this.m.set(party, this.now() + ttlMs);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}

export interface ReadProofGuardOptions {
  mode: ReadProofMode;
  /** Required in `enforce` (the guard refuses to be built without it). */
  lookup?: PayerSigningKeyLookup | undefined;
  now?: () => number;
  /** METRICS: one call per checked request (never in `off`, never for trusted).
   *  `why` is set when the result is `unverifiable`. */
  record?: (result: ReadProofResult, why?: UnverifiableReason) => void;
  /** Uncached lookups per minute, all sources together. */
  lookupBudgetPerMinute?: number;
  /** Uncached lookups per minute for one source. */
  lookupBudgetPerSourcePerMinute?: number;
  /** Pause after the breaker opens, ms. */
  breakerMs?: number;
  /** Distinct parties whose lookups must fail to open the breaker. */
  breakerDistinctParties?: number;
  maxCachedParties?: number;
  lookupTimeoutMs?: number;
  enforceWaitMs?: number;
}

/** Who is asking: the budget key (the relay's `ipBucket`). A bad proof never
 *  strikes the caller: a proxy that rewrites Host, a path prefix a proxy strips
 *  or a wallet whose key topology has not seen yet would otherwise get honest
 *  clients banned from every relay route. Junk is bounded by the per-source
 *  lookup share instead. */
export interface ReadProofSource {
  key: string;
}

export type ReadProofGuard = ((
  req: FastifyRequest,
  reply: FastifyReply,
  trusted: boolean,
  source?: ReadProofSource
) => Promise<boolean>) & {
  /** Resolves when no background work (observe checks, refreshes) is running. */
  settled(): Promise<void>;
  /** At onboard/prepare: remember the key the relay just built `party` for. It is
   *  not trusted until `seedKey`. */
  stageKey(party: string, spkiDer: Buffer): void;
  /** At a successful onboard/finalize: trust the staged key for `party`, so the
   *  wallet's first reads need no topology lookup. */
  seedKey(party: string): void;
};

const delay = <T>(ms: number, value: T): { promise: Promise<T>; cancel(): void } => {
  let timer: NodeJS.Timeout;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

export function createReadProofGuard(opts: ReadProofGuardOptions): ReadProofGuard {
  if (opts.mode === "enforce" && !opts.lookup) {
    throw new Error(
      "CANTON_X402_WALLET_READ_PROOF=enforce needs a signing-key lookup " +
        "(CANTON_X402_TOPOLOGY_READER_URL and _TOKEN); refusing to start"
    );
  }
  const now = opts.now ?? Date.now;
  const budgetMax = opts.lookupBudgetPerMinute ?? LOOKUP_BUDGET_PER_MINUTE;
  const sourceBudgetMax = opts.lookupBudgetPerSourcePerMinute ?? LOOKUP_BUDGET_PER_SOURCE_PER_MINUTE;
  const breakerMs = opts.breakerMs ?? BREAKER_MS;
  const breakerParties = opts.breakerDistinctParties ?? BREAKER_DISTINCT_PARTIES;
  const lookupTimeoutMs = opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  const enforceWaitMs = opts.enforceWaitMs ?? ENFORCE_WAIT_MS;
  const cache = new KeyCache(now, opts.maxCachedParties ?? KEY_CACHE_MAX);
  const noKey = new ExpiryMap(now, NO_KEY_CACHE_MAX);
  const backoff = new ExpiryMap(now, BACKOFF_MAX);
  const inflight = new Map<string, Promise<KeyAnswer>>();
  const background = new Set<Promise<void>>();
  const track = (p: Promise<unknown>): void => {
    const task = p.then(
      () => undefined,
      () => undefined
    );
    background.add(task);
    void task.then(() => background.delete(task));
  };
  // A metrics callback that throws must never fail a read or leave a rejection.
  const record = (r: ReadProofResult, why?: UnverifiableReason): void => {
    try {
      opts.record?.(r, why);
    } catch {
      /* observability must not break the request */
    }
  };

  // ── Lookup gating: breaker, global budget, per-source budget ──
  let breakerUntil = 0;
  const recentFailures = new Map<string, number>();
  const noteFailure = (party: string): void => {
    const t = now();
    recentFailures.set(party, t);
    for (const [p, at] of recentFailures) if (t - at > BREAKER_FAILURE_WINDOW_MS) recentFailures.delete(p);
    if (recentFailures.size >= breakerParties) {
      breakerUntil = t + breakerMs;
      recentFailures.clear();
    }
  };
  const noteSuccess = (): void => recentFailures.clear();

  type Window = { start: number; count: number };
  const globalWindow: Window = { start: 0, count: 0 };
  const sourceWindows = new Map<string, Window>();
  const roll = (w: Window, t: number): void => {
    if (t - w.start >= BUDGET_WINDOW_MS) {
      w.start = t;
      w.count = 0;
    }
  };
  const gate = (source: string | undefined): UnverifiableReason | undefined => {
    const t = now();
    if (t < breakerUntil) return "breaker";
    roll(globalWindow, t);
    let sw: Window | undefined;
    if (source !== undefined) {
      sw = sourceWindows.get(source);
      if (!sw) {
        if (sourceWindows.size >= SOURCE_TABLE_MAX) {
          for (const [k, w] of sourceWindows) if (t - w.start >= BUDGET_WINDOW_MS) sourceWindows.delete(k);
        }
        sw = { start: t, count: 0 };
        sourceWindows.set(source, sw);
      }
      roll(sw, t);
      if (sw.count >= sourceBudgetMax) return "budget";
    }
    if (globalWindow.count >= budgetMax) return "budget";
    globalWindow.count++;
    if (sw) sw.count++;
    return undefined;
  };

  const fetchKeys = async (party: string): Promise<KeyAnswer> => {
    const timeout = delay<"timeout">(lookupTimeoutMs, "timeout");
    try {
      const published = await Promise.race([opts.lookup!(party), timeout.promise]);
      if (published === "timeout") throw new Error("key lookup timed out");
      const keys = published
        .filter(
          (der) =>
            der.length === ED25519_SPKI_PREFIX.length + 32 &&
            der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
        )
        .map((der) => createPublicKey({ key: der, format: "der", type: "spki" }));
      noteSuccess();
      return keys.length === 0 ? { kind: "no_key" } : { kind: "keys", keys };
    } catch (err) {
      // Topology answering "no key" is a disproof, and the reader is fine.
      if ((err as { reason?: unknown } | null)?.reason === "no_key") {
        noteSuccess();
        return { kind: "no_key" };
      }
      // Anything else (outage, broken reader, timeout, unknown error) is ours,
      // not the caller's. One party failing proves little; several in a row
      // open the breaker.
      noteFailure(party);
      backoff.set(party, LOOKUP_BACKOFF_MS);
      return { kind: "error", why: "error" };
    } finally {
      timeout.cancel();
    }
  };

  const keysEntry = (keys: KeyObject[]): KeyEntry => ({
    keys,
    freshUntil: now() + KEY_TTL_MS,
    staleUntil: now() + KEY_STALE_TTL_MS,
    refreshing: false,
  });

  const remember = (party: string, a: KeyAnswer): void => {
    if (a.kind === "keys") cache.set(party, keysEntry(a.keys));
    else if (a.kind === "no_key") noKey.set(party, NO_KEY_TTL_MS);
  };

  const refresh = (party: string, stale: KeyEntry, source: string | undefined): void => {
    if (stale.refreshing || backoff.has(party) || gate(source) !== undefined) return;
    stale.refreshing = true;
    track(
      fetchKeys(party).then((a) => {
        // Success replaces the entry; a failure keeps the stale keys.
        remember(party, a);
        stale.refreshing = false;
      })
    );
  };

  const keysFor = async (party: string, source: string | undefined): Promise<KeyAnswer> => {
    const hit = cache.get(party);
    if (hit) {
      if (now() >= hit.freshUntil) refresh(party, hit, source);
      return { kind: "keys", keys: hit.keys };
    }
    if (noKey.has(party)) return { kind: "no_key" };
    const running = inflight.get(party);
    if (running) return running;
    if (!opts.lookup) return { kind: "error", why: "error" };
    if (backoff.has(party)) return { kind: "error", why: "backoff" };
    const why = gate(source);
    if (why) return { kind: "error", why };
    const answer = fetchKeys(party);
    inflight.set(party, answer);
    try {
      const a = await answer;
      remember(party, a);
      return a;
    } finally {
      inflight.delete(party);
    }
  };

  // ── Keys the relay itself just created (onboard) ──
  const staged = new Map<string, { key: KeyObject; until: number }>();
  const parseSpki = (der: Buffer): KeyObject | undefined => {
    if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      return undefined;
    }
    try {
      return createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      return undefined;
    }
  };

  type Verdict = { result: ReadProofResult; why?: UnverifiableReason };

  /**
   * The host a proxy says the client used, when it differs from Host: the
   * first X-Forwarded-Host value, if it fits a hostname. One candidate only,
   * and never RFC 7239 Forwarded, which our Caddy passes on as the client sent
   * it: a long list there made one junk proof cost a signature check per
   * entry. So a failed proof costs at most one more check.
   */
  const forwardedHost = (req: FastifyRequest, host: string): string | undefined => {
    const xfh = req.headers["x-forwarded-host"];
    if (typeof xfh !== "string") return undefined;
    const comma = xfh.indexOf(",");
    const first = (comma === -1 ? xfh : xfh.slice(0, comma)).trim().toLowerCase();
    return first !== "" && first.length <= 255 && first !== host ? first : undefined;
  };

  // Everything taken from `req` is read before the first await: in observe
  // mode this runs after the reply has gone.
  const classify = async (req: FastifyRequest, source: string | undefined): Promise<Verdict> => {
    const header = req.headers[READ_PROOF_HEADER];
    if (header === undefined) return { result: "absent" };
    if (typeof header !== "string") return { result: "invalid" };
    const parsed = parseHeader(header);
    const party = (req.params as { party?: string } | undefined)?.party;
    const url = splitUrl(req.url);
    if (!parsed || !party || !url || !PARTY_RE.test(party)) return { result: "invalid" };
    if (Math.abs(now() - parsed.timestampMs) > READ_PROOF_WINDOW_MS) return { result: "expired" };
    const host = String(req.headers.host ?? "").toLowerCase();
    const messageFor = (h: string): Buffer =>
      readProofMessage({
        method: req.method,
        host: h,
        pathname: url.pathname,
        query: url.query,
        party,
        timestampMs: parsed.timestampMs,
      });
    const other = forwardedHost(req, host);
    const message = messageFor(host);
    const otherMessage = other === undefined ? undefined : messageFor(other);
    const answer = await keysFor(party, source);
    if (answer.kind === "error") return { result: "unverifiable", why: answer.why };
    if (answer.kind === "no_key") return { result: "invalid" };
    const fits = (m: Buffer): boolean => answer.keys.some((k) => cryptoVerify(null, m, k, parsed.signature));
    if (fits(message)) return { result: "valid" };
    return otherMessage && fits(otherMessage) ? { result: "wrong_host" } : { result: "invalid" };
  };

  const guard = (async (req, reply, trusted, source) => {
    if (opts.mode === "off" || trusted) return true;
    if (opts.mode === "observe") {
      // The read never waits on the check, and a measurement never strikes.
      track(
        classify(req, source?.key).then(
          (v) => record(v.result, v.why),
          () => record("unverifiable", "error")
        )
      );
      return true;
    }
    const wait = delay<Verdict>(enforceWaitMs, { result: "unverifiable", why: "error" });
    const verdict = await Promise.race([
      classify(req, source?.key).catch((): Verdict => ({ result: "unverifiable", why: "error" })),
      wait.promise,
    ]);
    wait.cancel();
    record(verdict.result, verdict.why);
    if (verdict.result === "valid") return true;
    if (verdict.result === "unverifiable") {
      reply.code(503).header("Retry-After", String(RETRY_AFTER_SECONDS)).send({ error: "read_proof_unverifiable" });
    } else {
      const error =
        verdict.result === "absent"
          ? "read_proof_required"
          : verdict.result === "expired"
            ? "read_proof_expired"
            : verdict.result === "wrong_host"
              ? "read_proof_wrong_host"
              : "read_proof_invalid";
      reply.code(401).send({ error });
    }
    return false;
  }) as ReadProofGuard;
  guard.stageKey = (party, spkiDer) => {
    const key = parseSpki(spkiDer);
    if (!key || !PARTY_RE.test(party)) return;
    const t = now();
    for (const [p, v] of staged) if (v.until <= t) staged.delete(p);
    if (staged.size >= STAGED_KEY_MAX) staged.delete(staged.keys().next().value!);
    staged.set(party, { key, until: t + STAGED_KEY_TTL_MS });
  };
  guard.seedKey = (party) => {
    const s = staged.get(party);
    staged.delete(party);
    if (s && s.until > now()) remember(party, { kind: "keys", keys: [s.key] });
  };
  guard.settled = async () => {
    while (background.size > 0) await Promise.allSettled([...background]);
  };
  return guard;
}
