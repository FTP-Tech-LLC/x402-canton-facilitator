/**
 * Tests for the small routes — supported / discovery-resources /
 * health / close. These are exercised by the conformance harness; failure
 * here means a downstream conformance break.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { SupportedResponse } from "@ftptech/x402-canton-core";
import { registerSupportedRoute } from "./supported.js";
import { registerDiscoveryResourcesRoute } from "./discovery-resources.js";
import { registerHealthRoute } from "./health.js";
import { registerCloseRoute } from "./close.js";
import type { FacilitatorConfig } from "../config.js";
import { parseDiscoveryResources } from "../config.js";

const SAMPLE_RESOURCE = {
  resource: "https://api.example.com/inference",
  type: "http",
  accepts: [
    {
      scheme: "exact",
      network: "canton:mainnet",
      amount: "0.2500000000",
      asset: "CC",
      payTo: "merchant::1220deadbeef",
      maxTimeoutSeconds: 120,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: "facilitator",
      },
    },
  ],
  metadata: { title: "Example Inference API" },
};

function dummyConfig(
  overrides: Partial<FacilitatorConfig> = {}
): FacilitatorConfig {
  return {
    port: 4022,
    participantUrl: "http://localhost:3975",
    facilitatorParty: "ftp_facilitator::1220",
    facilitatorMemberId: undefined,
    network: "canton:devnet" as const,
    synchronizerId: "global-domain::1220",
    scanUrl: "http://localhost:3903",
    jwtIssuer: "unsafe-hmac",
    jwtSecret: "unsafe",
    oidcTokenEndpoint: undefined,
    oidcClientId: undefined,
    oidcClientSecret: undefined,
    ledgerApiAudience: undefined,
    dbUrl: "postgres://x:x@localhost/x",
    logLevel: "info",
    discoveryResources: [],
    ...overrides,
  };
}

describe("GET /health", () => {
  it("returns 200 with status:ok", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("returns Content-Type application/json", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("returns exactly {status:'ok'} with no extra fields", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    const r = await app.inject({ method: "GET", url: "/health" });
    const body = r.json<Record<string, unknown>>();
    // toEqual already checks deep equality — Object.keys check
    // makes the "no extra fields" intent explicit in the test name.
    expect(Object.keys(body)).toEqual(["status"]);
    expect(body.status).toBe("ok");
    await app.close();
  });

  it("always returns 200 regardless of other state", async () => {
    // Health must be unconditional — no service dependency should gate it.
    // We exercise it on a freshly-built app (no services wired) to prove
    // the handler doesn't throw when the rest of the server is absent.
    const app = Fastify();
    await registerHealthRoute(app);
    const r1 = await app.inject({ method: "GET", url: "/health" });
    expect(r1.statusCode).toBe(200);
    // Second call on same instance — still 200.
    const r2 = await app.inject({ method: "GET", url: "/health" });
    expect(r2.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /supported", () => {
  it("returns exactly ONE v2 'exact' kind for the configured network", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/supported" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as SupportedResponse;

    // x402-ENVELOPE: exactly ONE kind — v2 "exact" (the only scheme). The old v2
    // "exact-canton" and v1 "exact-canton" kinds were removed.
    expect(body.kinds).toHaveLength(1);
    const v2 = body.kinds.find((k) => k.x402Version === 2);
    expect(v2?.scheme).toBe("exact");
    expect(v2?.network).toBe("canton:devnet");
    expect(v2?.extra?.transferMethods).toContain("transfer-factory");
    // No legacy "exact-canton" kind and no v1 kind anymore.
    expect(body.kinds.some((k) => k.scheme === "exact-canton")).toBe(false);
    expect(body.kinds.some((k) => k.x402Version === 1)).toBe(false);

    expect(body.extensions).toEqual([]);
    expect(body.signers).toEqual({
      "canton:*": ["ftp_facilitator::1220"],
    });
    await app.close();
  });

  it("reflects mainnet when configured for mainnet", async () => {
    const app = Fastify();
    await registerSupportedRoute(
      app,
      dummyConfig({ network: "canton:mainnet" })
    );
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    expect(body.kinds.every((k) => k.network === "canton:mainnet")).toBe(true);
    await app.close();
  });

  it("POST /supported returns 404 (GET-only route)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const r = await app.inject({ method: "POST", url: "/supported" });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /discovery/resources", () => {
  it("returns an empty bazaar listing with default pagination", async () => {
    const app = Fastify();
    await registerDiscoveryResourcesRoute(app, dummyConfig());
    const r = await app.inject({
      method: "GET",
      url: "/discovery/resources",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      x402Version: 2,
      items: [],
      pagination: { limit: 20, offset: 0, total: 0 },
    });
    await app.close();
  });

  it("honors limit + offset query params (clamped to 100)", async () => {
    const app = Fastify();
    await registerDiscoveryResourcesRoute(app, dummyConfig());
    const r = await app.inject({
      method: "GET",
      url: "/discovery/resources?limit=500&offset=42",
    });
    const body = r.json() as { pagination: { limit: number; offset: number } };
    expect(body.pagination.limit).toBe(100);
    expect(body.pagination.offset).toBe(42);
    await app.close();
  });

  it("responds 200 for GET /discovery/resources", async () => {
    const app = Fastify();
    await registerDiscoveryResourcesRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/discovery/resources" });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it("Content-Type is application/json", async () => {
    const app = Fastify();
    await registerDiscoveryResourcesRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/discovery/resources" });
    expect(r.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("returns configured resources with a total count", async () => {
    const app = Fastify();
    await registerDiscoveryResourcesRoute(
      app,
      dummyConfig({ discoveryResources: [SAMPLE_RESOURCE] })
    );
    const r = await app.inject({ method: "GET", url: "/discovery/resources" });
    const body = r.json() as { items: unknown[]; pagination: { total: number } };
    expect(body.items).toEqual([SAMPLE_RESOURCE]);
    expect(body.pagination.total).toBe(1);
    await app.close();
  });

  it("filters items by ?type", async () => {
    const ws = {
      resource: "wss://api.example.com/stream",
      type: "websocket",
      accepts: SAMPLE_RESOURCE.accepts,
    };
    const app = Fastify();
    await registerDiscoveryResourcesRoute(
      app,
      dummyConfig({ discoveryResources: [SAMPLE_RESOURCE, ws] })
    );
    const r = await app.inject({
      method: "GET",
      url: "/discovery/resources?type=websocket",
    });
    const body = r.json() as {
      items: Array<{ resource: string }>;
      pagination: { total: number };
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].resource).toBe("wss://api.example.com/stream");
    expect(body.pagination.total).toBe(1);
    await app.close();
  });

  it("paginates configured resources with limit + offset", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      resource: `https://api.example.com/r${i}`,
      type: "http",
      accepts: SAMPLE_RESOURCE.accepts,
    }));
    const app = Fastify();
    await registerDiscoveryResourcesRoute(
      app,
      dummyConfig({ discoveryResources: many })
    );
    const r = await app.inject({
      method: "GET",
      url: "/discovery/resources?limit=2&offset=1",
    });
    const body = r.json() as {
      items: Array<{ resource: string }>;
      pagination: { total: number; limit: number; offset: number };
    };
    expect(body.items.map((i) => i.resource)).toEqual([
      "https://api.example.com/r1",
      "https://api.example.com/r2",
    ]);
    expect(body.pagination).toEqual({ limit: 2, offset: 1, total: 5 });
    await app.close();
  });
});

describe("parseDiscoveryResources", () => {
  it("returns [] for unset or blank", () => {
    expect(parseDiscoveryResources(undefined)).toEqual([]);
    expect(parseDiscoveryResources("   ")).toEqual([]);
  });

  it("parses a valid array and defaults type to http", () => {
    const out = parseDiscoveryResources(
      JSON.stringify([{ resource: "https://a/x", accepts: [{ scheme: "exact" }] }])
    );
    expect(out).toEqual([
      { resource: "https://a/x", type: "http", accepts: [{ scheme: "exact" }] },
    ]);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseDiscoveryResources("{not json")).toThrow(/not valid JSON/);
  });

  it("throws when the top level is not an array", () => {
    expect(() => parseDiscoveryResources('{"resource":"x"}')).toThrow(
      /must be a JSON array/
    );
  });

  it("throws when an entry has no resource string", () => {
    expect(() => parseDiscoveryResources('[{"accepts":[{}]}]')).toThrow(
      /missing a non-empty "resource"/
    );
  });

  it("throws when accepts is empty or missing", () => {
    expect(() =>
      parseDiscoveryResources('[{"resource":"https://a/x","accepts":[]}]')
    ).toThrow(/non-empty "accepts"/);
    expect(() =>
      parseDiscoveryResources('[{"resource":"https://a/x"}]')
    ).toThrow(/non-empty "accepts"/);
  });
});

describe("GET /supported signers", () => {
  it("includes facilitatorParty in signers['canton:*']", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig({ facilitatorParty: "ftp_fac::1220abc" }));
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    expect(body.signers?.["canton:*"]).toContain("ftp_fac::1220abc");
    await app.close();
  });

  it("signers object has at least one key", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    expect(Object.keys(body.signers ?? {})).toHaveLength(1);
    await app.close();
  });

  it("each kind has x402Version, scheme, and network fields", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    for (const kind of body.kinds) {
      expect(kind).toHaveProperty("x402Version");
      expect(kind).toHaveProperty("scheme");
      expect(kind).toHaveProperty("network");
    }
    await app.close();
  });

  it("extensions is an array", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    expect(Array.isArray(body.extensions)).toBe(true);
    await app.close();
  });

  it("returns Content-Type application/json", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/supported" });
    expect(r.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("network field on all kinds matches what was configured (devnet)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig({ network: "canton:devnet" }));
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    expect(body.kinds.every((k) => k.network === "canton:devnet")).toBe(true);
    await app.close();
  });

  it("network field on all kinds matches what was configured (mainnet)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig({ network: "canton:mainnet" }));
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    expect(body.kinds.every((k) => k.network === "canton:mainnet")).toBe(true);
    await app.close();
  });
});

describe("GET /supported — x402Version type and value assertions", () => {
  // all kinds have x402Version as number (not string)
  it("all kinds have x402Version as a number (not a string)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;

    for (const kind of body.kinds) {
      expect(typeof kind.x402Version).toBe("number");
      // Must NOT be a string like "2" or "1"
      expect(typeof kind.x402Version).not.toBe("string");
    }
    await app.close();
  });

  // x402Version is exactly 2 (the v1 kind was removed)
  it("x402Version is 2 only (no v1 kind)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;

    const versions = body.kinds.map((k) => k.x402Version);
    expect(versions).toContain(2);
    expect(versions).not.toContain(1);
    await app.close();
  });

  // the network field in each kind is "canton:devnet" or "canton:mainnet"
  it("the network field in each kind is 'canton:devnet' or 'canton:mainnet'", async () => {
    const validNetworks = ["canton:devnet", "canton:mainnet"];

    // test with devnet
    const appDev = Fastify();
    await registerSupportedRoute(appDev, dummyConfig({ network: "canton:devnet" }));
    const bodyDev = (
      await appDev.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    for (const kind of bodyDev.kinds) {
      expect(validNetworks).toContain(kind.network);
    }
    await appDev.close();

    // test with mainnet
    const appMain = Fastify();
    await registerSupportedRoute(appMain, dummyConfig({ network: "canton:mainnet" }));
    const bodyMain = (
      await appMain.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    for (const kind of bodyMain.kinds) {
      expect(validNetworks).toContain(kind.network);
    }
    await appMain.close();
  });

  // signers["canton:*"] is a non-empty array of strings
  it("signers['canton:*'] is a non-empty array of strings", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;

    const cantonSigners = body.signers?.["canton:*"];
    expect(Array.isArray(cantonSigners)).toBe(true);
    expect((cantonSigners as string[]).length).toBeGreaterThan(0);
    for (const s of cantonSigners as string[]) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    }
    await app.close();
  });
});

describe("GET /health — JSON validity", () => {
  // response is valid JSON (parseable)
  it("response body is valid JSON (parseable)", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    const r = await app.inject({ method: "GET", url: "/health" });

    // r.body is a raw string — verify it's valid JSON by parsing
    expect(() => JSON.parse(r.body)).not.toThrow();
    const parsed = JSON.parse(r.body);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
    await app.close();
  });
});

describe("GET /supported — structure and method guards (batch 3)", () => {
  // GET /supported returns extensions as empty array
  it("GET /supported returns extensions as an empty array", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/supported" });
    const body = r.json() as SupportedResponse;
    expect(body.extensions).toEqual([]);
    await app.close();
  });

  // POST /health → 404 (method not allowed)
  it("POST /health → 404 (health is GET-only)", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    const r = await app.inject({ method: "POST", url: "/health" });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  // GET /close → 404 (GET not allowed for close)
  it("GET /close → 404 (close is POST-only)", async () => {
    const app = Fastify();
    await registerCloseRoute(app);
    const r = await app.inject({ method: "GET", url: "/close" });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  // /supported has exactly the keys: kinds, extensions, signers
  it("/supported response has exactly the keys: kinds, extensions, signers", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/supported" });
    const body = r.json<Record<string, unknown>>();
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(["extensions", "kinds", "signers"]);
    await app.close();
  });

  // /health has exactly one key: status
  it("/health response has exactly one key: status", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    const r = await app.inject({ method: "GET", url: "/health" });
    const body = r.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(["status"]);
    await app.close();
  });

  // /discovery/resources returns valid JSON (parseable)
  it("/discovery/resources returns valid JSON (parseable body)", async () => {
    const app = Fastify();
    await registerDiscoveryResourcesRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/discovery/resources" });
    // r.body is a raw string — must be parseable JSON
    expect(() => JSON.parse(r.body)).not.toThrow();
    const parsed = JSON.parse(r.body);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    await app.close();
  });
});



describe("GET /supported — transferMethods and version shape (batch 4)", () => {
  it("advertises the sole settlement method (transfer-factory)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/supported" });
    const v2 = (
      r.json() as {
        kinds: Array<{
          x402Version: number;
          extra?: { transferMethods?: string[] };
        }>;
      }
    ).kinds.find((k) => k.x402Version === 2);
    expect(v2?.extra?.transferMethods).toEqual(["transfer-factory"]);
    await app.close();
  });

  it("v2 kind extra.transferMethods contains 'transfer-factory'", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    const v2 = body.kinds.find((k) => k.x402Version === 2);
    expect(v2?.extra?.transferMethods).toContain("transfer-factory");
    await app.close();
  });

  it("there is NO v1 kind (it was removed)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    const v1 = body.kinds.find((k) => k.x402Version === 1);
    expect(v1).toBeUndefined();
    await app.close();
  });

  it("x402Version across all kinds is exactly {2} (no v1)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    // x402-ENVELOPE: exactly ONE v2 "exact" kind now (the old v2 "exact-canton"
    // and v1 "exact-canton" kinds were removed).
    const versions = [...new Set(body.kinds.map((k) => k.x402Version))].sort(
      (a, b) => a - b
    );
    expect(versions).toEqual([2]);
    await app.close();
  });

  it("health: repeated calls always return 200 and {status:'ok'}", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: "GET", url: "/health" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: "ok" });
    }
    await app.close();
  });

  it("kinds array has exactly 1 entry (the sole v2 'exact' kind)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    expect(body.kinds).toHaveLength(1);
    await app.close();
  });

  it("/discovery/resources returns an object (not array)", async () => {
    const app = Fastify();
    await registerDiscoveryResourcesRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/discovery/resources" });
    const body = r.json();
    expect(typeof body).toBe("object");
    expect(Array.isArray(body)).toBe(false);
    await app.close();
  });

  it("signers['canton:*'] array contains exactly the facilitator party", async () => {
    const PARTY = "ftp_facilitator::1220exact";
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig({ facilitatorParty: PARTY }));
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    const signers = body.signers?.["canton:*"] ?? [];
    expect(signers).toContain(PARTY);
    // It must contain ONLY this party — exactly one entry
    expect(signers).toHaveLength(1);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Completeness round (batch 5)
// ---------------------------------------------------------------------------

describe("GET /supported — completeness round (batch 5)", () => {
  it("/supported: all kinds are for the configured network (devnet check)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig({ network: "canton:devnet" }));
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    // Every kind must carry the network we configured
    for (const kind of body.kinds) {
      expect(kind.network).toBe("canton:devnet");
    }
    await app.close();
  });

  it("/health: response Content-Type includes 'application/json'", async () => {
    const app = Fastify();
    await registerHealthRoute(app);
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("/supported: when mainnet — all kinds have network='canton:mainnet'", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig({ network: "canton:mainnet" }));
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    for (const kind of body.kinds) {
      expect(kind.network).toBe("canton:mainnet");
    }
    await app.close();
  });

  it("/close: response body before exit is {status:'ok'} or {}", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as typeof process.exit);
    const app = Fastify();
    // H2: /close is gated; enable it for this conformance assertion.
    await registerCloseRoute(app, true);
    const r = await app.inject({ method: "POST", url: "/close" });
    expect(r.statusCode).toBe(200);
    // The body should be a valid JSON object (either {status:'ok'} or {})
    const body = r.json<Record<string, unknown>>();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    // The handler defers shutdown via setImmediate(async () => {
    //   await app.close(); process.exit(0); }). We MUST let that callback
    // fire while the process.exit spy is still active — otherwise the real
    // process.exit(0) runs after restoreAllMocks() and Vitest reports an
    // unhandled "process.exit unexpectedly called with 0" error that fails
    // the whole suite. Poll until exit was observed, then restore.
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    vi.restoreAllMocks();
  });

  it("/supported: signers keys include 'canton:*' specifically (not just any key)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const body = (
      await app.inject({ method: "GET", url: "/supported" })
    ).json() as SupportedResponse;
    // The signers object must have exactly the "canton:*" key
    const keys = Object.keys(body.signers ?? {});
    expect(keys).toContain("canton:*");
    // Verify it is literally "canton:*" (not "canton:devnet" or "canton:mainnet")
    expect(keys).toContain("canton:*");
    expect(keys.every((k) => k === "canton:*")).toBe(true);
    await app.close();
  });
});



describe("GET /supported transfer-factory advertisement", () => {
  it("advertises transfer-factory unconditionally (the sole settlement method)", async () => {
    const app = Fastify();
    await registerSupportedRoute(app, dummyConfig());
    const r = await app.inject({ method: "GET", url: "/supported" });
    const body = r.json() as SupportedResponse;
    expect(body.kinds[0]!.extra!.transferMethods).toEqual([
      "transfer-factory",
    ]);
    await app.close();
  });

  it("advertises transfer-factory regardless of the tfEnabled/advertiseTf gates", async () => {
    const app = Fastify();
    await registerSupportedRoute(
      app,
      dummyConfig({ tfEnabled: true, advertiseTf: true })
    );
    const r = await app.inject({ method: "GET", url: "/supported" });
    const body = r.json() as SupportedResponse;
    expect(body.kinds[0]!.extra!.transferMethods).toEqual([
      "transfer-factory",
    ]);
    await app.close();
  });
});
