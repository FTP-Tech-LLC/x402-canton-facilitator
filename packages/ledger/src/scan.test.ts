import { describe, it, expect, vi } from "vitest";
import {
  ScanClient,
  TtlSingleFlightCache,
  getEventTrafficSummaryWithFallback,
  isTransientScanError,
  type TrafficSummaryResult,
} from "./scan.js";
import { CantonError } from "./client.js";

const VALIDATOR_BASE = "http://validator.test:3903";
const SV_BASE = "https://scan.sv-1.dev.global.test.sync";
const TOKEN = "test-jwt";

function makeFetch(
  responder: (req: { url: string; init: RequestInit }) => {
    status?: number;
    body?: unknown;
  }
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = {} } = responder({ url, init: init ?? {} });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof globalThis.fetch;
}

describe("ScanClient validator-proxy flavor", () => {
  it("targets /api/validator/v0/scan-proxy/amulet-rules", async () => {
    let url = "";
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch((req) => {
        url = req.url;
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar-cid",
                template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
                created_event_blob: "blob",
                payload: { dso: "dso::1220", isDevNet: true },
              },
              domain_id: "global-domain::1220",
            },
          },
        };
      }),
    });

    const r = await c.getAmuletRules();
    expect(url).toBe(
      `${VALIDATOR_BASE}/api/validator/v0/scan-proxy/amulet-rules`
    );
    expect(r.amulet_rules.contract.contract_id).toBe("ar-cid");
    expect(r.amulet_rules.contract.payload.isDevNet).toBe(true);
    expect(r.amulet_rules.domain_id).toBe("global-domain::1220");
  });

  it("targets /api/validator/v0/scan-proxy/open-and-issuing-mining-rounds", async () => {
    let url = "";
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch((req) => {
        url = req.url;
        return {
          body: {
            open_mining_rounds: [
              {
                contract: {
                  contract_id: "omr-1",
                  template_id: "#splice-amulet:Splice.AmuletRules:OpenMiningRound",
                  created_event_blob: "blob1",
                  payload: { round: { number: "42" } },
                },
              },
            ],
            issuing_mining_rounds: [
              {
                contract: {
                  contract_id: "imr-1",
                  template_id: "#splice-amulet:Splice.AmuletRules:IssuingMiningRound",
                  created_event_blob: "blob2",
                  payload: {
                    round: { number: "41" },
                    opensAt: "2026-05-24T10:00:00Z",
                  },
                },
              },
            ],
          },
        };
      }),
    });

    const r = await c.getOpenAndIssuingMiningRounds();
    expect(url).toBe(
      `${VALIDATOR_BASE}/api/validator/v0/scan-proxy/open-and-issuing-mining-rounds`
    );
    expect(r.open_mining_rounds[0]?.contract.contract_id).toBe("omr-1");
    expect(r.issuing_mining_rounds[0]?.contract.payload.opensAt).toBe(
      "2026-05-24T10:00:00Z"
    );
  });


  it("forwards Authorization Bearer header when token configured", async () => {
    let auth: string | null = null;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      token: TOKEN,
      fetch: makeFetch((req) => {
        auth = new Headers(req.init.headers).get("Authorization");
        return { body: { amulet_rules: { contract: { contract_id: "", template_id: "", created_event_blob: "", payload: { dso: "", isDevNet: false } }, domain_id: "" } } };
      }),
    });
    await c.getAmuletRules();
    expect(auth).toBe(`Bearer ${TOKEN}`);
  });

  it("omits Authorization when no token configured (public SV reads)", async () => {
    let headers: Headers | null = null;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch((req) => {
        headers = new Headers(req.init.headers);
        return { body: { amulet_rules: { contract: { contract_id: "", template_id: "", created_event_blob: "", payload: { dso: "", isDevNet: false } }, domain_id: "" } } };
      }),
    });
    await c.getAmuletRules();
    expect(headers?.get("Authorization")).toBeNull();
  });
});

describe("ScanClient sv flavor", () => {
  it("targets /api/scan/v0/amulet-rules", async () => {
    let url = "";
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        url = req.url;
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    await c.getAmuletRules();
    expect(url).toBe(`${SV_BASE}/api/scan/v0/amulet-rules`);
  });

  it("traffic-status path includes synchronizerId and memberId", async () => {
    let url = "";
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        url = req.url;
        return {
          body: {
            traffic_status: {
              actual: { total_consumed: 1234567, total_limit: 5000000 },
              target: { total_purchased: 5000000 },
            },
          },
        };
      }),
    });

    const r = await c.getTrafficStatus(
      "global-domain::1220xyz",
      "PAR::ftp-validator-1::1220abc"
    );
    expect(url).toBe(
      `${SV_BASE}/api/scan/v0/domains/global-domain%3A%3A1220xyz/members/PAR%3A%3Aftp-validator-1%3A%3A1220abc/traffic-status`
    );
    expect(r.traffic_status.actual.total_consumed).toBe(1234567);
  });
});

describe("ScanClient errors", () => {
  it("throws CantonError on HTTP 404 with status preserved", async () => {
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({ status: 404, body: { error: "not found" } })),
    });
    await expect(c.getAmuletRules()).rejects.toMatchObject({
      name: "CantonError",
      status: 404,
    });
  });

  it("aborts when timeoutMs elapses", async () => {
    let aborted = false;
    const slowFetch: typeof globalThis.fetch = vi.fn(
      async (_input, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        })
    ) as typeof globalThis.fetch;

    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      timeoutMs: 20,
      fetch: slowFetch,
    });
    await expect(c.getAmuletRules()).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

// ─── New targeted tests ────────────────────────────────────────────

describe("ScanClient — new coverage", () => {
  it("getAmuletRules: contract_id from response body is preserved exactly", async () => {
    const EXACT_CID = "00aabbccddeeff112233445566778899aabbccddeeff001122334455667788";
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          amulet_rules: {
            contract: {
              contract_id: EXACT_CID,
              template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
              created_event_blob: "blob-exact",
              payload: { dso: "dso::1220", isDevNet: false },
            },
            domain_id: "global-domain::1220",
          },
        },
      })),
    });
    const r = await c.getAmuletRules();
    expect(r.amulet_rules.contract.contract_id).toBe(EXACT_CID);
  });

  it("getOpenAndIssuingMiningRounds: returns both openMiningRounds and issuingMiningRounds arrays", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({
        body: {
          open_mining_rounds: [
            {
              contract: {
                contract_id: "omr-open-1",
                template_id: "#splice:OpenMiningRound",
                created_event_blob: "blob-omr",
                payload: { round: { number: "100" } },
              },
            },
            {
              contract: {
                contract_id: "omr-open-2",
                template_id: "#splice:OpenMiningRound",
                created_event_blob: "blob-omr2",
                payload: { round: { number: "101" } },
              },
            },
          ],
          issuing_mining_rounds: [
            {
              contract: {
                contract_id: "imr-issuing-1",
                template_id: "#splice:IssuingMiningRound",
                created_event_blob: "blob-imr",
                payload: {
                  round: { number: "99" },
                  opensAt: "2026-06-01T00:00:00Z",
                },
              },
            },
          ],
        },
      })),
    });
    const r = await c.getOpenAndIssuingMiningRounds();
    expect(Array.isArray(r.open_mining_rounds)).toBe(true);
    expect(Array.isArray(r.issuing_mining_rounds)).toBe(true);
    expect(r.open_mining_rounds).toHaveLength(2);
    expect(r.issuing_mining_rounds).toHaveLength(1);
    expect(r.open_mining_rounds[0]?.contract.contract_id).toBe("omr-open-1");
    expect(r.open_mining_rounds[1]?.contract.contract_id).toBe("omr-open-2");
    expect(r.issuing_mining_rounds[0]?.contract.contract_id).toBe("imr-issuing-1");
  });

  it("getTrafficStatus: path includes both synchronizerId and memberId in the URL", async () => {
    let capturedUrl = "";
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(({ url }) => {
        capturedUrl = url;
        return {
          body: {
            traffic_status: {
              actual: { total_consumed: 0, total_limit: 1000000 },
              target: { total_purchased: 1000000 },
            },
          },
        };
      }),
    });
    const syncId = "global-domain::1220xyz";
    const membId = "PAR::node-1::1220abc";
    await c.getTrafficStatus(syncId, membId);
    expect(capturedUrl).toContain(encodeURIComponent(syncId));
    expect(capturedUrl).toContain(encodeURIComponent(membId));
  });

  it("tokenProvider function is called on each request", async () => {
    let callCount = 0;
    const tokenProvider = vi.fn(async () => {
      callCount++;
      return `token-${callCount}`;
    });
    const capturedAuths: string[] = [];
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      token: tokenProvider,
      // Disable the amulet-rules TTL cache so each getAmuletRules() actually
      // hits the wire — this test verifies the token provider is consulted
      // (and a fresh token forwarded) per HTTP request, not per logical call.
      cache: { amuletRulesTtlMs: 0 },
      fetch: makeFetch(({ init }) => {
        const h = new Headers(init.headers);
        const auth = h.get("Authorization");
        if (auth) capturedAuths.push(auth);
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    await c.getAmuletRules();
    await c.getAmuletRules();
    // tokenProvider called once per request
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    // Each call got a different token
    expect(capturedAuths[0]).toBe("Bearer token-1");
    expect(capturedAuths[1]).toBe("Bearer token-2");
  });

});

// ─── Additional complex scan tests ────────────────────────────────

describe("ScanClient — error handling and edge cases", () => {
  it("throws CantonError with status code on non-2xx response", async () => {
    const scan = new ScanClient({
      scanUrl: "http://scan.test",
      flavor: "sv",
      fetch: makeFetch(() => ({ status: 503, body: { error: "unavailable" } })),
    });
    await expect(scan.getAmuletRules()).rejects.toThrow(/503/);
  });


  it("getOpenAndIssuingMiningRounds uses validator-proxy path for flavor=validator", async () => {
    let capturedUrl = "";
    const scan = new ScanClient({
      scanUrl: "http://validator.test",
      flavor: "validator",
      token: "tok",
      fetch: makeFetch(({ url }) => {
        capturedUrl = url;
        return { status: 200, body: { openMiningRounds: [], issuingMiningRounds: [] } };
      }),
    });
    await scan.getOpenAndIssuingMiningRounds().catch(() => {});
    expect(capturedUrl).toContain("scan-proxy");
  });

  it("getOpenAndIssuingMiningRounds uses public scan path for flavor=sv", async () => {
    let capturedUrl = "";
    const scan = new ScanClient({
      scanUrl: "http://sv-scan.test",
      flavor: "sv",
      fetch: makeFetch(({ url }) => {
        capturedUrl = url;
        return { status: 200, body: { openMiningRounds: [], issuingMiningRounds: [] } };
      }),
    });
    await scan.getOpenAndIssuingMiningRounds().catch(() => {});
    expect(capturedUrl).not.toContain("scan-proxy");
    expect(capturedUrl).toContain("api/scan");
  });

  it("token is sent in Authorization header for validator flavor", async () => {
    let capturedHeaders: Record<string, string> = {};
    const scan = new ScanClient({
      scanUrl: "http://validator.test",
      flavor: "validator",
      token: "bearer-secret",
      fetch: makeFetch(({ init }) => {
        capturedHeaders = init.headers as Record<string, string>;
        return { status: 200, body: {} };
      }),
    });
    await scan.getAmuletRules().catch(() => {});
    expect(capturedHeaders["Authorization"]).toBe("Bearer bearer-secret");
  });

  it("no Authorization header for sv flavor (public scan)", async () => {
    let capturedHeaders: Record<string, string> = {};
    const scan = new ScanClient({
      scanUrl: "http://sv.scan.test",
      flavor: "sv",
      fetch: makeFetch(({ init }) => {
        capturedHeaders = init.headers as Record<string, string>;
        return { status: 200, body: {} };
      }),
    });
    await scan.getAmuletRules().catch(() => {});
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("timeout aborts and throws (signal-aware mock)", async () => {
    // Mock that listens to AbortSignal — required for timeout test to work
    const fetch: typeof globalThis.fetch = vi.fn(
      async (_input, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
          );
        })
    ) as typeof globalThis.fetch;
    const scan = new ScanClient({
      scanUrl: "http://scan.test",
      flavor: "sv",
      timeoutMs: 20,
      fetch,
    });
    await expect(scan.getAmuletRules()).rejects.toThrow(/aborted/i);
  });
});

// ─── New targeted tests (batch 2) ─────────────────────────────────

describe("ScanClient — domain_id, contract_id, nonce path, headers, traffic flavor", () => {
  it("getAmuletRules: the full domain_id field is accessible in the response", async () => {
    const DOMAIN_ID = "global-domain::1220aabbccddeeff";
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          amulet_rules: {
            contract: {
              contract_id: "ar-cid-domaintest",
              template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
              created_event_blob: "blob-domain",
              payload: { dso: "dso::1220", isDevNet: false },
            },
            domain_id: DOMAIN_ID,
          },
        },
      })),
    });
    const r = await c.getAmuletRules();
    expect(r.amulet_rules.domain_id).toBe(DOMAIN_ID);
  });

  it("getOpenAndIssuingMiningRounds: each open mining round has a contract_id field", async () => {
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          open_mining_rounds: [
            {
              contract: {
                contract_id: "omr-cid-alpha",
                template_id: "#splice-amulet:Splice.AmuletRules:OpenMiningRound",
                created_event_blob: "blob-a",
                payload: { round: { number: "10" } },
              },
            },
            {
              contract: {
                contract_id: "omr-cid-beta",
                template_id: "#splice-amulet:Splice.AmuletRules:OpenMiningRound",
                created_event_blob: "blob-b",
                payload: { round: { number: "11" } },
              },
            },
          ],
          issuing_mining_rounds: [],
        },
      })),
    });
    const r = await c.getOpenAndIssuingMiningRounds();
    for (const omr of r.open_mining_rounds) {
      expect(typeof omr.contract.contract_id).toBe("string");
      expect(omr.contract.contract_id.length).toBeGreaterThan(0);
    }
    expect(r.open_mining_rounds[0]?.contract.contract_id).toBe("omr-cid-alpha");
    expect(r.open_mining_rounds[1]?.contract.contract_id).toBe("omr-cid-beta");
  });


  it("ScanClient: requests include correct Accept: application/json header", async () => {
    let capturedAccept: string | null = null;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(({ init }) => {
        const h = new Headers(init.headers);
        capturedAccept = h.get("Accept");
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    await c.getAmuletRules();
    expect(capturedAccept).toBe("application/json");
  });

  // ── NEW: ScanClient does NOT auto-retry on error ──────────────────────
  it("ScanClient retries are NOT done automatically (if first call returns error, it throws immediately)", async () => {
    let callCount = 0;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => {
        callCount++;
        return { status: 500, body: { error: "internal server error" } };
      }),
    });

    await expect(c.getAmuletRules()).rejects.toThrow(/500/);
    // Only one fetch call — no automatic retry
    expect(callCount).toBe(1);
  });

  // ── NEW: getAmuletRules response contains template_id field ──────────────
  it("getAmuletRules: the response contains template_id field", async () => {
    const TEMPLATE_ID = "#splice-amulet:Splice.AmuletRules:AmuletRules";
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          amulet_rules: {
            contract: {
              contract_id: "ar-template-check",
              template_id: TEMPLATE_ID,
              created_event_blob: "blob",
              payload: { dso: "dso::1220", isDevNet: false },
            },
            domain_id: "global-domain::1220",
          },
        },
      })),
    });
    const r = await c.getAmuletRules();
    expect(r.amulet_rules.contract.template_id).toBe(TEMPLATE_ID);
  });

  // ── NEW: getOpenAndIssuingMiningRounds with empty arrays ─────────────────
  it("getOpenAndIssuingMiningRounds: empty arrays are valid (no error when both are [])", async () => {
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          open_mining_rounds: [],
          issuing_mining_rounds: [],
        },
      })),
    });

    // Must NOT throw when both arrays are empty
    const r = await c.getOpenAndIssuingMiningRounds();
    expect(r.open_mining_rounds).toEqual([]);
    expect(r.issuing_mining_rounds).toEqual([]);
    expect(r.open_mining_rounds).toHaveLength(0);
    expect(r.issuing_mining_rounds).toHaveLength(0);
  });


  it("getTrafficStatus for flavor=validator: uses scan-proxy path (not public scan)", async () => {
    let capturedUrl = "";
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      flavor: "validator",
      token: TOKEN,
      fetch: makeFetch(({ url }) => {
        capturedUrl = url;
        return {
          body: {
            traffic_status: {
              actual: { total_consumed: 0, total_limit: 1000000 },
              target: { total_purchased: 1000000 },
            },
          },
        };
      }),
    });
    await c.getTrafficStatus("global-domain::1220", "PAR::node-1::1220abc");
    // For validator flavor, the prefix is /api/validator/v0/scan-proxy
    expect(capturedUrl).toContain("/api/validator/v0/scan-proxy");
    expect(capturedUrl).not.toContain("/api/scan/v0");
  });
});

// ─── New targeted tests (batch 3) ─────────────────────────────────

describe("ScanClient — Content-Type, URL construction, auth, trailing slash", () => {
  it("body of POST requests has Content-Type: application/json (GET requests use Accept)", async () => {
    // ScanClient only issues GET requests; each GET must include Accept: application/json.
    // This test confirms that the Accept header is set correctly on every GET,
    // which is the scan-client equivalent of "Content-Type on POST" for consumers
    // that drive JSON-aware parsers on the server side.
    let capturedAccept: string | null = null;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(({ init }) => {
        capturedAccept = new Headers(init.headers).get("Accept");
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    await c.getAmuletRules();
    expect(capturedAccept).toBe("application/json");
  });


  it("getAmuletRules for sv flavor: does NOT include Authorization header", async () => {
    // Public SV Scan is unauthenticated. When no token is provided and flavor=sv,
    // the Authorization header must be absent from the request.
    let authHeader: string | null = "PRESENT"; // sentinel — will be overwritten
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      // Deliberately no token
      fetch: makeFetch(({ init }) => {
        authHeader = new Headers(init.headers).get("Authorization");
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar-sv-no-auth",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    await c.getAmuletRules();
    expect(authHeader).toBeNull();
  });

  it("getAmuletRules: the contract payload preserves nested fields", async () => {
    // The AmuletRules contract payload has nested fields (e.g. transferConfig,
    // issuanceCurve). This test confirms the client returns the complete payload
    // object without stripping or flattening nested keys.
    const nestedPayload = {
      dso: "dso::1220nested",
      isDevNet: false,
      configSchedule: {
        initialValue: {
          transferConfig: {
            holdingFee: { rate: "0.0000190259" },
          },
        },
      },
    };
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          amulet_rules: {
            contract: {
              contract_id: "ar-nested",
              template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
              created_event_blob: "blob-nested",
              payload: nestedPayload,
            },
            domain_id: "global-domain::1220",
          },
        },
      })),
    });
    const r = await c.getAmuletRules();
    // Nested payload must be preserved exactly
    expect(r.amulet_rules.contract.payload).toEqual(nestedPayload);
    expect((r.amulet_rules.contract.payload as any).configSchedule?.initialValue?.transferConfig?.holdingFee?.rate).toBe("0.0000190259");
  });

  it("getOpenAndIssuingMiningRounds: each mining round has a payload field", async () => {
    // Confirms that every round in both arrays exposes the contract.payload object
    // (not null/undefined) — the facilitator reads payload.round.number from it.
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          open_mining_rounds: [
            {
              contract: {
                contract_id: "omr-payload-1",
                template_id: "#splice-amulet:Splice.AmuletRules:OpenMiningRound",
                created_event_blob: "blob-p1",
                payload: { round: { number: "55" } },
              },
            },
          ],
          issuing_mining_rounds: [
            {
              contract: {
                contract_id: "imr-payload-1",
                template_id: "#splice-amulet:Splice.AmuletRules:IssuingMiningRound",
                created_event_blob: "blob-p2",
                payload: { round: { number: "54" }, opensAt: "2026-06-10T00:00:00Z" },
              },
            },
          ],
        },
      })),
    });
    const r = await c.getOpenAndIssuingMiningRounds();
    // Every open mining round must have a defined payload
    for (const omr of r.open_mining_rounds) {
      expect(omr.contract.payload).toBeDefined();
      expect(omr.contract.payload).not.toBeNull();
    }
    // Every issuing mining round must have a defined payload
    for (const imr of r.issuing_mining_rounds) {
      expect(imr.contract.payload).toBeDefined();
      expect(imr.contract.payload).not.toBeNull();
    }
    expect((r.open_mining_rounds[0]?.contract.payload as any).round.number).toBe("55");
    expect((r.issuing_mining_rounds[0]?.contract.payload as any).round.number).toBe("54");
  });

  it("ScanClient: Content-Type header in POST body is 'application/json' (Accept header for GET requests)", async () => {
    // ScanClient issues GET requests to the Scan API. For GET requests, the
    // relevant header confirming JSON is the Accept header (not Content-Type).
    // This test verifies the Accept header is set to application/json, which
    // ensures the server responds with JSON (equivalent guarantee for GETs).
    let capturedHeaders: Headers | null = null;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(({ init }) => {
        capturedHeaders = new Headers(init.headers);
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar-ct",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    await c.getAmuletRules();
    expect(capturedHeaders).not.toBeNull();
    // GET requests carry Accept: application/json (Content-Type is for request bodies)
    expect(capturedHeaders!.get("Accept")).toBe("application/json");
  });

  it("ScanClient: when scanUrl has trailing slash, it's used as-is (no double slash)", async () => {
    // The implementation concatenates scanUrl + path directly. If scanUrl ends
    // with '/' and path starts with '/', the caller would get a double slash.
    // This test documents the current behavior: scanUrl is stored verbatim,
    // so callers should NOT include a trailing slash.
    let capturedUrl = "";
    const BASE_WITH_SLASH = "http://trailing.test:3903/";
    const c = new ScanClient({
      scanUrl: BASE_WITH_SLASH,
      fetch: makeFetch(({ url }) => {
        capturedUrl = url;
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar-trailing",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    await c.getAmuletRules();
    // The URL is constructed as `${scanUrl}${path}` — verify the full URL is present
    // and that it starts with the scanUrl as-is (trailing slash preserved).
    expect(capturedUrl).toMatch(/^http:\/\/trailing\.test:3903\//);
  });
});

// ─── New targeted tests (batch 4) — requested additions ──────────────────────

describe("ScanClient — caching, URL encoding, filtering, and timeout", () => {
  // getAmuletRules: with the TTL cache DISABLED (ttl=0), calling twice makes
  // two separate fetch calls and each gets fresh data. (Default-cache hit
  // behavior is covered in the dedicated "TTL cache" describe block below.)
  it("getAmuletRules: with cache disabled, calling twice makes 2 separate fetch calls", async () => {
    let callCount = 0;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      cache: { amuletRulesTtlMs: 0 },
      fetch: makeFetch(() => {
        callCount++;
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: `ar-call-${callCount}`,
                template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
                created_event_blob: "blob",
                payload: { dso: "dso::1220", isDevNet: false },
              },
              domain_id: "global-domain::1220",
            },
          },
        };
      }),
    });

    const r1 = await c.getAmuletRules();
    const r2 = await c.getAmuletRules();

    // Cache disabled → 2 separate fetch calls.
    expect(callCount).toBe(2);
    // Each call should get fresh data (different contract_ids reflect different calls)
    expect(r1.amulet_rules.contract.contract_id).toBe("ar-call-1");
    expect(r2.amulet_rules.contract.contract_id).toBe("ar-call-2");
  });


  // ScanClient: when request body includes filter, it's JSON-serialized correctly
  // (ScanClient sends GET requests; this test verifies the Accept header is set and
  //  the response body is parsed as JSON for the getAmuletRules call)
  it("ScanClient: getAmuletRules response is parsed as JSON (Accept: application/json)", async () => {
    let capturedAccept: string | null = null;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(({ init }) => {
        capturedAccept = new Headers(init.headers).get("Accept");
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar-json-check",
                template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
                created_event_blob: "blob",
                payload: { dso: "dso::1220", isDevNet: true },
              },
              domain_id: "global-domain::1220",
            },
          },
        };
      }),
    });

    const r = await c.getAmuletRules();
    // Accept header must be set to application/json
    expect(capturedAccept).toBe("application/json");
    // Response is correctly parsed as JSON
    expect(r.amulet_rules.contract.payload.isDevNet).toBe(true);
  });

  // getOpenAndIssuingMiningRounds: handles response with null issuingMiningRounds gracefully
  it("getOpenAndIssuingMiningRounds: handles response with empty issuingMiningRounds (not null)", async () => {
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => ({
        body: {
          open_mining_rounds: [
            {
              contract: {
                contract_id: "omr-null-test",
                template_id: "#splice:OpenMiningRound",
                created_event_blob: "blob",
                payload: { round: { number: "77" } },
              },
            },
          ],
          // issuing_mining_rounds is an empty array (no issuing rounds active)
          issuing_mining_rounds: [],
        },
      })),
    });

    // Must not throw when issuing_mining_rounds is empty
    const r = await c.getOpenAndIssuingMiningRounds();
    expect(r.open_mining_rounds).toHaveLength(1);
    expect(r.issuing_mining_rounds).toHaveLength(0);
    expect(r.open_mining_rounds[0]?.contract.contract_id).toBe("omr-null-test");
  });

  // ScanClient: timeout of 1ms → aborts before response (signal-aware mock)
  it("ScanClient: timeout of 1ms → aborts before response (signal-aware mock)", async () => {
    let abortEventFired = false;
    const fetch: typeof globalThis.fetch = vi.fn(
      async (_input, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortEventFired = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
          // Never resolves — simulates infinite hang
        })
    ) as typeof globalThis.fetch;

    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      timeoutMs: 1, // 1ms timeout — will abort almost immediately
      fetch,
    });

    await expect(c.getAmuletRules()).rejects.toThrow();
    // The abort event must have fired on the signal
    expect(abortEventFired).toBe(true);
  });
});

// ─── SV public-scan wire contract (verified live 2026-05-30) ──────────────
//
// The public SV scan (/api/scan/v0) differs from the validator scan-proxy:
//   - amulet-rules + open-and-issuing-mining-rounds are POST (GET → 405)
//   - amulet-rules response wraps the contract in `amulet_rules_update`
//   - mining-rounds requires a {cached_*_contract_ids:[]} request body and
//     returns a keyed MAP {<cid>:{contract}}, not an array
// These tests assert the WIRE shape (method, body, unwrap, map→array), so
// they fail against the old GET/array assumptions and pass against the fix.
describe("ScanClient sv flavor — real public-scan wire contract", () => {
  it("getAmuletRules: issues POST and unwraps amulet_rules_update", async () => {
    let method = "";
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        method = (req.init.method ?? "GET").toUpperCase();
        // SV returns the contract under `amulet_rules_update`, NOT `amulet_rules`.
        return {
          body: {
            amulet_rules_update: {
              contract: {
                contract_id: "ar-sv",
                template_id: "pkg:Splice.AmuletRules:AmuletRules",
                created_event_blob: "blob-sv",
                payload: { dso: "dso::1220", isDevNet: true },
              },
              domain_id: "global-domain::1220sv",
            },
          },
        };
      }),
    });
    const r = await c.getAmuletRules();
    expect(method).toBe("POST");
    // Normalized back to the flavor-agnostic { amulet_rules: {...} } shape.
    expect(r.amulet_rules.contract.contract_id).toBe("ar-sv");
    expect(r.amulet_rules.domain_id).toBe("global-domain::1220sv");
    expect(r.amulet_rules.contract.payload.isDevNet).toBe(true);
  });

  it("getOpenAndIssuingMiningRounds: POSTs cached-id body and normalizes keyed map → array", async () => {
    let method = "";
    let bodySent: unknown = null;
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        method = (req.init.method ?? "GET").toUpperCase();
        bodySent = req.init.body ? JSON.parse(req.init.body as string) : null;
        // SV returns a keyed MAP, not an array.
        return {
          body: {
            time_to_live_in_microseconds: 60000000,
            open_mining_rounds: {
              "00omrcid1": {
                contract: {
                  contract_id: "00omrcid1",
                  template_id: "pkg:Splice.Round:OpenMiningRound",
                  created_event_blob: "blob-omr",
                  payload: { round: { number: "46500" } },
                },
                domain_id: "global-domain::1220sv",
              },
            },
            issuing_mining_rounds: {
              "00imrcid1": {
                contract: {
                  contract_id: "00imrcid1",
                  template_id: "pkg:Splice.Round:IssuingMiningRound",
                  created_event_blob: "blob-imr",
                  payload: { round: { number: "46497" } },
                },
                domain_id: "global-domain::1220sv",
              },
            },
          },
        };
      }),
    });
    const r = await c.getOpenAndIssuingMiningRounds();
    expect(method).toBe("POST");
    // The required cached-id arrays must be present in the request body.
    expect(bodySent).toMatchObject({
      cached_open_mining_round_contract_ids: [],
      cached_issuing_round_contract_ids: [],
    });
    // Keyed map normalized to the array shape settle.ts consumes.
    expect(Array.isArray(r.open_mining_rounds)).toBe(true);
    expect(r.open_mining_rounds).toHaveLength(1);
    expect(r.open_mining_rounds[0]?.contract.contract_id).toBe("00omrcid1");
    expect(r.open_mining_rounds[0]?.contract.payload.round.number).toBe("46500");
    expect(Array.isArray(r.issuing_mining_rounds)).toBe(true);
    expect(r.issuing_mining_rounds[0]?.contract.contract_id).toBe("00imrcid1");
  });

  it("getOpenAndIssuingMiningRounds: empty SV maps normalize to empty arrays", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({
        body: {
          time_to_live_in_microseconds: 1,
          open_mining_rounds: {},
          issuing_mining_rounds: {},
        },
      })),
    });
    const r = await c.getOpenAndIssuingMiningRounds();
    expect(r.open_mining_rounds).toEqual([]);
    expect(r.issuing_mining_rounds).toEqual([]);
  });

  it("validator flavor stays GET (no body) — unchanged contract", async () => {
    let method = "";
    let hadBody = false;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      flavor: "validator",
      fetch: makeFetch((req) => {
        method = (req.init.method ?? "GET").toUpperCase();
        hadBody = req.init.body != null;
        return {
          body: {
            amulet_rules: {
              contract: {
                contract_id: "ar-val",
                template_id: "t",
                created_event_blob: "b",
                payload: { dso: "d", isDevNet: false },
              },
              domain_id: "g",
            },
          },
        };
      }),
    });
    const r = await c.getAmuletRules();
    expect(method).toBe("GET");
    expect(hadBody).toBe(false);
    expect(r.amulet_rules.contract.contract_id).toBe("ar-val");
  });
});

// ---------------------------------------------------------------------------
// getUpdateById — Scan v2/updates read (CIP-56 completed-verify via Scan)
// ---------------------------------------------------------------------------
const SCAN_COMPLETED_UPDATE = {
  update_id: "1220deadbeef",
  record_time: "2026-05-31T12:00:00Z",
  synchronizer_id: "global-domain::1220",
  root_event_ids: ["ev-0"],
  events_by_id: {
    "ev-0": {
      event_type: "exercised_event",
      event_id: "ev-0",
      contract_id: "00factory",
      template_id:
        "hash:Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules",
      package_name: "splice-amulet",
      choice: "TransferFactory_Transfer",
      choice_argument: {
        expectedAdmin: "DSO::1220",
        transfer: {
          sender: "sender::1220",
          receiver: "receiver::1220",
          amount: "10.0000000000",
          instrumentId: { admin: "DSO::1220", id: "Amulet" },
          requestedAt: "2026-05-31T11:59:00Z",
          executeBefore: "2026-05-31T12:05:00Z",
          inputHoldingCids: [],
          meta: { values: { "x402.resourceUrl": "https://api.example.com/paid" } },
        },
        extraArgs: {},
      },
      exercise_result: {
        output: {
          tag: "TransferInstructionResult_Completed",
          value: { receiverHoldingCids: ["00h"] },
        },
        senderChangeCids: ["00chg"],
        meta: { values: { "splice.lfdecentralizedtrust.org/sender": "sender::1220" } },
      },
      child_event_ids: [],
      acting_parties: ["sender::1220"],
      consuming: false,
    },
    // A created Holding — must be ignored by callers reading the choice arg.
    "ev-1": {
      event_type: "created_event",
      contract_id: "00h",
      template_id: "hash:Splice.Amulet:Amulet",
    },
  },
};

describe("ScanClient.getUpdateById", () => {
  it("sv: GETs /api/scan/v2/updates/{id}?daml_value_encoding=compact_json (NOT under v0)", async () => {
    let url = "";
    let method = "";
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        url = req.url;
        method = (req.init.method as string) ?? "GET";
        return { body: SCAN_COMPLETED_UPDATE };
      }),
    });
    await c.getUpdateById("1220deadbeef");
    expect(method).toBe("GET");
    expect(url).toBe(
      `${SV_BASE}/api/scan/v2/updates/1220deadbeef?daml_value_encoding=compact_json`
    );
    expect(url).not.toContain("/api/scan/v0");
  });

  it("sv: URL-encodes an updateId containing ::", async () => {
    let url = "";
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        url = req.url;
        return { body: SCAN_COMPLETED_UPDATE };
      }),
    });
    await c.getUpdateById("1220abc::xyz");
    expect(url).toContain("%3A%3A");
  });

  it("sv: parses events_by_id and exposes the completed exercised event", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({ body: SCAN_COMPLETED_UPDATE })),
    });
    const u = await c.getUpdateById("1220deadbeef");
    const ev = u.events_by_id["ev-0"];
    expect(ev?.choice).toBe("TransferFactory_Transfer");
    expect(ev?.exercise_result?.output?.tag).toBe(
      "TransferInstructionResult_Completed"
    );
    expect(ev?.choice_argument?.transfer?.amount).toBe("10.0000000000");
    expect(ev?.choice_argument?.transfer?.sender).toBe("sender::1220");
    expect(ev?.choice_argument?.transfer?.instrumentId.id).toBe("Amulet");
  });

  it("validator flavor: throws UNSUPPORTED without calling fetch", async () => {
    const fetchSpy = vi.fn();
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      flavor: "validator",
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await expect(c.getUpdateById("x")).rejects.toMatchObject({
      name: "CantonError",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sv: a 404 surfaces as a CantonError with status 404", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({ status: 404, body: { error: "not found" } })),
    });
    await expect(c.getUpdateById("missing")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("ScanClient.resolveTransferKind", () => {
  const probe = {
    sender: "agent::1220a",
    receiver: "merchant::1220m",
    amount: "1.0000000000",
    admin: "dso::1220",
    id: "Amulet",
    requestedAt: "2026-06-02T00:00:00Z",
    executeBefore: "2026-06-02T01:00:00Z",
  };

  it("sv: POSTs to the registry transfer-factory and returns transferKind", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        captured = req;
        return { body: { factoryId: "00factory", transferKind: "direct" } };
      }),
    });
    const kind = await c.resolveTransferKind(probe);
    expect(kind).toBe("direct");
    expect(captured?.url).toBe(
      `${SV_BASE}/registry/transfer-instruction/v1/transfer-factory`
    );
    expect(captured?.init.method).toBe("POST");
    const body = JSON.parse(captured?.init.body as string);
    expect(body.choiceArguments.transfer.receiver).toBe("merchant::1220m");
    expect(body.choiceArguments.expectedAdmin).toBe("dso::1220");
    expect(body.choiceArguments.transfer.inputHoldingCids).toEqual([]);
  });

  it("sv: returns 'offer' when the merchant has no preapproval", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({ body: { transferKind: "offer" } })),
    });
    expect(await c.resolveTransferKind(probe)).toBe("offer");
  });

  it("validator flavor throws UNSUPPORTED without calling fetch", async () => {
    const fetchSpy = vi.fn();
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await expect(c.resolveTransferKind(probe)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getEventTrafficSummary + getEventTrafficSummaryWithFallback (per-payment
// traffic-burn attribution, M2/M3/M4). Reads GET /api/scan/v0/events/{updateId}
// which exposes traffic_summary.total_traffic_cost + the verdict. SV flavor
// only (the validator scan-proxy does not surface the verdict envelope).
// ---------------------------------------------------------------------------
describe("ScanClient.getEventTrafficSummary", () => {
  const UPDATE_ID = "1220-update-abc";

  function acceptedBody(opts: {
    cost?: number | null;
    verdict?: unknown;
  } = {}) {
    const traffic_summary =
      opts.cost === null
        ? null
        : {
            total_traffic_cost: opts.cost ?? 4321,
            envelope_traffic_summaries: [
              { traffic_cost: opts.cost ?? 4321, view_ids: [0] },
            ],
          };
    const verdict =
      opts.verdict !== undefined
        ? opts.verdict
        : {
            update_id: UPDATE_ID,
            submitting_participant_uid: "PAR::ftp::1220",
            submitting_parties: ["ftp_facilitator::1220"],
            verdict_result: "VERDICT_RESULT_ACCEPTED",
            record_time: "2026-06-01T00:00:00Z",
          };
    return { traffic_summary, verdict };
  }

  it("is sv-flavor only — validator flavor throws UNSUPPORTED without a fetch", async () => {
    const fetchSpy = vi.fn();
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      flavor: "validator",
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    await expect(c.getEventTrafficSummary(UPDATE_ID)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("targets /api/scan/v0/events/{updateId} (url-encoded) and maps fields", async () => {
    let url = "";
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch((req) => {
        url = req.url;
        return { body: acceptedBody({ cost: 5000 }) };
      }),
    });
    const r = await c.getEventTrafficSummary(UPDATE_ID);
    expect(url).toBe(
      `${SV_BASE}/api/scan/v0/events/${encodeURIComponent(UPDATE_ID)}`
    );
    expect(r).toEqual({
      updateId: UPDATE_ID,
      recordTime: "2026-06-01T00:00:00Z",
      verdictResult: "VERDICT_RESULT_ACCEPTED",
      submittingParticipantUid: "PAR::ftp::1220",
      submittingParties: ["ftp_facilitator::1220"],
      totalTrafficCost: 5000,
    });
  });

  it("returns null when the verdict is null (event not yet sequenced)", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({ body: acceptedBody({ verdict: null }) })),
    });
    expect(await c.getEventTrafficSummary(UPDATE_ID)).toBeNull();
  });

  it("maps totalTrafficCost to null when traffic_summary is null", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({ body: acceptedBody({ cost: null }) })),
    });
    const r = await c.getEventTrafficSummary(UPDATE_ID);
    expect(r?.totalTrafficCost).toBeNull();
    expect(r?.verdictResult).toBe("VERDICT_RESULT_ACCEPTED");
  });

  it("tolerates a missing submitting_parties (defaults to [])", async () => {
    const c = new ScanClient({
      scanUrl: SV_BASE,
      flavor: "sv",
      fetch: makeFetch(() => ({
        body: {
          traffic_summary: { total_traffic_cost: 1, envelope_traffic_summaries: [] },
          verdict: {
            update_id: UPDATE_ID,
            submitting_participant_uid: "PAR::ftp::1220",
            verdict_result: "VERDICT_RESULT_ACCEPTED",
          },
        },
      })),
    });
    const r = await c.getEventTrafficSummary(UPDATE_ID);
    expect(r?.submittingParties).toEqual([]);
    expect(r?.recordTime).toBeNull();
  });
});

describe("getEventTrafficSummaryWithFallback", () => {
  const UPDATE_ID = "1220-update-fallback";

  function summary(cost: number): TrafficSummaryResult {
    return {
      updateId: UPDATE_ID,
      recordTime: null,
      verdictResult: "VERDICT_RESULT_ACCEPTED",
      submittingParticipantUid: "PAR::ftp::1220",
      submittingParties: [],
      totalTrafficCost: cost,
    };
  }

  it("returns the first non-null result and does not consult later clients", async () => {
    const c1 = { getEventTrafficSummary: vi.fn().mockResolvedValue(summary(11)) };
    const c2 = { getEventTrafficSummary: vi.fn().mockResolvedValue(summary(22)) };
    const r = await getEventTrafficSummaryWithFallback([c1, c2], UPDATE_ID);
    expect(r).toEqual(summary(11));
    expect(c1.getEventTrafficSummary).toHaveBeenCalledWith(UPDATE_ID);
    expect(c2.getEventTrafficSummary).not.toHaveBeenCalled();
  });

  it("falls through to the next client when one THROWS (UNSUPPORTED / timeout / HTTP)", async () => {
    const c1 = {
      getEventTrafficSummary: vi
        .fn()
        .mockRejectedValue(new CantonError("down", "UNSUPPORTED")),
    };
    const c2 = { getEventTrafficSummary: vi.fn().mockResolvedValue(summary(33)) };
    const r = await getEventTrafficSummaryWithFallback([c1, c2], UPDATE_ID);
    expect(r).toEqual(summary(33));
    expect(c1.getEventTrafficSummary).toHaveBeenCalledOnce();
    expect(c2.getEventTrafficSummary).toHaveBeenCalledOnce();
  });

  it("falls through to the next client when one returns NULL (no verdict yet)", async () => {
    const c1 = { getEventTrafficSummary: vi.fn().mockResolvedValue(null) };
    const c2 = { getEventTrafficSummary: vi.fn().mockResolvedValue(summary(44)) };
    const r = await getEventTrafficSummaryWithFallback([c1, c2], UPDATE_ID);
    expect(r).toEqual(summary(44));
    expect(c2.getEventTrafficSummary).toHaveBeenCalledOnce();
  });

  it("returns null when every client throws or returns null (a clean null was seen → 'no data yet')", async () => {
    const c1 = { getEventTrafficSummary: vi.fn().mockRejectedValue(new Error("x")) };
    const c2 = { getEventTrafficSummary: vi.fn().mockResolvedValue(null) };
    expect(await getEventTrafficSummaryWithFallback([c1, c2], UPDATE_ID)).toBeNull();
  });

  it("THROWS when EVERY client fails (could-not-ask must not look like no-data)", async () => {
    // The attribution-undercount regression: a 429 wave was swallowed into
    // `null`, the retry worker spent its bounded attempts on the outage, and
    // rows froze 'failed' while the data existed. All-clients-errored must
    // surface as an error so the worker can skip the attempt charge.
    const c1 = {
      getEventTrafficSummary: vi
        .fn()
        .mockRejectedValue(new CantonError("rl", "HTTP_ERROR", 429)),
    };
    const c2 = {
      getEventTrafficSummary: vi
        .fn()
        .mockRejectedValue(new CantonError("down", "TIMEOUT")),
    };
    await expect(
      getEventTrafficSummaryWithFallback([c1, c2], UPDATE_ID)
    ).rejects.toMatchObject({ code: "TIMEOUT" }); // last error is propagated
  });

  it("returns null for an empty client list", async () => {
    expect(await getEventTrafficSummaryWithFallback([], UPDATE_ID)).toBeNull();
  });
});

describe("ScanClient request — HTTP 429 bounded retry", () => {
  const UPDATE_ID = "1220-rl-update";
  const okBody = {
    update_id: UPDATE_ID,
    verdict: {
      verdict_result: "VERDICT_RESULT_ACCEPTED",
      submitting_participant_uid: "PAR::x::1220",
      submitting_parties: [],
      update_id: UPDATE_ID,
      record_time: "2026-06-11T00:00:00Z",
    },
    traffic_summary: { total_traffic_cost: 6710 },
  };

  it("retries 429 with backoff and succeeds (sv burst budget self-heals)", async () => {
    let calls = 0;
    const c = new ScanClient({
      scanUrl: "http://scan.test",
      flavor: "sv",
      fetch: vi.fn(async () => {
        calls += 1;
        if (calls <= 2) return new Response("local_rate_limited", { status: 429 });
        return new Response(JSON.stringify(okBody), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const r = await c.getEventTrafficSummary(UPDATE_ID);
    expect(r?.totalTrafficCost).toBe(6710);
    expect(calls).toBe(3); // 429, 429, 200
  });

  it("gives up after the retry budget and surfaces the 429", async () => {
    const c = new ScanClient({
      scanUrl: "http://scan.test",
      flavor: "sv",
      fetch: vi.fn(
        async () => new Response("local_rate_limited", { status: 429 })
      ) as typeof globalThis.fetch,
    });
    await expect(c.getEventTrafficSummary(UPDATE_ID)).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 429,
    });
  }, 15000);

  it("does NOT retry non-429 HTTP errors (single attempt)", async () => {
    let calls = 0;
    const c = new ScanClient({
      scanUrl: "http://scan.test",
      flavor: "sv",
      fetch: vi.fn(async () => {
        calls += 1;
        return new Response("nope", { status: 500 });
      }) as typeof globalThis.fetch,
    });
    await expect(c.getEventTrafficSummary(UPDATE_ID)).rejects.toMatchObject({
      status: 500,
    });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TtlSingleFlightCache (the cache primitive behind the v1 /settle DSO reads)
// ---------------------------------------------------------------------------
describe("TtlSingleFlightCache", () => {
  it("serves a fresh hit from cache without re-invoking the loader", async () => {
    let now = 1000;
    const cache = new TtlSingleFlightCache<number>(100, () => now);
    const loader = vi.fn(async () => 42);
    expect(await cache.get(loader)).toBe(42);
    now = 1050; // still within ttl (1000 + 100)
    expect(await cache.get(loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    let now = 1000;
    const cache = new TtlSingleFlightCache<number>(100, () => now);
    let n = 0;
    const loader = vi.fn(async () => ++n);
    expect(await cache.get(loader)).toBe(1);
    now = 1101; // past expiry (1000 + 100)
    expect(await cache.get(loader)).toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent misses into ONE loader call (single-flight)", async () => {
    const now = 1000; // clock is held constant; single-flight, not expiry, is under test
    const cache = new TtlSingleFlightCache<number>(1000, () => now);
    let resolve!: (v: number) => void;
    const loader = vi.fn(
      () => new Promise<number>((r) => { resolve = r; })
    );
    const p1 = cache.get(loader);
    const p2 = cache.get(loader);
    const p3 = cache.get(loader);
    expect(loader).toHaveBeenCalledTimes(1); // not yet resolved → shared
    resolve(7);
    expect(await Promise.all([p1, p2, p3])).toEqual([7, 7, 7]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a rejected load; the next caller retries", async () => {
    const cache = new TtlSingleFlightCache<number>(1000);
    const loader = vi
      .fn<[], Promise<number>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(99);
    await expect(cache.get(loader)).rejects.toThrow("boom");
    // failure cleared the in-flight slot; next get retries and succeeds
    expect(await cache.get(loader)).toBe(99);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("ttlMs<=0 disables caching (loader every call) but still single-flights", async () => {
    const cache = new TtlSingleFlightCache<number>(0);
    let n = 0;
    const loader = vi.fn(async () => ++n);
    expect(await cache.get(loader)).toBe(1);
    expect(await cache.get(loader)).toBe(2); // no caching → fresh each time
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the next get to refetch", async () => {
    const now = 1000; // held constant: invalidate(), not TTL expiry, forces the refetch
    const cache = new TtlSingleFlightCache<number>(10_000, () => now);
    let n = 0;
    const loader = vi.fn(async () => ++n);
    expect(await cache.get(loader)).toBe(1);
    cache.invalidate();
    expect(await cache.get(loader)).toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// ScanClient TTL cache integration (getAmuletRules / getOpenAndIssuingMiningRounds)
// ---------------------------------------------------------------------------
describe("ScanClient — getAmuletRules / mining-rounds TTL cache", () => {
  function amuletBody(cid: string) {
    return {
      amulet_rules: {
        contract: {
          contract_id: cid,
          template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
          created_event_blob: "blob",
          payload: { dso: "dso::1220", isDevNet: false },
        },
        domain_id: "global-domain::1220",
      },
    };
  }
  function roundsBody(cid: string) {
    return {
      open_mining_rounds: [
        {
          contract: {
            contract_id: cid,
            template_id: "#splice-amulet:Splice.AmuletRules:OpenMiningRound",
            created_event_blob: "blob",
            payload: { round: { number: "42" } },
          },
        },
      ],
      issuing_mining_rounds: [],
    };
  }

  it("getAmuletRules: second call within TTL is served from cache (1 fetch)", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(amuletBody(`ar-${++calls}`)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof globalThis.fetch;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: fetchFn,
      cache: { amuletRulesTtlMs: 60_000 },
    });
    const r1 = await c.getAmuletRules();
    const r2 = await c.getAmuletRules();
    expect(r1.amulet_rules.contract.contract_id).toBe("ar-1");
    expect(r2.amulet_rules.contract.contract_id).toBe("ar-1"); // cached
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("getOpenAndIssuingMiningRounds: second call within TTL is cached (1 fetch)", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify(roundsBody(`omr-${++calls}`)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof globalThis.fetch;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: fetchFn,
      cache: { miningRoundsTtlMs: 30_000 },
    });
    const r1 = await c.getOpenAndIssuingMiningRounds();
    const r2 = await c.getOpenAndIssuingMiningRounds();
    expect(r1.open_mining_rounds[0]?.contract.contract_id).toBe("omr-1");
    expect(r2.open_mining_rounds[0]?.contract.contract_id).toBe("omr-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("concurrent getAmuletRules calls coalesce into ONE fetch (single-flight)", async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchFn = vi.fn(
      () => new Promise<Response>((res) => { resolveFetch = res; })
    ) as unknown as typeof globalThis.fetch;
    const c = new ScanClient({ scanUrl: VALIDATOR_BASE, fetch: fetchFn });
    const p1 = c.getAmuletRules();
    const p2 = c.getAmuletRules();
    expect(fetchFn).toHaveBeenCalledTimes(1); // both awaiting same in-flight
    resolveFetch(
      new Response(JSON.stringify(amuletBody("ar-shared")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.amulet_rules.contract.contract_id).toBe("ar-shared");
    expect(b.amulet_rules.contract.contract_id).toBe("ar-shared");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a failed getAmuletRules is not cached; the next call refetches", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n++;
      if (n === 1) {
        // 500 = a NON-transient error (not retried), so the first call genuinely
        // fails — proving the failure is not cached. (A 503 would now be retried
        // transparently into the success below, which is the resilience fix.)
        return new Response("err", { status: 500 });
      }
      return new Response(JSON.stringify(amuletBody("ar-ok")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: fetchFn,
      cache: { amuletRulesTtlMs: 60_000 },
    });
    await expect(c.getAmuletRules()).rejects.toThrow(/500/);
    const ok = await c.getAmuletRules();
    expect(ok.amulet_rules.contract.contract_id).toBe("ar-ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("the amulet-rules and mining-rounds caches are independent", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.includes("mining-rounds")
        ? roundsBody("omr-x")
        : amuletBody("ar-x");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const c = new ScanClient({ scanUrl: VALIDATOR_BASE, fetch: fetchFn });
    await c.getAmuletRules();
    await c.getOpenAndIssuingMiningRounds();
    await c.getAmuletRules(); // cached
    await c.getOpenAndIssuingMiningRounds(); // cached
    // one fetch per distinct endpoint, not four
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Cache-BYPASSING getters used by the v1 /settle LOCAL_VERDICT_INACTIVE_CONTRACTS
// retry. The retry must never be served a stale cached round/amulet cid — that
// was the adversarial-review MEDIUM finding. These prove the *Fresh getters
// (a) refetch even within the TTL window, and (b) repopulate the cache.
// ---------------------------------------------------------------------------
describe("ScanClient — cache-bypassing *Fresh getters (stale-retry safety)", () => {
  function amuletBodyF(cid: string) {
    return {
      amulet_rules: {
        contract: {
          contract_id: cid,
          template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
          created_event_blob: "blob",
          payload: { dso: "dso::1220", isDevNet: false },
        },
        domain_id: "global-domain::1220",
      },
    };
  }
  function roundsBodyF(cid: string) {
    return {
      open_mining_rounds: [
        {
          contract: {
            contract_id: cid,
            template_id: "#splice-amulet:Splice.Round:OpenMiningRound",
            created_event_blob: "blob",
            payload: { round: { number: "42" } },
          },
        },
      ],
      issuing_mining_rounds: [],
    };
  }

  it("getOpenAndIssuingMiningRoundsFresh refetches inside the TTL and repopulates the cache", async () => {
    let calls = 0;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      // Long TTL so a plain get() would be a cache HIT; the *Fresh call must
      // bypass it anyway.
      cache: { miningRoundsTtlMs: 60_000 },
      fetch: makeFetch(() => ({ body: roundsBodyF(`omr-${++calls}`) })),
    });

    const r1 = await c.getOpenAndIssuingMiningRounds(); // cold fill (fetch #1)
    expect(r1.open_mining_rounds[0]?.contract.contract_id).toBe("omr-1");
    const cached = await c.getOpenAndIssuingMiningRounds(); // HIT, no fetch
    expect(cached.open_mining_rounds[0]?.contract.contract_id).toBe("omr-1");
    expect(calls).toBe(1);

    // Fresh must bypass the still-valid cache → fetch #2, new cid.
    const fresh = await c.getOpenAndIssuingMiningRoundsFresh();
    expect(fresh.open_mining_rounds[0]?.contract.contract_id).toBe("omr-2");
    expect(calls).toBe(2);

    // ...and it must have REPOPULATED the cache, so the next plain get() serves
    // the fresh value without another fetch (coalesces the rest of the round's
    // settles onto the refreshed entry).
    const afterFresh = await c.getOpenAndIssuingMiningRounds();
    expect(afterFresh.open_mining_rounds[0]?.contract.contract_id).toBe("omr-2");
    expect(calls).toBe(2);
  });

  it("getAmuletRulesFresh refetches inside the TTL and repopulates the cache", async () => {
    let calls = 0;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      cache: { amuletRulesTtlMs: 60_000 },
      fetch: makeFetch(() => ({ body: amuletBodyF(`ar-${++calls}`) })),
    });

    const r1 = await c.getAmuletRules();
    expect(r1.amulet_rules.contract.contract_id).toBe("ar-1");
    await c.getAmuletRules(); // cached hit
    expect(calls).toBe(1);

    const fresh = await c.getAmuletRulesFresh();
    expect(fresh.amulet_rules.contract.contract_id).toBe("ar-2");
    expect(calls).toBe(2);

    const afterFresh = await c.getAmuletRules();
    expect(afterFresh.amulet_rules.contract.contract_id).toBe("ar-2");
    expect(calls).toBe(2);
  });
});

// ─── getCurrentOpenRoundNumber ────────────────────────────────────────────────

function makeRoundsResponse(rounds: Array<{ number: string; opensAt?: string }>) {
  return {
    open_mining_rounds: rounds.map((r) => ({
      contract: {
        contract_id: `omr-${r.number}`,
        template_id: "#splice-amulet:Splice.AmuletRules:OpenMiningRound",
        created_event_blob: "blob",
        payload: { round: { number: r.number }, ...(r.opensAt ? { opensAt: r.opensAt } : {}) },
      },
    })),
    issuing_mining_rounds: [],
  };
}

describe("ScanClient.getCurrentOpenRoundNumber", () => {
  const NOW = new Date("2026-06-07T12:00:00Z").getTime();

  function makeClient(rounds: Array<{ number: string; opensAt?: string }>) {
    return new ScanClient({
      scanUrl: "http://scan.test",
      fetch: makeFetch(() => ({ body: makeRoundsResponse(rounds) })),
    });
  }

  it("returns the highest usable round number (opensAt past)", async () => {
    const c = makeClient([
      { number: "10", opensAt: "2026-06-07T10:00:00Z" },
      { number: "11", opensAt: "2026-06-07T11:00:00Z" },
      { number: "12", opensAt: "2026-06-07T13:00:00Z" }, // future — not usable
    ]);
    vi.setSystemTime(NOW);
    const n = await c.getCurrentOpenRoundNumber();
    expect(n).toBe(11);
    vi.useRealTimers();
  });

  it("falls back to highest round when all are future-dated", async () => {
    const c = makeClient([
      { number: "20", opensAt: "2026-06-08T00:00:00Z" },
      { number: "21", opensAt: "2026-06-08T01:00:00Z" },
    ]);
    vi.setSystemTime(NOW);
    const n = await c.getCurrentOpenRoundNumber();
    expect(n).toBe(21);
    vi.useRealTimers();
  });

  it("returns the single round when opensAt is absent", async () => {
    const c = makeClient([{ number: "5" }]);
    const n = await c.getCurrentOpenRoundNumber();
    expect(n).toBe(5);
  });

  it("throws CantonError when no open rounds", async () => {
    const c = new ScanClient({
      scanUrl: "http://scan.test",
      fetch: makeFetch(() => ({
        body: { open_mining_rounds: [], issuing_mining_rounds: [] },
      })),
    });
    await expect(c.getCurrentOpenRoundNumber()).rejects.toBeInstanceOf(CantonError);
  });
});

// ─── getFeaturedAppRight ──────────────────────────────────────────────────────

describe("ScanClient.getFeaturedAppRight", () => {
  it("returns contract_id when FeaturedAppRight exists", async () => {
    let capturedUrl = "";
    const c = new ScanClient({
      scanUrl: "http://scan.test",
      fetch: makeFetch(({ url }) => {
        capturedUrl = url;
        return { body: { featured_app_right: { contract_id: "far-cid-1" } } };
      }),
    });
    const cid = await c.getFeaturedAppRight("my-party::123");
    expect(cid).toBe("far-cid-1");
    expect(capturedUrl).toContain("/featured-apps/");
    expect(capturedUrl).toContain(encodeURIComponent("my-party::123"));
  });

  it("throws CantonError when featured_app_right is null", async () => {
    const c = new ScanClient({
      scanUrl: "http://scan.test",
      fetch: makeFetch(() => ({ body: { featured_app_right: null } })),
    });
    await expect(c.getFeaturedAppRight("no-party::1")).rejects.toBeInstanceOf(CantonError);
  });

  it("throws CantonError on HTTP error", async () => {
    const c = new ScanClient({
      scanUrl: "http://scan.test",
      fetch: makeFetch(() => ({ status: 404, body: "not found" })),
    });
    await expect(c.getFeaturedAppRight("p::1")).rejects.toBeInstanceOf(CantonError);
  });
});

describe("ScanClient — transient-5xx retry + multi-SV fallback", () => {
  it("isTransientScanError: 429/502/503/504 + TIMEOUT/TRANSPORT_ERROR are transient; 500/404/400 and non-CantonError are not", () => {
    const http = (s: number) => new CantonError(`x`, "HTTP_ERROR", s, "");
    expect(isTransientScanError(http(429))).toBe(true);
    expect(isTransientScanError(http(502))).toBe(true);
    expect(isTransientScanError(http(503))).toBe(true);
    expect(isTransientScanError(http(504))).toBe(true);
    expect(isTransientScanError(new CantonError("t", "TIMEOUT"))).toBe(true);
    expect(isTransientScanError(new CantonError("t", "TRANSPORT_ERROR"))).toBe(true);
    expect(isTransientScanError(http(500))).toBe(false); // genuine app error, not shed
    expect(isTransientScanError(http(404))).toBe(false); // real "not found"
    expect(isTransientScanError(http(400))).toBe(false);
    expect(isTransientScanError(new Error("plain"))).toBe(false);
  });

  it("retries a transient 503 on the same base, then succeeds", async () => {
    let n = 0;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fetch: makeFetch(() => {
        n++;
        return n === 1
          ? { status: 503, body: { error: "local_rate_limited" } }
          : { body: { amulet_rules: { contract: { contract_id: "ar", template_id: "#t:M:AmuletRules", created_event_blob: "b", payload: {} }, domain_id: "d::1" } } };
      }),
    });
    const r = await c.getAmuletRules();
    expect(r.amulet_rules.contract.contract_id).toBe("ar");
    expect(n).toBe(2); // 503 → backoff → retry → 200
  });

  it("fails over to a fallback SV base when the primary keeps returning 503", async () => {
    let primary = 0;
    let fallback = 0;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fallbackUrls: ["https://scan.alt.test:3903"],
      fetch: makeFetch(({ url }) => {
        if (url.startsWith("https://scan.alt.test:3903")) {
          fallback++;
          return { body: { amulet_rules: { contract: { contract_id: "ar-alt", template_id: "#t:M:AmuletRules", created_event_blob: "b", payload: {} }, domain_id: "d::1" } } };
        }
        primary++;
        return { status: 503, body: { error: "local_rate_limited" } };
      }),
    });
    const r = await c.getAmuletRules();
    expect(r.amulet_rules.contract.contract_id).toBe("ar-alt");
    expect(primary).toBe(4); // 1 + 3 retries exhausted on primary
    expect(fallback).toBe(1); // then the alternate SV answers
  }, 15000);

  it("does NOT retry or fail over on a non-transient 404 (a real answer)", async () => {
    let n = 0;
    const c = new ScanClient({
      scanUrl: VALIDATOR_BASE,
      fallbackUrls: ["https://scan.alt.test:3903"],
      fetch: makeFetch(() => {
        n++;
        return { status: 404, body: "not found" };
      }),
    });
    await expect(c.getAmuletRules()).rejects.toThrow(/404/);
    expect(n).toBe(1); // immediate throw, no retry, no fallback
  });
});
