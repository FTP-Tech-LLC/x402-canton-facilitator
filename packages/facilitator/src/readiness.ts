/**
 * Readiness probe for GET /ready (health/readiness split).
 *
 * /health is a static liveness signal ("the process is up and answering").
 * /ready answers the operationally-meaningful question: can this facilitator
 * actually SETTLE right now? A settle needs (a) a valid ledger-API token, (b) a
 * reachable participant, and (c) reachable Scan DSO-state. The old setup pointed
 * the Docker HEALTHCHECK at the static /health literal, so a container reported
 * "healthy" even when settle was impossible (expired OIDC client, participant
 * down, Scan unreachable). This probe closes that gap.
 *
 * Design:
 *   - A set of named async checks (token / participant / scan). Each resolves to
 *     { ok, detail? } and NEVER throws — a thrown error is caught and mapped to
 *     { ok:false } so one failing dep cannot crash the probe.
 *   - Results are CACHED for a short TTL (default ~12s) so a scrape/HEALTHCHECK
 *     storm cannot turn the probe itself into a load source on the participant /
 *     Scan / IdP. A single-flight guard coalesces concurrent refreshes.
 *   - `evaluate()` returns { ready, checks } where ready = every check ok. The
 *     route maps ready→200 / not-ready→503 and always returns the per-dep
 *     breakdown so an operator sees WHICH dep is down.
 *
 * Timekeeping uses an injectable `now()` so tests drive TTL expiry deterministically.
 */

export interface ReadinessCheckResult {
  ok: boolean;
  /** Short human-readable detail (error class / message). Omitted on success. */
  detail?: string;
}

/** One named dependency check. Should resolve (not reject) — but the probe
 *  defends against rejection anyway. */
export type ReadinessCheck = () => Promise<ReadinessCheckResult>;

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, ReadinessCheckResult>;
  /** True when this report was served from cache (debug aid; not in the wire body). */
  cached: boolean;
}

export interface ReadinessProbe {
  /** Evaluate readiness, honouring the TTL cache. */
  evaluate(): Promise<ReadinessReport>;
}

const DEFAULT_TTL_MS = 12_000;

/**
 * Build a readiness probe from a map of named checks.
 *
 * `ttlMs` (default 12s) is the cache window — within it, repeated `evaluate()`
 * calls return the last computed report without re-running the checks. `0`
 * disables caching (every call re-runs the checks; still single-flighted).
 */
export function createReadinessProbe(
  checks: Record<string, ReadinessCheck>,
  opts?: { ttlMs?: number; now?: () => number }
): ReadinessProbe {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  const names = Object.keys(checks);

  let cached: ReadinessReport | null = null;
  let cachedAt = -Infinity;
  let inFlight: Promise<ReadinessReport> | null = null;

  const runAll = async (): Promise<ReadinessReport> => {
    const entries = await Promise.all(
      names.map(async (name): Promise<[string, ReadinessCheckResult]> => {
        try {
          const r = await checks[name]!();
          return [name, r];
        } catch (err) {
          // A check MUST NOT crash the probe: a thrown error is an unhealthy dep.
          return [
            name,
            {
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            },
          ];
        }
      })
    );
    const result: Record<string, ReadinessCheckResult> = {};
    for (const [name, r] of entries) result[name] = r;
    const ready = entries.every(([, r]) => r.ok);
    return { ready, checks: result, cached: false };
  };

  return {
    async evaluate(): Promise<ReadinessReport> {
      const t = now();
      // Fresh cache hit — return the prior report flagged as cached.
      if (ttlMs > 0 && cached && t - cachedAt < ttlMs) {
        return { ...cached, cached: true };
      }
      // Coalesce concurrent refreshes onto a single in-flight run.
      if (inFlight) return inFlight;

      const p = (async () => {
        const report = await runAll();
        cached = report;
        cachedAt = now();
        return report;
      })();
      inFlight = p;
      try {
        return await p;
      } finally {
        if (inFlight === p) inFlight = null;
      }
    },
  };
}
