/**
 * Canton x402 facilitator HTTP server.
 *
 * Conforms to the x402-foundation facilitator protocol contract:
 *   - POST /verify
 *   - POST /settle
 *   - GET  /supported
 *   - GET  /discovery/resources
 *   - GET  /health
 *   - POST /close
 *
 * The server logs `"Facilitator listening"` on startup, handles
 * SIGTERM/SIGINT gracefully, and exits 0 on `POST /close` per the
 * conformance harness requirement
 * (x402-foundation/x402/e2e/facilitators/text-facilitator-protocol.txt).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { buildServices, type Services } from "./services.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerReadyRoute } from "./routes/ready.js";
import { registerMetricsRoute } from "./routes/metrics.js";
import { registerSupportedRoute } from "./routes/supported.js";
import { registerCloseRoute } from "./routes/close.js";
import { registerVerifyRoute } from "./routes/verify.js";
import { registerSettleRoute } from "./routes/settle.js";
import { registerDiscoveryResourcesRoute } from "./routes/discovery-resources.js";
import { registerRegistryRoutes } from "./registry/routes.js";
import { registerWalletRoutes } from "./routes/wallet.js";
import { registerAttributionRoute } from "./routes/attribution.js";
import { getEventTrafficSummaryWithFallback } from "@ftptech/x402-canton-ledger";
import { startTrafficMonitor } from "./traffic-monitor.js";
import { startPaidMarkerWorker } from "./workers/paid-marker-worker.js";
import { cantonErrSerializer } from "./log-serializers.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const services = buildServices(config);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Custom err serializer so CantonError's code/status/responseBody (the
      // actual ledger reason: traffic vs nonce vs auth) appear in `{ err }` log
      // lines instead of being dropped by pino's default err serializer.
      serializers: {
        err: cantonErrSerializer,
      },
    },
    // 8 MiB. The relay /v1/wallet/* POSTs (prepare/execute/allocate/onboard)
    // carry a prepared Canton tx plus disclosed contracts (AmuletRules blob +
    // mining rounds + one blob per input holding), which blows past a tight
    // limit once a wallet holds many amulets. /verify and /settle bodies stay
    // small and are rate-limited, so the wider limit is not an abuse surface.
    bodyLimit: 8 * 1024 * 1024,
    disableRequestLogging: false,
    // The facilitator runs behind a reverse proxy (Caddy/Nginx). `trustProxy`
    // controls how Fastify resolves `req.ip` from X-Forwarded-For — this is the
    // rate-limit key for /verify and the 2nd key for /settle, so it must NOT be
    // attacker-forgeable. Default trusts ONLY the loopback proxy (config), which
    // makes `req.ip` the real client appended on the right of XFF and truncates
    // any client-forged left-hand entries. `trustProxy: true` (whole-chain
    // trust) would let a client set `req.ip` to an arbitrary value via XFF and
    // defeat both limiters; it is opt-in and warned about below.
    trustProxy: config.trustProxy,
  });

  if (config.trustProxy === true) {
    app.log.warn(
      "CANTON_X402_TRUST_PROXY=true trusts the ENTIRE X-Forwarded-For chain — " +
        "req.ip becomes client-forgeable and the /verify + /settle IP rate-limits " +
        "can be evaded by rotating X-Forwarded-For. Set it to your proxy's IP/CIDR " +
        "(or a hop count, or leave unset for loopback-only) instead."
    );
  }

  // Allow POST /close (and any other route) to receive an empty body
  // even when Content-Type is application/json. The x402 conformance
  // harness sends `POST /close` with no body. Without this, Fastify's
  // default JSON parser returns FST_ERR_CTP_EMPTY_JSON_BODY (400).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const s = body as string;
      if (!s || s.trim() === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(s));
      } catch (err) {
        const e = err as Error;
        // Fastify maps errors without statusCode to HTTP 500.
        // Explicitly set 400 so malformed JSON returns a client error,
        // not a server error that leaks implementation details.
        const parseErr = Object.assign(
          new Error(`invalid request body: ${e.message}`),
          { statusCode: 400 }
        );
        done(parseErr, undefined);
      }
    }
  );

  // Expose v1 and v2 headers across CORS for browser-side x402 clients.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header(
      "Access-Control-Expose-Headers",
      "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, PAYMENT-REQUIRED"
    );
    return payload;
  });

  // Normalize Fastify internal errors (413 body-too-large, 415 bad content-type)
  // so responses don't expose `FST_ERR_*` internal code strings.
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({ error: "Payload Too Large", statusCode: 413 });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message, statusCode: status });
    }
    reply.code(status).send({ error: "Internal Server Error", statusCode: status });
  });

  await registerHealthRoute(app);
  await registerReadyRoute(app, services.readiness);
  await registerMetricsRoute(app, services.metrics);
  await registerSupportedRoute(app, config);
  await registerVerifyRoute(app, services);
  await registerSettleRoute(app, services);
  await registerDiscoveryResourcesRoute(app, config);
  await registerRegistryRoutes(app, services);
  await registerWalletRoutes(app, services);
  // transfer-factory stash hygiene: expired-unsettled rows can never settle
  // (the ledger rejects past-executeBefore transfers) and settled rows only
  // need to live for the legit-retry idempotency window. 60s cadence, 10min
  // grace on unsettled, 24h retention on settled.
  if (services.tfPay) {
    const stash = services.tfPay.stash;
    setInterval(() => {
      stash
        .sweep(new Date(), 600_000, 86_400_000)
        .catch((err) =>
          app.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "tf stash sweep failed"
          )
        );
    }, 60_000).unref();
  }
  await registerCloseRoute(app, config.enableCloseRoute);
  await registerAttributionRoute(app, services);  // before listen — decision #9

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info("Facilitator listening");

  startAttributionRetryWorker(services, app);

  if (services.markerStore && services.markerFtpParty && services.markerUserId) {
    startPaidMarkerWorker(
      {
        markerStore: services.markerStore,
        client: services.client,
        scan: services.scan,
        markerFtpParty: services.markerFtpParty,
        markerUserId: services.markerUserId,
        markerWeightMultiplier: services.markerWeightMultiplier,
      },
      app
    );
  }

  // Proactive GS traffic-budget monitor (v1 settle burns the facilitator
  // party's sequencer traffic on every payment). Inert when
  // CANTON_FACILITATOR_MEMBER_ID is unset — it logs once and skips.
  startTrafficMonitor({
    scan: services.scan,
    synchronizerId: services.synchronizerId,
    memberId: services.facilitatorMemberId,
    log: {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const MAX_FETCH_ATTEMPTS = 10;

function startAttributionRetryWorker(
  services: Services,
  app: FastifyInstance
): void {
  if (!services.attribution || services.attributionScanClients.length === 0) return;

  // Tick interval is config-driven (CANTON_X402_ATTRIBUTION_RETRY_MS, default
  // 60s — the old fixed 5 minutes left rows byte-less for up to half a mining
  // round, starving the per-round marker weights). Guarded against overlap: a
  // tick with many pending rows (each paced 500ms) can outlast a short
  // interval, and stacked ticks would double-fetch the same rows and re-burst
  // the Scan rate limit the pacing exists to avoid.
  const intervalMs = services.attributionRetryIntervalMs;
  let tickRunning = false;

  setInterval(async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      await runAttributionTick(services, app);
    } finally {
      tickRunning = false;
    }
  }, intervalMs).unref();
}

async function runAttributionTick(
  services: Services,
  app: FastifyInstance
): Promise<void> {
  {
    // Repair: promote 'attempted' rows confirmed by the consumed store.
    try {
      const attempted = await services.attribution!.getAttempted(100);
      for (const { updateId } of attempted) {
        try {
          if (await services.consumed.has(updateId)) {
            await services.attribution!.markServed(updateId);
          }
        } catch (err) {
          app.log.warn({ err, updateId }, "attribution_repair_failed");
        }
      }
    } catch (err) {
      app.log.warn({ err }, "attribution_get_attempted_failed");
    }

    // Retry: fetch traffic bytes for pending served rows (Send).
    //
    // PACING + ERROR CLASSIFICATION (the attribution-undercount fix). The
    // public SV Scan enforces a tiny per-IP burst budget (observed live on
    // mainnet sv-2: ~2 rapid requests, then HTTP 429 `local_rate_limited`),
    // so the old unpaced 100+100 batch tripped it on every tick: the Send
    // loop won the budget, every Create fetch 429'd, and — because a THROWN
    // fetch was counted exactly like a clean "no verdict yet" — rows burned
    // their bounded attempts on an OUTAGE and froze as permanently 'failed'
    // while the data was fetchable one request at a time. Now: (1) a small
    // delay between fetches keeps each tick under the budget (the 5-minute
    // interval has room for 200 paced fetches), and (2) a thrown fetch only
    // logs — attempts are spent ONLY on a clean null (event genuinely not
    // sequenced/visible yet), so a rate-limit or Scan outage can never freeze
    // a recoverable row.
    const PACE_MS = 500;
    const pace = () => new Promise((r) => setTimeout(r, PACE_MS));
    try {
      const pending = await services.attribution!.getPending(
        100,
        MAX_FETCH_ATTEMPTS
      );
      for (const { updateId } of pending) {
        await pace();
        try {
          const result = await getEventTrafficSummaryWithFallback(
            services.attributionScanClients,
            updateId
          );
          if (result !== null) {
            await services.attribution!.updateTrafficSummary(updateId, result);
          } else {
            await services.attribution!.incrementFetchAttempts(
              updateId,
              MAX_FETCH_ATTEMPTS
            );
          }
        } catch (err) {
          // All scan clients errored — "could not ask", not "no data". Log
          // loudly, leave the attempt budget intact for the next tick.
          app.log.warn({ err, updateId }, "attribution_retry_failed");
        }
      }
    } catch (err) {
      app.log.warn({ err }, "attribution_get_pending_failed");
    }

    // Retry: fetch traffic bytes for pending Create rows (v1 relay path).
    try {
      const pendingCreate = await services.attribution!.getPendingCreate(
        100,
        MAX_FETCH_ATTEMPTS
      );
      for (const { updateId, createUpdateId } of pendingCreate) {
        await pace();
        try {
          const result = await getEventTrafficSummaryWithFallback(
            services.attributionScanClients,
            createUpdateId
          );
          if (result !== null) {
            await services.attribution!.updateCreateTrafficSummary(updateId, result);
          } else {
            await services.attribution!.incrementCreateFetchAttempts(
              updateId,
              MAX_FETCH_ATTEMPTS
            );
          }
        } catch (err) {
          // See above: a thrown fetch must not spend the bounded attempts.
          app.log.warn(
            { err, updateId, createUpdateId },
            "attribution_create_retry_failed"
          );
        }
      }
    } catch (err) {
      app.log.warn({ err }, "attribution_get_pending_create_failed");
    }
  }
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
