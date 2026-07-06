/**
 * Global Synchronizer traffic-budget monitor (proactive observability).
 *
 * On the v1 (external-party-amulet-rules) settle method, EVERY /settle burns the
 * facilitator party's GS sequencer traffic. The only prior defence was the
 * REACTIVE circuit breaker, which trips AFTER N failed Sends — i.e. once the
 * budget is already at zero and payments are already failing. This is the
 * highest-value observability gap on a live v1 deploy: there was no
 * before-the-fact signal that the budget was running low.
 *
 * This module polls `ScanClient.getTrafficStatus` on a background interval
 * (~60s, `.unref()` so it never keeps the process alive — same pattern as the
 * attribution retry worker) and logs total_consumed/total_limit at INFO, raising
 * a WARN once consumption crosses a high-water mark (default 80%).
 *
 * getTrafficStatus needs the participant MEMBER id (e.g.
 * `PAR::ftp-validator-1::1220abc`), which the facilitator does not otherwise
 * have. It is supplied via the OPTIONAL `CANTON_FACILITATOR_MEMBER_ID` config:
 *   - set   → the monitor runs.
 *   - unset → the monitor logs ONCE that it is disabled and skips entirely
 *             (inert-safe: nothing breaks when the id is absent).
 */

import type { ScanClient } from "@ftptech/x402-canton-ledger";

/** The slice of ScanClient + logger the monitor needs (keeps it unit-testable). */
export interface TrafficMonitorDeps {
  scan: Pick<ScanClient, "getTrafficStatus">;
  synchronizerId: string;
  /** Participant MEMBER id for getTrafficStatus. */
  memberId: string;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  /** Fraction (0..1) of total_limit at/above which to WARN. Default 0.8. */
  highWaterFraction?: number;
}

/**
 * Run ONE traffic-status poll: fetch, then log consumed/limit at info and warn
 * past the high-water mark. Never throws — a Scan error is logged at warn and
 * swallowed so the interval keeps polling. Returns the parsed numbers (or null
 * on error) for tests/assertions.
 *
 * Exported separately from the interval wiring so a single poll can be unit
 * tested without driving timers.
 */
export async function pollTrafficOnce(
  deps: TrafficMonitorDeps
): Promise<{ consumed: number; limit: number; fraction: number } | null> {
  const highWater = deps.highWaterFraction ?? 0.8;
  try {
    const status = await deps.scan.getTrafficStatus(
      deps.synchronizerId,
      deps.memberId
    );
    const consumed = status.traffic_status.actual.total_consumed;
    const limit = status.traffic_status.actual.total_limit;
    // limit 0 (or missing) → undefined fraction; treat as 0 to avoid div-by-zero
    // and a spurious WARN, but still surface the raw numbers at info.
    const fraction = limit > 0 ? consumed / limit : 0;
    const fields = {
      memberId: deps.memberId,
      total_consumed: consumed,
      total_limit: limit,
      fraction: Number(fraction.toFixed(4)),
    };
    if (limit > 0 && fraction >= highWater) {
      deps.log.warn(
        fields,
        `facilitator GS traffic at ${(fraction * 100).toFixed(1)}% of limit (high-water ${(highWater * 100).toFixed(0)}%)`
      );
    } else {
      deps.log.info(fields, "facilitator GS traffic budget");
    }
    return { consumed, limit, fraction };
  } catch (err) {
    deps.log.warn(
      { err, memberId: deps.memberId },
      "traffic-status poll failed"
    );
    return null;
  }
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Start the background traffic-budget poller. Returns the NodeJS.Timeout (so a
 * caller/test can clear it) or `null` when the monitor is disabled.
 *
 * Disabled (returns null, logs once) when:
 *   - `memberId` is unset/empty   → inert-safe: no CANTON_FACILITATOR_MEMBER_ID.
 *   - `intervalMs <= 0`           → explicitly turned off.
 *
 * The interval is `.unref()`-ed so it never holds the event loop open on
 * shutdown. A first poll runs immediately (so a misconfigured member id / Scan
 * outage surfaces at boot, not 60s later).
 */
export function startTrafficMonitor(
  deps: Omit<TrafficMonitorDeps, "memberId"> & {
    memberId: string | undefined;
  },
  opts?: { intervalMs?: number }
): NodeJS.Timeout | null {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!deps.memberId) {
    deps.log.info(
      {},
      "GS traffic monitor disabled: set CANTON_FACILITATOR_MEMBER_ID " +
        "(the participant MEMBER id) to enable proactive traffic-budget polling"
    );
    return null;
  }
  if (intervalMs <= 0) {
    deps.log.info({}, "GS traffic monitor disabled (interval <= 0)");
    return null;
  }

  const liveDeps: TrafficMonitorDeps = { ...deps, memberId: deps.memberId };
  // Fire-and-forget first poll at boot (errors are swallowed inside pollTrafficOnce).
  void pollTrafficOnce(liveDeps);
  const timer = setInterval(() => {
    void pollTrafficOnce(liveDeps);
  }, intervalMs);
  timer.unref();
  return timer;
}
