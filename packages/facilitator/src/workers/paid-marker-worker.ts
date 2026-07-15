/**
 * Marker worker — emits one FeaturedAppActivityMarker per mining round, weighted
 * by the validator's TOTAL Global Synchronizer traffic for that round.
 *
 *   - Round-gated: one emission per round (round_number is the PK).
 *   - Total-traffic: weight = Δ total_consumed/1e6 * $60/MB * mult,
 *     where total_consumed is the participant's cumulative GS traffic from Scan
 *     getTrafficStatus. The per-round delta between snapshots covers ALL traffic
 *     (payments + faucet + onboard + accept), not just attributed x402 payments.
 *   - Gap-safe: if the worker was down, a delta would span >1 round → seed a fresh
 *     snapshot instead of emitting (FA Rule 5).
 *   - Clamped: per-round weight is capped at maxWeightPerRound, so an abuse/anomaly
 *     spike can never be amplified into an FA overuse-cap breach / revocation.
 *   - Idempotent: commandId = `x402-round-marker-{round}` → Canton dedup.
 *
 * featuredAppRightCid + synchronizerId are resolved ONCE at startup (cached in the
 * loop closure) to avoid per-tick Scan round-trips.
 */
import type { FastifyBaseLogger } from "fastify";
import type { CantonClient } from "@ftptech/x402-canton-ledger";
import type { ScanClient } from "@ftptech/x402-canton-ledger";
import { emitX402RoundMarker } from "@ftptech/x402-canton-ledger";
import type { MarkerStore } from "../db/marker-store.js";

const TICK_INTERVAL_MS = 60_000;
const TRAFFIC_PRICE_USD_PER_MB = 60;
// No free-tier deduction in total-traffic mode: `total_consumed` counts only
// PURCHASED traffic (the free base rate is not billed against it — consumed never
// exceeds total_purchased), and the node's built-in FA emission already claims
// that free base, which is NOT in this metric. So the whole per-round delta is
// paid overage and fully markable; subtracting a free tier would discard real
// paid bytes with no double-count to prevent.

export interface PaidMarkerWorkerServices {
  markerStore: MarkerStore;
  client: CantonClient;
  scan: ScanClient;
  markerFtpParty: string;
  markerUserId: string;
  /** Overuse / cost-recovery coefficient applied to the round's total GS traffic
   *  (target 1.15 = +15%). Env-driven (CANTON_X402_MARKER_WEIGHT_MULTIPLIER),
   *  re-tunable with a restart and no rebuild. In total-traffic mode the old
   *  1.35 unattributed-tx uplift is moot — total already includes everything. */
  markerWeightMultiplier: number;
  /** Participant MEMBER id for scan.getTrafficStatus — `PAR::${facilitatorParty}`. */
  facilitatorMemberId: string;
  /** Hard per-round weight ceiling (USD). Clamps abuse/anomaly spikes so a single
   *  round can never be amplified into an FA overuse-cap breach / revocation. */
  maxWeightPerRound: number;
}

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

/**
 * Process ONE mining round: read the validator's cumulative GS traffic snapshot
 * (Scan getTrafficStatus), gap-check (seed instead of emit on a round gap — FA
 * Rule 5), compute the delta over the previous round's snapshot, and emit a
 * FeaturedAppActivityMarker weighted by (delta-over-free) * multiplier, clamped to
 * maxWeightPerRound (or mark skipped when the round had no new traffic).
 * Exported for the deterministic offline simulation of the MainNet worker
 * (paid-marker-worker.test.ts) — production drives it via processAllRounds.
 */
export async function processRound(
  targetRound: number,
  currentRound: number,
  services: PaidMarkerWorkerServices,
  featuredAppRightCid: string,
  synchronizerId: string,
  log: Logger
): Promise<void> {
  const {
    markerStore: store,
    client,
    scan,
    markerFtpParty,
    markerUserId,
    markerWeightMultiplier,
    facilitatorMemberId,
    maxWeightPerRound,
  } = services;

  const prevRow = await store.getPrevRound(targetRound);

  // The round row tracks status; ON CONFLICT DO NOTHING is idempotent on retry.
  await store.insertPending(targetRound);
  const row = await store.getRow(targetRound);
  if (!row) {
    log.warn({ targetRound }, "marker_worker: getRow returned undefined after insert");
    return;
  }

  // Read the validator's cumulative GS traffic. On a Scan failure, skip the round
  // (the row stays pending → retried next tick); NEVER emit a wrong weight.
  let consumed: number;
  try {
    const trafficStatus = await scan.getTrafficStatus(synchronizerId, facilitatorMemberId);
    consumed = trafficStatus.traffic_status.actual.total_consumed;
  } catch (err) {
    log.warn({ targetRound, err }, "marker_worker: traffic-status read failed — skipping round");
    return;
  }
  const consumedBig = BigInt(Math.trunc(consumed));

  // Gap: worker was down, so a delta would span >1 round. Seed with the current
  // snapshot (no emit) so the next round has a fresh baseline (FA Rule 5).
  if (prevRow && prevRow.round_number !== targetRound - 1) {
    await store.updateStatus(targetRound, "seeded", { traffic_consumed: consumedBig });
    log.warn(
      { prevRound: prevRow.round_number, targetRound },
      "marker_worker: round gap detected — seeding checkpoint, skipping emission"
    );
    return;
  }

  // First run / no prior snapshot: seed the baseline, do not emit.
  if (prevRow?.traffic_consumed == null) {
    await store.updateStatus(targetRound, "seeded", { traffic_consumed: consumedBig });
    log.info({ targetRound }, "marker_worker: seeded first traffic snapshot");
    return;
  }

  const deltaBytes = consumed - Number(prevRow.traffic_consumed);
  if (deltaBytes < 0) {
    // Counter reset / anomaly — snapshot forward and skip this round.
    await store.updateStatus(targetRound, "skipped", {
      traffic_consumed: consumedBig,
      traffic_usd: "0",
    });
    log.warn({ targetRound, deltaBytes }, "marker_worker: negative consumed delta — skipped");
    return;
  }

  const totalBytesBig = BigInt(Math.trunc(deltaBytes));
  // Whole delta is paid overage (see constants above) — no free-tier deduction.
  const rawUsd = (deltaBytes / 1_000_000) * TRAFFIC_PRICE_USD_PER_MB * markerWeightMultiplier;
  // Clamp to the hard per-round ceiling — an abuse/anomaly spike is capped here,
  // never amplified into an FA overuse-cap breach.
  const totalUsd = Math.min(rawUsd, maxWeightPerRound);
  if (totalUsd < rawUsd) {
    log.warn(
      { targetRound, rawUsd: rawUsd.toFixed(2), cap: maxWeightPerRound },
      "marker_worker: weight clamped to max-per-round (traffic spike)"
    );
  }

  if (totalUsd <= 0) {
    await store.updateStatus(targetRound, "skipped", {
      traffic_bytes: totalBytesBig,
      traffic_consumed: consumedBig,
      traffic_usd: "0",
    });
    log.info({ targetRound }, "marker_worker: round skipped (no new traffic this round)");
    return;
  }

  try {
    const result = await emitX402RoundMarker(client, {
      app: markerFtpParty,
      userId: markerUserId,
      synchronizerId,
      featuredAppRightCid,
      weight: totalUsd,
      roundNumber: targetRound,
    });
    await store.updateStatus(targetRound, "emitted", {
      traffic_bytes: totalBytesBig,
      traffic_consumed: consumedBig,
      traffic_usd: totalUsd.toFixed(10),
      weight: totalUsd.toFixed(10),
      update_id: result.updateId,
    });
    log.info(
      { targetRound, weight: totalUsd.toFixed(4), updateId: result.updateId },
      "marker_worker: emitted"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = currentRound > targetRound + 1 ? "expired" : "failed";
    await store.updateStatus(targetRound, status, {
      traffic_bytes: totalBytesBig,
      traffic_consumed: consumedBig,
      traffic_usd: totalUsd.toFixed(10),
      error_message: msg.slice(0, 500),
    });
    log.error({ targetRound, status, err }, "marker_worker: emission failed");
  }
}

/**
 * One worker tick: read the current open round, expire stale rows (FA Rule 5),
 * process the current round (first-run seed / crash-recovery retry / normal
 * advance), then catch up recent pending/failed rows (up to 3 rounds back).
 * Exported for the deterministic offline simulation (paid-marker-worker.test.ts);
 * production calls it on the 60s interval inside startPaidMarkerWorker.
 */
export async function processAllRounds(
  services: PaidMarkerWorkerServices,
  featuredAppRightCid: string,
  synchronizerId: string,
  log: Logger
): Promise<void> {
  const { markerStore: store, scan } = services;

  const currentRound = await scan.getCurrentOpenRoundNumber();

  // Expire all pending/failed rows that are more than 1 round old (FA Rule 5).
  await store.expireRows(currentRound - 1);

  // Process current round.
  const currentRow = await store.getRow(currentRound);

  if (!currentRow) {
    if (await store.isEmpty()) {
      // First-ever run — processRound seeds the baseline traffic snapshot (no
      // prevRow → no emit) so the very next round can delta immediately.
      await processRound(currentRound, currentRound, services, featuredAppRightCid, synchronizerId, log);
      return;
    }
    await processRound(currentRound, currentRound, services, featuredAppRightCid, synchronizerId, log);
  } else if (currentRow.status === "failed" || currentRow.status === "pending") {
    // Crash recovery: retry the current round.
    await processRound(currentRound, currentRound, services, featuredAppRightCid, synchronizerId, log);
  }

  // Retry recent pending/failed rows (up to 3 rounds back).
  const retryRows = await store.getPendingRetry(currentRound - 3, currentRound);
  for (const r of retryRows) {
    if (currentRound > r.round_number + 1) {
      await store.updateStatus(r.round_number, "expired");
      log.info({ round: r.round_number }, "marker_worker: expired stale retry row");
    } else {
      await processRound(r.round_number, currentRound, services, featuredAppRightCid, synchronizerId, log);
    }
  }
}

export function startPaidMarkerWorker(
  services: PaidMarkerWorkerServices,
  app: { log: Logger }
): void {
  const log = app.log;
  log.info("marker_worker: starting (interval=60s)");

  // Resolve featuredAppRightCid + synchronizerId once at startup.
  // Both are stable across rounds; no need to re-fetch per tick.
  Promise.all([
    services.scan.getFeaturedAppRight(services.markerFtpParty),
    services.scan.getAmuletRules().then((amulet: { amulet_rules: { domain_id: string } }) => amulet.amulet_rules.domain_id),
  ])
    .then(([featuredAppRightCid, synchronizerId]) => {
      log.info({ featuredAppRightCid, synchronizerId }, "marker_worker: resolved startup deps");

      let running = true;
      const tick = async (): Promise<void> => {
        while (running) {
          const start = Date.now();
          try {
            await processAllRounds(services, featuredAppRightCid, synchronizerId, log);
          } catch (err) {
            log.error({ err }, "marker_worker: tick failed");
          }
          const wait = Math.max(0, TICK_INTERVAL_MS - (Date.now() - start));
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      };

      void tick();

      // Allow graceful shutdown if the process exits.
      const stop = (): void => { running = false; };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    })
    .catch((err) => {
      log.error({ err }, "marker_worker: failed to resolve startup deps — worker disabled");
    });
}
