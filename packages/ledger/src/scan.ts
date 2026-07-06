/**
 * Scan API client.
 *
 * Canton's Scan API surfaces DSO-signed state (AmuletRules, mining
 * rounds, traffic status) that an individual participant cannot read
 * from its own ACS. The facilitator depends on Scan for:
 *
 *   - AmuletRules + open/issuing mining rounds → disclosedContracts
 *     for CIP-56 settlement reads.
 *   - Traffic status → M2/M3/M4 burn attribution telemetry.
 *
 * Two URL flavors:
 *   - `validator` (default): hits the validator-local Scan proxy at
 *     `/api/validator/v0/scan-proxy/...`. Authenticated via the
 *     validator's own JWT. Used in production.
 *   - `sv`: hits an SV's public Scan directly at `/api/scan/v0/...`.
 *     Mostly unauthenticated. Used as a fallback or for cross-checks.
 *
 */

import { CantonError, type TokenProvider } from "./client.js";

export type ScanFlavor = "validator" | "sv";

export interface ScanClientOptions {
  /** Base URL of the validator (for `validator` flavor) or the SV
   *  Scan host (for `sv` flavor). No trailing slash. */
  scanUrl: string;
  /** Optional alternate Scan base URLs, tried IN ORDER after `scanUrl` when a
   *  request keeps failing with a transient/5xx error after its bounded retry
   *  on the primary. These reads are idempotent registry/DSO-state lookups, so
   *  failing over to another SV's Scan is safe. Use a DIFFERENT-operator SV (a
   *  real independent failure domain): the sv-1..sv-N `*.sync.global` hosts sit
   *  behind one operator's edge and do not protect against that operator's
   *  app-layer 503. Empty by default; an alternate MUST be verified reachable +
   *  unauthenticated from the deploy host before use. */
  fallbackUrls?: string[];
  /** Optional bearer token. Required for validator-proxy reads;
   *  optional for direct SV Scan. Accepts a `TokenProvider` for
   *  OIDC-issued tokens that refresh before expiry. */
  token?: string | TokenProvider;
  flavor?: ScanFlavor;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * Per-instance TTL cache for the two DSO-state reads the v1 /settle path
   * hits on EVERY settle (`getAmuletRules`, `getOpenAndIssuingMiningRounds`).
   * Both are identical across the many settles that happen within a mining
   * round, so caching them roughly halves pre-submit Scan latency. A
   * briefly-stale rounds entry is harmless: a stale/archived round cid makes
   * the Send fail with `LOCAL_VERDICT_INACTIVE_CONTRACTS`, and the settle
   * path's retry re-reads BOTH the counter AND the rounds/amulet via the
   * cache-bypassing `*Fresh` getters, so the retry re-discloses the live
   * contracts rather than re-submitting the same stale cid.
   *
   * `0` disables a cache (always refetch). Omitted → the defaults below.
   */
  cache?: ScanCacheOptions;
}

export interface ScanCacheOptions {
  /**
   * AmuletRules TTL in ms. AmuletRules changes only on rare DSO governance
   * actions, so minutes are safe. Default 5 min. `0` disables.
   */
  amuletRulesTtlMs?: number;
  /**
   * Open+issuing mining rounds TTL in ms. Rounds rotate on the order of
   * tens of minutes; a short TTL keeps the disclosed round fresh while still
   * coalescing the bursts of settles within a round. Default 30 s. `0`
   * disables.
   */
  miningRoundsTtlMs?: number;
}

export interface AmuletRulesResponse {
  amulet_rules: {
    contract: {
      contract_id: string;
      template_id: string;
      created_event_blob: string;
      payload: {
        dso: string;
        isDevNet: boolean;
      };
    };
    domain_id: string;
  };
}

export interface MiningRoundsResponse {
  open_mining_rounds: Array<{
    contract: {
      contract_id: string;
      template_id: string;
      created_event_blob: string;
      payload: {
        round: { number: string };
        opensAt?: string;
      };
    };
  }>;
  issuing_mining_rounds: Array<{
    contract: {
      contract_id: string;
      template_id: string;
      created_event_blob: string;
      payload: {
        round: { number: string };
        opensAt?: string;
      };
    };
  }>;
}

export interface TrafficStatusResponse {
  traffic_status: {
    actual: {
      total_consumed: number;
      total_limit: number;
    };
    target: {
      total_purchased: number;
    };
  };
}

/** Response of `GET /api/scan/v0/events/{updateId}`. */
export interface ScanEventVerdictResponse {
  traffic_summary: {
    total_traffic_cost: number;
    envelope_traffic_summaries: Array<{
      traffic_cost: number;
      view_ids: number[];
    }>;
  } | null;
  verdict: {
    update_id: string;
    submitting_participant_uid: string;
    submitting_parties: string[];
    verdict_result: string;
    record_time?: string;
  } | null;
}

/** Parsed result of a Scan event verdict. */
export interface TrafficSummaryResult {
  updateId: string;
  recordTime: string | null;
  verdictResult: string | null;
  submittingParticipantUid: string | null;
  submittingParties: string[];
  totalTrafficCost: number | null;
}

/** Daml `InstrumentId` as it appears inside a Scan v2 update's exercised
 *  `TransferFactory_Transfer` choice argument. */
export interface ScanInstrumentId {
  admin: string;
  id: string;
}

/** The `transfer` sub-object of the `TransferFactory_Transfer` choice
 *  argument. Daml field names (NOT snake_case). Only the fields the
 *  facilitator validates are typed. */
export interface ScanTransfer {
  sender: string;
  receiver: string;
  /** Daml Decimal as a JSON string — compared exactly, never coerced. */
  amount: string;
  instrumentId: ScanInstrumentId;
  requestedAt?: string;
  executeBefore?: string;
  /** Transfer metadata; the x402 client stamps `x402.resourceUrl` /
   *  `x402.paymentId` here (see client/src/scheme.ts). */
  meta?: { values?: Record<string, string> };
}

/** One entry of a Scan update's `events_by_id` map. The envelope is
 *  snake_case (`event_type`, `choice_argument`, `exercise_result`); the
 *  Daml choice-argument values use Daml field names. Only the fields the
 *  completed-transfer validator needs are typed; everything else (created
 *  Holdings, nested exercised events, etc.) is tolerated loosely. */
export interface ScanEvent {
  event_type: string;
  event_id?: string;
  contract_id?: string;
  template_id?: string;
  /** Unqualified choice name, e.g. "TransferFactory_Transfer". */
  choice?: string;
  choice_argument?: { transfer?: ScanTransfer; expectedAdmin?: string };
  /** `output.tag` discriminates Completed vs Pending. */
  exercise_result?: { output?: { tag?: string } };
  acting_parties?: string[];
}

/** Response of `GET /api/scan/v2/updates/{updateId}` (SV Scan flavor).
 *  Public on the validator LAN — does NOT require the reader to be a
 *  transaction stakeholder. */
export interface ScanUpdate {
  update_id: string;
  record_time?: string;
  synchronizer_id?: string;
  root_event_ids?: string[];
  events_by_id: Record<string, ScanEvent>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_AMULET_RULES_TTL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_MINING_ROUNDS_TTL_MS = 30_000; // 30 seconds

/**
 * A single-slot TTL cache with single-flight refresh.
 *
 * - Within `ttlMs` of the last *successful* fill, `get()` returns the cached
 *   value without calling `loader`.
 * - On a miss (cold or expired) the first caller starts ONE `loader` call;
 *   concurrent callers awaiting at the same time share that in-flight promise
 *   (single-flight) rather than each firing their own request — this is what
 *   coalesces a burst of /settle requests into a single Scan round-trip.
 * - A rejected load is NOT cached: the in-flight promise is cleared so the
 *   next caller retries. A stale cached value is only ever served while still
 *   inside its TTL.
 * - `ttlMs <= 0` disables caching entirely (every `get()` calls `loader`),
 *   while still coalescing truly-concurrent callers via single-flight.
 *
 * Timekeeping uses an injectable `now()` so tests can drive expiry with fake
 * timers deterministically.
 */
export class TtlSingleFlightCache<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private inFlight: Promise<T> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async get(loader: () => Promise<T>): Promise<T> {
    const t = this.now();
    // Fresh hit.
    if (this.ttlMs > 0 && this.value !== undefined && t < this.expiresAt) {
      return this.value;
    }
    // Coalesce concurrent refreshes onto a single in-flight load.
    if (this.inFlight) return this.inFlight;

    const p = (async () => {
      const fresh = await loader();
      // Only cache on success; record fill time from a post-load clock read
      // so a slow load does not shorten the effective TTL window unfairly.
      this.value = fresh;
      this.expiresAt = this.ttlMs > 0 ? this.now() + this.ttlMs : 0;
      return fresh;
    })();
    this.inFlight = p;
    try {
      return await p;
    } catch (err) {
      // Do not poison the cache on a failed refresh — next caller retries.
      throw err;
    } finally {
      if (this.inFlight === p) this.inFlight = null;
    }
  }

  /** Drop the cached value (next get() refetches). Exposed for tests/ops. */
  invalidate(): void {
    this.value = undefined;
    this.expiresAt = 0;
  }
}

/**
 * Is this Scan error TRANSIENT — worth a backoff-retry / failover rather than a
 * hard failure? Covers the per-IP 429 burst budget, server-side overload/5xx
 * (502/503/504 — the SV Scan's `local_*` shedding that surfaced as relay 502s),
 * and our own timeout/transport faults. A 4xx other than 429 (e.g. 404 from
 * getUpdateById in the first-payment dead-zone, or a 400) is a real, stable
 * answer and is NOT transient. Exported for unit testing.
 */
export function isTransientScanError(err: unknown): boolean {
  if (!(err instanceof CantonError)) return false;
  if (err.code === "TIMEOUT" || err.code === "TRANSPORT_ERROR") return true;
  return (
    err.status === 429 ||
    err.status === 502 ||
    err.status === 503 ||
    err.status === 504
  );
}

export class ScanClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly prefix: string;
  private readonly token: string | TokenProvider | undefined;
  private readonly scanUrl: string;
  private readonly fallbackUrls: string[];

  private readonly isSv: boolean;

  /** Per-instance TTL+single-flight caches for the two DSO-state reads the
   *  v1 /settle path repeats on every settle. Created once per ScanClient so
   *  the cache lifetime is the client's lifetime (not shared across clients,
   *  per design). */
  private readonly amuletRulesCache: TtlSingleFlightCache<AmuletRulesResponse>;
  private readonly miningRoundsCache: TtlSingleFlightCache<MiningRoundsResponse>;

  constructor(opts: ScanClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.scanUrl = opts.scanUrl;
    this.fallbackUrls = (opts.fallbackUrls ?? []).filter((u) => u && u !== opts.scanUrl);
    this.token = opts.token;
    this.isSv = (opts.flavor ?? "validator") === "sv";
    this.prefix = this.isSv
      ? "/api/scan/v0"
      : "/api/validator/v0/scan-proxy";

    const amuletTtl =
      opts.cache?.amuletRulesTtlMs ?? DEFAULT_AMULET_RULES_TTL_MS;
    const roundsTtl =
      opts.cache?.miningRoundsTtlMs ?? DEFAULT_MINING_ROUNDS_TTL_MS;
    this.amuletRulesCache = new TtlSingleFlightCache<AmuletRulesResponse>(
      amuletTtl
    );
    this.miningRoundsCache = new TtlSingleFlightCache<MiningRoundsResponse>(
      roundsTtl
    );
  }

  /**
   * AmuletRules + domain id.
   *
   * Wire difference by flavor (verified live 2026-05-30):
   *   - validator scan-proxy: GET, response `{ amulet_rules: {contract, domain_id} }`.
   *   - public SV scan (`/api/scan/v0`): POST (GET → 405), response
   *     `{ amulet_rules_update: {contract, domain_id} }` (note the
   *     `_update` wrapper key, and `domain_id` is a sibling of `contract`
   *     INSIDE the update object). Both carry the same inner
   *     `{contract:{template_id,contract_id,created_event_blob,payload},
   *     domain_id}`.
   *
   * Both branches return the same `AmuletRulesResponse` so downstream
   * settle code is flavor-agnostic.
   *
   * Served from a per-instance TTL cache (default 5 min, single-flight): on
   * the v1 /settle path this is fetched on every settle but is identical for
   * the lifetime of the AmuletRules contract, so caching removes one Scan
   * round-trip from almost every settle. See {@link ScanCacheOptions}.
   */
  getAmuletRules(): Promise<AmuletRulesResponse> {
    return this.amuletRulesCache.get(() => this.getAmuletRulesUncached());
  }

  /**
   * Bypass-the-cache variant of {@link getAmuletRules}: drop the cached entry,
   * refetch from Scan, and repopulate the cache with the fresh value. Used by
   * the v1 /settle `LOCAL_VERDICT_INACTIVE_CONTRACTS` retry, which must NOT be
   * served a stale AmuletRules cid when re-disclosing contracts (a stale cid is
   * exactly what triggered the retry). Repopulating means a single refresh also
   * benefits the other settles coalescing in the same round.
   */
  getAmuletRulesFresh(): Promise<AmuletRulesResponse> {
    this.amuletRulesCache.invalidate();
    return this.amuletRulesCache.get(() => this.getAmuletRulesUncached());
  }

  private async getAmuletRulesUncached(): Promise<AmuletRulesResponse> {
    if (!this.isSv) {
      return this.get<AmuletRulesResponse>(`${this.prefix}/amulet-rules`);
    }
    const raw = await this.request<{
      amulet_rules_update: AmuletRulesResponse["amulet_rules"];
    }>("POST", `${this.prefix}/amulet-rules`, {});
    return { amulet_rules: raw.amulet_rules_update };
  }

  /**
   * Open + issuing mining rounds.
   *
   * Wire difference by flavor (verified live 2026-05-30):
   *   - validator scan-proxy: GET, response arrays
   *     `{ open_mining_rounds: [{contract}], issuing_mining_rounds: [{contract}] }`.
   *   - public SV scan: POST with a REQUIRED body
   *     `{ cached_open_mining_round_contract_ids:[], cached_issuing_round_contract_ids:[] }`
   *     (empty arrays = "I have nothing cached, send everything"), and the
   *     response is a keyed MAP `{ <contractId>: {contract, domain_id} }`,
   *     NOT an array. We normalize the map's values to the array shape so
   *     downstream code is flavor-agnostic.
   *
   * Served from a per-instance TTL cache (default 30 s, single-flight). The
   * v1 /settle path re-reads this on every settle; within a mining round the
   * answer is stable, so a short TTL coalesces the burst of settles in a
   * round into one Scan round-trip. A briefly-stale round cid (which can occur
   * for up to one TTL around a round rotation) surfaces as a
   * `LOCAL_VERDICT_INACTIVE_CONTRACTS` rejection on the Send; the settle path's
   * retry calls {@link getOpenAndIssuingMiningRoundsFresh} to bypass the cache
   * and re-disclose the live round, so the cache cannot cause a wrong settle.
   * See {@link ScanCacheOptions}.
   */
  getOpenAndIssuingMiningRounds(): Promise<MiningRoundsResponse> {
    return this.miningRoundsCache.get(() =>
      this.getOpenAndIssuingMiningRoundsUncached()
    );
  }

  /**
   * Bypass-the-cache variant of {@link getOpenAndIssuingMiningRounds}: drop the
   * cached entry, refetch from Scan, and repopulate the cache. Used by the v1
   * /settle `LOCAL_VERDICT_INACTIVE_CONTRACTS` retry so a stale/archived round
   * cid (possible within one TTL of a round rotation now that rounds are
   * cached) is replaced with the live round before re-disclosing — without it
   * the retry would re-submit the SAME stale round cid and burn every attempt.
   */
  getOpenAndIssuingMiningRoundsFresh(): Promise<MiningRoundsResponse> {
    this.miningRoundsCache.invalidate();
    return this.miningRoundsCache.get(() =>
      this.getOpenAndIssuingMiningRoundsUncached()
    );
  }

  private async getOpenAndIssuingMiningRoundsUncached(): Promise<MiningRoundsResponse> {
    if (!this.isSv) {
      return this.get<MiningRoundsResponse>(
        `${this.prefix}/open-and-issuing-mining-rounds`
      );
    }
    const raw = await this.request<{
      open_mining_rounds: Record<
        string,
        MiningRoundsResponse["open_mining_rounds"][number]
      >;
      issuing_mining_rounds: Record<
        string,
        MiningRoundsResponse["issuing_mining_rounds"][number]
      >;
    }>("POST", `${this.prefix}/open-and-issuing-mining-rounds`, {
      cached_open_mining_round_contract_ids: [],
      cached_issuing_round_contract_ids: [],
    });
    return {
      open_mining_rounds: Object.values(raw.open_mining_rounds ?? {}),
      issuing_mining_rounds: Object.values(raw.issuing_mining_rounds ?? {}),
    };
  }

  /**
   * `synchronizerId` is the Global Synchronizer id (e.g.
   * `global-domain::1220xyz`). `memberId` is the participant member
   * id (e.g. `PAR::ftp-validator-1::1220abc`). Both are URL-encoded.
   *
   * On the SV Scan flavor this returns the participant's cumulative
   * sequencer burn — the primary attribution signal for M2/M3/M4.
   */
  async getTrafficStatus(
    synchronizerId: string,
    memberId: string
  ): Promise<TrafficStatusResponse> {
    const path =
      (this.prefix === "/api/scan/v0" ? "/api/scan/v0" : this.prefix) +
      `/domains/${encodeURIComponent(synchronizerId)}` +
      `/members/${encodeURIComponent(memberId)}/traffic-status`;
    return this.get<TrafficStatusResponse>(path);
  }

  /**
   * `GET /api/scan/v2/updates/{updateId}?daml_value_encoding=compact_json`
   *
   * The public-on-the-LAN Scan view of a single ledger update. Unlike the
   * participant's `transaction-by-id`, this does NOT require the caller to
   * be a transaction stakeholder — so the facilitator can read an
   * agent→merchant `TransferFactory_Transfer` it is not party to (the core
   * of the CIP-56 completed-verify fix).
   *
   * SV flavor ONLY: the endpoint lives at the Scan ROOT (`/api/scan/v2`),
   * NOT under the `/api/scan/v0` prefix used by the other reads. The
   * validator-local scan-proxy equivalent is unconfirmed, so for the
   * `validator` flavor this throws `UNSUPPORTED` and callers fall back to
   * the participant read.
   *
   * `daml_value_encoding=compact_json` makes the registry emit the Daml
   * choiceArgument/result as plain JSON (so `choice_argument.transfer.*`
   * carries `sender`/`receiver`/`amount`/`instrumentId` directly).
   */
  async getUpdateById(updateId: string): Promise<ScanUpdate> {
    if (!this.isSv) {
      throw new CantonError(
        "getUpdateById is only supported for the sv Scan flavor",
        "UNSUPPORTED"
      );
    }
    const path =
      `/api/scan/v2/updates/${encodeURIComponent(updateId)}` +
      `?daml_value_encoding=compact_json`;
    return this.request<ScanUpdate>("GET", path);
  }

  /** `GET /api/scan/v0/events/{updateId}`. SV flavor only. */
  async getEventTrafficSummary(
    updateId: string
  ): Promise<TrafficSummaryResult | null> {
    if (!this.isSv) {
      throw new CantonError(
        "getEventTrafficSummary is only supported for sv flavor",
        "UNSUPPORTED"
      );
    }
    const path = `/api/scan/v0/events/${encodeURIComponent(updateId)}`;
    const r = await this.request<ScanEventVerdictResponse>("GET", path);
    if (!r.verdict) return null;
    return {
      updateId: r.verdict.update_id,
      recordTime: r.verdict.record_time ?? null,
      verdictResult: r.verdict.verdict_result,
      submittingParticipantUid: r.verdict.submitting_participant_uid,
      submittingParties: r.verdict.submitting_parties ?? [],
      totalTrafficCost: r.traffic_summary?.total_traffic_cost ?? null,
    };
  }

  /**
   * Resolve the `transferKind` the token-standard registry would use for a
   * transfer to `receiver`, via `POST /registry/transfer-instruction/v1/
   * transfer-factory`. Read-only — no holdings, nothing submitted. We use it to
   * DETECT whether a merchant holds a `TransferPreapproval`:
   *   - `direct` → receiver is preapproved → an x402 CC payment settles
   *     atomically (Completed in one update).
   *   - `offer`  → no preapproval → two-step Pending; x402 cannot settle in
   *     one round-trip.
   *   - `self`   → sender == receiver.
   * SV flavor ONLY (the registry root path; the validator scan-proxy equivalent
   * is unconfirmed) — throws `UNSUPPORTED` otherwise so callers degrade to
   * "unknown".
   */
  async resolveTransferKind(args: {
    sender: string;
    receiver: string;
    amount: string;
    admin: string;
    id: string;
    requestedAt: string;
    executeBefore: string;
  }): Promise<string> {
    if (!this.isSv) {
      throw new CantonError(
        "resolveTransferKind is only supported for the sv Scan flavor",
        "UNSUPPORTED"
      );
    }
    const reqBody = {
      choiceArguments: {
        expectedAdmin: args.admin,
        transfer: {
          sender: args.sender,
          receiver: args.receiver,
          amount: args.amount,
          instrumentId: { admin: args.admin, id: args.id },
          requestedAt: args.requestedAt,
          executeBefore: args.executeBefore,
          inputHoldingCids: [],
          meta: { values: {} },
        },
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      excludeDebugFields: true,
    };
    const res = await this.request<{ transferKind?: string }>(
      "POST",
      "/registry/transfer-instruction/v1/transfer-factory",
      reqBody
    );
    return res.transferKind ?? "";
  }

  /**
   * Highest-numbered open mining round whose opensAt has already passed.
   * Falls back to the highest-numbered round overall when all are future-dated.
   * Used by the paid-marker-worker to bucket traffic bytes per round.
   */
  async getCurrentOpenRoundNumber(): Promise<number> {
    const data = await this.getOpenAndIssuingMiningRounds();
    const now = Date.now();
    const rounds = data.open_mining_rounds;
    const usable = rounds.filter(
      (r) =>
        !r.contract.payload.opensAt ||
        new Date(r.contract.payload.opensAt).getTime() <= now
    );
    const pool = usable.length > 0 ? usable : rounds;
    const nums = pool
      .map((r) => Number(r.contract.payload.round.number))
      .filter(Number.isFinite);
    if (nums.length === 0)
      throw new CantonError("No usable open mining rounds", "NO_ROUNDS");
    return Math.max(...nums);
  }

  /**
   * Fetch the FeaturedAppRight contract ID for a party.
   * GET /api/scan/v0/featured-apps/{party} — DSO-issued; needed by the
   * paid-marker-worker to emit FeaturedAppActivityMarker with a USD weight.
   */
  async getFeaturedAppRight(party: string): Promise<string> {
    const data = await this.get<{
      featured_app_right: { contract_id: string } | null;
    }>(`${this.prefix}/featured-apps/${encodeURIComponent(party)}`);
    if (!data.featured_app_right) {
      throw new CantonError(
        `No FeaturedAppRight for party ${party}`,
        "NOT_FOUND"
      );
    }
    return data.featured_app_right.contract_id;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /**
   * HTTP request to the Scan API, with a bounded retry on HTTP 429.
   *
   * The public SV Scan enforces a SMALL per-IP burst budget (observed live on
   * mainnet sv-2: ~2 rapid requests, then `local_rate_limited` for every
   * request after — no Retry-After header). Every Scan call here is an
   * idempotent READ, so a short backoff-and-retry is always safe and turns a
   * pacing hiccup into a slightly slower success instead of a hard failure.
   * (This was silently freezing burn-attribution rows: the retry worker's
   * batch tripped the budget, the 429s were swallowed upstream, and rows hit
   * their attempt cap as permanently 'failed' while the data was available.)
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const MAX_TRANSIENT_RETRIES = 3;
    // Try the primary base, then each fallback in order. A TRANSIENT failure
    // (429 burst, 5xx/overload, timeout, transport) is retried with backoff on
    // the SAME base; if it persists past the retry budget, fail over to the
    // next base. A NON-transient error (e.g. 404/400 — a real answer that is
    // the same on every SV) throws immediately and never burns a fallback (a
    // getUpdateById 404 is meaningful — the first-payment counter dead-zone
    // relies on it). Every Scan call here is an idempotent READ, so both the
    // retry and the failover are safe.
    const bases = [this.scanUrl, ...this.fallbackUrls];
    let lastErr: unknown;
    for (const base of bases) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.requestOnce<T>(method, path, body, base);
        } catch (err) {
          lastErr = err;
          if (!isTransientScanError(err)) throw err;
          if (attempt < MAX_TRANSIENT_RETRIES) {
            // 400/800/1600ms + jitter — rides over a brief 429/5xx/timeout
            // without stalling long, jitter avoids a thundering-herd retrace.
            await new Promise((r) =>
              setTimeout(
                r,
                400 * 2 ** attempt + Math.floor(Math.random() * 150)
              )
            );
            continue;
          }
          break; // exhausted on this base → try the next fallback (if any)
        }
      }
    }
    throw lastErr;
  }

  /**
   * Single HTTP attempt to the Scan API.
   *
   * `body === undefined` → GET (validator scan-proxy reads, traffic-status).
   * `body` provided      → POST with a JSON body. The public SV Scan
   * (`/api/scan/v0/*`) requires POST for amulet-rules and
   * open-and-issuing-mining-rounds (GET → 405). The validator scan-proxy
   * accepts GET for the same logical reads, so the per-method dispatch in
   * the callers picks the verb by flavor.
   */
  private async requestOnce<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    base: string = this.scanUrl
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
      }
      if (this.token) {
        const tok =
          typeof this.token === "string" ? this.token : await this.token();
        headers.Authorization = `Bearer ${tok}`;
      }
      const res = await this.fetchFn(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CantonError(
          `${method} ${path} returned HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          text.slice(0, 1024)
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof CantonError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new CantonError(
          `${method} ${path} aborted after ${this.timeoutMs}ms`,
          "TIMEOUT"
        );
      }
      throw new CantonError(
        `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        "TRANSPORT_ERROR"
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Try each client in order. Three distinct outcomes:
 *   - a summary            → returned immediately;
 *   - `null`               → at least one client answered CLEANLY but the
 *                            event has no verdict/summary yet — the caller
 *                            should retry later (this spends a bounded retry
 *                            attempt);
 *   - throws (last error)  → EVERY client failed to answer (rate-limit /
 *                            timeout / HTTP / transport). Callers must treat
 *                            this as "could not ask", NOT "no data": the old
 *                            silent-swallow here returned `null` for a 429
 *                            wave, the retry worker burned its bounded
 *                            attempts on an outage, and rows froze as
 *                            permanently 'failed' while the data existed.
 */
export async function getEventTrafficSummaryWithFallback(
  clients: Pick<ScanClient, "getEventTrafficSummary">[],
  updateId: string
): Promise<TrafficSummaryResult | null> {
  let lastErr: unknown = null;
  let sawCleanNull = false;
  for (const client of clients) {
    try {
      const result = await client.getEventTrafficSummary(updateId);
      if (result !== null) return result;
      sawCleanNull = true;
    } catch (err) {
      // UNSUPPORTED / timeout / HTTP error — try the next client.
      lastErr = err;
    }
  }
  if (!sawCleanNull && lastErr !== null) throw lastErr;
  return null;
}
