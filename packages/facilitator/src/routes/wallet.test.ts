import { FaucetPreSubmitError } from "../canton/faucet.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { registerWalletRoutes, deniedChoice, type WalletRelayServices } from "./wallet.js";
import { UnfundedFeePartyError } from "../canton/preapproval.js";
import { SubmissionOutcomeUnknownError } from "../canton/transfer-factory.js";
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
    walletSubmitChoices: ["TransferFactory_Transfer", "TransferInstruction_Accept"],
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
    // Sends a REAL command now. It used to send `[{}]`, which was fine while
    // the route forwarded commands without looking at them — and stopped being
    // fine the moment it started checking what it was being asked to build.
    const a = await build(svc());
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/prepare",
      payload: {
        userId: "u", commandId: "c", actAs: ["agent::12201"], synchronizerId: "",
        commands: [
          {
            ExerciseCommand: {
              templateId: "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
              contractId: "00ab",
              choice: "TransferFactory_Transfer",
              choiceArgument: {},
            },
          },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ preparedTransaction: "pt", hash: "h1" });
    await a.close();
  });

  it("submit/prepare refuses a choice outside the allowlist, before touching the participant", async () => {
    const prepare = vi.fn();
    const s = svc();
    s.client.interactiveSubmissionPrepare = prepare as never;
    const a = await build(s);
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/prepare",
      payload: {
        userId: "u", commandId: "c", actAs: ["agent::12201"], synchronizerId: "",
        commands: [{ ExerciseCommand: { templateId: "#p:M:T", contractId: "00ab", choice: "AmuletRules_Melt", choiceArgument: {} } }],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("choice_not_allowed");
    // The point of refusing here rather than downstream: our participant never
    // did the work. If this ever fires, the guard has become decorative.
    expect(prepare).not.toHaveBeenCalled();
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

describe("resolve/transfer-factory instrument routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  const USDCX_ADMIN = "decentralized-usdc-interchain-rep::1220abc";
  const UTIL = "https://registry.example";

  function stubResolveFetch(capture: (url: string) => void) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        capture(u);
        if (u.includes("/dso-party-id")) {
          return new Response(JSON.stringify({ dso_party_id: "DSO::1220cafe" }), {
            status: 200,
          });
        }
        if (u.includes("/transfer-factory")) {
          return new Response(
            JSON.stringify({
              factoryId: "00factory",
              transferKind: "direct",
              choiceContext: { choiceContextData: {}, disclosedContracts: [] },
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );
  }

  it("routes a non-Amulet instrument to its DA Registry Utility per-registrar path", async () => {
    const urls: string[] = [];
    stubResolveFetch((u) => urls.push(u));
    const a = await build(svc({ tokenRegistries: { [USDCX_ADMIN]: UTIL } }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/resolve/transfer-factory",
      payload: {
        sender: "agent::1220a",
        receiver: "merchant::1220m",
        amount: "1.0000000000",
        instrumentId: { admin: USDCX_ADMIN, id: "USDCx" },
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.instrumentId).toEqual({ admin: USDCX_ADMIN, id: "USDCx" });
    const factoryUrl = urls.find((u) => u.includes("/transfer-factory"));
    expect(factoryUrl).toBe(
      `${UTIL}/api/token-standard/v0/registrars/${encodeURIComponent(
        USDCX_ADMIN
      )}/registry/transfer-instruction/v1/transfer-factory`
    );
    // Never asked the SV Scan for a DSO — a utility token names its own admin.
    expect(urls.some((u) => u.includes("/dso-party-id"))).toBe(false);
  });

  it("falls back to Amulet (SV Scan + DSO) when no instrument is given", async () => {
    const urls: string[] = [];
    stubResolveFetch((u) => urls.push(u));
    const a = await build(svc({ tokenRegistries: { [USDCX_ADMIN]: UTIL } }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/resolve/transfer-factory",
      payload: {
        sender: "agent::1220a",
        receiver: "merchant::1220m",
        amount: "1.0000000000",
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.instrumentId).toEqual({ admin: "DSO::1220cafe", id: "Amulet" });
    expect(urls.some((u) => u.includes("/dso-party-id"))).toBe(true);
    expect(urls.some((u) => u.includes(UTIL))).toBe(false);
  });

  it("an instrument admin with no configured registry is REJECTED (never silently Amulet)", async () => {
    const urls: string[] = [];
    stubResolveFetch((u) => urls.push(u));
    const a = await build(svc({ tokenRegistries: {} }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/resolve/transfer-factory",
      payload: {
        sender: "agent::1220a",
        receiver: "merchant::1220m",
        amount: "1.0000000000",
        instrumentId: { admin: "who::1220", id: "MYSTERY" },
      },
    });
    // A requested instrument we have no registry for is a hard 400, not a
    // silent Amulet factory for the wrong asset.
    expect(r.statusCode).toBe(400);
    expect(urls.some((u) => u.includes("/transfer-factory"))).toBe(false);
  });
});

describe("pay/prepare instrument guard", () => {
  it("rejects a named instrument whose admin has no configured registry (400)", async () => {
    const a = await build(svc({ tokenRegistries: {} }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: {
        party: "agent::1220a",
        receiver: "merchant::1220m",
        amount: "1.0000000000",
        instrumentId: { admin: "usdcx-admin::1220", id: "USDCx" },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/no registry configured/i);
  });
});

describe("pay/prepare venueMeta validation (bounded, /venue-suffixed, no memo clobber)", () => {
  const base = {
    party: "agent::1220cafe1234",
    receiver: "merchant::1220beef5678",
    amount: "1.0000000000",
  };
  const post = async (venueMeta: unknown) => {
    // tfPay enabled so the handler passes the TF-disabled 503 gate and reaches the
    // venueMeta validation (which runs before the expensive prepare path).
    const a = await build(svc({ tokenRegistries: {}, tfPay: { defaultExecuteBeforeSeconds: 120, maxExecuteBeforeSeconds: 300 } }));
    return a.inject({ method: "POST", url: "/v1/wallet/pay/prepare", payload: { ...base, venueMeta } });
  };

  it("rejects a key that does not end in /venue (400)", async () => {
    const r = await post({ "ftp/notvenue": "ftp" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/venue/i);
  });

  it("rejects more than 4 keys (400)", async () => {
    const r = await post({ "a/venue": "1", "b/venue": "2", "c/venue": "3", "d/venue": "4", "e/venue": "5" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/at most 4/i);
  });

  it("rejects a non-string / empty value (400)", async () => {
    expect((await post({ "ftp/venue": "" })).statusCode).toBe(400);
    expect((await post({ "ftp/venue": 5 })).statusCode).toBe(400);
  });

  it("rejects an array (400)", async () => {
    const r = await post(["ftp/venue"]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/object/i);
  });

  it("does NOT reject a valid venueMeta on venue grounds (proceeds past validation)", async () => {
    // With no registry configured it fails later on the CC prepare path, but the
    // failure must NOT be about venueMeta — validation let it through.
    const r = await post({ "ftp/venue": "ftp/agentic-wallet" });
    expect(JSON.stringify(r.json())).not.toMatch(/venueMeta|at most 4|\/venue/i);
  });
});

describe("a registry token is prepared inline like any other instrument", () => {
  // The inline carriage is the only one, and it settles a registry token the
  // same way it settles Canton Coin. pay/prepare must not special-case or refuse
  // a configured registry instrument on carriage grounds — but a NAMED
  // instrument with NO configured registry is still a hard 400.
  const USDCX_ADMIN = "decentralized-usdc-interchain-rep::12208115";
  const REG = { [USDCX_ADMIN]: "https://api.utilities.digitalasset.com" };

  it("does not refuse a configured registry instrument on carriage grounds", async () => {
    const a = await build(svc({ tokenRegistries: REG }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: {
        party: "agent::1220a",
        receiver: "merchant::1220m",
        amount: "0.1000000000",
        instrumentId: { admin: USDCX_ADMIN, id: "USDCx" },
      },
    });
    // It proceeds into the normal prepare flow (which may fail later on holdings
    // or an unstubbed resolve) — but never with a carriage refusal.
    expect(JSON.stringify(r.json())).not.toMatch(/carriage/i);
  });

  it("rejects a named instrument with NO configured registry (hard 400)", async () => {
    const a = await build(svc({ tokenRegistries: {} }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: {
        party: "agent::1220a",
        receiver: "merchant::1220m",
        amount: "0.1000000000",
        instrumentId: { admin: USDCX_ADMIN, id: "USDCx" },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/no registry configured/i);
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

  async function claimWith(err: unknown, store = createInMemoryFaucetStore()) {
    stubScanFetch();
    const a = await build(
      faucetSvc({
        client: mockClient({
          submitAndWaitForTransaction: vi.fn().mockRejectedValue(err),
        }) as never,
        faucet: faucetConf({ store }),
      })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/faucet/claim",
      payload: { party: "agent::1220cafe1234" },
    });
    await a.close();
    return { code: r.statusCode, claimed: await store.hasClaimed("agent::1220cafe1234") };
  }

  it("releases the reservation only when the participant PROVED nothing moved", async () => {
    // A definite 4xx means the participant processed the request and refused
    // it, so no contract changed and the agent may try again later.
    const r = await claimWith(
      Object.assign(new Error("rejected"), { code: "HTTP_ERROR", status: 400 })
    );
    expect(r.code).toBe(502);
    expect(r.claimed).toBe(false); // rolled back
  });

  it("KEEPS the reservation when the failure is ambiguous — no second payout", async () => {
    // The reservation is per-party-once and is the only thing stopping a second
    // real CC payout. Releasing it on ANY throw meant a submit that timed out
    // AFTER the participant committed looked exactly like a clean refusal: the
    // party claims again, CC leaves twice, and the daily/lifetime budget never
    // sees the first payout. "I do not know" has to fail closed here — an
    // honest party losing its one claim during our outage is undoable by an
    // operator; the CC is not.
    for (const err of [
      Object.assign(new Error("timeout"), { code: "TIMEOUT" }),
      Object.assign(new Error("bad gateway"), { code: "HTTP_ERROR", status: 502 }),
      Object.assign(new Error("try later"), { code: "HTTP_ERROR", status: 429 }),
      new Error("ledger boom"), // plain throw: unclassifiable, so ambiguous
    ]) {
      const r = await claimWith(err);
      expect(r.code).toBe(502);
      expect(r.claimed).toBe(true); // reservation STANDS
    }
  });

  it("RELEASES when the claim died before the ledger was ever asked", async () => {
    // The other proof. A Scan read, an ACS query, and a registry call all run
    // BEFORE the submit and none of them can move CC, so a failure there is not
    // "I do not know" — it is "we never asked". Charging an honest agent its one
    // lifetime claim, and debiting the daily + lifetime budget, because OUR
    // registry timed out is a bug the ambiguity rule was never meant to cover.
    for (const cause of [
      Object.assign(new Error("scan 503"), { code: "HTTP_ERROR", status: 503 }),
      Object.assign(new Error("registry timeout"), { code: "TIMEOUT" }),
      new Error("faucet funder has no Amulet holdings"),
    ]) {
      const r = await claimWith(new FaucetPreSubmitError(cause));
      expect(r.claimed).toBe(false); // rolled back — the claim is still theirs
    }
  });

  it("still KEEPS the reservation when the same status arrives UNWRAPPED", async () => {
    // The discriminator: the rule is "the service proved it never submitted",
    // not "503 and TIMEOUT are safe". An identical status thrown from the
    // submit itself is still ambiguous and must fail closed, or the fix would
    // have quietly re-opened the double-payout it replaced.
    const r = await claimWith(
      Object.assign(new Error("scan 503"), { code: "HTTP_ERROR", status: 503 })
    );
    expect(r.claimed).toBe(true);
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

describe("submit/prepare — the relay builds only what it agreed to build", () => {
  const ALLOWED = ["TransferFactory_Transfer", "TransferInstruction_Accept"];
  const ex = (choice: string) => ({
    ExerciseCommand: { templateId: "#pkg:M:T", contractId: "00ab", choice, choiceArgument: {} },
  });

  it("passes the two choices the shipped client actually sends", () => {
    // Measured from agent-wallet's prepareSignExecute, which has exactly one
    // call site — not guessed from what sounded plausible.
    expect(deniedChoice([ex("TransferFactory_Transfer")], ALLOWED)).toBeUndefined();
    expect(deniedChoice([ex("TransferInstruction_Accept")], ALLOWED)).toBeUndefined();
    expect(
      deniedChoice([ex("TransferFactory_Transfer"), ex("TransferInstruction_Accept")], ALLOWED)
    ).toBeUndefined();
  });

  it("names the offending choice rather than failing vaguely", () => {
    expect(deniedChoice([ex("AmuletRules_Melt")], ALLOWED)).toBe("AmuletRules_Melt");
  });

  it("refuses a batch where only ONE command is disallowed", () => {
    // The interesting case: hiding a bad command behind good ones.
    expect(
      deniedChoice(
        [ex("TransferFactory_Transfer"), ex("SomethingElse"), ex("TransferInstruction_Accept")],
        ALLOWED
      )
    ).toBe("SomethingElse");
  });

  it("refuses command SHAPES the client never sends, instead of inspecting them", () => {
    // THE ONE THAT MATTERS. An allowlist that only reads `choice` waves through
    // anything with no `choice` field at all — which is the standard way this
    // check gets walked past.
    expect(deniedChoice([{ CreateCommand: { templateId: "#p:M:T", createArguments: {} } }], ALLOWED))
      .toBe("CreateCommand");
    expect(
      deniedChoice([{ ExerciseByKeyCommand: { choice: "TransferFactory_Transfer" } }], ALLOWED)
    ).toBe("ExerciseByKeyCommand");
    // Two keys: we are not guessing which half the participant would honour.
    expect(
      deniedChoice(
        [{ ExerciseCommand: { choice: "TransferFactory_Transfer" }, CreateCommand: {} }],
        ALLOWED
      )
    ).toBe("(malformed command)");
    expect(deniedChoice([null], ALLOWED)).toBe("(malformed command)");
    expect(deniedChoice(["TransferFactory_Transfer"], ALLOWED)).toBe("(malformed command)");
    expect(deniedChoice([{ ExerciseCommand: { choice: 42 } }], ALLOWED)).toBe(
      "(command without a choice)"
    );
  });

  it("`*` restores the old forward-anything behaviour for an operator who wants it", () => {
    expect(deniedChoice([ex("Anything")], ["*"])).toBeUndefined();
    expect(deniedChoice([{ CreateCommand: {} }], ["*"])).toBeUndefined();
  });
});

describe("submit/execute is bounded before it spends ledger traffic", () => {
  it("refuses past the cap, and the refusal costs no submission", async () => {
    // This route hands bytes straight to interactiveSubmissionExecute — a real
    // ledger submission spending our Global Synchronizer traffic — behind
    // nothing but a presence check and authed(), which is a no-op unless the
    // relay key is set (it is not on this deployment). The choice allowlist
    // guards submit/PREPARE, the cheap step; the expensive one was open.
    const execute = vi.fn(async () => ({ updateId: "1220u" }));
    const a = await build(
      svc({
        client: mockClient({
          getLedgerEnd: vi.fn(async () => ({ offset: 0 })),
          interactiveSubmissionExecute: execute,
        }) as never,
        submitRateMaxPerKey: 2,
      })
    );
    const call = () =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/submit/execute",
        payload: {
          preparedTransaction: "cHJlcA==",
          partySignatures: { signatures: [{ party: "agent::1220aa" }] },
        },
      });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    const blocked = await call();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(execute).toHaveBeenCalledTimes(2); // the refusal submitted nothing
    await a.close();
  });

  it("the bucket is the PAIR (party, caller IP), so a stranger cannot lock a party out", async () => {
    // Same reasoning as the wasted-prepare budget: the party in the body is
    // caller-asserted, so keying on it alone would hand anyone a lockout.
    const execute = vi.fn(async () => ({ updateId: "1220u" }));
    const a = await build(
      svc({
        client: mockClient({
          getLedgerEnd: vi.fn(async () => ({ offset: 0 })),
          interactiveSubmissionExecute: execute,
        }) as never,
        submitRateMaxPerKey: 1,
      })
    );
    const from = (ip: string) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/submit/execute",
        remoteAddress: ip,
        payload: {
          preparedTransaction: "cHJlcA==",
          partySignatures: { signatures: [{ party: "agent::1220victim" }] },
        },
      });
    expect((await from("9.9.9.9")).statusCode).toBe(200);
    expect((await from("9.9.9.9")).statusCode).toBe(429); // attacker exhausted
    expect((await from("1.1.1.1")).statusCode).toBe(200); // victim unaffected
    await a.close();
  });
});

describe("a read the participant refuses is the caller's answer, not our outage", () => {
  const refuse = () =>
    Object.assign(new Error("HTTP 403"), {
      code: "HTTP_ERROR",
      status: 403,
      responseBody: JSON.stringify({
        code: "NA",
        cause: "A security-sensitive error has been received",
      }),
    });

  async function app() {
    return build(
      svc({
        client: mockClient({
          queryActiveContracts: vi.fn().mockRejectedValue(refuse()),
        }) as never,
      })
    );
  }
  const bal = (a: Awaited<ReturnType<typeof app>>, party: string) =>
    a.inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(party)}/balance` });

  it("404s a single unknown party instead of 502 + an error line", async () => {
    // `level:50` has to mean "something is wrong with US" or it stops being a
    // signal. Measured on production: 56 of 5575 requests were this, all for
    // one party that has never paid, prepared or claimed here — a steady 1%
    // of noise burying everything else. 404 is both true from the caller's
    // side and actionable.
    const a = await app();
    const r = await bal(a, "agent::1220stranger");
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: string }).error).toMatch(/not readable/);
    await a.close();
  });

  it("escalates to 502 once MANY DISTINCT parties are refused — that is our outage", async () => {
    // The escalation is what stops this trading one blind spot for another. If
    // our own read rights broke, refusals would not stay confined to one
    // party. Distinct-party count is the discriminator, and it costs no extra
    // request.
    const a = await app();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await bal(a, `agent::1220party${i}`)).statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([404, 404, 404]);
    expect(codes[3]).toBe(502); // the 4th DISTINCT party is a pattern
    expect(codes[4]).toBe(502);
    await a.close();
  });

  it("one party asking repeatedly never escalates — it is still one party", async () => {
    const a = await app();
    for (let i = 0; i < 6; i++) {
      expect((await bal(a, "agent::1220sameone")).statusCode).toBe(404);
    }
    await a.close();
  });
});

describe("every door to interactiveSubmissionExecute charges the SAME budget", () => {
  // The submit budget exists for one line: "past this point we spend real
  // Global Synchronizer traffic on someone else's bytes". /submit/execute
  // charged it; /preapproval/self/commit reached the identical participant call
  // and charged nothing, so the 60/min cap bounded nothing at all — an
  // anonymous caller took a prepared transaction from any prepare route and
  // looped it through the unbudgeted door instead.
  const body = {
    party: "agent::1220aaa",
    preparedTransaction: "cHJlcA==",
    partySignatures: { signatures: [{ party: "agent::1220aaa", signatures: [{}] }] },
  };

  function selfPreapprovalSvc(cap: number) {
    return svc({
      submitRateMaxPerKey: cap,
      selfPreapproval: {
        executeSelfPreapproval: async () => ({ updateId: "1220-ok" }),
      },
    } as never);
  }

  it("refuses past the cap, exactly like /submit/execute", async () => {
    const a = await build(selfPreapprovalSvc(2));
    const call = () =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/preapproval/self/commit",
        payload: body,
      });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    const third = await call();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: "too many submissions" });
    expect(third.headers["retry-after"]).toBe("60");
    await a.close();
  });

  it("cap 0 disables the budget rather than refusing everything", async () => {
    // The documented meaning of 0 elsewhere in this file. Getting this backwards
    // would take the relay offline for every self-provisioning merchant.
    const a = await build(selfPreapprovalSvc(0));
    for (let i = 0; i < 5; i++) {
      const r = await a.inject({
        method: "POST",
        url: "/v1/wallet/preapproval/self/commit",
        payload: body,
      });
      expect(r.statusCode).toBe(200);
    }
    await a.close();
  });
});

describe("the onboarding doors had no lock at all", () => {
  // onboard/finalize writes a topology transaction under OUR participant, on
  // OUR sequencer traffic, and the party it allocates is permanent. It is
  // anonymous in production: authed() is a no-op when
  // CANTON_X402_AGENT_WALLET_KEY is unset, and an out-of-box agent has no key
  // to present anyway. Every comparable mutating route in this file already
  // carried a limiter; these did not.
  function onboardSvc(cap: number) {
    return svc({
      submitRateMaxPerKey: cap,
      client: {
        allocateExternalParty: async () => ({ partyId: "agent::1220new" }),
        grantUserRights: async () => undefined,
      },
    } as never);
  }
  const body = {
    onboardingTransactions: ["dHg="],
    multiHashSignatures: [{ signature: "c2ln" }],
  };
  const call = (a: Awaited<ReturnType<typeof build>>) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/onboard/finalize",
      payload: body,
    });

  it("refuses past the cap instead of allocating without bound", async () => {
    const a = await build(onboardSvc(2));
    expect((await call(a)).statusCode).toBe(200);
    expect((await call(a)).statusCode).toBe(200);
    const third = await call(a);
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBe("60");
    await a.close();
  });

  it("a DIFFERENT caller is unaffected — the key is the caller, not a body field", async () => {
    // The discriminator. Every field in this body is caller-asserted, so a
    // per-party key would be a budget a stranger could spend — the lesson the
    // pay/prepare cap already learned the hard way in production.
    const a = await build(onboardSvc(1));
    expect((await call(a)).statusCode).toBe(200);
    expect((await call(a)).statusCode).toBe(429);
    const other = await a.inject({
      method: "POST",
      url: "/v1/wallet/onboard/finalize",
      payload: body,
      remoteAddress: "203.0.113.9",
    });
    expect(other.statusCode).toBe(200);
    await a.close();
  });
});

describe("the submit budget key must be bounded", () => {
  // The key was read straight out of the request body and inserted into the
  // limiter's Map, so a caller could grow that Map with whatever string it
  // liked — as long as the body limit allowed — just by varying one field.
  it("a garbage party does not mint a fresh bucket per request", async () => {
    const a = await build(
      svc({
        submitRateMaxPerKey: 2,
        client: { interactiveSubmissionExecute: async () => ({ updateId: "u" }) },
      } as never)
    );
    const call = (party: string) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/submit/execute",
        payload: {
          preparedTransaction: "cHJlcA==",
          partySignatures: { signatures: [{ party, signatures: [{}] }] },
        },
      });
    // Three requests, three DIFFERENT junk "parties", cap 2. They all collapse
    // onto the same bucket, so the third is refused.
    await call("x".repeat(5000));
    await call("y".repeat(5000));
    const third = await call("z".repeat(5000));
    expect(third.statusCode).toBe(429);
    await a.close();
  });

  it("rotating a WELL-FORMED party still hits the per-caller ceiling", async () => {
    // The shape check alone bounds nothing: a valid-looking party costs a
    // caller nothing to mint, so a composite key that CONTAINS one hands out a
    // fresh bucket per request. The IP arm is what a single host cannot vary,
    // which is why /settle has always passed two keys instead of one.
    const a = await build(
      svc({
        submitRateMaxPerKey: 60,
        submitRateMaxPerIp: 3,
        client: { interactiveSubmissionExecute: async () => ({ updateId: "u" }) },
      } as never)
    );
    const call = (n: number) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/submit/execute",
        payload: {
          preparedTransaction: "cHJlcA==",
          partySignatures: {
            signatures: [
              { party: `agent::1220${String(n).padStart(8, "0")}`, signatures: [{}] },
            ],
          },
        },
      });
    expect((await call(1)).statusCode).not.toBe(429);
    expect((await call(2)).statusCode).not.toBe(429);
    expect((await call(3)).statusCode).not.toBe(429);
    expect((await call(4)).statusCode).toBe(429); // every party distinct, still bounded
    await a.close();
  });

  it("a DIFFERENT caller is untouched by another caller's ceiling", async () => {
    // The discriminator for the IP arm: it must bound one host, not the world.
    const a = await build(
      svc({
        submitRateMaxPerKey: 60,
        submitRateMaxPerIp: 1,
        client: { interactiveSubmissionExecute: async () => ({ updateId: "u" }) },
      } as never)
    );
    const call = (remoteAddress?: string) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/submit/execute",
        payload: {
          preparedTransaction: "cHJlcA==",
          partySignatures: {
            signatures: [{ party: "agent::1220aaaaaaaa", signatures: [{}] }],
          },
        },
        ...(remoteAddress ? { remoteAddress } : {}),
      });
    expect((await call()).statusCode).not.toBe(429);
    expect((await call()).statusCode).toBe(429);
    expect((await call("203.0.113.44")).statusCode).not.toBe(429);
    await a.close();
  });

  it("a REAL party still gets its own bucket", async () => {
    // The discriminator: collapsing everything onto one key would make one
    // honest agent's traffic refuse another's.
    const a = await build(
      svc({
        submitRateMaxPerKey: 1,
        client: { interactiveSubmissionExecute: async () => ({ updateId: "u" }) },
      } as never)
    );
    const call = (party: string) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/submit/execute",
        payload: {
          preparedTransaction: "cHJlcA==",
          partySignatures: { signatures: [{ party, signatures: [{}] }] },
        },
      });
    expect((await call("agent::1220aaaaaaaa")).statusCode).not.toBe(429);
    expect((await call("agent::1220aaaaaaaa")).statusCode).toBe(429);
    expect((await call("agent::1220bbbbbbbb")).statusCode).not.toBe(429);
    await a.close();
  });
});

/**
 * `onboard/finalize` allocates a PERMANENT party, writes topology to the Global
 * Synchronizer on our traffic, and takes a user-rights slot — a limit this
 * participant has already met in production (see the TOO_MANY_USER_RIGHTS test
 * above). The route is anonymous in the shipped configuration.
 *
 * It was bounded per IP only. Per-IP admission control cannot bound a resource
 * that everyone shares: one more IP buys a whole fresh bucket, and every bucket
 * costs us permanent allocations. The global arm is the bound; the per-IP arm
 * stays the cheap first line.
 */
describe("onboard/finalize — facilitator-wide allocation budget", () => {
  const finalize = (a: ReturnType<typeof Fastify>, remoteAddress: string) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/onboard/finalize",
      remoteAddress,
      payload: {
        onboardingTransactions: ["tx1"],
        multiHashSignatures: [
          { format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" },
        ],
      },
    });

  it("bounds allocations across DIFFERENT callers, and allocates nothing when it refuses", async () => {
    const alloc = vi.fn().mockResolvedValue({ partyId: "agent::1220new" });
    const s = svc({
      client: mockClient({ allocateExternalParty: alloc }) as never,
      // Per-IP cap far out of the way: this test is about the global arm, and
      // every request comes from a different address anyway.
      submitRateMaxPerKey: 100,
      onboardRateMaxGlobal: 2,
    });
    const a = await build(s);

    expect((await finalize(a, "203.0.113.1")).statusCode).toBe(200);
    expect((await finalize(a, "203.0.113.2")).statusCode).toBe(200);
    const third = await finalize(a, "203.0.113.3");

    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBe("60");
    // The refusal happened BEFORE the spend — this is the whole point.
    expect(alloc).toHaveBeenCalledTimes(2);
    await a.close();
  });

  it("admission traffic does NOT spend the allocation budget", async () => {
    // DISCRIMINATOR. Charging the scarce budget on arrival would let requests
    // that never allocate anything — onboard/prepare builds topology locally,
    // submit/prepare is participant-local — exhaust it for the requests that
    // do. That is the rule the settle path already follows.
    const alloc = vi.fn().mockResolvedValue({ partyId: "agent::1220new" });
    const s = svc({
      client: mockClient({ allocateExternalParty: alloc }) as never,
      submitRateMaxPerKey: 100,
      onboardRateMaxGlobal: 2,
    });
    const a = await build(s);

    for (let i = 0; i < 5; i++) {
      const r = await a.inject({
        method: "POST",
        url: "/v1/wallet/onboard/prepare",
        remoteAddress: `198.51.100.${i}`,
        payload: pk,
      });
      expect(r.statusCode).toBe(200);
    }
    // The budget is untouched, so both real allocations still go through.
    expect((await finalize(a, "203.0.113.1")).statusCode).toBe(200);
    expect((await finalize(a, "203.0.113.2")).statusCode).toBe(200);
    expect(alloc).toHaveBeenCalledTimes(2);
    await a.close();
  });

  it("a cap of 0 disables the global arm entirely", async () => {
    // DISCRIMINATOR against over-correction: an operator must be able to turn
    // this off, and the default must not be the only reachable behaviour.
    const alloc = vi.fn().mockResolvedValue({ partyId: "agent::1220new" });
    const s = svc({
      client: mockClient({ allocateExternalParty: alloc }) as never,
      submitRateMaxPerKey: 100,
      onboardRateMaxGlobal: 0,
    });
    const a = await build(s);
    for (let i = 0; i < 6; i++) {
      expect((await finalize(a, `192.0.2.${i}`)).statusCode).toBe(200);
    }
    expect(alloc).toHaveBeenCalledTimes(6);
    await a.close();
  });

  it("the per-IP arm still refuses one hammering caller before the global arm sees it", async () => {
    // DISCRIMINATOR: the cheap first line must still be first. If the global
    // arm were charged at admission, this caller would spend everyone's budget
    // on its way to its own cap.
    const alloc = vi.fn().mockResolvedValue({ partyId: "agent::1220new" });
    const s = svc({
      client: mockClient({ allocateExternalParty: alloc }) as never,
      submitRateMaxPerKey: 2,
      onboardRateMaxGlobal: 50,
    });
    const a = await build(s);
    expect((await finalize(a, "203.0.113.9")).statusCode).toBe(200);
    expect((await finalize(a, "203.0.113.9")).statusCode).toBe(200);
    const third = await finalize(a, "203.0.113.9");
    expect(third.statusCode).toBe(429);
    expect((third.json() as { error: string }).error).toContain("onboarding");
    // A different caller is unaffected — the refusal was that IP's own cap.
    expect((await finalize(a, "203.0.113.10")).statusCode).toBe(200);
    await a.close();
  });
});

/**
 * `/v1/wallet/preapproval/self/commit` spends the same resource as
 * /submit/execute — a getLedgerEnd plus a real POST
 * /v2/interactive-submission/execute on our Global Synchronizer traffic — and
 * it is anonymous in the shipped configuration. It carried the composite
 * `submit:${party}|${ip}` key ALONE, with `party` read verbatim off the body,
 * so rotating that one field handed the caller a fresh bucket every request
 * and the 60/min cap never trips. The sibling route had already learned this.
 */
describe("preapproval/self/commit — submit budget", () => {
  const commitSvc = (over: Record<string, unknown> = {}) =>
    svc({
      submitRateMaxPerKey: 60,
      submitRateMaxPerIp: 3,
      selfPreapproval: {
        executeSelfPreapproval: vi.fn().mockResolvedValue({ updateId: "u1" }),
      },
      ...over,
    } as never);

  const commit = (
    a: ReturnType<typeof Fastify>,
    party: string,
    remoteAddress = "203.0.113.7"
  ) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/preapproval/self/commit",
      remoteAddress,
      payload: {
        party,
        preparedTransaction: "cHJlcA==",
        partySignatures: { signatures: [{ party, signatures: [{}] }] },
      },
    });

  it("rotating the body's party does not mint a fresh budget", async () => {
    const a = await build(commitSvc());
    const p = (n: number) => `agent::1220${String(n).padStart(8, "0")}`;
    expect((await commit(a, p(1))).statusCode).not.toBe(429);
    expect((await commit(a, p(2))).statusCode).not.toBe(429);
    expect((await commit(a, p(3))).statusCode).not.toBe(429);
    // Every party distinct, and still bounded — the IP arm is what holds.
    expect((await commit(a, p(4))).statusCode).toBe(429);
    await a.close();
  });

  it("junk in the party field never becomes a limiter key of its own", async () => {
    const a = await build(commitSvc());
    // Four different malformed parties: all collapse to the same "unknown"
    // bucket instead of four buckets.
    expect((await commit(a, "a")).statusCode).not.toBe(429);
    expect((await commit(a, "b")).statusCode).not.toBe(429);
    expect((await commit(a, "c")).statusCode).not.toBe(429);
    expect((await commit(a, "d")).statusCode).toBe(429);
    await a.close();
  });

  it("a DIFFERENT caller is untouched by another caller's ceiling", async () => {
    // DISCRIMINATOR against over-correction: the ceiling must be per caller,
    // not a facilitator-wide gate that one abuser can close for everyone.
    const a = await build(commitSvc());
    const p = (n: number) => `agent::1220${String(n).padStart(8, "0")}`;
    for (let i = 1; i <= 3; i++) await commit(a, p(i), "203.0.113.7");
    expect((await commit(a, p(9), "203.0.113.7")).statusCode).toBe(429);
    expect((await commit(a, p(9), "198.51.100.4")).statusCode).not.toBe(429);
    await a.close();
  });

  it("two agents behind ONE NAT do not spend each other's per-key budget", async () => {
    // This is what the party arm is FOR. Without it, both agents collapse into
    // a single bucket and the first one to fill it locks out the second — the
    // exact failure the sibling route's comment warns about. The IP ceiling is
    // still there above both of them.
    const a = await build(commitSvc({ submitRateMaxPerKey: 2, submitRateMaxPerIp: 60 }));
    const nat = "203.0.113.50";
    const A = "agent::1220aaaaaaaaaaaaaaaa";
    const B = "agent::1220bbbbbbbbbbbbbbbb";
    expect((await commit(a, A, nat)).statusCode).not.toBe(429);
    expect((await commit(a, A, nat)).statusCode).not.toBe(429);
    expect((await commit(a, A, nat)).statusCode).toBe(429); // A spent its own
    expect((await commit(a, B, nat)).statusCode).not.toBe(429); // B untouched
    await a.close();
  });

  it("an honest single caller is not throttled below its own per-key cap", async () => {
    // DISCRIMINATOR: one agent committing its own preapproval must still work.
    const a = await build(commitSvc({ submitRateMaxPerIp: 60 }));
    for (let i = 0; i < 5; i++) {
      expect(
        (await commit(a, "agent::1220aaaaaaaaaaaaaaaa")).statusCode
      ).not.toBe(429);
    }
    await a.close();
  });
});

/**
 * Past a 200 from interactiveSubmissionExecute the submission is ACCEPTED and
 * will be sequenced. Everything after that reads an outcome; it cannot unmake
 * one. The completion read failing is therefore not the submission failing —
 * and answering 502 said exactly that, so the operator re-ran a money-moving
 * command over fresh inputs while the first one was committing.
 *
 * The /settle twin of this is already guarded (canton/transfer-factory.ts).
 * These pin the relay copy so the two cannot drift apart again.
 */
describe("submit/execute: an unreadable completion is not a failed submission", () => {
  const executed = { updateId: undefined as string | undefined };
  const run = async (poll: () => Promise<string>) => {
    const a = await build(
      svc({
        client: mockClient({
          interactiveSubmissionExecute: vi.fn().mockResolvedValue(executed),
          pollCompletionUpdateId: vi.fn().mockImplementation(poll),
        }) as never,
      })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/execute",
      payload: {
        preparedTransaction: "pt",
        partySignatures: { signatures: [{ party: "agent::12201" }] },
      },
    });
    await a.close();
    return r;
  };

  it("answers 503 outcome-unknown when the completion cannot be read", async () => {
    const r = await run(async () => {
      throw Object.assign(new Error("no completion for submissionId within timeout"), {
        code: "INVALID_RESPONSE",
      });
    });
    expect(r.statusCode).toBe(503);
    const b = r.json() as { error: string; submissionId: string; detail: string };
    expect(b.error).toBe("submission_outcome_unknown");
    // The submissionId is the whole point: it is what makes the outcome
    // recoverable instead of guessable.
    expect(b.submissionId).toBeTruthy();
    expect(b.detail).toContain("do NOT resubmit");
  });

  it("keeps 5xx-as-failure for SUBMISSION_FAILED — the participant DID answer", async () => {
    // The discriminator against over-correcting. If everything became 503 the
    // caller could never learn that a submission was definitively refused, and
    // an honest retry would be blocked behind a warning about a payment that
    // never existed.
    const r = await run(async () => {
      throw Object.assign(new Error("interactive submission rejected: bad"), {
        code: "SUBMISSION_FAILED",
      });
    });
    expect(r.statusCode).toBe(502);
    expect((r.json() as { error: string }).error).not.toBe("submission_outcome_unknown");
  });

  it("does not dress an unpollable submission up as a success", async () => {
    // No party in the signatures → nothing to poll with. Returning 200
    // {updateId: undefined} claimed success for an outcome we never read.
    const a = await build(
      svc({
        client: mockClient({
          interactiveSubmissionExecute: vi.fn().mockResolvedValue({ updateId: undefined }),
        }) as never,
      })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/execute",
      payload: { preparedTransaction: "pt", partySignatures: {} },
    });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: string }).error).toBe("submission_outcome_unknown");
    await a.close();
  });
});

/**
 * The THIRD copy of "accepted submission, unreadable completion". The other two
 * (canton/transfer-factory.ts execute, and submit/execute above) already
 * distinguish it; this one answered 502, so a merchant whose preapproval
 * committed was told it failed and paid a second creation fee for it.
 */
describe("preapproval/self/commit: unreadable completion is not a failed commit", () => {
  const run = async (thrown: unknown) => {
    const a = await build(
      svc({
        selfPreapproval: {
          executeSelfPreapproval: vi.fn().mockRejectedValue(thrown),
        } as never,
      })
    );
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/preapproval/self/commit",
      payload: {
        party: "merchant::1220aabbcc",
        preparedTransaction: "pt",
        partySignatures: { signatures: [{ party: "merchant::1220aabbcc" }] },
      },
    });
    await a.close();
    return r;
  };

  it("answers 503 outcome-unknown when the service could not read the completion", async () => {
    const r = await run(
      new SubmissionOutcomeUnknownError(
        Object.assign(new Error("no completion within timeout"), { code: "INVALID_RESPONSE" })
      )
    );
    expect(r.statusCode).toBe(503);
    const b = r.json() as { error: string; detail: string };
    expect(b.error).toBe("submission_outcome_unknown");
    expect(b.detail).toContain("do NOT resubmit");
  });

  it("keeps 5xx-as-failure for every other error — the participant DID answer", async () => {
    // The discriminator against over-correcting: if everything became 503 the
    // merchant could never learn their preapproval was definitively refused.
    const r = await run(new Error("interactive submission rejected: bad"));
    expect(r.statusCode).toBe(502);
    expect((r.json() as { error: string }).error).not.toBe("submission_outcome_unknown");
  });
});

describe("accepting a registry token asks that token's registry", () => {
  // The asymmetry this closes: resolve/transfer-factory already routed OUTBOUND
  // by instrumentAdmin, while resolve/accept always asked the SV Scan. A wallet
  // could therefore SEND a registry token and not ACCEPT one — the choice
  // context for a USDCx instruction does not live on the SV Scan.
  const USDCX_ADMIN = "usdcx-admin::1220";
  const REG = "https://registry.example";

  it("routes to the per-registrar path when the admin is a configured registry", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(String(u));
        return {
          ok: true,
          status: 200,
          json: async () => ({ choiceContextData: { a: 1 }, disclosedContracts: [] }),
        } as never;
      })
    );
    const a = await build(svc({ tokenRegistries: { [USDCX_ADMIN]: REG } }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/resolve/accept",
      payload: { instructionCid: "00abc", instrumentAdmin: USDCX_ADMIN },
    });
    expect(r.statusCode).toBe(200);
    expect(seen.some((u) => u.startsWith(REG))).toBe(true);
    expect(seen.some((u) => u.includes("/choice-contexts/accept"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("an admin that is not a configured registry (the DSO on every Amulet row) falls through to the SV Scan — never a 400", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(String(u));
        return { ok: true, status: 200, json: async () => ({ choiceContextData: { scan: 1 }, disclosedContracts: [] }) } as never;
      })
    );
    const a = await build(svc({ tokenRegistries: { [USDCX_ADMIN]: REG } }));
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/resolve/accept",
      payload: { instructionCid: "00abc", instrumentAdmin: "DSO::1220dso" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ choiceContextData: { scan: 1 }, disclosedContracts: [] });
    expect(seen.some((u) => u.startsWith(REG))).toBe(false);
    expect(seen.some((u) => u.startsWith("http://scan.test") && u.includes("/choice-contexts/accept"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("without an instrumentAdmin nothing changes — Amulet still goes to the SV Scan", async () => {
    // The discriminator against over-correcting: every existing caller omits
    // the field and must keep its behaviour exactly.
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        seen.push(String(u));
        return { ok: true, status: 200, json: async () => ({ choiceContextData: {}, disclosedContracts: [] }) } as never;
      })
    );
    const a = await build(svc({ tokenRegistries: { [USDCX_ADMIN]: REG } }));
    await a.inject({
      method: "POST",
      url: "/v1/wallet/resolve/accept",
      payload: { instructionCid: "00abc" },
    });
    expect(seen.some((u) => u.startsWith(REG))).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("GET /v1/wallet/:party/holdings — the read that sees every instrument", () => {
  // /balance enumerates the Amulet TEMPLATE, so a wallet holding USDCx could pay
  // with it and not see it. This route reads the HoldingV1 INTERFACE, which the
  // token standard guarantees for every CIP-56 token.
  const P = "agent::1220a";
  const USDCX = "usdcx-admin::1220";
  const DSO = "DSO::1220d";
  const iv = (owner: string, admin: string, id: string, amount: string, lock: unknown = null) => ({
    interfaceId: "#pkg:Splice.Api.Token.HoldingV1:Holding",
    viewValue: { owner, instrumentId: { admin, id }, amount, lock },
  });
  const events = [
    { contractId: "cc-1", interfaceViews: [iv(P, DSO, "Amulet", "0.5000000000")] },
    { contractId: "us-1", interfaceViews: [iv(P, USDCX, "USDCx", "0.0300000000")] },
    { contractId: "us-2", interfaceViews: [iv(P, USDCX, "USDCx", "0.0200000000")] },
    { contractId: "us-L", interfaceViews: [iv(P, USDCX, "USDCx", "1.0000000000", { holders: [] })] },
    { contractId: "other", interfaceViews: [iv("someone::1220x", USDCX, "USDCx", "9.0000000000")] },
  ];
  function appWith() {
    const s = svc({});
    (s.client as { queryActiveContracts: unknown }).queryActiveContracts = vi.fn(async () => events);
    return build(s);
  }

  it("lists every instrument the party owns, grouped, with totals", async () => {
    const a = await appWith();
    const r = await a.inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(P)}/holdings` });
    expect(r.statusCode).toBe(200);
    const ins = r.json().instruments as Array<{ id: string; total: string; holdings: unknown[] }>;
    const usdcx = ins.find((i) => i.id === "USDCx")!;
    // 0.03 + 0.02 + the locked 1.0 — locked is LISTED (it is owned) but flagged.
    expect(usdcx.total).toBe("1.0500000000");
    expect(usdcx.holdings).toHaveLength(3);
    expect(ins.find((i) => i.id === "Amulet")!.total).toBe("0.5000000000");
    // Someone else's holding never appears under this party.
    expect(JSON.stringify(r.json())).not.toContain("9.0000000000");
  });

  it("narrows to one instrument with ?admin=&id=, and marks locked ones", async () => {
    const a = await appWith();
    const r = await a.inject({
      method: "GET",
      url: `/v1/wallet/${encodeURIComponent(P)}/holdings?admin=${encodeURIComponent(USDCX)}&id=USDCx`,
    });
    const ins = r.json().instruments as Array<{ id: string; holdings: Array<{ cid: string; locked: boolean }> }>;
    expect(ins).toHaveLength(1);
    expect(ins[0]!.holdings.find((h) => h.cid === "us-L")!.locked).toBe(true);
    expect(ins[0]!.holdings.find((h) => h.cid === "us-1")!.locked).toBe(false);
  });

  it("refuses half an instrument — admin without id, or id without admin", async () => {
    const a = await appWith();
    const r = await a.inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(P)}/holdings?admin=${encodeURIComponent(USDCX)}` });
    expect(r.statusCode).toBe(400);
  });
});


describe("/pending lists registry-token rows only when asked (?registry=1)", () => {
  const DSO = "DSO::1220dso";
  const USDCX_ADMIN = "usdcx-admin::1220";
  const TI = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";
  const view = (admin: string, id: string, amount: string, sender: string) => ({
    interfaceId: TI,
    viewValue: {
      transfer: { sender, receiver: "agent::12201", amount, instrumentId: { admin, id }, executeBefore: "2099-01-01T00:00:00Z" },
      status: { tag: "TransferPendingReceiverAcceptance" },
    },
  });
  const events = [
    { contractId: "cc-1", templateId: "#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction", createArgument: {}, interfaceViews: [view(DSO, "Amulet", "1.0000000000", "faucet::1220f")], signatories: [], observers: [], packageName: "p" },
    { contractId: "usdcx-1", templateId: "#utility-registry-app-v0:Utility.Registry.App.V0.Model.Transfer:TransferOffer", createArgument: {}, interfaceViews: [view(USDCX_ADMIN, "USDCx", "0.0100000000", "merchant::1220m")], signatories: [], observers: [], packageName: "p" },
    { contractId: "other", templateId: "#x:Other:TransferOffer", createArgument: {}, interfaceViews: [{ interfaceId: TI, viewValue: { transfer: { sender: "s", receiver: "someone-else::1", amount: "9", instrumentId: { admin: USDCX_ADMIN, id: "USDCx" } } } }], signatories: [], observers: [], packageName: "p" },
    // A registrar that names its token "Amulet": the id is the row's own label and
    // must not promote it into the Canton Coin class.
    { contractId: "fake-amulet", templateId: "#utility-registry-app-v0:Utility.Registry.App.V0.Model.Transfer:TransferOffer", createArgument: {}, interfaceViews: [view("attacker::1220bad", "Amulet", "999.0000000000", "s::1220s")], signatories: [], observers: [], packageName: "p" },
    // A registry template with no interface view at all: not Canton Coin either.
    { contractId: "noview", templateId: "#utility-registry-app-v0:Utility.Registry.App.V0.Model.Transfer:TransferOffer", createArgument: { transfer: { sender: "s::1220s", receiver: "agent::12201", amount: "42.0" } }, interfaceViews: [], signatories: [], observers: [], packageName: "p" },
    // The pre-registry shape: Amulet instruction template, no view (older participant) — still Canton Coin.
    { contractId: "cc-noview", templateId: "#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction", createArgument: { transfer: { sender: "faucet::1220f", receiver: "agent::12201", amount: "2.0000000000" } }, interfaceViews: [], signatories: [], observers: [], packageName: "p" },
  ];
  const withEvents = (tokenRegistries: Record<string, string> = { [USDCX_ADMIN]: "https://registry.example" }) =>
    svc({ client: { ...mockClient(), queryActiveContracts: vi.fn(async () => events) } as never, tokenRegistries });

  it("without the flag: Canton Coin rows only — the shape a pre-registry client relies on — still carrying its instrumentId", async () => {
    const a = await build(withEvents());
    const r = await a.inject({ method: "GET", url: "/v1/wallet/agent::12201/pending" });
    expect(r.statusCode).toBe(200);
    expect(r.json().pending).toEqual([
      { cid: "cc-1", amount: "1.0000000000", sender: "faucet::1220f", instrumentId: { admin: DSO, id: "Amulet" }, executeBefore: "2099-01-01T00:00:00Z" },
      { cid: "cc-noview", amount: "2.0000000000", sender: "faucet::1220f" },
    ]);
  });

  it("with ?registry=1: registry rows too, each naming its instrument; rows for another receiver are never listed", async () => {
    const a = await build(withEvents());
    const r = await a.inject({ method: "GET", url: "/v1/wallet/agent::12201/pending?registry=1" });
    expect(r.statusCode).toBe(200);
    expect(r.json().pending.map((p: { cid: string }) => p.cid)).toEqual(["cc-1", "usdcx-1", "cc-noview"]);
    expect(r.json().pending[1]).toMatchObject({ instrumentId: { admin: USDCX_ADMIN, id: "USDCx" }, amount: "0.0100000000" });
  });

  it("a registrar naming its token \"Amulet\", or a registry template with no view, is never promoted into the Canton Coin class", async () => {
    const a = await build(withEvents({ "attacker::1220bad": "https://evil.example" }));
    const plain = await a.inject({ method: "GET", url: "/v1/wallet/agent::12201/pending" });
    expect(plain.json().pending.map((p: { cid: string }) => p.cid)).toEqual(["cc-1", "cc-noview"]);
    const flagged = await a.inject({ method: "GET", url: "/v1/wallet/agent::12201/pending?registry=1" });
    // Listed as a REGISTRY row (its registrar is configured here) — never as Canton Coin.
    expect(flagged.json().pending.map((p: { cid: string }) => p.cid)).toEqual(["cc-1", "fake-amulet", "cc-noview"]);
  });

  it("with ?registry=1 but the registrar NOT configured: the row is withheld — this facilitator could not route its accept anyway", async () => {
    const a = await build(withEvents({}));
    const r = await a.inject({ method: "GET", url: "/v1/wallet/agent::12201/pending?registry=1" });
    expect(r.statusCode).toBe(200);
    expect(r.json().pending.map((p: { cid: string }) => p.cid)).toEqual(["cc-1", "cc-noview"]);
  });
});
