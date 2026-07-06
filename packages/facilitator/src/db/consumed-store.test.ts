import { describe, it, expect } from "vitest";
import {
  createInMemoryConsumedStore,
  createPostgresConsumedStore,
  createConsumedStore,
  type PgExecutor,
} from "./consumed-store.js";

describe("InMemoryConsumedStore", () => {
  it("markSettled: true first time, false on replay", async () => {
    const s = createInMemoryConsumedStore();
    expect(await s.markSettled("u1")).toBe(true);
    expect(await s.markSettled("u1")).toBe(false);
    expect(await s.markSettled("u2")).toBe(true);
  });

  it("has: non-consuming reflection of settled keys", async () => {
    const s = createInMemoryConsumedStore();
    expect(await s.has("u1")).toBe(false);
    expect(await s.markSettled("u1")).toBe(true);
    expect(await s.has("u1")).toBe(true);
    expect(await s.has("u1")).toBe(true);
  });

  it("FIFO-evicts beyond maxSize (bounded memory)", async () => {
    const s = createInMemoryConsumedStore({ maxSize: 2 });
    await s.markSettled("a");
    await s.markSettled("b");
    expect(await s.has("a")).toBe(true);
    await s.markSettled("c"); // evicts oldest "a"
    expect(await s.has("a")).toBe(false);
    expect(await s.has("b")).toBe(true);
    expect(await s.has("c")).toBe(true);
  });
});


function mockExec(): { exec: PgExecutor; calls: string[] } {
  const seen = new Set<string>();
  const calls: string[] = [];
  const exec: PgExecutor = {
    async query(sql: string, params?: unknown[]) {
      calls.push(sql.split(" ").slice(0, 2).join(" "));
      if (sql.startsWith("CREATE TABLE")) return { rows: [], rowCount: 0 };
      const key = (params as string[] | undefined)?.[0] ?? "";
      if (sql.startsWith("INSERT")) {
        if (seen.has(key)) return { rows: [], rowCount: 0 };
        seen.add(key);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SELECT")) {
        return seen.has(key) ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { exec, calls };
}

describe("PostgresConsumedStore (injected executor)", () => {
  it("markSettled: true first, false on replay (INSERT ON CONFLICT)", async () => {
    const s = createPostgresConsumedStore(mockExec().exec);
    expect(await s.markSettled("u1")).toBe(true);
    expect(await s.markSettled("u1")).toBe(false);
  });

  it("has: reflects settled, non-consuming", async () => {
    const s = createPostgresConsumedStore(mockExec().exec);
    expect(await s.has("u1")).toBe(false);
    expect(await s.markSettled("u1")).toBe(true);
    expect(await s.has("u1")).toBe(true);
  });

  it("creates the table lazily exactly once", async () => {
    const m = mockExec();
    const s = createPostgresConsumedStore(m.exec);
    await s.markSettled("a");
    await s.markSettled("b");
    await s.has("a");
    expect(m.calls.filter((c) => c.startsWith("CREATE TABLE")).length).toBe(1);
  });

  it("fail-open on DB error: markSettled→true (allow), has→false (not-seen)", async () => {
    const exec: PgExecutor = {
      async query() {
        throw new Error("db down");
      },
    };
    const s = createPostgresConsumedStore(exec, { onError: () => {} });
    expect(await s.markSettled("x")).toBe(true);
    expect(await s.has("x")).toBe(false);
  });
});

describe("createConsumedStore factory", () => {
  it("no dbUrl → in-memory (works without a database)", async () => {
    const s = createConsumedStore({});
    expect(await s.markSettled("u1")).toBe(true);
    expect(await s.markSettled("u1")).toBe(false);
    expect(await s.has("u1")).toBe(true);
  });

  it("uses an injected shared executor (single-pool path) over building its own", async () => {
    // WS2: the composition root passes ONE hardened pool's executor; the
    // factory must route through it (no private Pool) so consumed+attribution
    // share connections. Using a mock executor also proves no real DB connect
    // is attempted even though dbUrl is set.
    const { exec, calls } = mockExec();
    const s = createConsumedStore({ dbUrl: "postgres://ignored", executor: exec });
    expect(await s.markSettled("u1")).toBe(true);
    expect(await s.markSettled("u1")).toBe(false); // replay → through same executor
    expect(await s.has("u1")).toBe(true);
    expect(calls.some((c) => c.startsWith("INSERT"))).toBe(true);
  });
});
