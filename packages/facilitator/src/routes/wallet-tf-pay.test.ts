/**
 * transfer-factory ("V3") relay-pay route tests: POST /v1/wallet/pay/prepare
 * (relay-build + interactive-prepare + stash) and POST /v1/wallet/pay/commit
 * (attach the payer's signing bundle, NO execution).
 *
 * The registry envelope + the DSO read go through GLOBAL fetch (same harness
 * as the sibling allocation-route tests): `/dso-party-id` and the
 * transfer-factory registry endpoint are stubbed with vi.stubGlobal.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import {
  registerWalletRoutes,
  type WalletRelayServices,
} from "./wallet.js";
import {
  createInMemoryTfStashStore,
  type TfStashStore,
} from "../db/stash-store.js";

const DSO = "DSO::1220dddddddddddddddd";
const PAYER = "agent::1220aaaaaaaaaaaaaaaa";
const MERCHANT = "merchant::1220bbbbbbbbbbbbbbbb";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubScan(opts: { factoryStatus?: number } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/dso-party-id")) {
        return new Response(JSON.stringify({ dso_party_id: DSO }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/registry/transfer-instruction/v1/transfer-factory")) {
        if (opts.factoryStatus) {
          return new Response("registry says no", { status: opts.factoryStatus });
        }
        return new Response(
          JSON.stringify({
            factoryId: "00fac",
            transferKind: "offer",
            choiceContext: {
              choiceContextData: { values: {} },
              disclosedContracts: [
                {
                  templateId: "pkg:Splice:AmuletRules",
                  contractId: "00rules",
                  createdEventBlob: "blob",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    })
  );
}

function makeSvc(
  stash: TfStashStore,
  opts: {
    holdings?: Array<{ cid: string; amount: string }>;
    tfPayOff?: boolean;
    capPerPayer?: number;
  } = {}
): { svc: WalletRelayServices; prepare: ReturnType<typeof vi.fn> } {
  const holdings = opts.holdings ?? [{ cid: "00h1", amount: "1.0000000000" }];
  const prepare = vi.fn(async () => ({
    preparedTransaction: "cHJlcGFyZWQ=",
    preparedTransactionHash: "aGFzaA==",
  }));
  const client = {
    queryActiveContracts: vi.fn(async () =>
      holdings.map((h) => ({
        contractId: h.cid,
        createArgument: { amount: { initialAmount: h.amount } },
      }))
    ),
    interactiveSubmissionPrepare: prepare,
  } as unknown as WalletRelayServices["client"];
  const svc = {
    client,
    synchronizerId: "global-domain::1220sync",
    userId: "relay-user",
    scanUrl: "http://scan.test/api/scan",
    enableAgentWallet: true,
    ...(opts.tfPayOff
      ? {}
      : {
          tfPay: {
            stash,
            capPerPayer: opts.capPerPayer ?? 4,
            defaultExecuteBeforeSeconds: 120,
            maxExecuteBeforeSeconds: 600,
          },
        }),
  } as WalletRelayServices;
  return { svc, prepare };
}

function sigBundle(party: string = PAYER) {
  return {
    hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
    partySignatures: {
      signatures: [
        {
          party,
          signatures: [
            {
              format: "SIGNATURE_FORMAT_CONCAT" as const,
              signature: "c2lnbmF0dXJl",
              signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
              signedBy: "1220fingerprint",
            },
          ],
        },
      ],
    },
  };
}

describe("POST /v1/wallet/pay/prepare", () => {
  it("503 when tfPay is not wired (disabled deploy is inert)", async () => {
    stubScan();
    const app = Fastify();
    const { svc } = makeSvc(createInMemoryTfStashStore(), { tfPayOff: true });
    await registerWalletRoutes(app, svc);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "0.25" },
    });
    expect(r.statusCode).toBe(503);
    await app.close();
  });

  it("happy path: builds, prepares as the agent, stashes, returns the ref + prepared tx", async () => {
    stubScan();
    const stash = createInMemoryTfStashStore();
    const app = Fastify();
    const { svc, prepare } = makeSvc(stash);
    await registerWalletRoutes(app, svc);
    const before = Date.now();
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "0.2500000000" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      submissionRef: string;
      preparedTransaction: string;
      txHash: string;
      executeBefore: string;
      instrumentId: { admin: string; id: string };
    };
    expect(body.preparedTransaction).toBe("cHJlcGFyZWQ=");
    expect(body.txHash).toBe("aGFzaA==");
    expect(body.instrumentId).toEqual({ admin: DSO, id: "Amulet" });
    // default executeBefore horizon = 120s
    const ebMs = new Date(body.executeBefore).getTime() - before;
    expect(ebMs).toBeGreaterThan(110_000);
    expect(ebMs).toBeLessThan(130_000);
    // the stash recorded the relay-built fields
    const row = await stash.get(body.submissionRef);
    expect(row).not.toBeNull();
    expect(row!.payer).toBe(PAYER);
    expect(row!.receiver).toBe(MERCHANT);
    expect(row!.amount).toBe("0.2500000000");
    expect(row!.instrumentAdmin).toBe(DSO);
    expect(row!.txHash).toBe("aGFzaA==");
    expect(row!.signature).toBeUndefined();
    // the prepare ran AS the agent with the registry's disclosed contracts
    const call = prepare.mock.calls[0]![0] as {
      actAs: string[];
      disclosedContracts: Array<{ contractId: string }>;
      commands: Array<{ ExerciseCommand: { choice: string; contractId: string } }>;
    };
    expect(call.actAs).toEqual([PAYER]);
    expect(call.disclosedContracts[0]!.contractId).toBe("00rules");
    expect(call.commands[0]!.ExerciseCommand.choice).toBe(
      "TransferFactory_Transfer"
    );
    expect(call.commands[0]!.ExerciseCommand.contractId).toBe("00fac");
    await app.close();
  });

  it("valid memo: stamped into the transfer meta as x402.memo (trimmed) + recorded in the stash", async () => {
    stubScan();
    const stash = createInMemoryTfStashStore();
    const app = Fastify();
    const { svc, prepare } = makeSvc(stash);
    await registerWalletRoutes(app, svc);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "0.2500000000", memo: "  order-42  " },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { submissionRef: string };
    const call = prepare.mock.calls[0]![0] as {
      commands: Array<{
        ExerciseCommand: {
          choiceArgument: { transfer: { meta: { values: Record<string, string> } } };
        };
      }>;
    };
    expect(
      call.commands[0]!.ExerciseCommand.choiceArgument.transfer.meta.values["x402.memo"]
    ).toBe("order-42");
    const row = await stash.get(body.submissionRef);
    expect(row!.memo).toBe("order-42");
    await app.close();
  });

  it("no memo: the transfer meta carries no x402.memo and the stash records none", async () => {
    stubScan();
    const stash = createInMemoryTfStashStore();
    const app = Fastify();
    const { svc, prepare } = makeSvc(stash);
    await registerWalletRoutes(app, svc);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "0.25" },
    });
    expect(r.statusCode).toBe(200);
    const call = prepare.mock.calls[0]![0] as {
      commands: Array<{
        ExerciseCommand: {
          choiceArgument: { transfer: { meta: { values: Record<string, string> } } };
        };
      }>;
    };
    expect(
      call.commands[0]!.ExerciseCommand.choiceArgument.transfer.meta.values["x402.memo"]
    ).toBeUndefined();
    const row = await stash.get((r.json() as { submissionRef: string }).submissionRef);
    expect(row!.memo).toBeUndefined();
    await app.close();
  });

  it("rejects a non-string / blank / oversized memo with 400 (before any prepare)", async () => {
    stubScan();
    const app = Fastify();
    const { svc, prepare } = makeSvc(createInMemoryTfStashStore());
    await registerWalletRoutes(app, svc);
    const bad: Array<Record<string, unknown>> = [
      { party: PAYER, receiver: MERCHANT, amount: "0.25", memo: 123 },
      { party: PAYER, receiver: MERCHANT, amount: "0.25", memo: "" },
      { party: PAYER, receiver: MERCHANT, amount: "0.25", memo: "   " },
      { party: PAYER, receiver: MERCHANT, amount: "0.25", memo: "x".repeat(513) },
    ];
    for (const payload of bad) {
      const r = await app.inject({ method: "POST", url: "/v1/wallet/pay/prepare", payload });
      expect(r.statusCode).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("clamps a huge requested executeBeforeSeconds to the max", async () => {
    stubScan();
    const app = Fastify();
    const { svc } = makeSvc(createInMemoryTfStashStore());
    await registerWalletRoutes(app, svc);
    const before = Date.now();
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: {
        party: PAYER,
        receiver: MERCHANT,
        amount: "0.25",
        executeBeforeSeconds: 99_999,
      },
    });
    expect(r.statusCode).toBe(200);
    const eb = new Date((r.json() as { executeBefore: string }).executeBefore);
    expect(eb.getTime() - before).toBeLessThanOrEqual(600_000 + 5_000);
    await app.close();
  });

  it("rejects malformed party / self-payment / bad amounts before any work", async () => {
    stubScan();
    const app = Fastify();
    const { svc, prepare } = makeSvc(createInMemoryTfStashStore());
    await registerWalletRoutes(app, svc);
    const cases = [
      { party: "not-a-party", receiver: MERCHANT, amount: "0.25" },
      { party: PAYER, receiver: PAYER, amount: "0.25" },
      { party: PAYER, receiver: MERCHANT, amount: "abc" },
      { party: PAYER, receiver: MERCHANT, amount: "0" },
      { party: PAYER, receiver: MERCHANT, amount: "-1" },
    ];
    for (const payload of cases) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/wallet/pay/prepare",
        payload,
      });
      expect(r.statusCode).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it("insufficient holdings → honest 400 with the scanned balance", async () => {
    stubScan();
    const app = Fastify();
    const { svc } = makeSvc(createInMemoryTfStashStore(), {
      holdings: [{ cid: "00h1", amount: "0.1000000000" }],
    });
    await registerWalletRoutes(app, svc);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "5" },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toContain("insufficient");
    await app.close();
  });

  it("per-payer stash cap → 429", async () => {
    stubScan();
    const stash = createInMemoryTfStashStore();
    const future = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 2; i++) {
      await stash.create({
        payer: PAYER,
        receiver: MERCHANT,
        amount: "0.25",
        instrumentAdmin: DSO,
        instrumentId: "Amulet",
        executeBefore: future,
        txHash: "h",
        preparedTx: "p",
      });
    }
    const app = Fastify();
    const { svc } = makeSvc(stash, { capPerPayer: 2 });
    await registerWalletRoutes(app, svc);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "0.25" },
    });
    expect(r.statusCode).toBe(429);
    await app.close();
  });

  it("registry non-2xx → relayError 502 (nothing stashed)", async () => {
    stubScan({ factoryStatus: 400 });
    const stash = createInMemoryTfStashStore();
    const app = Fastify();
    const { svc } = makeSvc(stash);
    await registerWalletRoutes(app, svc);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "0.25" },
    });
    expect(r.statusCode).toBe(502);
    expect(await stash.livePayerCount(PAYER, new Date())).toBe(0);
    await app.close();
  });
});

describe("POST /v1/wallet/pay/commit", () => {
  async function preparedRef(
    app: ReturnType<typeof Fastify>,
    stash: TfStashStore
  ): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/prepare",
      payload: { party: PAYER, receiver: MERCHANT, amount: "0.25" },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { submissionRef: string }).submissionRef;
  }

  it("attaches the signing bundle once; the stash holds it verbatim", async () => {
    stubScan();
    const stash = createInMemoryTfStashStore();
    const app = Fastify();
    const { svc } = makeSvc(stash);
    await registerWalletRoutes(app, svc);
    const ref = await preparedRef(app, stash);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: { party: PAYER, submissionRef: ref, ...sigBundle() },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ committed: true, submissionRef: ref });
    const row = await stash.get(ref);
    const bundle = JSON.parse(row!.signature!) as {
      hashingSchemeVersion: string;
      partySignatures: { signatures: Array<{ party: string }> };
    };
    expect(bundle.hashingSchemeVersion).toBe("HASHING_SCHEME_VERSION_V2");
    expect(bundle.partySignatures.signatures[0]!.party).toBe(PAYER);
    await app.close();
  });

  it("double commit → 409; unknown ref → 404; wrong payer reads as 404", async () => {
    stubScan();
    const stash = createInMemoryTfStashStore();
    const app = Fastify();
    const { svc } = makeSvc(stash);
    await registerWalletRoutes(app, svc);
    const ref = await preparedRef(app, stash);
    const first = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: { party: PAYER, submissionRef: ref, ...sigBundle() },
    });
    expect(first.statusCode).toBe(200);
    const dup = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: { party: PAYER, submissionRef: ref, ...sigBundle() },
    });
    expect(dup.statusCode).toBe(409);
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: { party: PAYER, submissionRef: "no-such-ref", ...sigBundle() },
    });
    expect(unknown.statusCode).toBe(404);
    // Wrong payer: valid ref, someone else's party + matching bundle party —
    // must be indistinguishable from an unknown ref.
    const other = "other::1220cccccccccccccccc";
    const probe = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: { party: other, submissionRef: ref, ...sigBundle(other) },
    });
    expect(probe.statusCode).toBe(404);
    await app.close();
  });

  it("expired ref → 410 with a re-prepare hint", async () => {
    stubScan();
    const stash = createInMemoryTfStashStore();
    const ref = await stash.create({
      payer: PAYER,
      receiver: MERCHANT,
      amount: "0.25",
      instrumentAdmin: DSO,
      instrumentId: "Amulet",
      executeBefore: new Date(Date.now() - 1000).toISOString(),
      txHash: "h",
      preparedTx: "p",
    });
    const app = Fastify();
    const { svc } = makeSvc(stash);
    await registerWalletRoutes(app, svc);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: { party: PAYER, submissionRef: ref, ...sigBundle() },
    });
    expect(r.statusCode).toBe(410);
    await app.close();
  });

  it("bundle party mismatch → 400; missing fields → 400", async () => {
    stubScan();
    const app = Fastify();
    const { svc } = makeSvc(createInMemoryTfStashStore());
    await registerWalletRoutes(app, svc);
    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: {
        party: PAYER,
        submissionRef: "ref",
        ...sigBundle("someone-else::1220ffff"),
      },
    });
    expect(mismatch.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/wallet/pay/commit",
      payload: { party: PAYER },
    });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });
});
