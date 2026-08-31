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

/**
 * The floor the DAML choice enforces, quoted from the participant's own
 * rejection rather than inferred:
 *
 *   "The requirement 'Weight >= 1.0' was not met."
 *
 * A constant, not config: it is the ledger's rule, not our policy. If the DAML
 * ever changes it, this number is wrong and the symptom is the same HTTP 400 —
 * which is why the log line above prints the floor it applied.
 */
const MIN_LEDGER_WEIGHT = 1.0;
// `total_consumed` counts only PURCHASED traffic — the free base rate is not
// billed against it (consumed never exceeds total_purchased). Whether the free
// base ALSO needs claiming here depends on the node: if the node's own built-in
// FA emission for the free base is off, claiming it here recovers it; if that
// emission is on, claiming it here DOUBLE-counts and over-emits markers. Only
// the node operator can see which, so this is an env knob
// (`CANTON_X402_MARKER_FREE_BYTES_PER_ROUND`) and NOT a constant — it defaults
// to 0 (claim nothing extra, the fail-safe direction) and is re-tunable with a
// restart and no image rebuild, exactly like markerWeightMultiplier.

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
  /** Per-round free-base traffic grant (bytes) added to the paid delta before
   *  pricing (`CANTON_X402_MARKER_FREE_BYTES_PER_ROUND`). 0 = claim nothing
   *  extra; set it ONLY when the node's own free-base FA emission is off, or
   *  markers double-count. See the note at the top of this file. */
  freeBytesPerRound: number;
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
    freeBytesPerRound,
  } = services;

  const prevRow = await store.getPrevRound(targetRound);

  // The round row tracks status; ON CONFLICT DO NOTHING is idempotent on retry.
  await store.insertPending(targetRound);
  const row = await store.getRow(targetRound);
  if (!row) {
    log.warn({ targetRound }, "marker_worker: getRow returned undefined after insert");
    return;
  }

  // The right edge of THIS round's traffic window.
  //
  // On a RETRY, reuse the snapshot the first attempt already recorded. A fresh
  // live read would be a reading of NOW, and a retry happens in a later round —
  // so the round's window would silently stretch forward over traffic the
  // rounds in between have already claimed.
  //
  // That is not hypothetical, it is the order processAllRounds runs in: the
  // CURRENT round is processed first, and only then are pending/failed rows up
  // to three rounds back retried. Measured on the deterministic simulation:
  // round 100 fails at 1.6 MB, round 101 emits 1.6 -> 2.2 MB (weight 41.4),
  // then round 100 is retried off a live read and priced 1.0 -> 2.2 MB —
  // weight 82.8, exactly double its true 41.4, with the extra being precisely
  // what round 101 had just claimed. Two markers, one lot of bytes. The
  // per-round clamp cannot see it because each marker is separately under the
  // cap, and over-claiming is the direction that risks the Featured-App
  // overuse cap and the right being revoked.
  //
  // The failure path stores traffic_consumed precisely so this is possible: the
  // number was true when it was read, and a round's window does not move.
  let consumed: number;
  const recorded = row.traffic_consumed;
  if (recorded !== null && recorded !== undefined) {
    consumed = Number(recorded);
    log.info(
      { targetRound, consumed },
      "marker_worker: retry — pricing from the snapshot this round recorded, not a live read"
    );
  } else {
    try {
      const trafficStatus = await scan.getTrafficStatus(synchronizerId, facilitatorMemberId);
      consumed = trafficStatus.traffic_status.actual.total_consumed;
    } catch (err) {
      log.warn({ targetRound, err }, "marker_worker: traffic-status read failed — skipping round");
      return;
    }
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
  // Weight = paid delta PLUS the configured per-round free-base grant (see the
  // note at the top of this file). At the default 0 the weight is exactly the
  // purchased delta. traffic_bytes always stays the REAL purchased delta; only
  // the priced weight can include the grant.
  const markableBytes = deltaBytes + freeBytesPerRound;
  const rawUsd = (markableBytes / 1_000_000) * TRAFFIC_PRICE_USD_PER_MB * markerWeightMultiplier;
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

  // THE LEDGER HAS A FLOOR AND THIS GUARD DID NOT KNOW IT.
  //
  // The guard above tests `<= 0`, but the DAML choice asserts `Weight >= 1.0`
  // and says so in its own words on rejection:
  //
  //   DAML_FAILURE ... UNHANDLED_EXCEPTION/DA.Exception.AssertionFailed:
  //   "The requirement 'Weight >= 1.0' was not met."
  //
  // So every round priced in (0, 1) was submitted, refused with HTTP 400,
  // retried once a minute until the round moved on, and finally recorded
  // `expired`. Measured on the live table: 5,822 rounds have emitted and the
  // SMALLEST weight among them is 1.0000620000 — not once below the floor —
  // while 207 rounds died this way. It bites harder as traffic per round falls,
  // which is why the rate rose when the average round dropped from ~207 KB to
  // ~41 KB.
  //
  // The bytes are NOT discarded. The checkpoint is deliberately left where the
  // previous round put it, so this round's traffic rolls into the next one and
  // is claimed there once the accumulated weight clears the floor. Advancing it
  // (what the zero-delta skip above correctly does, because there is nothing to
  // carry) would silently throw away real purchased traffic.
  //
  // This cannot double-count: nothing is emitted for a carried round, so no
  // marker claims those bytes until one marker claims them all, exactly once.
  if (totalUsd < MIN_LEDGER_WEIGHT) {
    await store.updateStatus(targetRound, "skipped", {
      traffic_bytes: totalBytesBig,
      // NOT consumedBig — carry the previous edge forward.
      traffic_consumed: BigInt(Number(prevRow.traffic_consumed)),
      traffic_usd: totalUsd.toFixed(10),
    });
    log.info(
      { targetRound, weight: totalUsd.toFixed(4), floor: MIN_LEDGER_WEIGHT },
      "marker_worker: below the ledger's Weight >= 1.0 floor — carried into the next round " +
        "instead of submitting a marker the participant would refuse"
    );
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

  let running = true;
  const tick = async (): Promise<void> => {
    // featuredAppRightCid + synchronizerId are stable across rounds, so they are
    // resolved once and cached for the process lifetime — but the resolution is
    // attempted INSIDE the loop, not before it.
    //
    // It used to sit outside, and its `.catch` logged "worker disabled" and
    // returned. Both reads go to Scan, whose 503/429 shedding is common enough
    // that this repo carries a bounded retry and a multi-SV failover for it. An
    // outage lasting longer than that budget at the moment the process starts —
    // and the process starts on every deploy — silently ended marker emission
    // until a human noticed and restarted. Markers are the validator's app
    // rewards, so the cost is revenue, and nothing surfaced it: no metric, no
    // /ready check, one log line at boot.
    let deps: { featuredAppRightCid: string; synchronizerId: string } | null =
      null;
    while (running) {
      const start = Date.now();
      try {
        if (!deps) {
          const [featuredAppRightCid, synchronizerId] = await Promise.all([
            services.scan.getFeaturedAppRight(services.markerFtpParty),
            services.scan
              .getAmuletRules()
              .then(
                (amulet: { amulet_rules: { domain_id: string } }) =>
                  amulet.amulet_rules.domain_id
              ),
          ]);
          deps = { featuredAppRightCid, synchronizerId };
          log.info(deps, "marker_worker: resolved startup deps");
        }
        await processAllRounds(
          services,
          deps.featuredAppRightCid,
          deps.synchronizerId,
          log
        );
      } catch (err) {
        log.error({ err }, "marker_worker: tick failed");
      }
      const wait = Math.max(0, TICK_INTERVAL_MS - (Date.now() - start));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };

  void tick();

  // Allow graceful shutdown if the process exits.
  const stop = (): void => {
    running = false;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
