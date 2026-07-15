import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { createReadinessProbe } from "./readiness.js";
import { registerReadyRoute } from "./routes/ready.js";

const ok = async () => ({ ok: true });
const bad = (detail: string) => async () => ({ ok: false, detail });

describe("createReadinessProbe", () => {
  it("ready=true when every check passes", async () => {
    const probe = createReadinessProbe({ token: ok, participant: ok, scan: ok });
    const r = await probe.evaluate();
    expect(r.ready).toBe(true);
    expect(r.checks.token.ok).toBe(true);
    expect(r.checks.participant.ok).toBe(true);
    expect(r.checks.scan.ok).toBe(true);
  });

  it("ready=false with a per-dep breakdown when one check fails", async () => {
    const probe = createReadinessProbe({
      token: ok,
      participant: bad("participant 500"),
      scan: ok,
    });
    const r = await probe.evaluate();
    expect(r.ready).toBe(false);
    expect(r.checks.participant).toEqual({ ok: false, detail: "participant 500" });
    expect(r.checks.token.ok).toBe(true);
    expect(r.checks.scan.ok).toBe(true);
  });

  it("a THROWN check is caught and mapped to ok:false (never crashes the probe)", async () => {
    const probe = createReadinessProbe({
      token: ok,
      scan: async () => {
        throw new Error("scan unreachable");
      },
    });
    const r = await probe.evaluate();
    expect(r.ready).toBe(false);
    expect(r.checks.scan.ok).toBe(false);
    expect(r.checks.scan.detail).toBe("scan unreachable");
  });

  it("caches results within the TTL — checks run once for repeated evaluate()", async () => {
    let now = 1_000;
    const tokenCheck = vi.fn(ok);
    const probe = createReadinessProbe(
      { token: tokenCheck },
      { ttlMs: 10_000, now: () => now }
    );
    const r1 = await probe.evaluate();
    const r2 = await probe.evaluate();
    expect(r1.cached).toBe(false);
    expect(r2.cached).toBe(true);
    expect(tokenCheck).toHaveBeenCalledTimes(1);

    // Past the TTL → re-run.
    now += 11_000;
    const r3 = await probe.evaluate();
    expect(r3.cached).toBe(false);
    expect(tokenCheck).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent evaluate() onto a single in-flight run", async () => {
    const tokenCheck = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true };
    });
    const probe = createReadinessProbe({ token: tokenCheck });
    const [a, b] = await Promise.all([probe.evaluate(), probe.evaluate()]);
    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    expect(tokenCheck).toHaveBeenCalledTimes(1);
  });
});

describe("GET /ready route", () => {
  it("200 + {ready:true, checks} when healthy", async () => {
    const probe = createReadinessProbe({ token: ok, participant: ok, scan: ok });
    const app = Fastify();
    await registerReadyRoute(app, probe);
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ready: boolean; checks: Record<string, unknown> };
    expect(body.ready).toBe(true);
    expect(Object.keys(body.checks)).toEqual(["token", "participant", "scan"]);
    // Healthy deps expose a bare { ok:true } — nothing more.
    expect(body.checks.token).toEqual({ ok: true });
    // The internal `cached` flag must not leak onto the wire body.
    expect("cached" in body).toBe(false);
    await app.close();
  });

  it("503 + per-dep breakdown when a dep is down (GENERIC status only — no raw detail leak)", async () => {
    const probe = createReadinessProbe({
      token: ok,
      participant: bad("ledger-end 503 https://participant.internal/v2/state/ledger-end"),
    });
    const app = Fastify();
    await registerReadyRoute(app, probe);
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      ready: boolean;
      checks: Record<string, { ok: boolean; error?: string }>;
    };
    expect(body.ready).toBe(false);
    // Failing dep exposes only a generic { ok:false, error:"unavailable" } —
    // the raw detail (which carries an internal URL here) MUST NOT be on the wire.
    expect(body.checks.participant).toEqual({ ok: false, error: "unavailable" });
    expect(body.checks.token).toEqual({ ok: true });
    // Defense-in-depth: serialize the whole body and assert no detail substring leaked.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("ledger-end 503");
    expect(wire).not.toContain("participant.internal");
    expect(wire).not.toContain("detail");
    await app.close();
  });

  it("logs the raw per-dep detail server-side (req.log) when not ready", async () => {
    const probe = createReadinessProbe({
      token: ok,
      scan: bad("scan 502 from https://scan.sv-1.internal/api/scan/v0/amulet-rules"),
    });
    const logged: Array<{ obj: unknown; msg?: string }> = [];
    const app = Fastify({
      // Capture pino log calls without depending on transport internals.
      loggerInstance: {
        warn: (obj: unknown, msg?: string) => logged.push({ obj, msg }),
        info: () => {},
        error: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        child: function () {
          return this;
        },
        level: "info",
      } as never,
    });
    await registerReadyRoute(app, probe);
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    // The full detail is present in the server-side log payload (operator-visible)...
    const warned = logged.find((l) => l.msg === "readiness probe not ready");
    expect(warned).toBeDefined();
    expect(JSON.stringify(warned!.obj)).toContain("scan.sv-1.internal");
    // ...but NOT on the wire body.
    expect(res.body).not.toContain("scan.sv-1.internal");
    await app.close();
  });
});
