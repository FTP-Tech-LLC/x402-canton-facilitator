import { describe, it, expect, vi } from "vitest";
import { createShutdownHandler, DRAIN_DEADLINE_MS } from "./shutdown.js";

function deps(close: () => Promise<void>) {
  const info: Array<[unknown, string]> = [];
  const error: Array<[unknown, string]> = [];
  const exits: number[] = [];
  return {
    info,
    error,
    exits,
    d: {
      close,
      exit: (c: number) => exits.push(c),
      log: {
        info: (o: unknown, m: string) => info.push([o, m]),
        error: (o: unknown, m: string) => error.push([o, m]),
      },
      deadlineMs: 20,
    },
  };
}

describe("shutdown drains, but not forever", () => {
  it("a clean drain exits 0 and logs no error", async () => {
    const { d, error, exits } = deps(async () => undefined);
    await createShutdownHandler(d)("SIGTERM");
    expect(exits).toEqual([0]);
    expect(error).toEqual([]);
  });

  it("a close that never returns still exits, and says what it left behind", async () => {
    // The whole point. Before, this awaited forever and the orchestrator
    // SIGKILLed the process — same outcome, later, with no final log line.
    const { d, error, exits } = deps(() => new Promise<void>(() => {}));
    await createShutdownHandler(d)("SIGTERM");
    expect(exits).toEqual([0]);
    expect(error).toHaveLength(1);
    expect(error[0]![1]).toMatch(/may have committed WITHOUT being recorded/);
  });

  it("a close that REJECTS is treated as a failed drain, not a clean one", async () => {
    const { d, error, exits } = deps(async () => {
      throw new Error("close blew up");
    });
    await createShutdownHandler(d)("SIGTERM");
    expect(exits).toEqual([0]);
    expect(error).toHaveLength(1);
  });

  it("a second signal does not start a second drain", async () => {
    // Ctrl-C twice, or SIGTERM followed by SIGINT. Two concurrent close() calls
    // racing each other is not a better shutdown.
    let calls = 0;
    const { d, exits } = deps(async () => {
      calls += 1;
    });
    const h = createShutdownHandler(d);
    await Promise.all([h("SIGTERM"), h("SIGINT")]);
    expect(calls).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("the deadline is longer than one worst-case in-flight settle", () => {
    // 45s execute budget + 20 x 600ms completion poll ~= 57s. The default has to
    // clear that, or a deploy routinely cuts an honest settle in half; and it
    // has to stay under the compose stop_grace_period, or Docker kills us before
    // we can log. Pinned so a future tweak to either number is a visible change.
    expect(DRAIN_DEADLINE_MS).toBeGreaterThanOrEqual(45_000);
    expect(DRAIN_DEADLINE_MS).toBeLessThan(70_000);
  });

  it("clears its own timer, so a clean drain does not keep the process alive", async () => {
    const cleared: unknown[] = [];
    const realClear = globalThis.clearTimeout;
    vi.stubGlobal("clearTimeout", (h: unknown) => {
      cleared.push(h);
      return realClear(h as never);
    });
    const { d } = deps(async () => undefined);
    await createShutdownHandler(d)("SIGTERM");
    expect(cleared.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
