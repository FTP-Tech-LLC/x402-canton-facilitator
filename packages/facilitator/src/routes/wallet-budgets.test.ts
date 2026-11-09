/**
 * Relay budgets that bound shared resources: the two self-preapproval prepare
 * routes (participant prepares, an ACS read, a registry GET), and the
 * facilitator-wide arm and traffic breaker on the routes that spend our Global
 * Synchronizer traffic (submit/execute, preapproval/self/commit).
 */
import { CantonError } from "@ftptech/x402-canton-ledger";
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { registerWalletRoutes, type WalletRelayServices } from "./wallet.js";
import { createScanBudget } from "../scan-budget.js";

function mockClient(over: Record<string, unknown> = {}) {
  return {
    generateExternalPartyTopology: vi.fn(),
    allocateExternalParty: vi.fn().mockResolvedValue({ partyId: "agent::1220new" }),
    interactiveSubmissionPrepare: vi
      .fn()
      .mockResolvedValue({ preparedTransaction: "pt", preparedTransactionHash: "h1" }),
    interactiveSubmissionExecute: vi.fn().mockResolvedValue({ updateId: "u1" }),
    grantUserRights: vi.fn().mockResolvedValue(undefined),
    getLedgerEnd: vi.fn().mockResolvedValue({ offset: 100 }),
    pollCompletionUpdateId: vi.fn().mockResolvedValue("u-polled"),
    queryActiveContracts: vi.fn().mockResolvedValue([]),
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
const TRUSTED_KEY = "trusted-relay-key-for-tests-only-000000";
const trusted = { "x-agent-key": TRUSTED_KEY };

describe("self-preapproval prepares are bounded per caller", () => {
  afterEach(() => vi.unstubAllGlobals());

  const SELF = "/v1/wallet/preapproval/self/prepare";
  const REGISTRY = "/v1/wallet/preapproval/registry/self/prepare";
  const ADMIN = "usdcx-admin::1220aa";
  const MERCHANT = "merchant::1220aabbcc";
  const routes = [SELF, REGISTRY] as const;

  const selfSvc = (o: Partial<WalletRelayServices> = {}) => {
    const prepareSelfPreapproval = vi
      .fn()
      .mockResolvedValue({ preparedTransaction: "pt", txHash: "h", synchronizerId: "s" });
    const client = mockClient();
    const s = svc({
      client: client as never,
      selfPreapproval: { prepareSelfPreapproval, executeSelfPreapproval: vi.fn() } as never,
      tokenRegistries: { [ADMIN]: "http://registry.test" },
      ...o,
    });
    return { s, prepareSelfPreapproval, client };
  };
  const stubOperator = () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ partyId: "operator::1220op" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    return f;
  };
  const call = (
    a: Awaited<ReturnType<typeof build>>,
    url: (typeof routes)[number],
    remoteAddress = "203.0.113.50",
    headers: Record<string, string> = {}
  ) =>
    a.inject({
      method: "POST",
      url,
      remoteAddress,
      headers,
      payload:
        url === SELF ? { party: MERCHANT } : { party: MERCHANT, instrumentId: { admin: ADMIN, id: "USDCx" } },
    });

  it("one IP past its share is refused before any participant or registry work", async () => {
    const operator = stubOperator();
    const { s, prepareSelfPreapproval, client } = selfSvc({ submitRateMaxPerKey: 2 });
    const a = await build(s);
    for (const url of routes) {
      expect((await call(a, url)).statusCode, url).toBe(200);
      expect((await call(a, url)).statusCode, url).toBe(200);
      const third = await call(a, url);
      expect(third.statusCode, url).toBe(429);
      expect(third.headers["retry-after"]).toBe("60");
      // Another caller is unaffected.
      expect((await call(a, url, "203.0.113.51")).statusCode, url).toBe(200);
    }
    expect(prepareSelfPreapproval).toHaveBeenCalledTimes(3);
    expect(client.interactiveSubmissionPrepare).toHaveBeenCalledTimes(3);
    expect(operator).toHaveBeenCalledTimes(3);
    await a.close();
  });

  it("a trusted key skips the per-IP cap", async () => {
    stubOperator();
    const { s } = selfSvc({ submitRateMaxPerKey: 1, trustedKeys: [TRUSTED_KEY] });
    const a = await build(s);
    for (const url of routes) {
      for (let i = 0; i < 3; i++) expect((await call(a, url, "203.0.113.52", trusted)).statusCode, url).toBe(200);
      // The unkeyed caller on the same IP keeps its own share.
      expect((await call(a, url, "203.0.113.52")).statusCode, url).toBe(200);
      expect((await call(a, url, "203.0.113.52")).statusCode, url).toBe(429);
    }
    await a.close();
  });

  it("a caller banned elsewhere is refused here, and refusals here earn the ban", async () => {
    stubOperator();
    const { s, prepareSelfPreapproval } = selfSvc({
      submitRateMaxPerKey: 1,
      abuseStrikesToBan: 2,
      abuseStrikeSpacingMs: 0,
    });
    const a = await build(s);
    const ip = "203.0.113.53";
    expect((await call(a, SELF, ip)).statusCode).toBe(200);
    expect((await call(a, SELF, ip)).statusCode).toBe(429); // strike 1
    expect((await call(a, SELF, ip)).statusCode).toBe(429); // strike 2 -> ban
    const banned = await call(a, REGISTRY, ip);
    expect(banned.statusCode).toBe(429);
    expect((banned.json() as { error: string }).error).toContain("suspended");
    expect(Number(banned.headers["retry-after"])).toBeGreaterThan(600);
    expect(prepareSelfPreapproval).toHaveBeenCalledTimes(1);
    await a.close();
  });
});

describe("relay submissions: a facilitator-wide arm and a traffic breaker", () => {
  const P = (n: number) => `agent::1220aa${String(n).padStart(6, "0")}`;
  const exec = (
    a: Awaited<ReturnType<typeof build>>,
    party: string,
    remoteAddress: string,
    headers: Record<string, string> = {}
  ) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/submit/execute",
      remoteAddress,
      headers,
      payload: { preparedTransaction: "cHJlcA==", partySignatures: { signatures: [{ party }] } },
    });
  const commit = (a: Awaited<ReturnType<typeof build>>, party: string, remoteAddress: string) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/preapproval/self/commit",
      remoteAddress,
      payload: { party, preparedTransaction: "cHJlcA==", partySignatures: { signatures: [{ party, signatures: [{}] }] } },
    });
  /** What the participant answers when our traffic is gone (see settle.ts:
   *  a sequencer/traffic verdict arrives as HTTP 5xx with ABORTED in the body). */
  const trafficVerdict = () =>
    new CantonError(
      "POST /v2/interactive-submission/execute returned HTTP 503",
      "HTTP_ERROR",
      503,
      '{"code":"ABORTED","cause":"insufficient traffic on the sequencer"}'
    );

  it("callers who each stay inside their own caps are still bounded together", async () => {
    const client = mockClient();
    const a = await build(svc({ client: client as never, submitRateMaxGlobal: 4 }));
    // Five hosts, five wallets, one execute each: every per-key and per-IP cap
    // has room. Callers without a key may use three quarters of the minute.
    for (let i = 1; i <= 3; i++) expect((await exec(a, P(i), `198.51.100.${i}`)).statusCode).toBe(200);
    const fourth = await exec(a, P(4), "198.51.100.4");
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers["retry-after"]).toBe("60");
    expect(client.interactiveSubmissionExecute).toHaveBeenCalledTimes(3);
    await a.close();
  });

  it("one network cannot take the whole anonymous share, and its refusals strike nobody", async () => {
    // Without a share per network one IP, one party, inside its own per-key and
    // per-IP caps, could hold the anonymous minute for everyone.
    const client = mockClient();
    const a = await build(
      svc({ client: client as never, submitRateMaxGlobal: 8, abuseStrikesToBan: 1, abuseStrikeSpacingMs: 0 })
    );
    // 8 a minute: anonymous callers 6 of it, one network 2 of that.
    expect((await exec(a, P(1), "198.51.100.1")).statusCode).toBe(200);
    expect((await exec(a, P(1), "198.51.100.1")).statusCode).toBe(200);
    const third = await exec(a, P(1), "198.51.100.1");
    expect(third.statusCode).toBe(429);
    expect(third.headers["retry-after"]).toBe("60");
    // Not a strike: honest agents behind one NAT reach this share together.
    const again = await exec(a, P(1), "198.51.100.1");
    expect((again.json() as { error: string }).error).not.toContain("suspended");
    // Everyone else still has the rest of the anonymous minute.
    for (const ip of ["198.51.100.2", "198.51.100.3"]) {
      expect((await exec(a, P(2), ip)).statusCode).toBe(200);
      expect((await exec(a, P(3), ip)).statusCode).toBe(200);
    }
    expect((await exec(a, P(4), "198.51.100.4")).statusCode).toBe(429); // anonymous share used up
    expect(client.interactiveSubmissionExecute).toHaveBeenCalledTimes(6);
    await a.close();
  });

  describe("four honest agents behind one NAT, 16 submissions a minute", () => {
    afterEach(() => vi.useRealTimers());
    it("are paced by the network's share and never banned, pay/prepare included", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.UTC(2026, 10, 8, 12, 0, 0));
      const a = await build(
        svc({
          submitRateMaxPerKey: 60,
          submitRateMaxPerIp: 240,
          submitRateMaxGlobal: 60,
          abuseStrikesToBan: 5,
          abuseStrikeWindowMs: 600_000,
          abuseStrikeSpacingMs: 60_000,
          abuseBaseBanMs: 3_600_000,
        })
      );
      const NAT = "198.51.100.200";
      let suspended = 0;
      for (let minute = 0; minute < 6; minute++) {
        for (let i = 0; i < 16; i++) {
          const r = await exec(a, P(i % 4), NAT);
          if (r.statusCode === 429 && (r.json() as { error: string }).error.includes("suspended")) suspended++;
          vi.setSystemTime(Date.now() + 3_000);
        }
        vi.setSystemTime(Date.now() + 13_000);
      }
      expect(suspended).toBe(0);
      const pay = await a.inject({
        method: "POST",
        url: "/v1/wallet/pay/prepare",
        remoteAddress: NAT,
        payload: { party: P(1), receiver: "merchant::1220beef5678", amount: "1.0000000000" },
      });
      expect((pay.json() as { error?: string }).error ?? "").not.toContain("suspended");
      await a.close();
    });
  });

  it("the trusted channel keeps the rest of the minute, and the arm binds it too", async () => {
    const client = mockClient();
    const a = await build(svc({ client: client as never, submitRateMaxGlobal: 4, trustedKeys: [TRUSTED_KEY] }));
    for (let i = 1; i <= 3; i++) expect((await exec(a, P(i), `198.51.100.${i}`)).statusCode).toBe(200);
    expect((await exec(a, P(4), "198.51.100.4")).statusCode).toBe(429);
    expect((await exec(a, P(5), "203.0.113.60", trusted)).statusCode).toBe(200);
    expect((await exec(a, P(6), "203.0.113.60", trusted)).statusCode).toBe(429);
    expect(client.interactiveSubmissionExecute).toHaveBeenCalledTimes(4);
    await a.close();
  });

  it("a submission the participant refused outright gives its slot back", async () => {
    // Junk that the participant rejects on sight (bad signature, malformed
    // bytes) burns no traffic, so it must not hold the minute shared with
    // everyone who does pay.
    const refused = new CantonError("HTTP 400", "HTTP_ERROR", 400, '{"code":"INVALID_ARGUMENT"}');
    const execute = vi
      .fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockResolvedValue({ updateId: "u1" });
    const a = await build(svc({ client: mockClient({ interactiveSubmissionExecute: execute }) as never, submitRateMaxGlobal: 1 }));
    expect((await exec(a, P(1), "198.51.100.1")).statusCode).toBe(502);
    expect((await exec(a, P(2), "198.51.100.2")).statusCode).toBe(502);
    expect((await exec(a, P(3), "198.51.100.3")).statusCode).toBe(200);
    // That one did spend: the minute is gone.
    expect((await exec(a, P(4), "198.51.100.4")).statusCode).toBe(429);
    expect(execute).toHaveBeenCalledTimes(3);
    await a.close();
  });

  it("a malformed partySignatures still reaches the participant, and its refusal gives the slot back", async () => {
    const refused = new CantonError("HTTP 400", "HTTP_ERROR", 400, '{"code":"INVALID_ARGUMENT"}');
    const execute = vi.fn().mockRejectedValueOnce(refused).mockResolvedValue({ updateId: "u1" });
    const a = await build(svc({ client: mockClient({ interactiveSubmissionExecute: execute }) as never, submitRateMaxGlobal: 1 }));
    const junk = await a.inject({
      method: "POST",
      url: "/v1/wallet/submit/execute",
      remoteAddress: "198.51.100.9",
      payload: { preparedTransaction: "cHJlcA==", partySignatures: { signatures: "not-a-list" } },
    });
    expect(junk.statusCode).toBe(502);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await exec(a, P(1), "198.51.100.1")).statusCode).toBe(200);
    await a.close();
  });

  it("preapproval/self/commit spends the same arm", async () => {
    const executeSelfPreapproval = vi.fn().mockResolvedValue({ updateId: "u2" });
    const a = await build(
      svc({ submitRateMaxGlobal: 2, selfPreapproval: { executeSelfPreapproval } as never })
    );
    expect((await exec(a, P(1), "198.51.100.1")).statusCode).toBe(200);
    const r = await commit(a, P(2), "198.51.100.2");
    expect(r.statusCode).toBe(429);
    expect(executeSelfPreapproval).not.toHaveBeenCalled();
    await a.close();
  });

  it("server-side traffic verdicts open the breaker; it then refuses with 429 before the participant", async () => {
    const execute = vi.fn().mockRejectedValue(trafficVerdict());
    const a = await build(
      svc({
        client: mockClient({ interactiveSubmissionExecute: execute }) as never,
        submitBreaker: { threshold: 3, cooldownMs: 60_000 },
      })
    );
    for (let i = 1; i <= 3; i++) expect((await exec(a, P(i), `198.51.100.${i}`)).statusCode).toBe(502);
    const open = await exec(a, P(4), "198.51.100.4");
    // 429, not 5xx: the wallet reads a 5xx on a submitting route as "this may
    // have committed" and tells the user to check the balance first.
    expect(open.statusCode).toBe(429);
    expect((open.json() as { error: string }).error).toBe("facilitator_traffic_unavailable");
    expect(Number(open.headers["retry-after"])).toBeGreaterThan(0);
    expect(execute).toHaveBeenCalledTimes(3);
    await a.close();
  });

  it("preapproval/self/commit feeds and obeys the same breaker", async () => {
    const executeSelfPreapproval = vi.fn().mockRejectedValue(trafficVerdict());
    const execute = vi.fn().mockResolvedValue({ updateId: "u1" });
    const a = await build(
      svc({
        client: mockClient({ interactiveSubmissionExecute: execute }) as never,
        selfPreapproval: { executeSelfPreapproval } as never,
        submitBreaker: { threshold: 3, cooldownMs: 60_000 },
      })
    );
    for (let i = 1; i <= 3; i++) expect((await commit(a, P(i), `198.51.100.${i}`)).statusCode).toBe(502);
    expect((await exec(a, P(4), "198.51.100.4")).statusCode).toBe(429);
    expect(execute).not.toHaveBeenCalled();
    await a.close();
  });

  it("failures the caller can shape do not count toward the breaker", async () => {
    // A 4xx is the participant judging the request, and the completion text of
    // a rejected submission is shaped by the transaction the caller built and
    // signed. Either can carry the word "traffic" on demand; neither says
    // anything about OUR traffic.
    const shaped = new CantonError("HTTP 400", "HTTP_ERROR", 400, '{"cause":"insufficient traffic (caller text)"}');
    const execute = vi.fn().mockRejectedValue(shaped);
    const poll = vi
      .fn()
      .mockRejectedValue(new CantonError("interactive submission rejected: sequencer traffic", "SUBMISSION_FAILED"));
    const a = await build(
      svc({
        client: mockClient({ interactiveSubmissionExecute: execute }) as never,
        submitBreaker: { threshold: 3, cooldownMs: 60_000 },
      })
    );
    for (let i = 1; i <= 5; i++) expect((await exec(a, P(i), `198.51.100.${i}`)).statusCode).toBe(502);
    const b = await build(
      svc({
        client: mockClient({
          interactiveSubmissionExecute: vi.fn().mockResolvedValue({}),
          pollCompletionUpdateId: poll,
        }) as never,
        submitBreaker: { threshold: 3, cooldownMs: 60_000 },
      })
    );
    for (let i = 1; i <= 5; i++) expect((await exec(b, P(i), `198.51.100.${i}`)).statusCode).toBe(502);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(poll).toHaveBeenCalledTimes(5);
    await a.close();
    await b.close();
  });

  it("absent config keeps the old behaviour: no arm, no breaker", async () => {
    const execute = vi.fn().mockRejectedValue(trafficVerdict());
    const a = await build(svc({ client: mockClient({ interactiveSubmissionExecute: execute }) as never }));
    for (let i = 1; i <= 6; i++) expect((await exec(a, P(i), `198.51.100.${i}`)).statusCode).toBe(502);
    expect(execute).toHaveBeenCalledTimes(6);
    await a.close();
  });
});

describe("relay Scan reads share one outbound budget with the payment path", () => {
  afterEach(() => vi.unstubAllGlobals());

  const DSO = "DSO::1220cafe";
  type Seen = { url: string };
  /** Scan stub. `factory` decides each transfer-factory answer. */
  const stubScan = (factory: (n: number) => Response = () => okFactory()) => {
    const seen: Seen[] = [];
    let n = 0;
    const f = vi.fn(async (url: unknown) => {
      const u = String(url);
      seen.push({ url: u });
      if (u.includes("/dso-party-id")) return new Response(JSON.stringify({ dso_party_id: DSO }), { status: 200 });
      if (u.includes("/transfer-factory")) return factory(++n);
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", f);
    return { f, seen, factoryCalls: () => seen.filter((s) => s.url.includes("/transfer-factory")).length };
  };
  const okFactory = () =>
    new Response(JSON.stringify({ factoryId: "00f", transferKind: "direct", choiceContext: { choiceContextData: {}, disclosedContracts: [] } }), {
      status: 200,
    });
  const rateLimited = () => new Response("local_rate_limited", { status: 429 });
  const resolve = (
    a: Awaited<ReturnType<typeof build>>,
    remoteAddress: string,
    headers: Record<string, string> = {}
  ) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/resolve/transfer-factory",
      remoteAddress,
      headers,
      payload: { sender: "agent::1220a", receiver: "merchant::1220m", amount: "1.0000000000" },
    });
  const budget = (o: Partial<Parameters<typeof createScanBudget>[0]> = {}) =>
    createScanBudget({ maxPerWindow: 100, cooldownMs: 60_000, paceMs: 0, ...o });

  it("anonymous reads stop at the shared line before any Scan request; a trusted caller does not", async () => {
    const s = stubScan();
    // The DSO lookup (payment path, once) and the first factory read take two.
    const a = await build(svc({ scanBudget: budget({ maxPerWindow: 3 }), trustedKeys: [TRUSTED_KEY] }));
    expect((await resolve(a, "198.51.100.1")).statusCode).toBe(200);
    expect((await resolve(a, "198.51.100.2")).statusCode).toBe(200);
    const shed = await resolve(a, "198.51.100.3");
    expect(shed.statusCode).toBe(503);
    expect((shed.json() as { error: string }).error).toBe("scan_busy");
    expect(Number(shed.headers["retry-after"])).toBeGreaterThan(0);
    expect(s.factoryCalls()).toBe(2);
    // A trusted key reads on the priority class: past the line, still sent.
    expect((await resolve(a, "203.0.113.70", trusted)).statusCode).toBe(200);
    expect(s.factoryCalls()).toBe(3);
    await a.close();
  });

  it("an anonymous read that meets a 429 is one request: no retry, no failover", async () => {
    const s = stubScan(() => rateLimited());
    const a = await build(svc({ scanBudget: budget(), scanFallbackUrls: ["http://scan-b.test"] }));
    const r = await resolve(a, "198.51.100.1");
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: string }).error).toBe("scan_busy");
    expect(s.factoryCalls()).toBe(1);
    await a.close();
  });

  it("a 429 seen on the priority path holds anonymous reads back without a Scan request", async () => {
    const s = stubScan((n) => (n === 1 ? rateLimited() : okFactory()));
    const a = await build(svc({ scanBudget: budget(), trustedKeys: [TRUSTED_KEY] }));
    // Priority retries its 429 as before and succeeds...
    expect((await resolve(a, "203.0.113.70", trusted)).statusCode).toBe(200);
    expect(s.factoryCalls()).toBe(2);
    // ...and the 429 it met starts the cooldown for everyone without a key.
    expect((await resolve(a, "198.51.100.1")).statusCode).toBe(503);
    expect(s.factoryCalls()).toBe(2);
    await a.close();
  });

  it("without the payment-path merchants wired, pay/prepare's Scan read stays priority, as before", async () => {
    const s = stubScan();
    const amulet = {
      contractId: "c1",
      templateId: "#splice-amulet:Splice.Amulet:Amulet",
      createArgument: { amount: { initialAmount: "5.0000000000" } },
      signatories: [],
      observers: [],
      packageName: "p",
    };
    const a = await build(
      svc({
        client: mockClient({ queryActiveContracts: vi.fn().mockResolvedValue([amulet]) }) as never,
        scanBudget: budget({ maxPerWindow: 2 }),
        tfPay: { defaultExecuteBeforeSeconds: 120, maxExecuteBeforeSeconds: 300 },
      })
    );
    expect((await resolve(a, "198.51.100.1")).statusCode).toBe(200); // dso + factory: line reached
    expect((await resolve(a, "198.51.100.2")).statusCode).toBe(503);
    const pay = await a.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      remoteAddress: "198.51.100.3",
      payload: { party: "agent::1220cafe1234", receiver: "merchant::1220beef5678", amount: "1.0000000000" },
    });
    expect(pay.statusCode, pay.body).toBe(200);
    expect(s.factoryCalls()).toBe(2);
    await a.close();
  });

  it("with the payment-path merchants wired, pay/prepare to any other receiver is best-effort for an anonymous caller", async () => {
    // A fresh receiver per call misses the per-receiver cache every time: on
    // the priority class, three IPv4 callers filled the Scan window with it.
    const s = stubScan();
    const amulet = {
      contractId: "c1",
      templateId: "#splice-amulet:Splice.Amulet:Amulet",
      createArgument: { amount: { initialAmount: "5.0000000000" } },
      signatories: [],
      observers: [],
      packageName: "p",
    };
    const served = new Set(["merchant::1220beef0001"]);
    const isPaymentPathMerchant = vi.fn((p: string, _now: number) => served.has(p));
    const a = await build(
      svc({
        client: mockClient({ queryActiveContracts: vi.fn().mockResolvedValue([amulet]) }) as never,
        scanBudget: budget({ maxPerWindow: 2 }),
        tfPay: { defaultExecuteBeforeSeconds: 120, maxExecuteBeforeSeconds: 300 },
        isPaymentPathMerchant,
        trustedKeys: [TRUSTED_KEY],
      })
    );
    const pay = (receiver: string, remoteAddress: string, headers: Record<string, string> = {}) =>
      a.inject({
        method: "POST",
        url: "/v1/wallet/pay/prepare",
        remoteAddress,
        headers,
        payload: { party: "agent::1220cafe1234", receiver, amount: "1.0000000000" },
      });
    expect((await resolve(a, "198.51.100.1")).statusCode).toBe(200); // dso + factory: line reached
    const shed = await pay("merchant::1220beef0002", "198.51.100.3");
    expect(shed.statusCode, shed.body).toBe(503);
    expect((shed.json() as { error: string }).error).toBe("scan_busy");
    expect(Number(shed.headers["retry-after"])).toBeGreaterThan(0);
    expect(s.factoryCalls()).toBe(1); // refused before any Scan request
    // A merchant on the payment path stays priority for the same caller.
    expect((await pay("merchant::1220beef0001", "198.51.100.3")).statusCode).toBe(200);
    // A trusted caller is priority whatever the receiver.
    expect((await pay("merchant::1220beef0003", "203.0.113.70", trusted)).statusCode).toBe(200);
    expect(s.factoryCalls()).toBe(3);
    expect(isPaymentPathMerchant).toHaveBeenCalledWith("merchant::1220beef0002", expect.any(Number));
    await a.close();
  });

  it("pay/prepare to a receiver off the payment path waits out a Scan cooldown once, as Rule 7 does", async () => {
    // Any 429 on the Scan host starts its cooldown; a first payment to a
    // merchant we do not serve yet must not fail on someone else's 429.
    const s = stubScan((n) => (n === 1 ? rateLimited() : okFactory()));
    const amulet = {
      contractId: "c1",
      templateId: "#splice-amulet:Splice.Amulet:Amulet",
      createArgument: { amount: { initialAmount: "5.0000000000" } },
      signatories: [],
      observers: [],
      packageName: "p",
    };
    const a = await build(
      svc({
        client: mockClient({ queryActiveContracts: vi.fn().mockResolvedValue([amulet]) }) as never,
        scanBudget: budget({ cooldownMs: 300 }),
        tfPay: { defaultExecuteBeforeSeconds: 120, maxExecuteBeforeSeconds: 300 },
        isPaymentPathMerchant: () => false,
        trustedKeys: [TRUSTED_KEY],
      })
    );
    expect((await resolve(a, "198.51.100.1")).statusCode).not.toBe(200); // the 429
    const t0 = Date.now();
    const paid = await a.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      remoteAddress: "198.51.100.3",
      payload: { party: "agent::1220cafe1234", receiver: "merchant::1220beef0002", amount: "1.0000000000" },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(s.factoryCalls()).toBe(2);
    await a.close();
  });

  it("holdings-scan for an anonymous caller fails on a 429 instead of settling on an older migration", async () => {
    // Today a probe that stays 429 reads as "no snapshot for this migration",
    // and the walk picks the next one down: a stale snapshot, cached for an hour.
    const f = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("snapshot-timestamp")) {
        const mid = Number(/migration_id=(\d+)/.exec(u)?.[1]);
        if (mid === 4) return rateLimited();
        if (mid === 3) return new Response(JSON.stringify({ record_time: "2026-01-01T00:00:00Z" }), { status: 200 });
        return new Response("no snapshot", { status: 404 });
      }
      if (u.includes("/holdings/state")) {
        return new Response(JSON.stringify({ created_events: [], next_page_token: null }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", f);
    const a = await build(svc({ scanBudget: budget() }));
    const r = await a.inject({
      method: "GET",
      url: `/v1/wallet/${encodeURIComponent("agent::12201")}/holdings-scan`,
      remoteAddress: "198.51.100.1",
    });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: string }).error).toBe("scan_busy");
    expect(f.mock.calls.filter(([u]) => String(u).includes("/holdings/state"))).toHaveLength(0);
    await a.close();
  });

  it("budget off (0): every read behaves as before, a 429 is retried", async () => {
    const s = stubScan((n) => (n === 1 ? rateLimited() : okFactory()));
    const a = await build(svc({ scanBudget: budget({ maxPerWindow: 0 }) }));
    expect((await resolve(a, "198.51.100.1")).statusCode).toBe(200);
    expect(s.factoryCalls()).toBe(2);
    await a.close();
  });
});

describe("pay/prepare: admission per caller, and one factory resolve per receiver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  /** One funded Amulet per party, so concurrent prepares never contend. */
  const funded = () =>
    vi.fn(async (f: { filtersByParty: Record<string, unknown> }) => {
      const party = Object.keys(f.filtersByParty)[0]!;
      return [
        {
          contractId: `c-${party}`,
          templateId: "#splice-amulet:Splice.Amulet:Amulet",
          createArgument: { amount: { initialAmount: "5.0000000000" } },
          signatories: [],
          observers: [],
          packageName: "p",
        },
      ];
    });
  const scanStub = () => {
    const factory: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/dso-party-id")) return new Response(JSON.stringify({ dso_party_id: "DSO::1220cafe" }), { status: 200 });
        if (u.includes("/transfer-factory")) {
          factory.push(JSON.parse(String(init?.body)).choiceArguments.transfer.receiver);
          return new Response(
            JSON.stringify({ factoryId: "00f", choiceContext: { choiceContextData: {}, disclosedContracts: [] } }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );
    return factory;
  };
  const tfPay = { defaultExecuteBeforeSeconds: 120, maxExecuteBeforeSeconds: 300 };
  const pay = (
    a: Awaited<ReturnType<typeof build>>,
    party: string,
    receiver: string,
    remoteAddress = "198.51.100.30",
    headers: Record<string, string> = {}
  ) =>
    a.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      remoteAddress,
      headers,
      payload: { party, receiver, amount: "1.0000000000" },
    });
  const M = (n: number) => `merchant::1220beef${String(n).padStart(4, "0")}`;
  const A = (n: number) => `agent::1220cafe${String(n).padStart(4, "0")}`;

  it("caps one caller per party and per IP before any participant or Scan work; a trusted key is exempt", async () => {
    // Unlimited before: 500 from one IP were 500 priority Scan reads.
    const factory = scanStub();
    const client = mockClient({ queryActiveContracts: funded() });
    const a = await build(
      svc({ client: client as never, tfPay, payPrepareRateMaxPerKey: 2, payPrepareRateMaxPerIp: 3, trustedKeys: [TRUSTED_KEY] })
    );
    expect((await pay(a, A(1), M(1))).statusCode).toBe(200);
    expect((await pay(a, A(1), M(2))).statusCode).toBe(200);
    const sameParty = await pay(a, A(1), M(3));
    expect(sameParty.statusCode).toBe(429);
    expect(sameParty.headers["retry-after"]).toBe("60");
    expect((await pay(a, A(2), M(4))).statusCode).toBe(200);
    expect((await pay(a, A(3), M(5))).statusCode).toBe(429); // the IP's 3
    expect(factory).toHaveLength(3);
    for (let i = 0; i < 4; i++) expect((await pay(a, A(9), M(10 + i), "198.51.100.30", trusted)).statusCode).toBe(200);
    // Not a strike: a NAT full of honest agents reaches this together.
    expect((await pay(a, A(4), M(20), "198.51.100.30")).json().error ?? "").not.toContain("suspended");
    await a.close();
  });

  it("counts an IPv6 caller by its /64, so rotating addresses inside it does not reset the caps", async () => {
    const factory = scanStub();
    const client = mockClient({ queryActiveContracts: funded() });
    const a = await build(svc({ client: client as never, tfPay, payPrepareRateMaxPerKey: 2, payPrepareRateMaxPerIp: 3 }));
    expect((await pay(a, A(1), M(1), "2001:db8:5:6::1")).statusCode).toBe(200);
    expect((await pay(a, A(1), M(2), "2001:db8:5:6::2")).statusCode).toBe(200);
    expect((await pay(a, A(1), M(3), "2001:db8:5:6::3")).statusCode).toBe(429); // the party's 2
    expect((await pay(a, A(2), M(4), "2001:db8:5:6::4")).statusCode).toBe(200);
    expect((await pay(a, A(3), M(5), "2001:db8:5:6::5")).statusCode).toBe(429); // the /64's 3
    expect((await pay(a, A(3), M(6), "2001:db8:5:7::1")).statusCode).toBe(200); // another /64
    expect(factory).toHaveLength(4);
    await a.close();
  });

  it("caches the Canton Coin factory resolve per receiver for a few seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 8, 12, 0, 0));
    const factory = scanStub();
    const a = await build(svc({ client: mockClient({ queryActiveContracts: funded() }) as never, tfPay }));
    expect((await pay(a, A(1), M(1), "198.51.100.31")).statusCode).toBe(200);
    expect((await pay(a, A(2), M(1), "198.51.100.32")).statusCode).toBe(200);
    expect((await pay(a, A(3), M(2), "198.51.100.33")).statusCode).toBe(200);
    expect(factory).toEqual([M(1), M(2)]);
    vi.setSystemTime(Date.now() + 6_000);
    expect((await pay(a, A(4), M(1), "198.51.100.34")).statusCode).toBe(200);
    expect(factory).toEqual([M(1), M(2), M(1)]);
    await a.close();
  });
});

