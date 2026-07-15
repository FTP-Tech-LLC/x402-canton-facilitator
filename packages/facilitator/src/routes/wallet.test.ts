import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { registerWalletRoutes, type WalletRelayServices } from "./wallet.js";
import { UnfundedFeePartyError } from "../canton/preapproval.js";
import {
  createInMemoryFaucetStore,
  type FaucetClaimStore,
} from "../db/faucet-store.js";

function mockClient(over: Record<string, unknown> = {}) {
  return {
    generateExternalPartyTopology: vi.fn().mockResolvedValue({
      partyId: "agent::12201",
      publicKeyFingerprint: "fp1",
      topologyTransactions: ["tx1"],
      multiHash: "mh1",
    }),
    allocateExternalParty: vi.fn().mockResolvedValue({ partyId: "agent::12201" }),
    interactiveSubmissionPrepare: vi
      .fn()
      .mockResolvedValue({ preparedTransaction: "pt", preparedTransactionHash: "h1" }),
    interactiveSubmissionExecute: vi.fn().mockResolvedValue({ updateId: "u1" }),
    grantUserRights: vi.fn().mockResolvedValue(undefined),
    getLedgerEnd: vi.fn().mockResolvedValue({ offset: 100 }),
    pollCompletionUpdateId: vi.fn().mockResolvedValue("u-polled"),
    queryActiveContracts: vi.fn().mockResolvedValue([
      { contractId: "c1", templateId: "#splice-amulet:Splice.Amulet:Amulet", createArgument: { amount: { initialAmount: "5.0000000000" } }, signatories: [], observers: [], packageName: "p" },
      { contractId: "c2", templateId: "#splice-amulet:Splice.Amulet:Amulet", createArgument: { amount: { initialAmount: "2.5000000000" } }, signatories: [], observers: [], packageName: "p" },
      { contractId: "c3", templateId: "#x:Other:Thing", createArgument: {}, signatories: [], observers: [], packageName: "p" },
    ]),
    ...over,
  };
}
function svc(o: Partial<WalletRelayServices> = {}): WalletRelayServices {
  return {
    client: mockClient() as never,
    facilitatorParty: "facilitator::1220fac",
    synchronizerId: "global-domain::12201",
    userId: "facilitator@clients",
    scanUrl: "http://scan.test",
    enableAgentWallet: true,
    agentWalletApiKey: undefined,
    ...o,
  } as WalletRelayServices;
}
async function build(s: WalletRelayServices) {
  const a = Fastify();
  await registerWalletRoutes(a, s);
  return a;
}
const pk = { publicKey: { format: "f", keyData: "k", keySpec: "s" }, partyHint: "agent" };

describe("wallet relay routes", () => {
  it("preapproval/self/prepare with an unfunded merchant → 409 merchant_unfunded, not 502", async () => {
    const a = await build(
      svc({
        selfPreapproval: {
          prepareSelfPreapproval: vi
            .fn()
            .mockRejectedValue(new UnfundedFeePartyError("merchant::1220aabbcc")),
        } as never,
      })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/preapproval/self/prepare",
      payload: { party: "merchant::1220aabbcc" },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json() as { error: string; party: string; detail: string };
    expect(body.error).toBe("merchant_unfunded");
    expect(body.party).toBe("merchant::1220aabbcc");
    expect(body.detail).toContain("merchant::1220aabbcc");
    await a.close();
  });

  it("flag OFF → routes are not registered (404)", async () => {
    const a = await build(svc({ enableAgentWallet: false }));
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: pk });
    expect(r.statusCode).toBe(404);
    await a.close();
  });

  it("onboard/prepare maps client topology → response + injects synchronizer", async () => {
    const s = svc();
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: pk });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ party: "agent::12201", publicKeyFingerprint: "fp1", onboardingTransactions: ["tx1"], hashToSign: "mh1" });
    expect(s.client.generateExternalPartyTopology).toHaveBeenCalledWith(
      expect.objectContaining({ synchronizer: "global-domain::12201", partyHint: "agent" })
    );
    await a.close();
  });

  it("onboard/prepare missing fields → 400", async () => {
    const a = await build(svc());
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: { partyHint: "agent" } });
    expect(r.statusCode).toBe(400);
    await a.close();
  });

  it("onboard/finalize → {party} + grants the relay user CanActAs", async () => {
    const s = svc();
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: { onboardingTransactions: ["tx1"], multiHashSignatures: [{ format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ party: "agent::12201" });
    expect(s.client.grantUserRights).toHaveBeenCalledWith("facilitator@clients", "agent::12201");
    await a.close();
  });

  it("onboard/finalize: grantUserRights failure is non-fatal (party still returned)", async () => {
    const s = svc({ client: mockClient({ grantUserRights: vi.fn().mockRejectedValue(new Error("rights 400")) }) as never });
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: { onboardingTransactions: ["tx1"], multiHashSignatures: [{ format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ party: "agent::12201" });
    await a.close();
  });

  it("submit/prepare → {preparedTransaction, hash}", async () => {
    const a = await build(svc());
    const r = await a.inject({ method: "POST", url: "/v1/wallet/submit/prepare", payload: { userId: "u", commandId: "c", actAs: ["agent::12201"], synchronizerId: "", commands: [{}] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ preparedTransaction: "pt", hash: "h1" });
    await a.close();
  });

  it("submit/execute → {updateId}", async () => {
    const a = await build(svc());
    const r = await a.inject({ method: "POST", url: "/v1/wallet/submit/execute", payload: { preparedTransaction: "pt", partySignatures: {} } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ updateId: "u1" });
    await a.close();
  });

  it("balance sums only Amulet holdings", async () => {
    const a = await build(svc());
    const r = await a.inject({ method: "GET", url: "/v1/wallet/agent::12201/balance" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ party: "agent::12201", amulet: 2, cc: "7.5000000000", holdings: [{ cid: "c1", amount: "5.0000000000" }, { cid: "c2", amount: "2.5000000000" }] });
    await a.close();
  });

  it("api-key gate: missing header → 401, correct header → 200", async () => {
    const s = svc({ agentWalletApiKey: "secret" });
    const a = await build(s);
    const no = await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: pk });
    expect(no.statusCode).toBe(401);
    const ok = await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: pk, headers: { "x-agent-key": "secret" } });
    expect(ok.statusCode).toBe(200);
    await a.close();
  });

  it("relay/client failure → 502", async () => {
    const s = svc({ client: mockClient({ allocateExternalParty: vi.fn().mockRejectedValue(new Error("boom")) }) as never });
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: { onboardingTransactions: ["tx1"], multiHashSignatures: [{ format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" }] } });
    expect(r.statusCode).toBe(502);
    await a.close();
  });

  it("relay error surfaces the upstream Canton code/cause", async () => {
    const upstream = Object.assign(new Error("POST /v2/users/u/rights returned HTTP 400"), {
      responseBody: JSON.stringify({ code: "TOO_MANY_USER_RIGHTS", cause: "user would have too many rights" }),
    });
    const s = svc({ client: mockClient({ allocateExternalParty: vi.fn().mockRejectedValue(upstream) }) as never });
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: { onboardingTransactions: ["tx1"], multiHashSignatures: [{ format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" }] } });
    expect(r.statusCode).toBe(502);
    expect(r.json().detail).toContain("TOO_MANY_USER_RIGHTS");
    await a.close();
  });
});

describe("wallet relay faucet route (POST /v1/wallet/faucet/claim)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Stub the Scan reads the faucet's transfer needs: dso-party-id + the
   *  transfer-factory resolve (both via scanFetchRetry → global fetch). */
  function stubScanFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/dso-party-id")) {
          return new Response(JSON.stringify({ dso_party_id: "DSO::1220cafe" }), {
            status: 200,
          });
        }
        if (u.includes("/transfer-factory")) {
          return new Response(
            JSON.stringify({
              factoryId: "00factory",
              choiceContext: { choiceContextData: {}, disclosedContracts: [] },
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );
  }

  const faucetConf = (over: Partial<NonNullable<WalletRelayServices["faucet"]>> = {}) => ({
    store: createInMemoryFaucetStore(),
    amountCc: "0.02",
    maxPerIp: 5,
    dailyBudgetCc: "1",
    lifetimeCapCc: "25",
    windowMs: 86_400_000,
    ...over,
  });

  /** svc with the faucet enabled + a client that can submit the transfer. */
  function faucetSvc(over: Partial<WalletRelayServices> = {}) {
    return svc({
      client: mockClient({
        submitAndWaitForTransaction: vi
          .fn()
          .mockResolvedValue({ updateId: "u-faucet", offset: 1, events: [] }),
      }) as never,
      faucet: faucetConf(),
      ...over,
    });
  }

  it("503 when the faucet is disabled (no faucet config)", async () => {
    const a = await build(svc()); // no faucet
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/disabled/);
    await a.close();
  });

  it("400 when party is missing", async () => {
    const a = await build(faucetSvc());
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    await a.close();
  });

  it("400 on a malformed party id (garbage never reaches the ledger or the store)", async () => {
    // The recipient becomes a ledger `receiver` party; a real Canton party is
    // `<hint>::<hex-fingerprint>`. Reject anything that does not match BEFORE any
    // store/ledger work so junk can't be submitted.
    const store = createInMemoryFaucetStore();
    const submit = vi
      .fn()
      .mockResolvedValue({ updateId: "u-faucet", offset: 1, events: [] });
    const a = await build(
      faucetSvc({
        client: mockClient({ submitAndWaitForTransaction: submit }) as never,
        faucet: faucetConf({ store }),
      })
    );
    for (const bad of [
      "not-a-party", // no ::
      "agent::xyz", // fingerprint not hex
      "agent::1220", // hex too short (<8)
      "agent::1220cafG0123", // non-hex char
      "bad party::1220cafe1234", // space
      "::1220cafe1234", // empty hint
    ]) {
      const r = await a.inject({
        method: "POST",
        url: "/v1/wallet/faucet/claim",
        payload: { party: bad },
      });
      expect(r.statusCode, `party=${bad}`).toBe(400);
    }
    // Nothing touched the store or the ledger.
    expect(await store.hasClaimed("agent::1220cafe1234")).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    await a.close();
  });

  it("accepts a well-formed party id (hint::8+hex-fingerprint)", async () => {
    stubScanFetch();
    const a = await build(faucetSvc());
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent_42::1220cafebabe1234567890abcdef" },
    });
    expect(r.statusCode).toBe(200);
    await a.close();
  });

  it("global burst cap: throttles a flood (claims/window) across all callers, then 429", async () => {
    stubScanFetch();
    const store = createInMemoryFaucetStore();
    // Cap = 2 claims per (long) window; the 3rd fresh-party claim is throttled.
    const a = await build(
      faucetSvc({
        faucet: faucetConf({
          store,
          maxPerIp: 0, // isolate the GLOBAL cap
          maxGlobalPerMin: 2,
          burstWindowMs: 60_000,
        }),
      })
    );
    const claim = (n: number) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/faucet/claim",
        payload: { party: `agent_${n}::1220cafe1234` },
      });
    expect((await claim(1)).statusCode).toBe(200);
    expect((await claim(2)).statusCode).toBe(200);
    const third = await claim(3);
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatch(/global burst/);
    await a.close();
  });

  it("ipExempt: the pay-proxy IP bypasses the per-IP + global-burst caps", async () => {
    stubScanFetch();
    // Cap everything to 1, but exempt 127.0.0.1 (the inject client's IP) → the
    // exempt caller sails past both caps.
    const a = await build(
      faucetSvc({
        faucet: faucetConf({
          maxPerIp: 1,
          maxGlobalPerMin: 1,
          ipExempt: ["127.0.0.1"],
        }),
      })
    );
    for (let n = 0; n < 3; n++) {
      const r = await a.inject({
        method: "POST",
        url: "/v1/wallet/faucet/claim",
        payload: { party: `agent_${n}::1220cafe1234` },
      });
      expect(r.statusCode, `claim ${n}`).toBe(200);
    }
    await a.close();
  });

  it("internal-secret lock: 403 without (or with a wrong) X-Faucet-Secret", async () => {
    const store = createInMemoryFaucetStore();
    const submit = vi
      .fn()
      .mockResolvedValue({ updateId: "u-faucet", offset: 1, events: [] });
    const a = await build(
      faucetSvc({
        client: mockClient({ submitAndWaitForTransaction: submit }) as never,
        faucet: faucetConf({ store, internalSecret: "pay-proxy-shared-secret" }),
      })
    );
    // No header → 403, and nothing touched the store/ledger.
    const noHdr = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(noHdr.statusCode).toBe(403);
    // Wrong secret → 403.
    const wrong = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      headers: { "x-faucet-secret": "nope" },
      payload: { party: "agent::1220cafe1234" },
    });
    expect(wrong.statusCode).toBe(403);
    expect(await store.hasClaimed("agent::1220cafe1234")).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    await a.close();
  });

  it("internal-secret lock: 200 with the correct X-Faucet-Secret", async () => {
    stubScanFetch();
    const a = await build(
      faucetSvc({
        faucet: faucetConf({ internalSecret: "pay-proxy-shared-secret" }),
      })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      headers: { "x-faucet-secret": "pay-proxy-shared-secret" },
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(200);
    await a.close();
  });

  it("happy path: seeds the agent, records the claim, returns the updateId", async () => {
    stubScanFetch();
    const store = createInMemoryFaucetStore();
    const a = await build(faucetSvc({ faucet: faucetConf({ store }) }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      updateId: "u-faucet",
      amount: "0.02",
      party: "agent::1220cafe1234",
    });
    expect(await store.hasClaimed("agent::1220cafe1234")).toBe(true);
    await a.close();
  });

  it("429 on a second claim by the same party (per-party-once)", async () => {
    stubScanFetch();
    const a = await build(faucetSvc());
    const first = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(first.statusCode).toBe(200);
    const second = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(second.statusCode).toBe(429);
    await a.close();
  });

  it("429 when one IP exceeds the per-IP cap (distinct parties)", async () => {
    stubScanFetch();
    const a = await build(faucetSvc({ faucet: faucetConf({ maxPerIp: 1 }) }));
    const first = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(first.statusCode).toBe(200);
    const second = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe5678" }, // different party, same IP
    });
    expect(second.statusCode).toBe(429);
    await a.close();
  });

  it("503 when the atomic guard refuses for daily_budget", async () => {
    // The route delegates the budget decision to the ATOMIC tryClaim (no
    // separate sumSince+tryReserve). A daily_budget reason → 503.
    const store: FaucetClaimStore = {
      hasClaimed: vi.fn().mockResolvedValue(false),
      tryClaim: vi.fn().mockResolvedValue("daily_budget"),
      tryReserve: vi.fn(),
      markPaid: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      sumSince: vi.fn(),
    };
    const a = await build(
      faucetSvc({ faucet: faucetConf({ store, amountCc: "0.6", dailyBudgetCc: "1" }) })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/budget/);
    // The atomic guard was used; the old non-atomic pair was NOT.
    expect(store.tryClaim).toHaveBeenCalledTimes(1);
    expect(store.tryReserve).not.toHaveBeenCalled();
    expect(store.sumSince).not.toHaveBeenCalled();
    await a.close();
  });

  it("503 (lifetime) when the atomic guard refuses for lifetime_cap", async () => {
    // Once ~lifetime CC has EVER been dispensed, tryClaim latches closed.
    const store: FaucetClaimStore = {
      hasClaimed: vi.fn().mockResolvedValue(false),
      tryClaim: vi.fn().mockResolvedValue("lifetime_cap"),
      tryReserve: vi.fn(),
      markPaid: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      sumSince: vi.fn(),
    };
    const a = await build(faucetSvc({ faucet: faucetConf({ store }) }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/lifetime/);
    // A lifetime latch must NOT roll back / retry — no payout was attempted.
    expect(store.release).not.toHaveBeenCalled();
    await a.close();
  });

  it("429 when the atomic guard refuses for already_claimed (race that beat the friendly pre-check)", async () => {
    const store: FaucetClaimStore = {
      hasClaimed: vi.fn().mockResolvedValue(false), // pre-check passes…
      tryClaim: vi.fn().mockResolvedValue("already_claimed"), // …but the atomic guard loses the race
      tryReserve: vi.fn(),
      markPaid: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
      sumSince: vi.fn(),
    };
    const a = await build(faucetSvc({ faucet: faucetConf({ store }) }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(429);
    await a.close();
  });

  it("fails CLOSED (503) when the store errors — never risks a double payout", async () => {
    const store: FaucetClaimStore = {
      hasClaimed: vi.fn().mockRejectedValue(new Error("db down")),
      tryClaim: vi.fn(),
      tryReserve: vi.fn(),
      markPaid: vi.fn(),
      release: vi.fn(),
      sumSince: vi.fn(),
    };
    const a = await build(faucetSvc({ faucet: faucetConf({ store }) }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/unavailable/);
    await a.close();
  });

  it("fails CLOSED (503) when the ATOMIC tryClaim itself throws (DB error mid-guard)", async () => {
    const store: FaucetClaimStore = {
      hasClaimed: vi.fn().mockResolvedValue(false),
      tryClaim: vi.fn().mockRejectedValue(new Error("db down")),
      tryReserve: vi.fn(),
      markPaid: vi.fn(),
      release: vi.fn(),
      sumSince: vi.fn(),
    };
    const a = await build(faucetSvc({ faucet: faucetConf({ store }) }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/unavailable/);
    await a.close();
  });

  it("releases the reservation and 502s if the on-ledger transfer fails (so it can retry)", async () => {
    stubScanFetch();
    const store = createInMemoryFaucetStore();
    const a = await build(
      faucetSvc({
        client: mockClient({
          submitAndWaitForTransaction: vi
            .fn()
            .mockRejectedValue(new Error("ledger boom")),
        }) as never,
        faucet: faucetConf({ store }),
      })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(r.statusCode).toBe(502);
    // reservation was rolled back so the agent can try again later
    expect(await store.hasClaimed("agent::1220cafe1234")).toBe(false);
    await a.close();
  });

  it("is gated by the api key when set", async () => {
    const a = await build(faucetSvc({ agentWalletApiKey: "secret" }));
    const no = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    expect(no.statusCode).toBe(401);
    await a.close();
  });
});
