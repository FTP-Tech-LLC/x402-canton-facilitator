import { describe, it, expect, vi } from "vitest";
import { ScanClient } from "@ftptech/x402-canton-ledger";
import {
  createPaymentPathMerchants,
  createScanBudget,
  scanBudgetFetch,
  ScanBudgetRefusedError,
} from "./scan-budget.js";

describe("createScanBudget", () => {
  it("never refuses the payment path, and what it uses is gone for everyone else", () => {
    const b = createScanBudget({ maxPerWindow: 3, windowMs: 60_000 });
    expect(b.admit(true, 0)).toBeUndefined();
    expect(b.admit(true, 1)).toBeUndefined();
    expect(b.admit(false, 2)).toBeUndefined(); // third slot
    const refused = b.admit(false, 3);
    expect(refused).toBeInstanceOf(ScanBudgetRefusedError);
    expect(refused?.reason).toBe("budget");
    // Priority past the line is still sent, and counted.
    expect(b.admit(true, 4)).toBeUndefined();
    expect(b._inWindow(4)).toBe(4);
  });

  it("the window slides: a best-effort read waits for the oldest slot, and is told how long", () => {
    const b = createScanBudget({ maxPerWindow: 1, windowMs: 1_000 });
    expect(b.admit(false, 0)).toBeUndefined();
    const r = b.admit(false, 400);
    expect(r?.retryAfterMs).toBe(600);
    expect(r?.retryAfterSeconds).toBe(1);
    expect(b.admit(false, 1_001)).toBeUndefined();
  });

  it("a 429 from Scan holds best-effort reads for the cooldown; priority keeps going", () => {
    const b = createScanBudget({ maxPerWindow: 100, cooldownMs: 2_000 });
    b.noteRateLimited(10_000);
    const r = b.admit(false, 10_500);
    expect(r?.reason).toBe("cooldown");
    expect(r?.retryAfterMs).toBe(1_500);
    expect(b.admit(true, 10_500)).toBeUndefined();
    expect(b.admit(false, 12_000)).toBeUndefined();
  });

  it("maxPerWindow 0 turns it off: nothing counted, nothing refused, no cooldown, no pacing", () => {
    const b = createScanBudget({ maxPerWindow: 0, cooldownMs: 2_000, paceMs: 500 });
    expect(b.enabled).toBe(false);
    expect(b.paceMs).toBe(0);
    b.noteRateLimited(0);
    for (let i = 0; i < 50; i++) expect(b.admit(false, 1)).toBeUndefined();
    expect(b._inWindow(1)).toBe(0);
  });

  it("the refusal carries no HTTP status, so ScanClient treats it as final", () => {
    const e = new ScanBudgetRefusedError("budget", 10);
    expect(e.status).toBeUndefined();
    expect(e.code).toBe("SCAN_BUDGET_REFUSED");
  });
});

describe("the budget follows the host", () => {
  const SV2 = "https://scan.sv-2.example";
  const SV1 = "https://scan.sv-1.example";
  const UTIL = "https://api.utilities.example";

  it("a 429 cools down only the Scan host that answered it", () => {
    const started: string[] = [];
    const b = createScanBudget({
      maxPerWindow: 100,
      cooldownMs: 2_000,
      scanHosts: [SV2, SV1],
      onCooldown: (h) => started.push(h),
    });
    b.noteRateLimited(1_000, `${SV2}/api/scan/v0/x`);
    expect(b.admit(false, 1_500, `${SV2}/api/scan/v0/y`)?.reason).toBe("cooldown");
    expect(b.admit(false, 1_500, `${SV1}/api/scan/v0/y`)).toBeUndefined();
    // Counted once when the cooldown starts, not on every 429 inside it.
    b.noteRateLimited(1_600, `${SV2}/api/scan/v0/z`);
    expect(started).toEqual(["scan.sv-2.example"]);
  });

  it("a request to a host that is not a Scan is not counted, not refused, and its 429 cools nothing", () => {
    const b = createScanBudget({ maxPerWindow: 1, cooldownMs: 2_000, scanHosts: [SV2] });
    for (let i = 0; i < 5; i++) expect(b.admit(false, 10, `${UTIL}/registry/x`)).toBeUndefined();
    expect(b._inWindow(10)).toBe(0);
    b.noteRateLimited(20, `${UTIL}/registry/x`);
    expect(b.admit(false, 30, `${SV2}/api/scan/v0/a`)).toBeUndefined();
  });
});

describe("scanBudgetFetch inside a real ScanClient", () => {
  const record = {
    transfer_preapproval: {
      contract: {
        contract_id: "00cid",
        payload: { dso: "DSO::1220", receiver: "m::1220", provider: "m::1220", expiresAt: "2099-01-01T00:00:00Z" },
      },
    },
  };
  const client = (budget: ReturnType<typeof createScanBudget>, priority: boolean, f: typeof fetch) =>
    new ScanClient({
      scanUrl: "http://sv-2.test",
      fallbackUrls: ["http://sv-1.test"],
      flavor: "sv",
      fetch: scanBudgetFetch(budget, priority, () => f),
    });

  it("a best-effort 429 is one request: no retry, no failover, and the cooldown starts", async () => {
    const f = vi.fn(async () => new Response("local_rate_limited", { status: 429 }));
    const budget = createScanBudget({ maxPerWindow: 100, cooldownMs: 2_000 });
    const err = await client(budget, false, f as never)
      .getTransferPreapprovalByParty("m::1220")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScanBudgetRefusedError);
    expect((err as ScanBudgetRefusedError).reason).toBe("rate_limited");
    expect(f).toHaveBeenCalledTimes(1);
    expect(budget.admit(false, Date.now(), "http://sv-2.test/api/scan/v0/x")?.reason).toBe("cooldown");
  });

  it("a refused best-effort read sends nothing", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(record), { status: 200 }));
    const budget = createScanBudget({ maxPerWindow: 1 });
    budget.admit(true, Date.now());
    const err = await client(budget, false, f as never)
      .getTransferPreapprovalByParty("m::1220")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScanBudgetRefusedError);
    expect(f).not.toHaveBeenCalled();
  });

  it("priority keeps its retry on 429, and its 429 still starts the cooldown for the rest", async () => {
    let n = 0;
    const f = vi.fn(async () =>
      ++n === 1
        ? new Response("local_rate_limited", { status: 429 })
        : new Response(JSON.stringify(record), { status: 200 })
    );
    const budget = createScanBudget({ maxPerWindow: 100, cooldownMs: 60_000 });
    const r = await client(budget, true, f as never).getTransferPreapprovalByParty("m::1220");
    expect(r?.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(f).toHaveBeenCalledTimes(2);
    expect(budget.admit(false, Date.now(), "http://sv-2.test/api/scan/v0/x")?.reason).toBe("cooldown");
  });

  it("with the budget off a best-effort client behaves exactly like before (retries a 429)", async () => {
    let n = 0;
    const f = vi.fn(async () =>
      ++n === 1
        ? new Response("local_rate_limited", { status: 429 })
        : new Response(JSON.stringify(record), { status: 200 })
    );
    const budget = createScanBudget({ maxPerWindow: 0 });
    const r = await client(budget, false, f as never).getTransferPreapprovalByParty("m::1220");
    expect(r).not.toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("createPaymentPathMerchants", () => {
  it("seeded and validated merchants are priority; a stranger is not", () => {
    const m = createPaymentPathMerchants({ seed: ["listed::1220"] });
    const now = Date.now();
    expect(m.isPriority("listed::1220", now)).toBe(true);
    expect(m.isPriority("stranger::1220", now)).toBe(false);
    m.markServed("paid::1220");
    expect(m.isPriority("paid::1220", now)).toBe(true);
  });

  it("a merchant whose preapproval lapsed or vanished drops back to best-effort until paid again", () => {
    const m = createPaymentPathMerchants({});
    const now = Date.now();
    m.markServed("a::1220");
    m.noteRecord("a::1220", now - 1);
    expect(m.isPriority("a::1220", now)).toBe(false);
    m.markServed("a::1220");
    expect(m.isPriority("a::1220", now)).toBe(true);
    m.noteRecord("a::1220", undefined);
    expect(m.isPriority("a::1220", now)).toBe(false);
    m.noteRecord("a::1220", now + 60_000);
    expect(m.isPriority("a::1220", now)).toBe(true);
  });

  it("a read for a party it does not track adds nothing", () => {
    const m = createPaymentPathMerchants({});
    m.noteRecord("x::1220", Date.now() + 60_000);
    expect(m.isPriority("x::1220", Date.now())).toBe(false);
    expect(m._size()).toBe(0);
  });

  it("is bounded: the least recently used merchant goes first", () => {
    const m = createPaymentPathMerchants({ max: 2 });
    const now = Date.now();
    m.markServed("a::1");
    m.markServed("b::1");
    m.markServed("a::1"); // refresh a
    m.markServed("c::1"); // evicts b
    expect(m.isPriority("a::1", now)).toBe(true);
    expect(m.isPriority("b::1", now)).toBe(false);
    expect(m.isPriority("c::1", now)).toBe(true);
    expect(m._size()).toBe(2);
  });
});
