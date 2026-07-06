import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { registerCloseRoute } from "./close.js";

// audit H2: POST /close is an unauthenticated process.exit(0) kill switch.
// It must only be registered when explicitly enabled (conformance harness);
// in production (disabled) the route is absent → 404.
describe("registerCloseRoute — gated kill switch (audit H2)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does NOT register /close when disabled → POST /close is 404", async () => {
    const app = Fastify();
    await registerCloseRoute(app, false);
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/close" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("registers /close when enabled → 200 {ok:true} and schedules exit(0)", async () => {
    const app = Fastify();
    await registerCloseRoute(app, true);
    await app.ready();

    // The handler defers `app.close(); process.exit(0)` via setImmediate.
    // Stub both so the test runner survives and we can assert the intent.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((): never => undefined as never));
    const closeSpy = vi
      .spyOn(app, "close")
      .mockResolvedValue(undefined as never);

    const res = await app.inject({ method: "POST", url: "/close" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // let the deferred close+exit run
    await new Promise((r) => setImmediate(r));
    expect(closeSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
