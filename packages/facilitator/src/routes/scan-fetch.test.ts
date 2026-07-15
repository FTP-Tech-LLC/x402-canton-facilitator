/**
 * Unit tests for the shared multi-SV scanFetchRetry helper (scan-fetch.ts) — the
 * robustness primitive the escrow execute-transfer choice-context resolve relies
 * on. Verifies: dedup/ordering of bases, a real non-2xx returns immediately, a
 * transient 5xx/429 is retried then fails over to the next SV, a 2xx is returned,
 * and getDso memoizes.
 *
 * fetchImpl is injected (no global stubbing needed) and the backoff uses real
 * setTimeout — kept tiny by design (the helper's max single backoff is bounded;
 * with one base + one transient the test stays well under a second).
 */
import { describe, it, expect, vi } from "vitest";
import { scanBases, makeScanFetchRetry, makeGetDso } from "./scan-fetch.js";

describe("scanBases", () => {
  it("strips trailing slashes, keeps order, de-dups", () => {
    expect(
      scanBases("http://a/", ["http://b/", "http://a", "http://c/"])
    ).toEqual(["http://a", "http://b", "http://c"]);
  });

  it("drops empty fallback entries", () => {
    expect(scanBases("http://a", ["", "http://b"])).toEqual([
      "http://a",
      "http://b",
    ]);
  });
});

describe("makeScanFetchRetry", () => {
  it("returns a 2xx response without retrying", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const f = makeScanFetchRetry("http://a", [], fetchImpl as never);
    const r = await f("/x", { method: "GET" });
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://a/x");
  });

  it("a real non-2xx (404) is returned IMMEDIATELY (not retried, no failover)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const f = makeScanFetchRetry("http://a", ["http://b"], fetchImpl as never);
    const r = await f("/x", { method: "GET" });
    expect(r.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledOnce(); // no retry, no failover
  });

  it("a transient 503 on the primary fails over to the fallback SV and succeeds", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).startsWith("http://a")) {
        return new Response("overloaded", { status: 503 });
      }
      return new Response("ok", { status: 200 });
    });
    const f = makeScanFetchRetry("http://a", ["http://b"], fetchImpl as never);
    const r = await f("/x", { method: "GET" });
    expect(r.status).toBe(200);
    // 4 attempts on the primary (original + 3 retries), then the fallback.
    const primaryCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).startsWith("http://a")
    );
    const fallbackCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).startsWith("http://b")
    );
    expect(primaryCalls.length).toBe(4);
    expect(fallbackCalls.length).toBe(1);
  }, 20_000);

  it("all bases exhausted → returns the last (transient) response so the caller's !ok throws", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 502 }));
    const f = makeScanFetchRetry("http://a", [], fetchImpl as never);
    const r = await f("/x", { method: "GET" });
    expect(r.status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // original + 3 retries
  }, 20_000);

  it("a transport throw with no response rethrows the last error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const f = makeScanFetchRetry("http://a", [], fetchImpl as never);
    await expect(f("/x", { method: "GET" })).rejects.toThrow(/ECONNREFUSED/);
  }, 20_000);
});

describe("makeGetDso", () => {
  it("reads /api/scan/v0/dso-party-id once and memoizes", async () => {
    const scanFetchRetry = vi.fn(
      async () => new Response(JSON.stringify({ dso_party_id: "DSO::1220" }), { status: 200 })
    );
    const getDso = makeGetDso(scanFetchRetry as never);
    expect(await getDso()).toBe("DSO::1220");
    expect(await getDso()).toBe("DSO::1220");
    expect(scanFetchRetry).toHaveBeenCalledOnce(); // memoized
    expect(scanFetchRetry.mock.calls[0]![0]).toBe("/api/scan/v0/dso-party-id");
  });

  it("throws when the DSO read is not ok", async () => {
    const scanFetchRetry = vi.fn(async () => new Response("x", { status: 500 }));
    const getDso = makeGetDso(scanFetchRetry as never);
    await expect(getDso()).rejects.toThrow(/dso-party-id HTTP 500/);
  });
});
