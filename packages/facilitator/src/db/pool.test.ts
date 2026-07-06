import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture every `new Pool(config)` call so we can assert the hardened options
// without opening a real database connection. `vi.hoisted` makes the spy state
// available inside the hoisted `vi.mock` factory.
const h = vi.hoisted(() => {
  const configs: unknown[] = [];
  const onEvents: string[] = [];
  return { configs, onEvents };
});

vi.mock("pg", () => {
  class FakePool {
    config: unknown;
    constructor(config: unknown) {
      this.config = config;
      h.configs.push(config);
    }
    on(event: string): this {
      h.onEvents.push(event);
      return this;
    }
    query(): Promise<{ rows: unknown[]; rowCount: number }> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

// Imported AFTER the mock is declared (vi.mock is hoisted above imports anyway).
import {
  createFacilitatorPool,
  poolExecutor,
  DEFAULT_POOL_OPTIONS,
  type PgExecutor,
} from "./pool.js";

interface CapturedConfig {
  connectionString?: string;
  statement_timeout?: number | false;
  query_timeout?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number | null;
  max?: number;
  application_name?: string;
}

describe("createFacilitatorPool", () => {
  beforeEach(() => {
    h.configs.length = 0;
    h.onEvents.length = 0;
  });

  it("applies the hardened defaults (timeouts + bounded max)", () => {
    createFacilitatorPool("postgres://u:p@host:5432/db");
    expect(h.configs).toHaveLength(1);
    const cfg = h.configs[0] as CapturedConfig;
    expect(cfg.connectionString).toBe("postgres://u:p@host:5432/db");
    expect(cfg.statement_timeout).toBe(DEFAULT_POOL_OPTIONS.statementTimeoutMs);
    expect(cfg.query_timeout).toBe(DEFAULT_POOL_OPTIONS.queryTimeoutMs);
    expect(cfg.connectionTimeoutMillis).toBe(
      DEFAULT_POOL_OPTIONS.connectionTimeoutMs
    );
    expect(cfg.idleTimeoutMillis).toBe(DEFAULT_POOL_OPTIONS.idleTimeoutMs);
    expect(cfg.max).toBe(DEFAULT_POOL_OPTIONS.max);
    expect(cfg.application_name).toBe(DEFAULT_POOL_OPTIONS.applicationName);
  });

  it("the default statement_timeout is a finite, positive number (not disabled)", () => {
    createFacilitatorPool("postgres://x/db");
    const cfg = h.configs[0] as CapturedConfig;
    expect(typeof cfg.statement_timeout).toBe("number");
    expect(cfg.statement_timeout).toBeGreaterThan(0);
    // a sane upper sanity bound — money path should never wait 60s on a query
    expect(cfg.statement_timeout as number).toBeLessThanOrEqual(10_000);
  });

  it("connectionTimeoutMillis is short (fail-fast acquire, ~2s)", () => {
    createFacilitatorPool("postgres://x/db");
    const cfg = h.configs[0] as CapturedConfig;
    expect(cfg.connectionTimeoutMillis as number).toBeGreaterThan(0);
    expect(cfg.connectionTimeoutMillis as number).toBeLessThanOrEqual(5_000);
  });

  it("max connections are bounded (sane cap, not unbounded)", () => {
    createFacilitatorPool("postgres://x/db");
    const cfg = h.configs[0] as CapturedConfig;
    expect(cfg.max as number).toBeGreaterThan(0);
    expect(cfg.max as number).toBeLessThanOrEqual(50);
  });

  it("honours explicit overrides", () => {
    createFacilitatorPool("postgres://x/db", {
      statementTimeoutMs: 1234,
      queryTimeoutMs: 2345,
      connectionTimeoutMs: 678,
      idleTimeoutMs: 9999,
      max: 7,
      applicationName: "custom-app",
    });
    const cfg = h.configs[0] as CapturedConfig;
    expect(cfg.statement_timeout).toBe(1234);
    expect(cfg.query_timeout).toBe(2345);
    expect(cfg.connectionTimeoutMillis).toBe(678);
    expect(cfg.idleTimeoutMillis).toBe(9999);
    expect(cfg.max).toBe(7);
    expect(cfg.application_name).toBe("custom-app");
  });

  it("registers a pool 'error' handler so an idle-client error cannot crash the process", () => {
    createFacilitatorPool("postgres://x/db");
    // A pool-level 'error' without a listener would be an unhandled EventEmitter
    // 'error' and crash Node; the factory must attach one.
    expect(h.onEvents).toContain("error");
  });
});

describe("poolExecutor", () => {
  it("adapts a pool to the PgExecutor surface and forwards sql + params", async () => {
    const queryMock = vi
      .fn()
      .mockResolvedValue({ rows: [{ x: 1 }], rowCount: 1 });
    const fakePool = { query: queryMock } as unknown as Parameters<
      typeof poolExecutor
    >[0];
    const exec: PgExecutor = poolExecutor(fakePool);
    const r = await exec.query("SELECT $1", ["a"]);
    expect(r.rowCount).toBe(1);
    expect(queryMock).toHaveBeenCalledWith("SELECT $1", ["a"]);
  });
});
