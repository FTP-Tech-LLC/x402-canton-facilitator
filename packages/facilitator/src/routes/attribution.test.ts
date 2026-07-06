import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import {
  registerAttributionRoute,
  type AttributionRouteServices,
} from "./attribution.js";
import type { AttributionStore } from "../db/attribution-store.js";

const OPERATOR_TOKEN = "op-secret-token";
const AUTH = { authorization: `Bearer ${OPERATOR_TOKEN}` };

function fakeTotals(): Awaited<ReturnType<AttributionStore["getTotals"]>> {
  return {
    totalPayments: 5,
    confirmedBytes: 12345n,
    eligibleBytes: 12000n,
    pendingCount: 1,
    failedCount: 0,
    rejectedCount: 0,
    noSummaryCount: 0,
    attemptedCount: 2,
    createConfirmedBytes: 678n,
    createPendingCount: 0,
    createFailedCount: 0,
  };
}

function makeStore(): AttributionStore {
  return {
    record: vi.fn(),
    markServed: vi.fn(),
    getAttempted: vi.fn(),
    updateTrafficSummary: vi.fn(),
    incrementFetchAttempts: vi.fn(),
    getPending: vi.fn(),
    setCreateUpdateId: vi.fn(),
    updateCreateTrafficSummary: vi.fn(),
    incrementCreateFetchAttempts: vi.fn(),
    getPendingCreate: vi.fn(),
    getTotals: vi.fn().mockResolvedValue(fakeTotals()),
  } as unknown as AttributionStore;
}

function makeServices(
  overrides: Partial<AttributionRouteServices> = {}
): AttributionRouteServices {
  return {
    attribution: makeStore(),
    excludedParticipants: [],
    excludedParties: [],
    operatorToken: OPERATOR_TOKEN,
    ...overrides,
  };
}

describe("GET /attribution — operator-token gate (decision #10)", () => {
  it("returns totals when authorized with the correct bearer token", async () => {
    const svc = makeServices();
    const app = Fastify();
    await registerAttributionRoute(app, svc);
    const res = await app.inject({ method: "GET", url: "/attribution", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total_payments: 5,
      send_bytes_confirmed: "12345",
      create_bytes_confirmed: "678",
      total_bytes_confirmed: "13023",
      eligible_bytes: "12000",
      pending_count: 1,
      attempted_count: 2,
      create_pending_count: 0,
    });
    expect(svc.attribution!.getTotals).toHaveBeenCalledWith({
      excludedParticipants: [],
      excludedParties: [],
    });
    await app.close();
  });

  it("passes the configured exclusions through to getTotals", async () => {
    const svc = makeServices({
      excludedParticipants: ["PAR::ftp::1220"],
      excludedParties: ["ftp_facilitator::1220"],
    });
    const app = Fastify();
    await registerAttributionRoute(app, svc);
    await app.inject({ method: "GET", url: "/attribution", headers: AUTH });
    expect(svc.attribution!.getTotals).toHaveBeenCalledWith({
      excludedParticipants: ["PAR::ftp::1220"],
      excludedParties: ["ftp_facilitator::1220"],
    });
    await app.close();
  });

  it("WITHOUT an Authorization header → 401, store NOT read", async () => {
    const svc = makeServices();
    const app = Fastify();
    await registerAttributionRoute(app, svc);
    const res = await app.inject({ method: "GET", url: "/attribution" });
    expect(res.statusCode).toBe(401);
    expect(svc.attribution!.getTotals).not.toHaveBeenCalled();
    await app.close();
  });

  it("with a WRONG bearer token → 401, store NOT read", async () => {
    const svc = makeServices();
    const app = Fastify();
    await registerAttributionRoute(app, svc);
    const res = await app.inject({
      method: "GET",
      url: "/attribution",
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(svc.attribution!.getTotals).not.toHaveBeenCalled();
    await app.close();
  });

  it("when NO operatorToken is configured → DISABLED (503), fail-secure", async () => {
    const svc = makeServices({ operatorToken: undefined });
    const app = Fastify();
    await registerAttributionRoute(app, svc);
    // even WITH a bearer header, an unset operator token disables the route.
    const res = await app.inject({ method: "GET", url: "/attribution", headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(svc.attribution!.getTotals).not.toHaveBeenCalled();
    await app.close();
  });

  it("authorized but attribution store unconfigured → 503 not configured", async () => {
    const svc = makeServices({ attribution: undefined });
    const app = Fastify();
    await registerAttributionRoute(app, svc);
    const res = await app.inject({ method: "GET", url: "/attribution", headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "attribution not configured" });
    await app.close();
  });
});
