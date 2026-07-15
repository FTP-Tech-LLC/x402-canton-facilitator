import { describe, it, expect, vi } from "vitest";
import type { TrafficStatusResponse } from "@ftptech/x402-canton-ledger";
import { pollTrafficOnce, startTrafficMonitor } from "./traffic-monitor.js";

function status(consumed: number, limit: number): TrafficStatusResponse {
  return {
    traffic_status: {
      actual: { total_consumed: consumed, total_limit: limit },
      target: { total_purchased: limit },
    },
  };
}

function fakeLog() {
  return {
    info: vi.fn<(obj: object, msg: string) => void>(),
    warn: vi.fn<(obj: object, msg: string) => void>(),
    error: vi.fn<(obj: object, msg: string) => void>(),
  };
}

describe("pollTrafficOnce", () => {
  it("logs at INFO below the high-water mark", async () => {
    const log = fakeLog();
    const scan = { getTrafficStatus: vi.fn().mockResolvedValue(status(50, 100)) };
    const r = await pollTrafficOnce({
      scan,
      synchronizerId: "global-domain::1220",
      memberId: "PAR::ftp-validator-1::1220abc",
      log,
    });
    expect(r).toEqual({ consumed: 50, limit: 100, fraction: 0.5 });
    expect(scan.getTrafficStatus).toHaveBeenCalledWith(
      "global-domain::1220",
      "PAR::ftp-validator-1::1220abc"
    );
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const [fields] = log.info.mock.calls[0]!;
    expect(fields).toMatchObject({ total_consumed: 50, total_limit: 100 });
  });

  it("WARNs at/above the high-water mark (default 80%)", async () => {
    const log = fakeLog();
    const scan = { getTrafficStatus: vi.fn().mockResolvedValue(status(85, 100)) };
    const r = await pollTrafficOnce({
      scan,
      synchronizerId: "s",
      memberId: "m",
      log,
    });
    expect(r?.fraction).toBeCloseTo(0.85);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("honours a custom high-water fraction", async () => {
    const log = fakeLog();
    const scan = { getTrafficStatus: vi.fn().mockResolvedValue(status(60, 100)) };
    await pollTrafficOnce({
      scan,
      synchronizerId: "s",
      memberId: "m",
      log,
      highWaterFraction: 0.5,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("treats total_limit 0 as fraction 0 (no div-by-zero, no spurious WARN)", async () => {
    const log = fakeLog();
    const scan = { getTrafficStatus: vi.fn().mockResolvedValue(status(0, 0)) };
    const r = await pollTrafficOnce({
      scan,
      synchronizerId: "s",
      memberId: "m",
      log,
    });
    expect(r).toEqual({ consumed: 0, limit: 0, fraction: 0 });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("swallows a Scan error (logs WARN, returns null) so the interval survives", async () => {
    const log = fakeLog();
    const scan = {
      getTrafficStatus: vi.fn().mockRejectedValue(new Error("scan 500")),
    };
    const r = await pollTrafficOnce({
      scan,
      synchronizerId: "s",
      memberId: "m",
      log,
    });
    expect(r).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.warn.mock.calls[0]!;
    expect(msg).toContain("traffic-status poll failed");
    expect(fields).toHaveProperty("err");
  });
});

describe("startTrafficMonitor — inert-safe gating", () => {
  it("returns null and logs once when memberId is undefined (CANTON_FACILITATOR_MEMBER_ID unset)", () => {
    const log = fakeLog();
    const scan = { getTrafficStatus: vi.fn() };
    const timer = startTrafficMonitor({
      scan,
      synchronizerId: "s",
      memberId: undefined,
      log,
    });
    expect(timer).toBeNull();
    expect(scan.getTrafficStatus).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![1]).toContain("CANTON_FACILITATOR_MEMBER_ID");
  });

  it("returns null when memberId is empty string (inert-safe)", () => {
    const log = fakeLog();
    const scan = { getTrafficStatus: vi.fn() };
    const timer = startTrafficMonitor({
      scan,
      synchronizerId: "s",
      memberId: "",
      log,
    });
    expect(timer).toBeNull();
    expect(scan.getTrafficStatus).not.toHaveBeenCalled();
  });

  it("returns null when intervalMs <= 0", () => {
    const log = fakeLog();
    const scan = { getTrafficStatus: vi.fn() };
    const timer = startTrafficMonitor(
      { scan, synchronizerId: "s", memberId: "m", log },
      { intervalMs: 0 }
    );
    expect(timer).toBeNull();
  });

  it("starts a timer and fires an immediate first poll when memberId is set", async () => {
    const log = fakeLog();
    const scan = {
      getTrafficStatus: vi.fn().mockResolvedValue(status(10, 100)),
    };
    const timer = startTrafficMonitor(
      { scan, synchronizerId: "s", memberId: "PAR::m::1220", log },
      { intervalMs: 60_000 }
    );
    expect(timer).not.toBeNull();
    // The immediate boot poll is fire-and-forget; let the microtask settle.
    await vi.waitFor(() =>
      expect(scan.getTrafficStatus).toHaveBeenCalledTimes(1)
    );
    if (timer) clearInterval(timer);
  });

  it("the returned timer is unref'd (does not keep the event loop alive)", () => {
    const log = fakeLog();
    const scan = {
      getTrafficStatus: vi.fn().mockResolvedValue(status(1, 100)),
    };
    const timer = startTrafficMonitor(
      { scan, synchronizerId: "s", memberId: "m", log },
      { intervalMs: 60_000 }
    );
    // hasRef() is false after unref(); guards against a regression that would
    // hang the process on shutdown.
    expect(timer && timer.hasRef()).toBe(false);
    if (timer) clearInterval(timer);
  });
});
