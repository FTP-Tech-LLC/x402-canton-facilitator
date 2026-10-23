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

  it("a DAML_FAILURE from the ledger is the caller's problem → 409 ledger_refused, not 502", async () => {
    // 2026-09-07: a merchant's TransferPreapproval lapsed and every pay/prepare
    // to it came back as our 502 + level:50, so clients retried the unretryable
    // and our own error metric lit for someone else's expiry.
    const refused = Object.assign(new Error("POST /v2/interactive-submission/prepare returned HTTP 400"), {
      code: "HTTP_ERROR",
      status: 400,
      responseBody: JSON.stringify({
        code: "DAML_FAILURE",
        cause: "Interpretation error: Error: User failure: stdlib.daml.com/deadline-exceeded (error category 9): Ledger time is at or past deadline 'TransferPreapproval.expiresAt'",
      }),
    });
    const s = svc({ client: mockClient({ allocateExternalParty: vi.fn().mockRejectedValue(refused) }) as never });
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: { onboardingTransactions: ["tx1"], multiHashSignatures: [{ format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" }] } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("ledger_refused");
    expect(r.json().detail).toContain("deadline-exceeded");
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

  // Past validation it walks into the real Scan retry backoff (~3 s against an
  // unreachable host), which timed out at the 5 s default on a busy CI runner.
  it("does NOT reject a valid venueMeta on venue grounds (proceeds past validation)", { timeout: 20_000 }, async () => {
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

  describe("starter grant at onboarding (faucet.onOnboard)", () => {
    const NEW_PARTY = "agent::1220abcd5678";
    const grantClient = (submit: ReturnType<typeof vi.fn>) =>
      mockClient({
        submitAndWaitForTransaction: submit,
        allocateExternalParty: vi.fn().mockResolvedValue({ partyId: NEW_PARTY }),
      }) as never;
    const finalize = (a: Awaited<ReturnType<typeof build>>) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/onboard/finalize",
        payload: {
          onboardingTransactions: ["tx1"],
          multiHashSignatures: [{ format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" }],
        },
      });
    const receiverOf = (submit: ReturnType<typeof vi.fn>, call = 0) =>
      (submit.mock.calls[call]![0] as {
        commands: Array<{ ExerciseCommand: { choiceArgument: { transfer: { receiver: string; amount: string } } } }>;
      }).commands[0]!.ExerciseCommand.choiceArgument.transfer;
    const unknownInformees = () =>
      Object.assign(
        new Error("HTTP 400: UNKNOWN_INFORMEES(11,abc): The participant is not connected to informees"),
        { code: "HTTP_ERROR", status: 400 }
      );

    it("pays the new party one grant in the background and says so in the answer", async () => {
      stubScanFetch();
      const store = createInMemoryFaucetStore();
      const submit = vi.fn().mockResolvedValue({ updateId: "u-grant", offset: 1, events: [] });
      const a = await build(
        faucetSvc({
          client: grantClient(submit),
          faucet: faucetConf({ store, amountCc: "1", dailyBudgetCc: "10", onOnboard: true }),
        })
      );
      const r = await finalize(a);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ party: NEW_PARTY, starterGrant: { status: "scheduled", amountCc: "1" } });
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      expect(receiverOf(submit)).toMatchObject({ receiver: NEW_PARTY, amount: "1" });
      // It is the party's one faucet claim: the faucet route now refuses it.
      await vi.waitFor(async () => expect(await store.hasClaimed(NEW_PARTY)).toBe(true));
      const again = await a.inject({ method: "POST", url: "/v1/wallet/faucet/claim", payload: { party: NEW_PARTY } });
      expect(again.statusCode).toBe(429);
      expect(submit).toHaveBeenCalledTimes(1);
      await a.close();
    });

    it("is off unless asked for: the answer and the ledger are untouched", async () => {
      stubScanFetch();
      const submit = vi.fn().mockResolvedValue({ updateId: "u-grant", offset: 1, events: [] });
      const a = await build(
        faucetSvc({ client: grantClient(submit) })
      );
      const r = await finalize(a);
      expect(r.json()).toEqual({ party: NEW_PARTY });
      await new Promise((res) => setTimeout(res, 20));
      expect(submit).not.toHaveBeenCalled();
      await a.close();
    });

    it("waits out UNKNOWN_INFORMEES while the new party reaches the synchronizer", async () => {
      stubScanFetch();
      const store = createInMemoryFaucetStore();
      const submit = vi
        .fn()
        .mockRejectedValueOnce(unknownInformees())
        .mockRejectedValueOnce(unknownInformees())
        .mockResolvedValue({ updateId: "u-grant", offset: 1, events: [] });
      const a = await build(
        faucetSvc({
          client: grantClient(submit),
          faucet: faucetConf({ store, amountCc: "1", dailyBudgetCc: "10", onOnboard: true, propagationRetryMs: 1 }),
        })
      );
      await finalize(a);
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
      await vi.waitFor(async () => expect(await store.hasClaimed(NEW_PARTY)).toBe(true));
      await a.close();
    });

    it("gives up after the retries and hands the reservation back (nothing moved)", async () => {
      stubScanFetch();
      const store = createInMemoryFaucetStore();
      const submit = vi.fn().mockRejectedValue(unknownInformees());
      const a = await build(
        faucetSvc({
          client: grantClient(submit),
          faucet: faucetConf({ store, amountCc: "1", dailyBudgetCc: "10", onOnboard: true, propagationRetryMs: 1 }),
        })
      );
      await finalize(a);
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(9)); // 1 + 8 retries
      await vi.waitFor(async () => expect(await store.hasClaimed(NEW_PARTY)).toBe(false));
      await new Promise((res) => setTimeout(res, 20));
      expect(submit).toHaveBeenCalledTimes(9); // and then it stops
      await a.close();
    });

    it("the faucet route itself does not wait on UNKNOWN_INFORMEES", async () => {
      stubScanFetch();
      const store = createInMemoryFaucetStore();
      const submit = vi.fn().mockRejectedValue(unknownInformees());
      const a = await build(
        faucetSvc({
          client: grantClient(submit),
          faucet: faucetConf({ store, propagationRetryMs: 1 }),
        })
      );
      const r = await a.inject({ method: "POST", url: "/v1/wallet/faucet/claim", payload: { party: "agent::1220cafe1234" } });
      expect(r.statusCode).toBe(502);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(await store.hasClaimed("agent::1220cafe1234")).toBe(false);
      await a.close();
    });

    it("a budget refusal never fails the onboarding, and no grant is promised", async () => {
      stubScanFetch();
      const submit = vi.fn().mockResolvedValue({ updateId: "u-grant", offset: 1, events: [] });
      const a = await build(
        faucetSvc({
          client: grantClient(submit),
          faucet: faucetConf({ amountCc: "1", dailyBudgetCc: "0.5", onOnboard: true }),
        })
      );
      const r = await finalize(a);
      expect(r.statusCode).toBe(200);
      // Reserved before the answer: a client told "scheduled" would wait for a
      // grant the budget already refused.
      expect(r.json()).toEqual({ party: NEW_PARTY });
      await new Promise((res) => setTimeout(res, 20));
      expect(submit).not.toHaveBeenCalled();
      await a.close();
    });

    it("a party that already had its grant is not promised another", async () => {
      stubScanFetch();
      const store = createInMemoryFaucetStore();
      await store.tryClaim({
        party: NEW_PARTY, ip: "1.2.3.4", amountCc: "1", nowMs: Date.now(),
        windowMs: 86_400_000, dailyBudgetCc: "10", lifetimeCapCc: "25",
      });
      const submit = vi.fn().mockResolvedValue({ updateId: "u-grant", offset: 1, events: [] });
      const a = await build(
        faucetSvc({
          client: grantClient(submit),
          faucet: faucetConf({ store, amountCc: "1", dailyBudgetCc: "10", onOnboard: true }),
        })
      );
      const r = await finalize(a);
      expect(r.json()).toEqual({ party: NEW_PARTY });
      await new Promise((res) => setTimeout(res, 20));
      expect(submit).not.toHaveBeenCalled();
      await a.close();
    });

    it("a store error never fails the onboarding either", async () => {
      stubScanFetch();
      const store: FaucetClaimStore = {
        hasClaimed: vi.fn().mockResolvedValue(false),
        tryClaim: vi.fn().mockRejectedValue(new Error("db down")),
        tryReserve: vi.fn(),
        markPaid: vi.fn(),
        release: vi.fn(),
        sumSince: vi.fn(),
      };
      const submit = vi.fn();
      const a = await build(
        faucetSvc({
          client: grantClient(submit),
          faucet: faucetConf({ store, amountCc: "1", onOnboard: true }),
        })
      );
      const r = await finalize(a);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ party: NEW_PARTY });
      expect(store.tryClaim).toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      await a.close();
    });
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
      .toBe("CreateCommand M:T");
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

  /** `hosted`: what the participant says when asked whether it hosts the
   *  party (GET /v2/parties/{party}); "unknown" = that lookup fails. */
  async function app(hosted: boolean | "unknown" = true) {
    const getPartyDetails = vi.fn(async (party: string) => {
      if (hosted === "unknown") throw Object.assign(new Error("HTTP 503"), { code: "HTTP_ERROR", status: 503 });
      return hosted ? { party, isLocal: true } : undefined;
    });
    const a = await build(
      svc({
        client: mockClient({
          queryActiveContracts: vi.fn().mockRejectedValue(refuse()),
          getTransactionById: vi.fn().mockRejectedValue(refuse()),
          getPartyDetails,
        }) as never,
      })
    );
    return Object.assign(a, { getPartyDetails });
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

  it("a party this participant does not host is never our outage, however many a caller asks about", async () => {
    // A caller sweeping parties that live elsewhere used to fill the distinct-
    // party count and flip every refusal to 502 + "read rights broken". The
    // participant says whether it hosts a party; one it does not host cannot
    // be ours to read.
    const a = await app(false);
    for (let i = 0; i < 12; i++) {
      const r = await bal(a, `agent::1220stranger${i}`);
      expect(r.statusCode).toBe(404);
      expect((r.json() as { error: string }).error).toMatch(/not readable/);
    }
    await a.close();
  });

  it.each([
    ["pending", "/pending"],
    ["tx-amulets", "/tx-amulets?updateId=1220abc"],
  ])("/%s attributes a refusal to its party too (it answered 502 + an error line before)", async (_name, suffix) => {
    const a = await app(false);
    const r = await a.inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent("agent::1220elsewhere")}${suffix}` });
    expect(r.statusCode).toBe(404);
    await a.close();
  });

  it("asks the participant once per party, not once per request", async () => {
    const a = await app(false);
    for (let i = 0; i < 5; i++) await bal(a, "agent::1220sweptagain");
    expect(a.getPartyDetails).toHaveBeenCalledTimes(1);
    await a.close();
  });

  it("when the participant cannot say whether it hosts the party, the refusal still counts", async () => {
    // "Could not tell" is not proof the party is a stranger: a broken lookup
    // must not hide a broken read right.
    const a = await app("unknown");
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await bal(a, `agent::1220unsure${i}`)).statusCode);
    expect(codes).toEqual([404, 404, 404, 502]);
    await a.close();
  });

  it("escalates to 502 once MANY DISTINCT parties are refused — that is our outage", async () => {
    // The escalation is what stops this trading one blind spot for another. If
    // our own read rights broke, refusals would not stay confined to one party
    // we HOST. Among those, the distinct-party count is the discriminator.
    const a = await app(true);
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

describe("a party whose holdings exceed the participant's element limit is its state, not our outage", () => {
  const tooMany = () =>
    Object.assign(new Error("active-contracts query exceeded the participant's element limit (JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED)"), {
      code: "ACS_LIMIT_EXCEEDED",
    });
  it("our OWN party hitting the cap is our outage: the faucet answers 502, not a 413 blaming the claimant", async () => {
    // The faucet selects inputs from the facilitator's own holdings. If those
    // outgrow the participant's element cap, telling the claimant to merge
    // holdings they do not own would hide a problem that is ours.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ dso_party_id: "DSO::1220cafe" }), { status: 200 })));
    const a = await build(
      svc({
        client: mockClient({ queryActiveContracts: vi.fn().mockRejectedValue(tooMany()) }) as never,
        faucet: {
          store: createInMemoryFaucetStore(),
          amountCc: "0.2",
          maxPerIp: 5,
          dailyBudgetCc: "10",
          lifetimeCapCc: "0",
          windowMs: 86_400_000,
        },
      })
    );
    const r = await a.inject({ method: "POST", url: "/v1/wallet/faucet/claim", payload: { party: "agent::1220cafe1234" } });
    expect(r.statusCode).toBe(502);
    await a.close();
    vi.unstubAllGlobals();
  });

  it.each(["balance", "holdings", "pending"])("/%s answers 413 holdings_exceed_node_limit, like /balance always did", async (route) => {
    const a = await build(svc({ client: mockClient({ queryActiveContracts: vi.fn().mockRejectedValue(tooMany()) }) as never }));
    const r = await a.inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent("agent::1220whale")}/${route}` });
    expect(r.statusCode).toBe(413);
    const body = r.json() as { code: string; party: string; detail: string };
    expect(body.code).toBe("holdings_exceed_node_limit");
    expect(body.party).toBe("agent::1220whale");
    expect(body.detail).toMatch(/merge|consolidate/);
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
 * The per-minute global bounds the burst; the DAILY cap bounds the total. A
 * script pacing just under the minute cap has no daily ceiling and could
 * exhaust the participant's user-rights slots over ~12h, locking onboarding for
 * everyone. This is the absolute stop.
 */
describe("onboard/finalize — daily allocation ceiling", () => {
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

  it("refuses past the daily cap even while the per-minute and per-IP arms have room", async () => {
    const alloc = vi.fn().mockResolvedValue({ partyId: "agent::1220new" });
    const s = svc({
      client: mockClient({ allocateExternalParty: alloc }) as never,
      // Minute + per-IP caps far out of the way: this asserts the DAILY arm.
      submitRateMaxPerKey: 100,
      onboardRateMaxGlobal: 100,
      onboardDailyMax: 2,
    });
    const a = await build(s);
    expect((await finalize(a, "203.0.113.1")).statusCode).toBe(200);
    expect((await finalize(a, "203.0.113.2")).statusCode).toBe(200);
    const third = await finalize(a, "203.0.113.3");
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBe("3600");
    expect((third.json() as { error: string }).error).toBe("onboarding daily limit reached");
    // Refused before the spend — nothing allocated past the cap.
    expect(alloc).toHaveBeenCalledTimes(2);
    await a.close();
  });

  it("a daily cap of 0 disables the daily arm", async () => {
    const alloc = vi.fn().mockResolvedValue({ partyId: "agent::1220new" });
    const s = svc({
      client: mockClient({ allocateExternalParty: alloc }) as never,
      submitRateMaxPerKey: 100,
      onboardRateMaxGlobal: 100,
      onboardDailyMax: 0,
    });
    const a = await build(s);
    for (let i = 0; i < 5; i++) {
      expect((await finalize(a, `192.0.2.${i}`)).statusCode).toBe(200);
    }
    expect(alloc).toHaveBeenCalledTimes(5);
    await a.close();
  });

  it("the per-minute arm refuses first, leaving the daily budget unspent", async () => {
    // Order matters: charging the 24h budget before the 60s one would burn a
    // day-long slot every time the minute cap refuses.
    const alloc = vi.fn().mockResolvedValue({ partyId: "agent::1220new" });
    const s = svc({
      client: mockClient({ allocateExternalParty: alloc }) as never,
      submitRateMaxPerKey: 100,
      onboardRateMaxGlobal: 1,
      onboardDailyMax: 5,
    });
    const a = await build(s);
    expect((await finalize(a, "203.0.113.1")).statusCode).toBe(200);
    // Second call trips the per-MINUTE global (cap 1), with retry-after 60.
    const second = await finalize(a, "203.0.113.2");
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
    expect(alloc).toHaveBeenCalledTimes(1);
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

/**
 * Escalating cooldown: an IP that keeps getting refused on agent-side money
 * routes accrues strikes and is temporarily banned for a growing period. Fed by
 * the routes' own per-IP refusals; NOT applied to /settle (merchant IP).
 */
describe("escalating cooldown for repeat abusers", () => {
  const abuseSvc = () =>
    svc({
      // Per-IP onboarding cap of 1: the 2nd call in a window is refused and
      // counts as a strike. 2 strikes -> ban.
      submitRateMaxPerKey: 1,
      abuseStrikesToBan: 2,
      abuseStrikeWindowMs: 600_000,
      abuseBaseBanMs: 3_600_000,
      abuseBanMultiplier: 2,
      abuseMaxBanMs: 86_400_000,
      // Back-to-back refusals below must each count: spacing is tested separately.
      abuseStrikeSpacingMs: 0,
      client: {
        allocateExternalParty: async () => ({ partyId: "agent::1220new" }),
        grantUserRights: async () => undefined,
      },
    } as never);
  const finalize = (a: ReturnType<typeof Fastify>) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/onboard/finalize",
      payload: {
        onboardingTransactions: ["tx1"],
        multiHashSignatures: [
          { format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" },
        ],
      },
    });

  it("bans an IP after repeated refusals, with a long Retry-After", async () => {
    const a = await build(abuseSvc());
    expect((await finalize(a)).statusCode).toBe(200); // 1st ok
    expect((await finalize(a)).statusCode).toBe(429); // 2nd refused -> strike 1
    expect((await finalize(a)).statusCode).toBe(429); // 3rd refused -> strike 2 -> ban
    const banned = await finalize(a); // 4th: now under the ban itself
    expect(banned.statusCode).toBe(429);
    // The abuse ban Retry-After is hours (baseBanMs), not the 60s soft limit.
    expect(Number(banned.headers["retry-after"])).toBeGreaterThan(600);
    expect((banned.json() as { error: string }).error).toContain("suspended");
    await a.close();
  });

  it("the ban is shared across agent-side routes but spares /settle", async () => {
    const a = await build(abuseSvc());
    // Earn a ban via onboarding.
    await finalize(a);
    await finalize(a);
    await finalize(a);
    // pay/prepare from the same IP is now refused by the cooldown...
    const pay = await a.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { receiver: "m::1220", amount: "1" },
    });
    expect(pay.statusCode).toBe(429);
    expect((pay.json() as { error: string }).error).toContain("suspended");
    await a.close();
  });

  it("a different IP is unaffected by another IP's ban", async () => {
    const a = await build(abuseSvc());
    await finalize(a); // strikes/ban accrue on the default remote address
    await finalize(a);
    await finalize(a);
    const other = await a.inject({
      method: "POST",
      url: "/v1/wallet/onboard/finalize",
      remoteAddress: "203.0.113.77",
      payload: {
        onboardingTransactions: ["tx1"],
        multiHashSignatures: [
          { format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" },
        ],
      },
    });
    expect(other.statusCode).toBe(200);
    await a.close();
  });

  it("abuseStrikesToBan=0 disables the cooldown (only soft limits apply)", async () => {
    const a = await build(
      svc({
        submitRateMaxPerKey: 1,
        abuseStrikesToBan: 0,
        abuseStrikeSpacingMs: 0,
        client: {
          allocateExternalParty: async () => ({ partyId: "agent::1220new" }),
          grantUserRights: async () => undefined,
        },
      } as never)
    );
    expect((await finalize(a)).statusCode).toBe(200);
    // Refused by the soft 60s limit, but never escalates to a ban.
    const soft = await finalize(a);
    expect(soft.statusCode).toBe(429);
    expect(soft.headers["retry-after"]).toBe("60");
    await a.close();
  });
});

/**
 * A client that retries a soft 429 without backoff produces a burst of refusals
 * in one second. With the default 60s strike spacing that burst is ONE strike,
 * so the burst can never escalate into an hours-long suspension on its own.
 */
describe("escalating cooldown — a retry storm is one strike, not a ban", () => {
  it("with the default spacing, back-to-back refusals stay on the soft 60s limit", async () => {
    const a = await build(
      svc({
        submitRateMaxPerKey: 1,
        abuseStrikesToBan: 2,
        abuseStrikeWindowMs: 600_000,
        abuseBaseBanMs: 3_600_000,
        abuseBanMultiplier: 2,
        abuseMaxBanMs: 86_400_000,
        // abuseStrikeSpacingMs deliberately omitted: the route default (60s) applies.
        client: {
          allocateExternalParty: async () => ({ partyId: "agent::1220new" }),
          grantUserRights: async () => undefined,
        },
      } as never)
    );
    const finalize = () =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/onboard/finalize",
        payload: {
          onboardingTransactions: ["tx1"],
          multiHashSignatures: [
            { format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" },
          ],
        },
      });
    expect((await finalize()).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      const r = await finalize();
      expect(r.statusCode).toBe(429);
      // Still the soft limit, never the suspension.
      expect(r.headers["retry-after"]).toBe("60");
    }
    await a.close();
  });
});

/**
 * The submit limiter refuses on EITHER arm, per-party or per-IP. Only the
 * per-IP arm may feed a strike: one wallet exhausting its own budget behind a
 * shared NAT is that wallet's overage, not the host's abuse, and must not
 * suspend every other agent on the address.
 */
describe("escalating cooldown — a per-party refusal is not host abuse", () => {
  const commitSvc = (over: Record<string, unknown> = {}) =>
    svc({
      submitRateMaxPerKey: 1,
      submitRateMaxPerIp: 60,
      abuseStrikesToBan: 1,
      abuseStrikeSpacingMs: 0,
      abuseStrikeWindowMs: 600_000,
      abuseBaseBanMs: 3_600_000,
      abuseBanMultiplier: 2,
      abuseMaxBanMs: 86_400_000,
      selfPreapproval: {
        executeSelfPreapproval: vi.fn().mockResolvedValue({ updateId: "u1" }),
      },
      ...over,
    } as never);
  const commit = (a: ReturnType<typeof Fastify>, party: string, remoteAddress: string) =>
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

  it("one wallet exhausting its own per-party cap never strikes the shared IP", async () => {
    const a = await build(commitSvc());
    const nat = "203.0.113.50";
    const A = "agent::1220aaaaaaaaaaaaaaaa";
    const B = "agent::1220bbbbbbbbbbbbbbbb";
    expect((await commit(a, A, nat)).statusCode).not.toBe(429);
    const refused = await commit(a, A, nat); // A over its own cap, the IP has room
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("60"); // the soft limit, not a ban
    // strikesToBan is 1: had that refusal counted, the NAT would be suspended now.
    expect((await commit(a, B, nat)).statusCode).not.toBe(429);
    await a.close();
  });

  it("exhausting the per-IP arm itself does strike, and the next call is suspended", async () => {
    const a = await build(commitSvc({ submitRateMaxPerKey: 60, submitRateMaxPerIp: 1 }));
    const nat = "203.0.113.51";
    expect((await commit(a, "agent::1220aaaaaaaaaaaaaaaa", nat)).statusCode).not.toBe(429);
    expect((await commit(a, "agent::1220bbbbbbbbbbbbbbbb", nat)).statusCode).toBe(429);
    const banned = await commit(a, "agent::1220cccccccccccccccc", nat);
    expect(banned.statusCode).toBe(429);
    expect((banned.json() as { error: string }).error).toContain("suspended");
    await a.close();
  });
});


describe("wallet relay across two participants (party replication)", () => {
  // `moved::` parties live on the primary (node 2), `old::` ones still only on
  // the secondary (node 1). Each call must reach the participant hosting the
  // party, as our ledger user THERE.
  const OLD = "old::1220abcdef01";
  const MOVED = "moved::1220abcdef02";
  function twoNodes() {
    const primary = mockClient({ queryActiveContracts: vi.fn().mockResolvedValue([]) });
    const secondary = mockClient();
    const router = {
      forParty: vi.fn(async (p: string) =>
        p === OLD ? { client: secondary, userId: "node1-user" } : { client: primary, userId: "node2-user" }
      ),
      hosts: vi.fn(async (p: string) => p === OLD || p === MOVED),
    };
    const s = svc({ client: primary as never, userId: "node2-user", router: router as never });
    return { primary, secondary, router, s };
  }
  const exercise = [
    {
      ExerciseCommand: {
        templateId: "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
        contractId: "00ab",
        choice: "TransferFactory_Transfer",
        choiceArgument: {},
      },
    },
  ];

  it("reads a not-yet-moved party's balance on the secondary", async () => {
    const { primary, secondary, s } = twoNodes();
    const a = await build(s);
    const r = await a.inject({ method: "GET", url: `/v1/wallet/${OLD}/balance` });
    expect(r.statusCode).toBe(200);
    expect(r.json().cc).toBe("7.5000000000");
    expect(secondary.queryActiveContracts).toHaveBeenCalled();
    expect(primary.queryActiveContracts).not.toHaveBeenCalled();
    await a.close();
  });

  it("prepares on the participant hosting the acting party, as our user there", async () => {
    const { primary, secondary, s } = twoNodes();
    const a = await build(s);
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/prepare",
      payload: { commandId: "c", actAs: [OLD], synchronizerId: "", commands: exercise },
    });
    expect(r.statusCode).toBe(200);
    expect(secondary.interactiveSubmissionPrepare).toHaveBeenCalledWith(expect.objectContaining({ userId: "node1-user" }));
    expect(primary.interactiveSubmissionPrepare).not.toHaveBeenCalled();
    await a.close();
  });

  it("executes, and takes the offset, on the signing party's participant", async () => {
    const { primary, secondary, s } = twoNodes();
    const a = await build(s);
    const r = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/execute",
      payload: { preparedTransaction: "pt", partySignatures: { signatures: [{ party: OLD, signatures: [] }] } },
    });
    expect(r.statusCode).toBe(200);
    expect(secondary.getLedgerEnd).toHaveBeenCalled();
    expect(secondary.interactiveSubmissionExecute).toHaveBeenCalled();
    expect(primary.interactiveSubmissionExecute).not.toHaveBeenCalled();
    await a.close();
  });

  it("a moved party goes to the primary", async () => {
    const { primary, secondary, s } = twoNodes();
    const a = await build(s);
    await a.inject({ method: "GET", url: `/v1/wallet/${MOVED}/balance` });
    expect(primary.queryActiveContracts).toHaveBeenCalled();
    expect(secondary.queryActiveContracts).not.toHaveBeenCalled();
    await a.close();
  });

  it("new wallets are onboarded on the primary", async () => {
    const { primary, secondary, s } = twoNodes();
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: pk });
    expect(r.statusCode).toBe(200);
    expect(primary.generateExternalPartyTopology).toHaveBeenCalled();
    expect(secondary.generateExternalPartyTopology).not.toHaveBeenCalled();
    await a.close();
  });

  it("a party hosted on neither participant still gets a 404 for a refused read", async () => {
    const { primary, s } = twoNodes();
    primary.queryActiveContracts = vi.fn().mockRejectedValue(Object.assign(new Error("403"), { code: "HTTP_ERROR", status: 403 }));
    const a = await build(s);
    const r = await a.inject({ method: "GET", url: "/v1/wallet/stranger::1220abcdef03/balance" });
    expect(r.statusCode).toBe(404);
    await a.close();
  });
});

describe("onboarding co-hosted on a second participant", () => {
  const CO_UID = "FTP-validator-2::1220da86";
  const finalize = {
    onboardingTransactions: ["tx1"],
    multiHashSignatures: [{ format: "F", signature: "S", signingAlgorithmSpec: "A", signedBy: "fp1" }],
  };
  function coHosted() {
    const coClient = {
      allocateExternalParty: vi.fn().mockResolvedValue({ partyId: "agent::12201" }),
      grantUserRights: vi.fn().mockResolvedValue(undefined),
    };
    const s = svc({
      onboardCoHost: { participantUid: CO_UID, client: coClient as never, userId: "node2-user", grantRetryMs: 1 },
    });
    return { s, coClient };
  }

  it("prepare asks for both participants confirming, threshold 1 (what the wallet will sign)", async () => {
    const { s } = coHosted();
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: pk });
    expect(r.statusCode).toBe(200);
    expect(s.client.generateExternalPartyTopology).toHaveBeenCalledWith(
      expect.objectContaining({ otherConfirmingParticipantUids: [CO_UID], confirmationThreshold: 1 })
    );
    await a.close();
  });

  it("finalize allocates on both participants and grants our user on each", async () => {
    const { s, coClient } = coHosted();
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: finalize });
    expect(r.statusCode).toBe(200);
    expect(coClient.allocateExternalParty).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingTransactions: [{ transaction: "tx1" }] })
    );
    expect(s.client.allocateExternalParty).toHaveBeenCalled();
    expect(coClient.grantUserRights).toHaveBeenCalledWith("node2-user", "agent::12201");
    expect(s.client.grantUserRights).toHaveBeenCalledWith("facilitator@clients", "agent::12201");
    await a.close();
  });

  it("a rights grant the co-host refuses at first (party not there yet) is retried", async () => {
    const { s, coClient } = coHosted();
    coClient.grantUserRights.mockRejectedValueOnce(new Error("unknown party")).mockResolvedValue(undefined);
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: finalize });
    expect(r.statusCode).toBe(200);
    expect(coClient.grantUserRights).toHaveBeenCalledTimes(2);
    await a.close();
  });

  it("a co-host grant that never succeeds does not fail the onboarding, but is counted", async () => {
    const { s, coClient } = coHosted();
    coClient.grantUserRights.mockRejectedValue(new Error("rights cap"));
    const recordRelayError = vi.fn();
    const a = await build({ ...s, metrics: { recordRelayError } as never });
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: finalize });
    expect(r.statusCode).toBe(200);
    expect(coClient.grantUserRights).toHaveBeenCalledTimes(3);
    expect(recordRelayError).toHaveBeenCalledWith("onboard/finalize:co-host-rights", "server");
    await a.close();
  });

  it("with any-party rights, onboarding grants nothing per party on either participant", async () => {
    const { s, coClient } = coHosted();
    const a = await build({
      ...s,
      grantPartyRights: false,
      onboardCoHost: { ...s.onboardCoHost!, grantPartyRights: false },
    });
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: finalize });
    expect(r.statusCode).toBe(200);
    expect(coClient.allocateExternalParty).toHaveBeenCalled();
    expect(coClient.grantUserRights).not.toHaveBeenCalled();
    expect(s.client.grantUserRights).not.toHaveBeenCalled();
    await a.close();
  });

  it("a co-host that refuses stops the onboarding before the primary does anything", async () => {
    const { s, coClient } = coHosted();
    coClient.allocateExternalParty.mockRejectedValue(new Error("node 2 down"));
    const a = await build(s);
    const r = await a.inject({ method: "POST", url: "/v1/wallet/onboard/finalize", payload: finalize });
    expect(r.statusCode).toBe(502);
    expect(s.client.allocateExternalParty).not.toHaveBeenCalled();
    await a.close();
  });

  it("without a co-host, onboarding is exactly as before", async () => {
    const s = svc();
    const a = await build(s);
    await a.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: pk });
    expect(s.client.generateExternalPartyTopology).toHaveBeenCalledWith(
      expect.not.objectContaining({ otherConfirmingParticipantUids: expect.anything() })
    );
    await a.close();
  });
});

describe("a wallet with more holdings than one participant read lists", () => {
  // The participant refuses an unbounded list past its element cap (413) but
  // serves `?limit=N`. The relay must make such a wallet WORKABLE (a bounded
  // slice, flagged incomplete) without ever passing a prefix off as a balance.
  const P = "agent::1220" + "ab".repeat(32);
  const USDCX = "decentralized-usdc-interchain-rep::12208115" + "ef".repeat(30);
  const REG = { [USDCX]: "https://api.utilities.digitalasset.com" };
  const iv = (amount: string) => ({
    interfaceId: "#pkg:Splice.Api.Token.HoldingV1:Holding",
    viewValue: { owner: P, instrumentId: { admin: USDCX, id: "USDCx" }, amount, lock: null },
  });
  const rows = (n: number, amount: string) =>
    Array.from({ length: n }, (_, i) => ({ contractId: `us-${i}`, interfaceViews: [iv(amount)] }));
  const capped = () =>
    Object.assign(new Error("active-contracts query exceeded the participant's element limit"), {
      code: "ACS_LIMIT_EXCEEDED",
    });
  function appWith(o: {
    plain: () => Promise<unknown[]>;
    slice?: (f: unknown, limit: number) => Promise<{ events: unknown[]; complete: boolean; limit: number }>;
    tokenRegistries?: Record<string, string>;
  }) {
    const s = svc({
      ...(o.tokenRegistries ? { tokenRegistries: o.tokenRegistries } : {}),
      tfPay: { defaultExecuteBeforeSeconds: 120, maxExecuteBeforeSeconds: 300 },
    } as Partial<WalletRelayServices>);
    const c = s.client as Record<string, unknown>;
    c.queryActiveContracts = vi.fn(o.plain);
    if (o.slice) c.queryActiveContractsSlice = vi.fn(o.slice);
    return { app: build(s), client: c };
  }
  const prepare = (amount: string) => ({
    method: "POST" as const,
    url: "/v1/wallet/pay/prepare",
    payload: { party: P, receiver: "merchant::1220" + "cd".repeat(32), amount, instrumentId: { admin: USDCX, id: "USDCx" } },
  });

  it("/holdings without ?slice keeps the old contract: the full list or 413, no `complete` field", async () => {
    const { app } = appWith({ plain: async () => { throw capped(); }, slice: async () => ({ events: [], complete: true, limit: 200 }) });
    const r = await (await app).inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(P)}/holdings` });
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("holdings_exceed_node_limit");
  });

  it("/holdings?slice=1 answers the oldest slice and says it is incomplete", async () => {
    const { app, client } = appWith({
      plain: async () => { throw capped(); },
      slice: async (_f, limit) => ({ events: rows(limit, "0.0100000000"), complete: false, limit }),
    });
    const r = await (await app).inject({
      method: "GET",
      url: `/v1/wallet/${encodeURIComponent(P)}/holdings?admin=${encodeURIComponent(USDCX)}&id=USDCx&slice=1`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().complete).toBe(false);
    expect(r.json().instruments[0].holdings).toHaveLength(200);
    expect(client.queryActiveContracts).not.toHaveBeenCalled();
    expect((client.queryActiveContractsSlice as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(200);
  });

  it("/holdings?slice=1 on a client without the slice capability falls back to the plain read", async () => {
    const { app } = appWith({ plain: async () => rows(3, "1.0000000000") });
    const r = await (await app).inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(P)}/holdings?slice=1` });
    expect(r.statusCode).toBe(200);
    expect(r.json().complete).toBe(true);
  });

  it("pay/prepare on a wallet the plain read refuses, not coverable from the slice → 413 holdings_merge_required (never 'insufficient')", async () => {
    const { app } = appWith({
      tokenRegistries: REG,
      plain: async () => { throw capped(); },
      slice: async (_f, limit) => ({ events: rows(limit, "0.0000000100"), complete: false, limit }),
    });
    const r = await (await app).inject(prepare("1.0000000000"));
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("holdings_merge_required");
    expect(r.json().detail).toContain(`merge --admin ${USDCX} --id USDCx`);
    expect(JSON.stringify(r.json())).not.toMatch(/insufficient/i);
  });

  it("pay/prepare from a SLICE whose amount needs more inputs than one transfer may spend → holdings_merge_required", async () => {
    // 200 × 0.01 = 2.0 visible, but 0.95 needs 95 inputs > the slice cap of 90.
    const { app } = appWith({
      tokenRegistries: REG,
      plain: async () => { throw capped(); },
      slice: async (_f, limit) => ({ events: rows(limit, "0.0100000000"), complete: false, limit }),
    });
    const r = await (await app).inject(prepare("0.9500000000"));
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("holdings_merge_required");
  });

  it("a COMPLETE read keeps the old behaviour: no input cap (95 inputs reach the registry resolve)", async () => {
    const bodies: Array<{ choiceArguments?: { transfer?: { inputHoldingCids?: string[] } } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("stop here", { status: 400 });
    }));
    try {
      const { app } = appWith({ tokenRegistries: REG, plain: async () => rows(100, "0.0100000000") });
      const r = await (await app).inject(prepare("0.9500000000"));
      expect(r.json().code).not.toBe("holdings_merge_required");
      expect(bodies[0]?.choiceArguments?.transfer?.inputHoldingCids).toHaveLength(95);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pay/prepare that IS short on a complete read stays the ordinary 'insufficient holdings' 400", async () => {
    const { app } = appWith({ tokenRegistries: REG, plain: async () => rows(3, "0.0100000000") });
    const r = await (await app).inject(prepare("1.0000000000"));
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/insufficient holdings/);
  });

  it("pay/prepare coverable from the slice sends exactly the covering holdings to the registry resolve", async () => {
    const bodies: Array<{ choiceArguments?: { transfer?: { inputHoldingCids?: string[] } } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("stop here", { status: 400 });
    }));
    try {
      const { app } = appWith({
        tokenRegistries: REG,
        plain: async () => { throw capped(); },
        slice: async (_f, limit) => ({ events: rows(limit, "1.0000000000"), complete: false, limit }),
      });
      await (await app).inject(prepare("2.0000000000"));
      expect(bodies[0]?.choiceArguments?.transfer?.inputHoldingCids).toEqual(["us-0", "us-1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("holdings reads narrowed to the class asked for", () => {
  // The ACS filter is a UNION of template/interface filters: it can name
  // templates but not exclude one. A HoldingV1 read sees every Amulet, so
  // Canton Coin dust fills it; the relay must still answer "is THIS class
  // complete?" — Canton Coin by its own templates, a registry token by its
  // holding template plus per-contract views — never "does the wallet fit".
  afterEach(() => vi.unstubAllGlobals());
  const P = "agent::1220" + "ab".repeat(32);
  const DSO = "DSO::1220cafe";
  const USDCX = "decentralized-usdc-interchain-rep::12208115" + "ef".repeat(30);
  const REG = { [USDCX]: "https://api.utilities.digitalasset.com" };
  const UTILITY_TEMPLATE = "#utility-registry-holding-v0:Utility.Registry.Holding.V0.Holding:Holding";
  const AMULET_TEMPLATES = ["#splice-amulet:Splice.Amulet:Amulet", "#splice-amulet:Splice.Amulet:LockedAmulet"];
  const HOLDING_IFACE = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding";
  const enc = encodeURIComponent;
  const view = (admin: string, id: string, amount: string) => ({
    interfaceId: "pkg:Splice.Api.Token.HoldingV1:Holding",
    viewValue: { owner: P, instrumentId: { admin, id }, amount, lock: null },
  });
  type Ev = { contractId: string; templateId: string; packageName: string; createArgument: Record<string, unknown>; interfaceViews?: unknown[] };
  // Holdings as the HoldingV1 INTERFACE read returns them: with their view.
  const ccInView = (i: number): Ev => ({
    contractId: `cc-${i}`,
    templateId: "amuletpkgid:Splice.Amulet:Amulet",
    packageName: "splice-amulet",
    createArgument: {},
    interfaceViews: [view(DSO, "Amulet", "0.0100000000")],
  });
  const usdcx = (cid: string, amount = "1.0000000000", pkg = "utility-registry-holding-v0"): Ev => ({
    contractId: cid,
    templateId: "utilpkgid:Utility.Registry.Holding.V0.Holding:Holding",
    packageName: pkg,
    createArgument: {},
    interfaceViews: [view(USDCX, "USDCx", amount)],
  });
  // The same holding as a TEMPLATE read returns it: no interface view.
  const bare = (e: Ev): Ev => ({ ...e, interfaceViews: undefined });
  const dust = (n: number): Ev[] => Array.from({ length: n }, (_, i) => ccInView(i));
  type F = { filtersByParty: Record<string, { cumulative: Array<{ identifierFilter: { TemplateFilter?: { value: { templateId: string } } } }> }> };
  const kindOf = (f: unknown): string[] =>
    (f as F).filtersByParty[P]!.cumulative.map((c) => c.identifierFilter.TemplateFilter?.value.templateId ?? "interface");
  // Errors shaped as CantonClient throws them.
  const httpError = (status: number, body: string) =>
    Object.assign(new Error(`HTTP ${status}`), { code: "HTTP_ERROR", status, responseBody: body });
  const timeoutError = () => Object.assign(new Error("aborted after 45000ms"), { code: "TIMEOUT" });

  function appWith(o: {
    read: (templates: string[]) => { events: Ev[]; complete: boolean };
    /** A holding by id: its event, undefined for "not found" (the
     *  participant's 404), or an Error to throw as is. */
    lookup?: (cid: string) => Ev | Error | undefined;
    tokenRegistries?: Record<string, string>;
    noSlice?: boolean;
    plain?: () => Promise<Ev[]>;
  }) {
    const s = svc({
      ...(o.tokenRegistries ? { tokenRegistries: o.tokenRegistries } : {}),
      tfPay: { defaultExecuteBeforeSeconds: 120, maxExecuteBeforeSeconds: 300 },
    } as Partial<WalletRelayServices>);
    const c = s.client as Record<string, unknown>;
    c.queryActiveContracts = vi.fn(
      o.plain ??
        (async () => {
          throw new Error("the plain (unbounded) read must not be used");
        })
    );
    if (!o.noSlice) {
      c.queryActiveContractsSlice = vi.fn(async (f: unknown, limit: number) => ({ ...o.read(kindOf(f)), limit }));
    }
    if (o.lookup) {
      c.getEventsByContractId = vi.fn(async (a: { contractId: string }) => {
        const e = o.lookup!(a.contractId);
        if (e instanceof Error) throw e;
        if (!e) throw httpError(404, "CONTRACT_EVENTS_NOT_FOUND");
        return { created: e, archived: false };
      });
    }
    return { app: build(s), client: c as Record<string, ReturnType<typeof vi.fn>> };
  }
  const get = async (app: ReturnType<typeof build>, query: string) =>
    (await app).inject({ method: "GET", url: `/v1/wallet/${enc(P)}/holdings?${query}` });
  const cidsOf = (r: { json: () => { instruments: Array<{ holdings: Array<{ cid: string }> }> } }) =>
    r.json().instruments.flatMap((i) => i.holdings.map((h) => h.cid));
  const stubDso = () =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ dso_party_id: DSO }), { status: 200 })));

  it("Canton Coin is read by its two templates: complete is about Canton Coin, whatever else the wallet holds", async () => {
    stubDso();
    const amulet = (cid: string, initialAmount: string, owner = P) => ({
      contractId: cid,
      templateId: "amuletpkgid:Splice.Amulet:Amulet",
      packageName: "splice-amulet",
      createArgument: { dso: DSO, owner, amount: { initialAmount } },
    });
    const locked = {
      contractId: "lk",
      templateId: "amuletpkgid:Splice.Amulet:LockedAmulet",
      packageName: "splice-amulet",
      createArgument: { amulet: { dso: DSO, owner: P, amount: { initialAmount: "2.0000000000" } }, lock: { holders: [] } },
    };
    const reads: string[][] = [];
    const { app } = appWith({
      read: (t) => (reads.push(t), { events: [amulet("a1", "1.0000000000"), amulet("a2", "0.5000000000"), locked, amulet("theirs", "9.0000000000", "other::1220")], complete: true }),
    });
    const r = await get(app, `admin=${enc(DSO)}&id=Amulet&slice=1`);
    expect(r.statusCode).toBe(200);
    expect(reads).toEqual([AMULET_TEMPLATES]); // never the HoldingV1 interface
    expect(r.json()).toMatchObject({
      complete: true,
      instruments: [
        {
          admin: DSO,
          id: "Amulet",
          total: "3.5000000000",
          holdings: [
            { cid: "a1", amount: "1.0000000000", locked: false },
            { cid: "a2", amount: "0.5000000000", locked: false },
            { cid: "lk", amount: "2.0000000000", locked: true },
          ],
        },
      ],
    });
  });

  it("a Canton Coin read that comes back full says so", async () => {
    stubDso();
    const { app } = appWith({ read: () => ({ events: [], complete: false }) });
    const r = await get(app, `admin=${enc(DSO)}&id=Amulet&slice=1`);
    expect(r.json().complete).toBe(false);
  });

  it("a registry token behind a full slice of Canton Coin dust: narrowed to the Utility template, views by contract id, COMPLETE", async () => {
    const beyond = [usdcx("us-a"), usdcx("us-b", "2.5000000000")];
    const reads: string[][] = [];
    const { app, client } = appWith({
      tokenRegistries: REG,
      read: (t) => (reads.push(t), t[0] === "interface" ? { events: dust(200), complete: false } : { events: beyond.map(bare), complete: true }),
      lookup: (cid) => beyond.find((e) => e.contractId === cid),
    });
    const r = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r.statusCode).toBe(200);
    expect(reads).toEqual([["interface"], [UTILITY_TEMPLATE]]);
    expect(r.json().complete).toBe(true);
    expect(cidsOf(r)).toEqual(["us-a", "us-b"]);
    expect(r.json().instruments[0].total).toBe("3.5000000000");
    expect(client.getEventsByContractId!.mock.calls.map((c) => c[0])).toEqual([
      { contractId: "us-a", requestingParties: [P], interfaceViews: [HOLDING_IFACE] },
      { contractId: "us-b", requestingParties: [P], interfaceViews: [HOLDING_IFACE] },
    ]);
  });

  it("the template is learned from the token's own holdings in view (package name as the participant reports it), even for an unconfigured registrar", async () => {
    const inView = usdcx("us-0", "1.0000000000", "utility-registry-holding-v0-renamed");
    const fresh = usdcx("us-new", "4.0000000000", "utility-registry-holding-v0-renamed");
    const reads: string[][] = [];
    const { app, client } = appWith({
      read: (t) => (reads.push(t), t[0] === "interface" ? { events: [...dust(199), inView], complete: false } : { events: [bare(inView), bare(fresh)], complete: true }),
      lookup: (cid) => (cid === "us-new" ? fresh : undefined),
    });
    const r = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(reads[1]).toEqual(["#utility-registry-holding-v0-renamed:Utility.Registry.Holding.V0.Holding:Holding"]);
    expect(r.json().complete).toBe(true);
    expect(cidsOf(r).sort()).toEqual(["us-0", "us-new"]);
    // Only the holding the interface slice did not show is looked up.
    expect(client.getEventsByContractId).toHaveBeenCalledTimes(1);
  });

  it("stays incomplete when the registry class itself is past the cap (tokens of one registry share a template)", async () => {
    const beyond = [usdcx("us-a")];
    const { app } = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: beyond.map(bare), complete: false }),
      lookup: (cid) => beyond.find((e) => e.contractId === cid),
    });
    const r = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r.json().complete).toBe(false);
    expect(cidsOf(r)).toEqual(["us-a"]); // what it found is still listed
  });

  it("stays incomplete when more holdings lie beyond the slice than it looks up (90), or a lookup fails", async () => {
    const many = Array.from({ length: 95 }, (_, i) => usdcx(`m-${i}`));
    const capped = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: many.map(bare), complete: true }),
      lookup: (cid) => many.find((e) => e.contractId === cid),
    });
    const r1 = await get(capped.app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(capped.client.getEventsByContractId).toHaveBeenCalledTimes(90);
    expect(r1.json().complete).toBe(false);
    expect(cidsOf(r1)).toHaveLength(90);

    const two = [usdcx("ok"), usdcx("gone")];
    const failing = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: two.map(bare), complete: true }),
      lookup: (cid) => (cid === "ok" ? two[0] : undefined),
    });
    const r2 = await get(failing.app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r2.json().complete).toBe(false);
    expect(cidsOf(r2)).toEqual(["ok"]);
  });

  it("a participant that refuses the template read (package unknown) gets the HoldingV1 slice back, incomplete — not an error", async () => {
    const { app } = appWith({
      tokenRegistries: REG,
      read: (t) => {
        if (t[0] === "interface") return { events: [...dust(199), usdcx("us-0")], complete: false };
        throw Object.assign(new Error("PACKAGE_NAMES_NOT_FOUND"), { status: 400 });
      },
      lookup: () => undefined,
    });
    const r = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r.statusCode).toBe(200);
    expect(r.json().complete).toBe(false);
    expect(cidsOf(r)).toEqual(["us-0"]);
  });

  it("an unconfigured registrar with nothing in view has no template to narrow to: incomplete, no template read", async () => {
    const reads: string[][] = [];
    const { app } = appWith({
      read: (t) => (reads.push(t), { events: dust(200), complete: false }),
      lookup: () => undefined,
    });
    const r = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(reads).toEqual([["interface"]]);
    expect(r.json()).toMatchObject({ complete: false, instruments: [] });
  });

  it("class=registry: every token but Canton Coin, complete about the tokens alone", async () => {
    const inView = Array.from({ length: 50 }, (_, i) => usdcx(`v-${i}`));
    const beyond = [usdcx("b-0"), usdcx("b-1")];
    const reads: string[][] = [];
    const { app } = appWith({
      tokenRegistries: REG,
      read: (t) => (reads.push(t), t[0] === "interface" ? { events: [...dust(150), ...inView], complete: false } : { events: [...inView, ...beyond].map(bare), complete: true }),
      lookup: (cid) => beyond.find((e) => e.contractId === cid),
    });
    const r = await get(app, "class=registry&slice=1");
    expect(r.statusCode).toBe(200);
    expect(reads[1]).toEqual([UTILITY_TEMPLATE]);
    expect(r.json().complete).toBe(true);
    expect(r.json().instruments.map((i: { id: string }) => i.id)).toEqual(["USDCx"]);
    expect(cidsOf(r)).toHaveLength(52);
  });

  it("without class, a full HoldingV1 slice is the answer and stays incomplete (no narrowing for 'everything')", async () => {
    const reads: string[][] = [];
    const { app } = appWith({ tokenRegistries: REG, read: (t) => (reads.push(t), { events: dust(200), complete: false }) });
    const r = await get(app, "slice=1");
    expect(reads).toEqual([["interface"]]);
    expect(r.json().complete).toBe(false);
  });

  it("class=registry without slice filters the plain read; bad class values are refused", async () => {
    const { app } = appWith({ noSlice: true, read: () => ({ events: [], complete: true }), plain: async () => [ccInView(0), usdcx("u")] });
    const r = await get(app, "class=registry");
    expect(r.statusCode).toBe(200);
    expect(cidsOf(r)).toEqual(["u"]);
    expect(r.json().complete).toBeUndefined();
    expect((await get(app, "class=coin")).statusCode).toBe(400);
    expect((await get(app, `class=registry&admin=${enc(USDCX)}&id=USDCx`)).statusCode).toBe(400);
  });

  it("pay/prepare in a registry token from a wallet full of Canton Coin dust spends the narrowed holdings — one bounded read, no plain read", async () => {
    const beyond = [usdcx("us-a", "1.0000000000"), usdcx("us-b", "3.0000000000")];
    const bodies: Array<{ choiceArguments?: { transfer?: { inputHoldingCids?: string[] } } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("stop here", { status: 400 });
    }));
    const { app, client } = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: beyond.map(bare), complete: true }),
      lookup: (cid) => beyond.find((e) => e.contractId === cid),
    });
    const r = await (await app).inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: P, receiver: "merchant::1220" + "cd".repeat(32), amount: "2.0000000000", instrumentId: { admin: USDCX, id: "USDCx" } },
    });
    expect(r.json().code).not.toBe("holdings_merge_required");
    expect(bodies[0]?.choiceArguments?.transfer?.inputHoldingCids).toEqual(["us-b"]);
    expect(client.queryActiveContracts).not.toHaveBeenCalled();
  });

  it("pay/prepare in Canton Coin: ONE bounded read of the Amulet template — never the plain read first", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      urls.push(String(u));
      if (String(u).includes("/dso-party-id")) return new Response(JSON.stringify({ dso_party_id: DSO }), { status: 200 });
      return new Response("stop here", { status: 400 });
    }));
    const reads: string[][] = [];
    const coin = (cid: string, initialAmount: string) => ({ contractId: cid, templateId: "amuletpkgid:Splice.Amulet:Amulet", packageName: "splice-amulet", createArgument: { dso: DSO, owner: P, amount: { initialAmount } } });
    const { app, client } = appWith({ read: (t) => (reads.push(t), { events: [coin("c1", "5.0000000000")], complete: true }) });
    await (await app).inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: P, receiver: "merchant::1220" + "cd".repeat(32), amount: "1.0000000000" },
    });
    expect(reads).toEqual([["#splice-amulet:Splice.Amulet:Amulet"]]);
    expect(client.queryActiveContractsSlice).toHaveBeenCalledTimes(1);
    expect(client.queryActiveContracts).not.toHaveBeenCalled();
    expect(urls.some((u) => u.includes("transfer-factory"))).toBe(true); // selection passed, resolve attempted
  });

  it("a by-id lookup that comes back WITHOUT a HoldingV1 view is not 'found': the answer is incomplete, never a short total marked complete", async () => {
    const beyond = [usdcx("us-a"), usdcx("us-b", "2.5000000000")];
    const { app } = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: beyond.map(bare), complete: true }),
      // us-b is live, but the participant hands it back with no view.
      lookup: (cid) => (cid === "us-b" ? bare(beyond[1]!) : beyond.find((e) => e.contractId === cid)),
    });
    const r = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r.statusCode).toBe(200);
    expect(r.json().complete).toBe(false);
    expect(cidsOf(r)).toEqual(["us-a"]);
  });

  it("class=registry with ANOTHER registry's holding in view still reads the Utility template: configured-registrar tokens beyond the slice are listed", async () => {
    const zView = {
      contractId: "z-0",
      templateId: "zpkgid:Z.Token:Holding",
      packageName: "z-token",
      createArgument: {},
      interfaceViews: [view("ztk-admin::1220" + "aa".repeat(32), "ZTK", "5.0000000000")],
    };
    const beyond = [usdcx("us-a"), usdcx("us-b", "2.5000000000")];
    const reads: string[][] = [];
    const { app } = appWith({
      tokenRegistries: REG,
      read: (t) => {
        reads.push(t);
        if (t[0] === "interface") return { events: [...dust(199), zView], complete: false };
        const evs: Ev[] = [];
        if (t.includes("#z-token:Z.Token:Holding")) evs.push(bare(zView));
        if (t.includes(UTILITY_TEMPLATE)) evs.push(...beyond.map(bare));
        return { events: evs, complete: true };
      },
      lookup: (cid) => beyond.find((e) => e.contractId === cid),
    });
    const r = await get(app, "class=registry&slice=1");
    expect(r.statusCode).toBe(200);
    expect([...reads[1]!].sort()).toEqual(["#z-token:Z.Token:Holding", UTILITY_TEMPLATE].sort());
    expect(r.json().complete).toBe(true);
    const totals = Object.fromEntries(r.json().instruments.map((i: { id: string; total: string }) => [i.id, i.total]));
    expect(totals).toEqual({ ZTK: "5.0000000000", USDCx: "3.5000000000" });
  });

  it("a holding spent between the interface read and the template read is not counted next to its change", async () => {
    // The interface read (earlier) shows us-old; a payment then spends it and
    // creates us-change, which the template read (later) lists instead.
    const old = usdcx("us-old", "10.0000000000");
    const change = usdcx("us-change", "7.0000000000");
    const { app } = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: [...dust(199), old], complete: false } : { events: [bare(change)], complete: true }),
      lookup: (cid) => (cid === "us-change" ? change : undefined),
    });
    const r = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r.json().complete).toBe(true);
    expect(cidsOf(r)).toEqual(["us-change"]);
    expect(r.json().instruments[0].total).toBe("7.0000000000");
  });

  it("a timeout or 5xx in the narrowed read is a 502 (retryable), not an incomplete answer; a 'not found' lookup is", async () => {
    const beyond = [usdcx("us-a")];
    const templateFails = (err: Error) =>
      appWith({
        tokenRegistries: REG,
        read: (t) => {
          if (t[0] === "interface") return { events: dust(200), complete: false };
          throw err;
        },
        lookup: (cid) => beyond.find((e) => e.contractId === cid),
      }).app;
    expect((await get(templateFails(timeoutError()), `admin=${enc(USDCX)}&id=USDCx&slice=1`)).statusCode).toBe(502);
    expect((await get(templateFails(httpError(503, "unavailable")), `admin=${enc(USDCX)}&id=USDCx&slice=1`)).statusCode).toBe(502);

    const lookupFails = (err: Error | undefined) =>
      appWith({
        tokenRegistries: REG,
        read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: beyond.map(bare), complete: true }),
        lookup: () => err,
      }).app;
    expect((await get(lookupFails(timeoutError()), `admin=${enc(USDCX)}&id=USDCx&slice=1`)).statusCode).toBe(502);
    const notFound = await get(lookupFails(undefined), `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(notFound.statusCode).toBe(200);
    expect(notFound.json().complete).toBe(false);
  });

  it("pay/prepare whose by-id lookup times out answers 502 — never holdings_merge_required charged to the payer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stop here", { status: 400 })));
    const beyond = [usdcx("us-a", "5.0000000000")];
    const { app } = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: beyond.map(bare), complete: true }),
      lookup: () => timeoutError(),
    });
    const r = await (await app).inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: P, receiver: "merchant::1220" + "cd".repeat(32), amount: "2.0000000000", instrumentId: { admin: USDCX, id: "USDCx" } },
    });
    expect(r.statusCode).toBe(502);
    expect(r.json().code).not.toBe("holdings_merge_required");
  });

  it("a holding's view is fetched by id once: a repeated read (a swap's poll, a caller looping) does not look it up again", async () => {
    const beyond = [usdcx("us-a"), usdcx("us-b", "2.5000000000")];
    let extra: Ev[] = [];
    const { app, client } = appWith({
      tokenRegistries: REG,
      read: (t) => (t[0] === "interface" ? { events: dust(200), complete: false } : { events: [...beyond, ...extra].map(bare), complete: true }),
      lookup: (cid) => [...beyond, ...extra].find((e) => e.contractId === cid),
    });
    const r1 = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r1.json().instruments[0].total).toBe("3.5000000000");
    expect(client.getEventsByContractId).toHaveBeenCalledTimes(2);
    extra = [usdcx("us-new", "1.0000000000")];
    const r2 = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r2.json()).toMatchObject({ complete: true, instruments: [{ total: "4.5000000000" }] });
    // Only the new holding is looked up; liveness still comes from the template read.
    expect(client.getEventsByContractId).toHaveBeenCalledTimes(3);
    expect(client.getEventsByContractId!.mock.calls[2]![0]).toMatchObject({ contractId: "us-new" });
    extra = [];
    const r3 = await get(app, `admin=${enc(USDCX)}&id=USDCx&slice=1`);
    expect(r3.json().instruments[0].total).toBe("3.5000000000"); // us-new gone from the template read: gone from the answer
    expect(client.getEventsByContractId).toHaveBeenCalledTimes(3);
  });
});

describe("Tradecraft queued mode relay surface", () => {
  afterEach(() => vi.unstubAllGlobals());
  const WR = "TC.V4.Settle.WithdrawalRequest:SettlementWithdrawalRequest";
  const create = (templateId: unknown) => ({ CreateCommand: { templateId, createArguments: {} } });

  it("creates only an allowlisted template, whatever package names it", () => {
    expect(deniedChoice([create(`#canton-swap-amm-vault:${WR}`)], ["X"], [WR])).toBeUndefined();
    expect(deniedChoice([create(`97571dd8:${WR}`)], ["X"], [WR])).toBeUndefined();
    expect(deniedChoice([create("#p:Evil:Contract")], ["X"], [WR])).toBe("CreateCommand Evil:Contract");
    // A create list never widens the choice list, and vice versa.
    expect(deniedChoice([create(`#p:${WR}`)], [WR])).toBe(`CreateCommand ${WR}`);
    expect(deniedChoice([create(42)], ["X"], [WR])).toBe("(create without a templateId)");
    expect(deniedChoice([create("NoColon")], ["X"], [WR])).toBe("CreateCommand NoColon");
  });

  it("submit/prepare forwards an allowlisted create and refuses another", async () => {
    const s = svc({ walletSubmitChoices: ["TransferFactory_Transfer"], walletSubmitCreateTemplates: [WR] });
    const a = await build(s);
    const ok = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/prepare",
      payload: { commands: [create(`#canton-swap-amm-vault:${WR}`)], actAs: ["agent::1220a"] },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/prepare",
      payload: { commands: [create("#p:Other:Thing")], actAs: ["agent::1220a"] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("choice_not_allowed");
  });

  describe("GET /v1/wallet/:party/contracts", () => {
    const P = "agent::1220a";
    const BATCHER = "#canton-swap-amm-vault:TC.V4.OrderBatch:SwapOrderBatcher";
    const ALLOC = "#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:Allocation";
    const ev = { contractId: "b1", templateId: "pkg:TC.V4.OrderBatch:SwapOrderBatcher", createArgument: { actor: P }, signatories: ["v"], observers: [], packageName: "x" };
    function appWith(ids: string[] | undefined) {
      const q = vi.fn(async () => [ev]);
      const s = svc({ walletReadIds: ids });
      (s.client as { queryActiveContracts: unknown }).queryActiveContracts = q;
      return { q, app: build(s) };
    }

    it("is off unless the operator lists ids", async () => {
      const { app } = appWith(undefined);
      const r = await (await app).inject({ method: "GET", url: `/v1/wallet/${P}/contracts?templateId=${encodeURIComponent(BATCHER)}` });
      expect(r.statusCode).toBe(404);
    });

    it("lists an allowlisted template with a TemplateFilter", async () => {
      const { app, q } = appWith([BATCHER, ALLOC]);
      const r = await (await app).inject({ method: "GET", url: `/v1/wallet/${P}/contracts?templateId=${encodeURIComponent(BATCHER)}` });
      expect(r.statusCode).toBe(200);
      expect(r.json().contracts).toEqual([
        { contractId: "b1", templateId: ev.templateId, signatories: ["v"], createArgument: { actor: P } },
      ]);
      expect(JSON.stringify(q.mock.calls[0])).toContain("TemplateFilter");
    });

    it("lists an allowlisted interface with its views", async () => {
      const { app, q } = appWith([ALLOC]);
      const r = await (await app).inject({ method: "GET", url: `/v1/wallet/${P}/contracts?interfaceId=${encodeURIComponent(ALLOC)}` });
      expect(r.statusCode).toBe(200);
      expect(JSON.stringify(q.mock.calls[0])).toContain("InterfaceFilter");
    });

    it("refuses an id outside the allowlist, and ambiguous queries", async () => {
      const { app } = appWith([BATCHER]);
      const a = await app;
      expect((await a.inject({ method: "GET", url: `/v1/wallet/${P}/contracts?templateId=${encodeURIComponent("#x:Splice.Amulet:Amulet")}` })).statusCode).toBe(400);
      expect((await a.inject({ method: "GET", url: `/v1/wallet/${P}/contracts` })).statusCode).toBe(400);
      expect(
        (await a.inject({ method: "GET", url: `/v1/wallet/${P}/contracts?templateId=${encodeURIComponent(BATCHER)}&interfaceId=${encodeURIComponent(BATCHER)}` })).statusCode
      ).toBe(400);
    });
  });

  describe("POST /v1/wallet/resolve/allocation-factory", () => {
    const CBTC = "cbtc-network::1220cb";
    const UTIL = "https://registry.example";
    function stub(capture: (url: string, body: string) => void, status = 200) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown, init?: RequestInit) => {
          const u = String(url);
          capture(u, String(init?.body ?? ""));
          if (u.includes("/dso-party-id")) return new Response(JSON.stringify({ dso_party_id: "DSO::1220cafe" }), { status: 200 });
          if (u.includes("/allocation-factory")) {
            return status === 200
              ? new Response(JSON.stringify({ factoryId: "00af", choiceContext: { choiceContextData: { values: {} }, disclosedContracts: [{ contractId: "d" }] } }), { status: 200 })
              : new Response("Missing field settlement", { status });
          }
          return new Response("not found", { status: 404 });
        })
      );
    }
    const args = { settlement: {}, allocation: {}, inputHoldingCids: [] };

    it("asks the SV Scan for Canton Coin", async () => {
      const calls: string[] = [];
      stub((u) => calls.push(u));
      const a = await build(svc({ tokenRegistries: { [CBTC]: UTIL } }));
      const r = await a.inject({ method: "POST", url: "/v1/wallet/resolve/allocation-factory", payload: { instrumentId: { admin: "DSO::1220cafe", id: "Amulet" }, choiceArguments: args } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ factoryId: "00af", choiceContextData: { values: {} }, disclosedContracts: [{ contractId: "d" }] });
      expect(calls.some((u) => u.endsWith("/registry/allocation-instruction/v2/allocation-factory") && !u.includes(UTIL))).toBe(true);
    });

    it("asks the token's DA Registry Utility for a registry token, forwarding the arguments", async () => {
      const calls: Array<[string, string]> = [];
      stub((u, b) => calls.push([u, b]));
      const a = await build(svc({ tokenRegistries: { [CBTC]: UTIL } }));
      const r = await a.inject({ method: "POST", url: "/v1/wallet/resolve/allocation-factory", payload: { instrumentId: { admin: CBTC, id: "CBTC" }, choiceArguments: args } });
      expect(r.statusCode).toBe(200);
      const hit = calls.find(([u]) => u.includes("/allocation-factory"))!;
      expect(hit[0]).toBe(`${UTIL}/api/token-standard/v0/registrars/${encodeURIComponent(CBTC)}/registry/allocation-instruction/v2/allocation-factory`);
      expect(JSON.parse(hit[1])).toEqual({ choiceArguments: args, excludeDebugFields: true });
    });

    it("resolves the V2 settlement factory on the same routing", async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          const u = String(url);
          calls.push(u);
          if (u.includes("/dso-party-id")) return new Response(JSON.stringify({ dso_party_id: "DSO::1220cafe" }), { status: 200 });
          if (u.includes("/settlement-factory")) {
            return new Response(JSON.stringify({ factoryId: "00sf", choiceContext: { choiceContextData: {}, disclosedContracts: [] } }), { status: 200 });
          }
          return new Response("not found", { status: 404 });
        })
      );
      const a = await build(svc({ tokenRegistries: { [CBTC]: UTIL } }));
      const r = await a.inject({ method: "POST", url: "/v1/wallet/resolve/settlement-factory", payload: { instrumentId: { admin: CBTC, id: "CBTC" }, choiceArguments: { settlement: {} } } });
      expect(r.statusCode).toBe(200);
      expect(r.json().factoryId).toBe("00sf");
      expect(calls).toContain(`${UTIL}/api/token-standard/v0/registrars/${encodeURIComponent(CBTC)}/registry/allocation/v2/settlement-factory`);
    });

    it("refuses an admin with no registry, and passes a registry refusal through as 400", async () => {
      stub(() => undefined, 400);
      const a = await build(svc({ tokenRegistries: { [CBTC]: UTIL } }));
      const none = await a.inject({ method: "POST", url: "/v1/wallet/resolve/allocation-factory", payload: { instrumentId: { admin: "who::1220", id: "X" }, choiceArguments: args } });
      expect(none.statusCode).toBe(400);
      const refused = await a.inject({ method: "POST", url: "/v1/wallet/resolve/allocation-factory", payload: { instrumentId: { admin: CBTC, id: "CBTC" }, choiceArguments: args } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().detail).toContain("Missing field settlement");
    });
  });
});

describe("holdings-scan (Scan ACS snapshot, whale path)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pages through Scan v2 holdings/state with a string cursor", async () => {
    const PARTY = "agent::1220whale";
    const AMULET = "#splice-amulet:Splice.Amulet:Amulet";
    const holdingsCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: string }) => {
        const u = String(url);
        if (u.includes("/state/acs/snapshot-timestamp")) {
          // Only the live migration answers; older ones have no snapshot.
          return u.includes("migration_id=4")
            ? new Response(JSON.stringify({ record_time: "2026-10-21T09:00:00Z" }), { status: 200 })
            : new Response("not found", { status: 404 });
        }
        if (u.includes("/holdings/state")) {
          const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
          holdingsCalls.push({ url: u, body });
          const page = body.after === undefined
            ? { created_events: [{ contract_id: "c1", template_id: AMULET, create_arguments: { owner: PARTY, amount: { initialAmount: "1.0000000000" } } }], next_page_token: "tok-2" }
            : { created_events: [{ contract_id: "c2", template_id: AMULET, create_arguments: { owner: PARTY, amount: { initialAmount: "2.0000000000" } } }], next_page_token: null };
          return new Response(JSON.stringify(page), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );
    const a = await build(svc());
    const r = await a.inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(PARTY)}/holdings-scan` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { holdings: Array<{ cid: string }>; complete: boolean; recordTime: string };
    expect(body.holdings.map((h) => h.cid)).toEqual(["c1", "c2"]);
    expect(body.complete).toBe(true);
    expect(body.recordTime).toBe("2026-10-21T09:00:00Z");
    // v2 only (Scan 0.9.0 removed v0/v1 holdings/state), and the cursor is a string.
    expect(holdingsCalls.every((c) => c.url.includes("/api/scan/v2/holdings/state"))).toBe(true);
    expect(holdingsCalls[0]!.body.after).toBeUndefined();
    expect(holdingsCalls[1]!.body.after).toBe("tok-2");
    expect(holdingsCalls[0]!.body.migration_id).toBe(4);
  });
});
