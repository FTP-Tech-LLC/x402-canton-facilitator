import { describe, it, expect } from "vitest";
import {
  createInMemoryFaucetStore,
  createPostgresFaucetStore,
  createFaucetStore,
  type PgExecutor,
} from "./faucet-store.js";

describe("InMemoryFaucetStore", () => {
  it("tryReserve: true first, false on a second claim by the same party", async () => {
    const s = createInMemoryFaucetStore();
    expect(
      await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1000 })
    ).toBe(true);
    expect(
      await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 2000 })
    ).toBe(false);
    expect(
      await s.tryReserve({ party: "b::2", ip: "1.1.1.1", amountCc: "0.02", nowMs: 3000 })
    ).toBe(true);
  });

  it("hasClaimed reflects reservations", async () => {
    const s = createInMemoryFaucetStore();
    expect(await s.hasClaimed("a::1")).toBe(false);
    await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1000 });
    expect(await s.hasClaimed("a::1")).toBe(true);
  });

  it("release undoes a reservation so the party can retry", async () => {
    const s = createInMemoryFaucetStore();
    await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1000 });
    await s.release("a::1");
    expect(await s.hasClaimed("a::1")).toBe(false);
    expect(
      await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 2000 })
    ).toBe(true);
  });

  it("sumSince counts only payouts strictly after the cutoff", async () => {
    const s = createInMemoryFaucetStore();
    await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1000 });
    await s.tryReserve({ party: "b::2", ip: "1.1.1.1", amountCc: "0.05", nowMs: 5000 });
    expect(await s.sumSince(0)).toBeCloseTo(0.07, 10);
    expect(await s.sumSince(1000)).toBeCloseTo(0.05, 10); // a::1 at 1000 is excluded (strict >)
    expect(await s.sumSince(5000)).toBe(0);
  });

  it("markPaid does not throw and does not change the claimed set", async () => {
    const s = createInMemoryFaucetStore();
    await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1000 });
    await s.markPaid({ party: "a::1", updateId: "u1" });
    expect(await s.hasClaimed("a::1")).toBe(true);
  });
});

describe("InMemoryFaucetStore.tryClaim (atomic party-once + daily + lifetime)", () => {
  const base = {
    ip: "1.1.1.1",
    amountCc: "0.02",
    windowMs: 1000,
    dailyBudgetCc: "1",
    lifetimeCapCc: "25",
  };

  it("ok on first claim, already_claimed on a repeat by the same party, inserts the claim", async () => {
    const s = createInMemoryFaucetStore();
    expect(await s.tryClaim({ ...base, party: "a::1", nowMs: 1000 })).toBe("ok");
    // The successful claim is recorded (single-use) and counts toward the sums.
    expect(await s.hasClaimed("a::1")).toBe(true);
    expect(await s.sumSince(0)).toBeCloseTo(0.02, 10);
    expect(await s.tryClaim({ ...base, party: "a::1", nowMs: 1500 })).toBe(
      "already_claimed"
    );
    // A different party still gets through.
    expect(await s.tryClaim({ ...base, party: "b::2", nowMs: 1600 })).toBe("ok");
  });

  it("refuses with daily_budget when the rolling-window sum + amount exceeds the budget", async () => {
    const s = createInMemoryFaucetStore();
    // budget 1.0, amount 0.6: first claim ok (0.6), second would be 1.2 > 1.0.
    expect(
      await s.tryClaim({
        ...base,
        party: "a::1",
        amountCc: "0.6",
        dailyBudgetCc: "1",
        nowMs: 1000,
      })
    ).toBe("ok");
    expect(
      await s.tryClaim({
        ...base,
        party: "b::2",
        amountCc: "0.6",
        dailyBudgetCc: "1",
        nowMs: 1100,
      })
    ).toBe("daily_budget");
    // The refused claim was NOT inserted.
    expect(await s.hasClaimed("b::2")).toBe(false);
  });

  it("the daily window slides: spend outside the window no longer counts against the budget", async () => {
    const s = createInMemoryFaucetStore();
    // window 1000ms, budget 1.0, amount 0.6.
    expect(
      await s.tryClaim({
        ...base,
        party: "a::1",
        amountCc: "0.6",
        dailyBudgetCc: "1",
        windowMs: 1000,
        nowMs: 1000,
      })
    ).toBe("ok");
    // Far in the future: a::1's spend at 1000 is now outside the 1000ms window
    // (sinceMs = 9000 - 1000 = 8000 > 1000), so the budget is free again.
    expect(
      await s.tryClaim({
        ...base,
        party: "b::2",
        amountCc: "0.6",
        dailyBudgetCc: "1",
        windowMs: 1000,
        nowMs: 9000,
      })
    ).toBe("ok");
  });

  it("refuses with lifetime_cap once the all-time total + amount exceeds the cap (even when the window is empty)", async () => {
    const s = createInMemoryFaucetStore();
    // lifetime cap 0.5, amount 0.3, but a HUGE daily budget so daily never bites.
    // First claim ok (0.3 total). Second would be 0.6 > 0.5 lifetime -> refused,
    // and it must be lifetime_cap, NOT daily_budget.
    expect(
      await s.tryClaim({
        party: "a::1",
        ip: base.ip,
        amountCc: "0.3",
        windowMs: 1000,
        dailyBudgetCc: "1000",
        lifetimeCapCc: "0.5",
        nowMs: 1000,
      })
    ).toBe("ok");
    // Push time far past the window so the DAILY sum is 0 — only the lifetime
    // total (which ignores the window) can refuse here.
    expect(
      await s.tryClaim({
        party: "b::2",
        ip: base.ip,
        amountCc: "0.3",
        windowMs: 1000,
        dailyBudgetCc: "1000",
        lifetimeCapCc: "0.5",
        nowMs: 100_000,
      })
    ).toBe("lifetime_cap");
    expect(await s.hasClaimed("b::2")).toBe(false);
  });

  it("lifetimeCapCc '0' disables the lifetime cap (only the daily budget bounds spend)", async () => {
    const s = createInMemoryFaucetStore();
    // cap disabled, generous daily budget, many claims well past any cap.
    for (let i = 0; i < 5; i++) {
      expect(
        await s.tryClaim({
          party: `p::${i}`,
          ip: base.ip,
          amountCc: "10",
          windowMs: 1000,
          dailyBudgetCc: "1000000",
          lifetimeCapCc: "0",
          nowMs: 1000 + i, // same window
        })
      ).toBe("ok");
    }
    expect(await s.sumSince(0)).toBeCloseTo(50, 10);
  });

  it("the party check takes precedence over budget/cap (a repeat is already_claimed, not budget)", async () => {
    const s = createInMemoryFaucetStore();
    expect(
      await s.tryClaim({ ...base, party: "a::1", amountCc: "0.6", dailyBudgetCc: "1", nowMs: 1000 })
    ).toBe("ok");
    // Same party again: even though a second 0.6 would also blow the budget, the
    // party-once reason must win (it's a 429, not a 503).
    expect(
      await s.tryClaim({ ...base, party: "a::1", amountCc: "0.6", dailyBudgetCc: "1", nowMs: 1100 })
    ).toBe("already_claimed");
  });
});

/** Mock Postgres executor emulating party-keyed INSERT ON CONFLICT + a SUM. */
function mockExec(): { exec: PgExecutor; calls: string[] } {
  const reserved = new Map<string, number>(); // party -> amount
  const calls: string[] = [];
  const exec: PgExecutor = {
    async query(sql: string, params?: unknown[]) {
      calls.push(sql.split(" ").slice(0, 2).join(" "));
      if (sql.startsWith("CREATE")) return { rows: [], rowCount: 0 };
      const p = params as unknown[] | undefined;
      if (sql.startsWith("INSERT")) {
        const party = String(p?.[0]);
        if (reserved.has(party)) return { rows: [], rowCount: 0 };
        reserved.set(party, Number(p?.[2]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SELECT COALESCE")) {
        let s = 0;
        for (const v of reserved.values()) s += v;
        return { rows: [{ s }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT 1")) {
        return reserved.has(String(p?.[0]))
          ? { rows: [{}], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("DELETE")) {
        reserved.delete(String(p?.[0]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { exec, calls };
}

describe("PostgresFaucetStore (injected executor)", () => {
  it("tryReserve inserts once (ON CONFLICT DO NOTHING) and reflects hasClaimed", async () => {
    const { exec } = mockExec();
    const s = createPostgresFaucetStore(exec);
    expect(
      await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1000 })
    ).toBe(true);
    expect(
      await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 2000 })
    ).toBe(false);
    expect(await s.hasClaimed("a::1")).toBe(true);
    expect(await s.hasClaimed("z::9")).toBe(false);
  });

  it("sumSince parses the numeric SUM and release lets a party re-reserve", async () => {
    const { exec } = mockExec();
    const s = createPostgresFaucetStore(exec);
    await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1000 });
    await s.tryReserve({ party: "b::2", ip: "1.1.1.1", amountCc: "0.05", nowMs: 2000 });
    expect(await s.sumSince(0)).toBeCloseTo(0.07, 10);
    await s.release("a::1");
    expect(await s.hasClaimed("a::1")).toBe(false);
    expect(
      await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 3000 })
    ).toBe(true);
  });

  it("FAILS CLOSED: a DB error rejects (so the route 503s, never over-pays)", async () => {
    const exec: PgExecutor = {
      async query() {
        throw new Error("db down");
      },
    };
    const s = createPostgresFaucetStore(exec);
    await expect(s.hasClaimed("a::1")).rejects.toThrow(/db down/);
    await expect(
      s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1 })
    ).rejects.toThrow(/db down/);
    await expect(s.sumSince(0)).rejects.toThrow(/db down/);
  });
});

/**
 * Faithful PG simulator for the ATOMIC tryClaim path: it interprets the
 * guarded INSERT...SELECT...WHERE (party-once AND daily-window-sum AND lifetime)
 * and the refusal-classification SELECT, so the test exercises the real guard
 * arithmetic + rowCount interpretation rather than string-matching.
 */
function mockAtomicExec(): { exec: PgExecutor; rows: Array<{ party: string; amount: number; at: number }> } {
  const rows: Array<{ party: string; amount: number; at: number }> = [];
  const exec: PgExecutor = {
    async query(sql: string, params?: unknown[]) {
      const p = (params ?? []) as unknown[];
      if (sql.startsWith("CREATE")) return { rows: [], rowCount: 0 };
      // Atomic guarded insert.
      if (sql.startsWith("INSERT") && /WHERE NOT EXISTS/i.test(sql)) {
        const [party, , amountCc, nowMs, sinceMs, budget, cap] = p as [
          string, string, string, number, number, string, string
        ];
        const amt = Number(amountCc);
        const exists = rows.some((r) => r.party === party);
        const daily = rows
          .filter((r) => r.at > Number(sinceMs))
          .reduce((s, r) => s + r.amount, 0);
        const lifetime = rows.reduce((s, r) => s + r.amount, 0);
        const capN = Number(cap);
        const dailyOk = daily + amt <= Number(budget);
        const lifeOk = capN <= 0 || lifetime + amt <= capN;
        if (!exists && dailyOk && lifeOk) {
          rows.push({ party, amount: amt, at: Number(nowMs) });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      // Refusal classification.
      if (sql.startsWith("SELECT") && /AS claimed/i.test(sql)) {
        const [party, sinceMs] = p as [string, number];
        const claimed = rows.some((r) => r.party === party);
        const daily_sum = rows
          .filter((r) => r.at > Number(sinceMs))
          .reduce((s, r) => s + r.amount, 0);
        const lifetime_sum = rows.reduce((s, r) => s + r.amount, 0);
        return { rows: [{ claimed, daily_sum, lifetime_sum }], rowCount: 1 };
      }
      // hasClaimed
      if (sql.startsWith("SELECT 1")) {
        return rows.some((r) => r.party === String(p[0]))
          ? { rows: [{}], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { exec, rows };
}

describe("PostgresFaucetStore.tryClaim (atomic, injected executor)", () => {
  const base = {
    ip: "1.1.1.1",
    amountCc: "0.02",
    windowMs: 1000,
    dailyBudgetCc: "1",
    lifetimeCapCc: "25",
  };

  it("ok then already_claimed for the same party (single WHERE-guarded INSERT)", async () => {
    const { exec } = mockAtomicExec();
    const s = createPostgresFaucetStore(exec);
    expect(await s.tryClaim({ ...base, party: "a::1", nowMs: 1000 })).toBe("ok");
    expect(await s.hasClaimed("a::1")).toBe(true);
    expect(await s.tryClaim({ ...base, party: "a::1", nowMs: 1500 })).toBe(
      "already_claimed"
    );
  });

  it("refuses daily_budget when the window sum + amount exceeds the budget", async () => {
    const { exec } = mockAtomicExec();
    const s = createPostgresFaucetStore(exec);
    expect(
      await s.tryClaim({ ...base, party: "a::1", amountCc: "0.6", dailyBudgetCc: "1", nowMs: 1000 })
    ).toBe("ok");
    expect(
      await s.tryClaim({ ...base, party: "b::2", amountCc: "0.6", dailyBudgetCc: "1", nowMs: 1100 })
    ).toBe("daily_budget");
    expect(await s.hasClaimed("b::2")).toBe(false);
  });

  it("refuses lifetime_cap once the all-time total + amount exceeds the cap (window empty)", async () => {
    const { exec } = mockAtomicExec();
    const s = createPostgresFaucetStore(exec);
    expect(
      await s.tryClaim({ party: "a::1", ip: base.ip, amountCc: "0.3", windowMs: 1000, dailyBudgetCc: "1000", lifetimeCapCc: "0.5", nowMs: 1000 })
    ).toBe("ok");
    expect(
      await s.tryClaim({ party: "b::2", ip: base.ip, amountCc: "0.3", windowMs: 1000, dailyBudgetCc: "1000", lifetimeCapCc: "0.5", nowMs: 100_000 })
    ).toBe("lifetime_cap");
  });

  it("lifetimeCapCc '0' disables the lifetime cap", async () => {
    const { exec } = mockAtomicExec();
    const s = createPostgresFaucetStore(exec);
    for (let i = 0; i < 4; i++) {
      expect(
        await s.tryClaim({ party: `p::${i}`, ip: base.ip, amountCc: "10", windowMs: 1000, dailyBudgetCc: "1000000", lifetimeCapCc: "0", nowMs: 1000 + i })
      ).toBe("ok");
    }
  });

  it("FAILS CLOSED: a DB error in tryClaim rejects (route 503s, never over-pays)", async () => {
    const exec: PgExecutor = {
      async query() {
        throw new Error("db down");
      },
    };
    const s = createPostgresFaucetStore(exec);
    await expect(
      s.tryClaim({ ...base, party: "a::1", nowMs: 1 })
    ).rejects.toThrow(/db down/);
  });
});

describe("createFaucetStore factory", () => {
  it("returns an in-memory store when neither executor nor dbUrl is given", async () => {
    const s = createFaucetStore({});
    expect(
      await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1 })
    ).toBe(true);
  });

  it("uses the injected executor when provided", async () => {
    const { exec, calls } = mockExec();
    const s = createFaucetStore({ executor: exec });
    await s.tryReserve({ party: "a::1", ip: "1.1.1.1", amountCc: "0.02", nowMs: 1 });
    expect(calls.some((c) => c.startsWith("INSERT"))).toBe(true);
  });
});
