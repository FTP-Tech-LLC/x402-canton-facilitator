/**
 * Paid marker worker — emits one FeaturedAppActivityMarker per mining round
 * with weight based on paid traffic over the free base-rate allowance.
 *
 * Mirrors CanTrustAI's paid-marker-worker.ts pattern:
 *   - Round-gated: one emission per round (round_number is the PK).
 *   - Time-windowed: lowerBound = prev row's created_at, upperBound = this
 *     row's created_at (inserted BEFORE querying bytes → stable window).
 *   - Gap-safe: if the worker was down and skipped rounds, it seeds a new
 *     checkpoint rather than emitting for stale windows (FA Rule 5).
 *   - Idempotent: commandId = `x402-round-marker-{round}` → Canton dedup.
 *
 * featuredAppRightCid + synchronizerId are resolved ONCE at startup (cached
 * in the loop closure) to avoid per-tick Scan round-trips.
 */
import type { FastifyBaseLogger } from "fastify";
import type { CantonClient } from "@ftptech/x402-canton-ledger";
import type { ScanClient } from "@ftptech/x402-canton-ledger";
import { emitX402RoundMarker } from "@ftptech/x402-canton-ledger";
import type { MarkerStore } from "../db/marker-store.js";

const TICK_INTERVAL_MS = 60_000;
const TRAFFIC_PRICE_USD_PER_MB = 60;
// Free base-rate traffic credited per round per FA guidance (0.1 MB).
// The node's built-in FA emission already covers this window, so we subtract it
// from x402 bytes to isolate the paid portion and avoid double-counting overage.
const FREE_BYTES_PER_ROUND = 100_000;

export interface PaidMarkerWorkerServices {
  markerStore: MarkerStore;
  client: CantonClient;
  scan: ScanClient;
  markerFtpParty: string;
  markerUserId: string;
  /** Uplift over directly-attributed bytes (Send + CreateTransferCommand) to
   *  cover x402-driven txs the attribution table never sees (~1
   *  AmuletRules_Transfer per ~10 payments). Env-driven (config default 1.35),
   *  so it can be re-tuned with a restart and no rebuild. */
  markerWeightMultiplier: number;
}

type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

/**
 * Process ONE mining round: establish the [prevRow.created_at, thisRow.created_at)
 * window, gap-check (seed instead of emit on a round gap — FA Rule 5), sum the
 * paid-overage traffic bytes for the window, and emit a FeaturedAppActivityMarker
 * weighted by bytes-over-free * multiplier (or mark skipped when there is no
 * paid overage). Exported for the deterministic offline simulation of the
 * MainNet worker (paid-marker-worker.test.ts) — production drives it via
 * processAllRounds.
 */
export async function processRound(
  targetRound: number,
  currentRound: number,
  services: PaidMarkerWorkerServices,
  featuredAppRightCid: string,
  synchronizerId: string,
  log: Logger
): Promise<void> {
  const { markerStore: store, client, markerFtpParty, markerUserId, markerWeightMultiplier } = services;

  const prevRow = await store.getPrevRound(targetRound);
  const lowerBound = prevRow?.created_at ?? new Date(0);

  // INSERT establishes the stable upperBound for this round's window.
  // ON CONFLICT DO NOTHING: on retry the row already exists with the same created_at.
  await store.insertPending(targetRound);
  const row = await store.getRow(targetRound);
  if (!row) {
    log.warn({ targetRound }, "marker_worker: getRow returned undefined after insert");
    return;
  }
  const upperBound = row.created_at;

  // Gap check: if the worker was down and missed rounds, emitting would include
  // bytes from >1 round ago. Seed a checkpoint instead (mirrors CanTrustAI).
  if (prevRow && prevRow.round_number !== targetRound - 1) {
    await store.updateStatus(targetRound, "seeded");
    log.warn(
      { prevRound: prevRow.round_number, targetRound },
      "marker_worker: round gap detected — seeding checkpoint, skipping emission"
    );
    return;
  }

  const totalBytes = await store.getTrafficBytesInWindow(lowerBound, upperBound);
  const eligibleBytes = Math.max(0, Number(totalBytes) - FREE_BYTES_PER_ROUND);
  const totalUsd = eligibleBytes / 1_000_000 * TRAFFIC_PRICE_USD_PER_MB * markerWeightMultiplier;

  if (totalUsd <= 0) {
    await store.updateStatus(targetRound, "skipped", {
      traffic_bytes: totalBytes,
      traffic_usd: "0",
    });
    log.info({ targetRound }, "marker_worker: round skipped (no paid-overage traffic bytes)");
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
      traffic_bytes: totalBytes,
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
      traffic_bytes: totalBytes,
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
      // First ever run — seed a checkpoint without emitting.
      await store.insertPending(currentRound);
      await store.updateStatus(currentRound, "seeded");
      log.info({ currentRound }, "marker_worker: seeded initial checkpoint");
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
