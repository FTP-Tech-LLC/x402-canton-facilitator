import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { LedgerTransaction } from "@ftptech/x402-canton-ledger";
import { registerWalletRoutes, type WalletRelayServices } from "./wallet.js";
import {
  type TcUpdate,
  linkSettlementsToFills,
  linkSettlementsWithLookback,
  parseTradecraftUpdatesQuery,
  summarizeTradecraftTransaction,
  tradecraftHelperTemplate,
  tradecraftReadIds,
  tradecraftUpdatesFilter,
} from "./tradecraft-updates.js";

// Shapes as the MainNet participant returned them on 2026-11-03 (our own test
// agent's CBTC sell: fill, then a batch settlement), with other traders'
// parties replaced by placeholders.
const P = "agent::1220aaaa";
const VENUE = "CantonSwap::1220venue";
const VAULT = "cs-vault::1220vault";
const OTHER_TRADER = "trader::1220other";
const DSO = "DSO::1220dso";
const PKG = "cc7b9c85";
const ORDER_T = `${PKG}:TC.V4.SwapOrderV2:SwapOrder`;
const REQ_T = `${PKG}:TC.V4.Settle.WithdrawalRequest:SettlementWithdrawalRequest`;
const ALLOC_IFACE = "aa11:Splice.Api.Token.AllocationV2:Allocation";
const ORDER_ID = "#canton-swap-amm-vault:TC.V4.SwapOrderV2:SwapOrder";
const REQ_ID = "#canton-swap-amm-vault:TC.V4.Settle.WithdrawalRequest:SettlementWithdrawalRequest";
const ALLOC_ID = "#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:Allocation";
const BATCHER_ID = "#canton-swap-amm-vault:TC.V4.OrderBatch:SwapOrderBatcher";

const created = (contractId: string, templateId: string, createArgument: Record<string, unknown>, view?: Record<string, unknown>) => ({
  CreatedEvent: {
    contractId,
    templateId,
    createArgument,
    signatories: [],
    observers: [],
    packageName: "x",
    ...(view ? { interfaceViews: [{ interfaceId: ALLOC_IFACE, viewValue: view }] } : {}),
  },
});
const exercised = (contractId: string, templateId: string, choice: string, choiceArgument: unknown, exerciseResult: unknown, consuming = true) => ({
  ExercisedEvent: { contractId, templateId, choice, choiceArgument, exerciseResult, consuming, actingParties: [VENUE] },
});
const order = (actor: string) => ({
  actor,
  venue: VENUE,
  vault: VAULT,
  ammId: "TC CBTC/CC LP",
  what: { tag: "Short", value: { instrument: { admin: "cbtc-network::1220cb", id: "CBTC" }, amount: "0.0000151820" } },
  minOut: "11.8089115611",
  createdAt: "2026-10-17T14:12:42.550769Z",
});
const allocView = (owner: string, meta: Record<string, string> | undefined, funding: Record<string, string>) => ({
  settlement: { executors: [VENUE], id: "tc-settlement", cid: null, meta: { values: {} } },
  allocation: {
    admin: DSO,
    authorizer: { owner, provider: null, id: "" },
    transferLegSides: [],
    settlementDeadline: null,
    nextIterationFunding: funding,
    committed: true,
    meta: { values: meta ?? {} },
  },
});
const settle = (oldCid: string, newCid: string, side: string, otherside: string, amount: string) =>
  exercised(
    oldCid,
    `${PKG}:Splice.AmuletAllocationV2:AmuletAllocationV2`,
    "Allocation_Settle",
    { actors: [DSO, VENUE], extraTransferLegSides: [{ transferLegId: "leg-to-actor", side, otherside: { owner: otherside, provider: null, id: "" }, amount, instrumentId: "Amulet", meta: { values: {} } }] },
    { output: { tag: "AllocationResult_Settled", value: { nextIterationAllocationCid: newCid } } }
  );
const tx = (offset: number, events: LedgerTransaction["events"]): LedgerTransaction => ({
  updateId: `u${offset}`,
  offset,
  recordTime: "2026-10-17T14:13:13Z",
  events,
});
const none = new Map<string, Record<string, unknown>>();
const createdBefore = (...cids: string[]) => new Map(cids.map((c) => [c, order(P)] as const));
/** The same event as the participant marks it: true = it changes the party's
 *  own contracts, false = the party only witnessed it. */
const acs = <E extends { CreatedEvent?: object; ExercisedEvent?: object }>(ev: E, acsDelta: boolean): E =>
  (ev.CreatedEvent
    ? { CreatedEvent: { ...ev.CreatedEvent, acsDelta } }
    : { ExercisedEvent: { ...ev.ExercisedEvent, acsDelta } }) as unknown as E;

describe("summarizeTradecraftTransaction", () => {
  it("reports the party's own order with what it sells", async () => {
    const s = await summarizeTradecraftTransaction(P, tx(1, [created("o1", ORDER_T, order(P))]), none);
    expect(s?.orders).toEqual([
      {
        kind: "created",
        orderCid: "o1",
        ammId: "TC CBTC/CC LP",
        sell: { instrument: { admin: "cbtc-network::1220cb", id: "CBTC" }, amount: "0.0000151820" },
        minOut: "11.8089115611",
        createdAt: "2026-10-17T14:12:42.550769Z",
      },
    ]);
  });

  it("maps a fill and a cancellation with its reason, with the terms of orders created earlier on the page", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(2, [
        exercised("o1", ORDER_T, "Order_Complete", {}, "Order_CompleteResult"),
        exercised("o2", ORDER_T, "Order_Cancel", { reason: "Output 0.0000075908 is below minimum 0.0000151815" }, { reason: "x" }),
        exercised("o3", ORDER_T, "SwapOrder_WithdrawV3", {}, {}),
        acs(exercised("foreign", ORDER_T, "Order_Complete", {}, "Order_CompleteResult"), false),
      ]),
      createdBefore("o1", "o2", "o3")
    );
    const terms = {
      ammId: "TC CBTC/CC LP",
      sell: { instrument: { admin: "cbtc-network::1220cb", id: "CBTC" }, amount: "0.0000151820" },
      minOut: "11.8089115611",
      createdAt: "2026-10-17T14:12:42.550769Z",
    };
    expect(s?.orders).toEqual([
      { kind: "filled", orderCid: "o1", choice: "Order_Complete", ...terms },
      { kind: "cancelled", orderCid: "o2", choice: "Order_Cancel", ...terms, reason: "Output 0.0000075908 is below minimum 0.0000151815" },
      { kind: "withdrawn", orderCid: "o3", choice: "SwapOrder_WithdrawV3", ...terms },
    ]);
    expect(s?.anomalies).toBeUndefined();
  });

  it("follows an order created and filled in one transaction, and skips another trader's order", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(3, [
        acs(created("o9", ORDER_T, order(P)), false),
        acs(exercised("o9", ORDER_T, "Order_Complete", {}, "r"), false),
        acs(created("x1", ORDER_T, order(OTHER_TRADER)), false),
        acs(exercised("x1", ORDER_T, "Order_Complete", {}, "r"), false),
      ]),
      none
    );
    // created and archived in one transaction: the participant marks both
    // false (no change to the active set), yet the order is the party's.
    expect(s?.orders.map((o) => `${o.kind}:${o.orderCid}`)).toEqual(["created:o9", "filled:o9"]);
  });

  it("keeps only the party's own settlement legs from a batch settlement", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(4, [
        // the vault paying another trader, which every batch witness sees
        settle("v-old", "v-new", "SenderSide", OTHER_TRADER, "1.0606497279"),
        created("v-new", `${PKG}:Splice.AmuletAllocationV2:AmuletAllocationV2`, {}, allocView(VAULT, { "tradecraft.fi/amm-id": "TC CC/TRKXAI LP", "tradecraft.fi/instrument-id": "Amulet" }, { Amulet: "125585.9" })),
        // the party's own allocation receiving the fill
        settle("p-old", "p-new", "ReceiverSide", VAULT, "11.9281722513"),
        created("p-new", `${PKG}:Splice.AmuletAllocationV2:AmuletAllocationV2`, {}, allocView(P, { "tradecraft.fi/amm-id": "TC CBTC/CC LP", "tradecraft.fi/instrument-id": "Amulet" }, { Amulet: "18.9281722513" })),
      ]),
      none
    );
    expect(s?.allocations).toEqual([
      {
        allocationCid: "p-new",
        previousAllocationCid: "p-old",
        ammId: "TC CBTC/CC LP",
        instrument: { admin: DSO, id: "Amulet" },
        fundingAfter: { Amulet: "18.9281722513" },
        legs: [{ side: "receive", amount: "11.9281722513", instrumentId: "Amulet", counterparty: VAULT, transferLegId: "leg-to-actor" }],
      },
    ]);
    expect(JSON.stringify(s)).not.toContain(OTHER_TRADER);
  });

  it("ignores the party's allocations that carry no Tradecraft metadata (x402 payments)", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(5, [created("a1", `${PKG}:Splice.AmuletAllocationV2:AmuletAllocationV2`, {}, allocView(P, undefined, { Amulet: "1" }))]),
      none
    );
    expect(s).toBeUndefined();
  });

  it("reports the party's withdrawal request and its outcome", async () => {
    const s1 = await summarizeTradecraftTransaction(
      P,
      tx(6, [created("r1", REQ_T, { actor: P, venue: VENUE, ammId: "TC CBTC/CC LP", instrument: { admin: DSO, id: "Amulet" }, createdAt: "t" })]),
      none
    );
    expect(s1?.withdrawals).toEqual([{ kind: "requested", requestCid: "r1", ammId: "TC CBTC/CC LP", instrument: { admin: DSO, id: "Amulet" } }]);
    const s2 = await summarizeTradecraftTransaction(
      P,
      tx(7, [exercised("r1", REQ_T, "SettlementWithdrawalRequest_Reject", { reason: { tag: "RejectReason_PendingSettlements" } }, {})]),
      new Map([["r1", { actor: P, ammId: "TC CBTC/CC LP", instrument: { admin: DSO, id: "Amulet" } }]])
    );
    expect(s2?.withdrawals).toEqual([
      {
        kind: "rejected",
        requestCid: "r1",
        choice: "SettlementWithdrawalRequest_Reject",
        ammId: "TC CBTC/CC LP",
        instrument: { admin: DSO, id: "Amulet" },
        reason: { tag: "RejectReason_PendingSettlements" },
      },
    ]);
  });

  it("reports an archive the participant marks as the party's without terms when its create is elsewhere, skips a witnessed one, and flags one it cannot place", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(9, [
        acs(exercised("foreign", ORDER_T, "Order_Complete", {}, "r"), false),
        acs(exercised("o1", ORDER_T, "Order_Complete", {}, "r"), true),
        exercised("o2", ORDER_T, "Order_Complete", {}, "r"),
      ]),
      none
    );
    expect(s?.orders).toEqual([{ kind: "filled", orderCid: "o1", choice: "Order_Complete" }]);
    expect(s?.anomalies).toEqual([{ detail: "o2: Order_Complete with no acsDelta, so whose contract it closed cannot be told" }]);
  });

  it("names every outcome of DAR 1.3.17 and leaves an unknown choice as archived with its name", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(10, [
        exercised("e1", ORDER_T, "Order_Expire", {}, {}),
        exercised("e2", ORDER_T, "SwapOrder_ExpireV3", {}, {}),
        exercised("w1", ORDER_T, "Order_Withdraw", {}, {}),
        exercised("c1", ORDER_T, "SwapOrder_CancelAndRefund", {}, {}),
        exercised("u1", ORDER_T, "SwapOrder_Consume", {}, {}),
      ]),
      createdBefore("e1", "e2", "w1", "c1", "u1")
    );
    expect(s?.orders.map((o) => `${o.kind}:${o.choice}`)).toEqual([
      "expired:Order_Expire",
      "expired:SwapOrder_ExpireV3",
      "withdrawn:Order_Withdraw",
      "cancelled:SwapOrder_CancelAndRefund",
      "archived:SwapOrder_Consume",
    ]);
  });

  it("keeps the party's allocation created and spent in one transaction, and reports its own records it cannot read", async () => {
    const ALLOC_T = `${PKG}:Splice.AmuletAllocationV2:AmuletAllocationV2`;
    const tcMeta = { "tradecraft.fi/amm-id": "TC CBTC/CC LP", "tradecraft.fi/instrument-id": "Amulet" };
    const noAdmin = allocView(P, tcMeta, {});
    delete (noAdmin.allocation as { admin?: string }).admin;
    const s = await summarizeTradecraftTransaction(
      P,
      tx(11, [
        // a top-up's funding allocation: created and settled away in one transaction
        acs(created("t-new", ALLOC_T, {}, allocView(P, tcMeta, { Amulet: "6" })), false),
        acs(created("v-new", ALLOC_T, {}, allocView(VAULT, tcMeta, { Amulet: "9" })), false),
        acs(created("n-new", ALLOC_T, {}, noAdmin), true),
        settle("p-old", "p-new", "SomeNewSide", VAULT, "1.0"),
        acs(created("p-new", ALLOC_T, {}, allocView(P, tcMeta, { Amulet: "2" })), true),
        exercised("q-old", ALLOC_T, "Allocation_Settle", { actors: [VENUE] }, { output: { tag: "AllocationResult_Settled", value: { nextIterationAllocationCid: "q-new" } } }),
        acs(created("q-new", ALLOC_T, {}, allocView(P, tcMeta, { Amulet: "3" })), true),
      ]),
      none
    );
    expect(s?.allocations.map((a) => [a.allocationCid, a.legs])).toEqual([
      ["t-new", []],
      ["p-new", []],
      ["q-new", []],
    ]);
    expect(s?.anomalies).toEqual([
      { ammId: "TC CBTC/CC LP", detail: "n-new: a Tradecraft allocation without its instrument admin" },
      { ammId: "TC CBTC/CC LP", detail: "p-old: a settlement leg that cannot be read" },
      { ammId: "TC CBTC/CC LP", detail: "q-old: a settlement whose legs cannot be read" },
    ]);
  });

  it("reports the party's order whose sale cannot be read", async () => {
    const odd = { ...order(P), what: { tag: "Long", value: {} } };
    const s = await summarizeTradecraftTransaction(P, tx(12, [created("o1", ORDER_T, odd)]), none);
    expect(s?.anomalies).toEqual([{ ammId: "TC CBTC/CC LP", detail: "o1: an order whose sale cannot be read" }]);
  });

  it("returns nothing for a transaction with nothing of the party's", async () => {
    expect(await summarizeTradecraftTransaction(P, tx(8, []), none)).toBeUndefined();
  });
});

describe("query parsing and filter", () => {
  it("defaults, clamps and refuses", () => {
    expect(parseTradecraftUpdatesQuery({})).toEqual({ ok: true, after: 0, limit: 50, orderCids: false });
    expect(parseTradecraftUpdatesQuery({ after: "1970240", limit: "500", orderCids: "true" })).toEqual({ ok: true, after: 1970240, limit: 200, orderCids: true });
    for (const bad of [{ after: "-1" }, { after: "1e3" }, { after: "abc" }, { limit: "0" }, { limit: "2.5" }, { limit: "x" }]) {
      expect(parseTradecraftUpdatesQuery(bad).ok).toBe(false);
    }
  });

  it("builds the filter from the allowlisted ids only", () => {
    const ids = tradecraftReadIds([BATCHER_ID, ORDER_ID, ALLOC_ID]);
    expect(ids).toEqual({ swapOrder: ORDER_ID, allocation: ALLOC_ID });
    const f = JSON.stringify(tradecraftUpdatesFilter(P, ids));
    expect(f).toContain(ORDER_ID);
    expect(f).toContain(ALLOC_ID);
    expect(f).not.toContain(BATCHER_ID);
    expect(f).toContain('"includeInterfaceView":true');
  });
});

describe("GET /v1/wallet/:party/tradecraft-updates", () => {
  function appWith(ids: string[] | undefined, page?: { transactions: LedgerTransaction[]; rows: number; lastOffset?: number }, over: Record<string, unknown> = {}) {
    const getUpdatesPage = vi.fn(async () => page ?? { transactions: [], rows: 0, lastOffset: undefined });
    const getEventsByContractId = vi.fn(async (_q: { contractId: string }): Promise<unknown> => ({ created: { createArgument: { actor: P } }, archived: true }));
    const client = {
      getLedgerEnd: vi.fn(async () => ({ offset: 1000 })),
      getUpdatesPage,
      getEventsByContractId,
      getPartyDetails: vi.fn(async (party: string) => ({ isLocal: party === P })),
      queryActiveContracts: vi.fn(async () => []),
      ...over,
    };
    const s = {
      client,
      facilitatorParty: "facilitator::1220fac",
      synchronizerId: "global-domain::12201",
      userId: "facilitator@clients",
      scanUrl: "http://scan.test",
      enableAgentWallet: true,
      walletSubmitChoices: ["TransferFactory_Transfer"],
      agentWalletApiKey: undefined,
      walletReadIds: ids,
    } as unknown as WalletRelayServices;
    const a = Fastify();
    return { ready: registerWalletRoutes(a, s).then(() => a), getUpdatesPage, getEventsByContractId, client };
  }
  const url = (q = "") => `/v1/wallet/${encodeURIComponent(P)}/tradecraft-updates${q}`;

  it("is off unless the operator lists the swap-order template and the allocation interface", async () => {
    expect((await (await appWith([BATCHER_ID, ALLOC_ID]).ready).inject({ method: "GET", url: url() })).statusCode).toBe(404);
    expect((await (await appWith([BATCHER_ID, ORDER_ID]).ready).inject({ method: "GET", url: url() })).statusCode).toBe(404);
  });

  it("answers only for a party this facilitator hosts", async () => {
    const { ready, getUpdatesPage } = appWith([ORDER_ID, ALLOC_ID]);
    const a = await ready;
    const vault = await a.inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(VAULT)}/tradecraft-updates` });
    expect(vault.statusCode).toBe(404);
    expect(getUpdatesPage).not.toHaveBeenCalled();
    const unsure = appWith([ORDER_ID, ALLOC_ID], undefined, { getPartyDetails: vi.fn(async () => { throw new Error("participant down"); }) });
    expect((await (await unsure.ready).inject({ method: "GET", url: url() })).statusCode).toBe(503);
  });

  it("refuses a malformed cursor or limit", async () => {
    const { ready } = appWith([ORDER_ID, ALLOC_ID]);
    const a = await ready;
    expect((await a.inject({ method: "GET", url: url("?after=-5") })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: url("?limit=zero") })).statusCode).toBe(400);
  });

  it("reads one bounded page for the party and summarizes it", async () => {
    const page = {
      transactions: [tx(10, [created("o1", ORDER_T, order(P))]), tx(11, [acs(exercised("o0", ORDER_T, "Order_Complete", {}, "r"), true)])],
      rows: 2,
      lastOffset: 11,
    };
    const { ready, getUpdatesPage, getEventsByContractId } = appWith([ORDER_ID, ALLOC_ID], page);
    const r = await (await ready).inject({ method: "GET", url: url("?after=5&limit=999") });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ party: P, after: 5, ledgerEnd: 1000, complete: true, next: 1000 });
    expect(body.updates.map((u: { offset: number }) => u.offset)).toEqual([10, 11]);
    // o0 was created before the page: reported without its terms, and nothing is looked up
    expect(body.updates[1].orders).toEqual([{ kind: "filled", orderCid: "o0", choice: "Order_Complete" }]);
    const call = (getUpdatesPage.mock.calls[0] as unknown as [{ beginExclusive: number; endInclusive: number; limit: number; filter: unknown }])[0];
    expect(call).toMatchObject({ beginExclusive: 5, endInclusive: 1000, limit: 200 });
    expect(JSON.stringify(call.filter)).toContain(P);
    expect(getEventsByContractId).not.toHaveBeenCalled();
  });

  it("gives an archive the terms of its create earlier on the same page, and skips another trader's", async () => {
    const page = {
      transactions: [
        tx(10, [created("o1", ORDER_T, order(P)), created("x1", ORDER_T, order(OTHER_TRADER))]),
        tx(11, [acs(exercised("o1", ORDER_T, "Order_Complete", {}, "r"), true), acs(exercised("x1", ORDER_T, "Order_Complete", {}, "r"), false)]),
      ],
      rows: 2,
      lastOffset: 11,
    };
    const { ready, getEventsByContractId } = appWith([ORDER_ID, ALLOC_ID], page);
    const body = (await (await ready).inject({ method: "GET", url: url() })).json();
    expect(body.updates[1].orders).toEqual([
      expect.objectContaining({ kind: "filled", orderCid: "o1", sell: { instrument: { admin: "cbtc-network::1220cb", id: "CBTC" }, amount: "0.0000151820" } }),
    ]);
    expect(getEventsByContractId).not.toHaveBeenCalled();
  });

  it("returns a resumable cursor when the page is full", async () => {
    const page = { transactions: [tx(40, [])], rows: 2, lastOffset: 41 };
    const { ready } = appWith([ORDER_ID, ALLOC_ID], page);
    const body = (await (await ready).inject({ method: "GET", url: url("?after=30&limit=2") })).json();
    expect(body).toMatchObject({ complete: false, next: 41, updates: [] });
  });

  it("answers at once when the cursor is at the ledger end", async () => {
    const { ready, getUpdatesPage } = appWith([ORDER_ID, ALLOC_ID]);
    const body = (await (await ready).inject({ method: "GET", url: url("?after=1000") })).json();
    expect(body).toMatchObject({ complete: true, next: 1000, updates: [] });
    expect(getUpdatesPage).not.toHaveBeenCalled();
  });

  it("refuses a cursor past the ledger end instead of answering nothing new forever", async () => {
    const { ready, getUpdatesPage } = appWith([ORDER_ID, ALLOC_ID]);
    const r = await (await ready).inject({ method: "GET", url: url("?after=1001") });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ ledgerEnd: 1000 });
    expect(getUpdatesPage).not.toHaveBeenCalled();
  });

  it("says whether it reads withdrawal requests", async () => {
    const without = (await (await appWith([ORDER_ID, ALLOC_ID]).ready).inject({ method: "GET", url: url() })).json();
    const withReq = (await (await appWith([ORDER_ID, ALLOC_ID, REQ_ID]).ready).inject({ method: "GET", url: url() })).json();
    expect([without.withdrawalsRead, withReq.withdrawalsRead]).toEqual([false, true]);
  });

  it("tags its offsets with the participant they belong to", async () => {
    const a = (await (await appWith([ORDER_ID, ALLOC_ID]).ready).inject({ method: "GET", url: url() })).json();
    const b = (await (await appWith([ORDER_ID, ALLOC_ID]).ready).inject({ method: "GET", url: url() })).json();
    expect(a.participant).toMatch(/^[0-9a-f]{16}$/);
    expect(b.participant).toBe(a.participant);
  });

  it("says so when the ledger client cannot read updates", async () => {
    const { ready } = appWith([ORDER_ID, ALLOC_ID], undefined, { getUpdatesPage: undefined });
    expect((await (await ready).inject({ method: "GET", url: url() })).statusCode).toBe(501);
  });
});

// The venue's batch helper as a trader witnesses it (MainNet, 2026-11-04: two
// of our test agent's 6 CC orders on CC/eXAG completed in one call).
const HELPER_T = `${PKG}:TC.V4.AMMHelperContract:AMMHelperContract`;
const EXAG = { admin: "ember-silver::1220ex", id: "eXAG" };
const CC = { admin: DSO, id: "Amulet" };
const helper = (out: { admin: string; id: string }, done: Array<[string, string]>, extra: unknown[] = []) =>
  acs(
    exercised(
      "helper-1",
      HELPER_T,
      "AMMHelperContract_HandleOrderBatches",
      { completions: [[{ _1: out }, [...done.map(([swapCidV2, outputAmount]) => ({ tag: "OrderCompletion_SwapV2", value: { swapCidV2, outputAmount } })), ...extra]]], cancellations: [] },
      {},
      false
    ),
    false
  );
const ccOrder = (amount: string) => ({ ...order(P), ammId: "TC CC/eXAG LP", what: { tag: "Short", value: { instrument: CC, amount } } });

describe("fill outputs from the venue's batch helper", () => {
  it("gives each of the party's fills its output and nothing of another trader's in the same batch", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(20, [
        helper(EXAG, [["o1", "0.0114641650"], ["x1", "0.5000000000"], ["o2", "0.0114638532"]]),
        exercised("o1", ORDER_T, "Order_Complete", {}, "Order_CompleteResult"),
        acs(exercised("x1", ORDER_T, "Order_Complete", {}, "Order_CompleteResult"), false),
        exercised("o2", ORDER_T, "Order_Complete", {}, "Order_CompleteResult"),
      ]),
      new Map([["o1", ccOrder("6.0000000000")], ["o2", ccOrder("6.0000000000")]])
    );
    expect(s?.orders.map((o) => [o.orderCid, o.kind, o.output])).toEqual([
      ["o1", "filled", { instrument: EXAG, amount: "0.0114641650" }],
      ["o2", "filled", { instrument: EXAG, amount: "0.0114638532" }],
    ]);
    expect(JSON.stringify(s)).not.toContain("x1");
    expect(JSON.stringify(s)).not.toContain("0.5000000000");
  });

  it("reports a fill without an output when the helper's argument has another shape, and flags nothing", async () => {
    const s = await summarizeTradecraftTransaction(
      P,
      tx(21, [
        acs(exercised("helper-1", HELPER_T, "AMMHelperContract_HandleOrderBatches", { completions: { o1: "1" } }, {}, false), false),
        exercised("o1", ORDER_T, "Order_Complete", {}, "r"),
        helper(EXAG, [["o2", "not-an-amount"]], [{ tag: "OrderCompletion_Other", value: { swapCidV2: "o3", outputAmount: "1.0" } }]),
        exercised("o2", ORDER_T, "Order_Complete", {}, "r"),
        exercised("o3", ORDER_T, "Order_Complete", {}, "r"),
      ]),
      createdBefore("o1", "o2", "o3")
    );
    expect(s?.orders.map((o) => o.output)).toEqual([undefined, undefined, undefined]);
    expect(s?.anomalies).toBeUndefined();
  });

  it("reads the helper of the swap order's package and nothing when no swap order is listed", () => {
    expect(tradecraftHelperTemplate(ORDER_ID)).toBe("#canton-swap-amm-vault:TC.V4.AMMHelperContract:AMMHelperContract");
    expect(tradecraftHelperTemplate(`${PKG}:TC.V4.SwapOrderV2:SwapOrder`)).toBe(HELPER_T);
    expect(tradecraftHelperTemplate(undefined)).toBeUndefined();
    const f = JSON.stringify(tradecraftUpdatesFilter(P, tradecraftReadIds([ORDER_ID, ALLOC_ID])));
    expect(f).toContain("#canton-swap-amm-vault:TC.V4.AMMHelperContract:AMMHelperContract");
    expect(JSON.stringify(tradecraftUpdatesFilter(P, tradecraftReadIds([ALLOC_ID])))).not.toContain("AMMHelperContract");
  });
});

/** Summaries as the relay builds them, for the linking rules. */
const filledAt = (
  offset: number,
  orderCid: string,
  out: string,
  opts: { sell?: string | null; ammId?: string | null; outId?: typeof EXAG; kind?: "filled" | "archived"; noOutput?: boolean } = {}
): TcUpdate => {
  const sell = opts.sell === undefined ? "6.0000000000" : opts.sell;
  const ammId = opts.ammId === undefined ? "TC CC/eXAG LP" : opts.ammId;
  return {
    offset,
    updateId: `u${offset}`,
    orders: [
      {
        kind: opts.kind ?? "filled",
        orderCid,
        choice: opts.kind === "archived" ? "Order_SomethingNew" : "Order_Complete",
        ...(ammId !== null ? { ammId } : {}),
        ...(sell !== null ? { sell: { instrument: CC, amount: sell } } : {}),
        ...(opts.noOutput || opts.kind === "archived" ? {} : { output: { instrument: opts.outId ?? EXAG, amount: out } }),
      },
    ],
    allocations: [],
    withdrawals: [],
  };
};
const tradeAllocs = (offset: number, trade: string, sent: string, got: string, ammId = "TC CC/eXAG LP"): TcUpdate["allocations"] => [
  { allocationCid: `cc${offset}${trade}`, ammId, instrument: CC, fundingAfter: {}, legs: [{ side: "send", amount: sent, instrumentId: "Amulet", counterparty: VAULT, transferLegId: `${trade}-from-actor` }] },
  { allocationCid: `ex${offset}${trade}`, ammId, instrument: EXAG, fundingAfter: {}, legs: [{ side: "receive", amount: got, instrumentId: "eXAG", counterparty: VAULT, transferLegId: `${trade}-to-actor` }] },
];
const settledAt = (offset: number, trade: string, sent: string, got: string, ammId = "TC CC/eXAG LP"): TcUpdate => ({
  offset,
  updateId: `u${offset}`,
  orders: [],
  allocations: tradeAllocs(offset, trade, sent, got, ammId),
  withdrawals: [],
});
const tiedTo = (u: TcUpdate) => u.allocations.flatMap((c) => c.legs.map((l) => l.orderCid));

describe("linkSettlementsToFills", () => {
  it("ties both legs of a trade to the one fill with that output and input", () => {
    const s = settledAt(31, "T1", "6.0000000000", "0.0114641650");
    linkSettlementsToFills([filledAt(30, "o1", "0.0114641650", { sell: "6.0000000000", ammId: "TC CC/eXAG LP" }), s]);
    expect(tiedTo(s)).toEqual(["o1", "o1"]);
  });

  it("ties each trade of one batch to its own order, whatever the settlement order, also two trades in one transaction", () => {
    const a = settledAt(32, "TB", "6.0000000000", "0.0114638532");
    const b = settledAt(33, "TA", "6.0000000000", "0.0114641650");
    linkSettlementsToFills([filledAt(30, "o1", "0.0114641650"), filledAt(30, "o2", "0.0114638532"), a, b]);
    expect([tiedTo(a), tiedTo(b)]).toEqual([["o2", "o2"], ["o1", "o1"]]);
    const both: TcUpdate = { offset: 41, updateId: "u41", orders: [], allocations: [...tradeAllocs(41, "TC", "6.0000000000", "0.0200000001"), ...tradeAllocs(41, "TD", "6.0000000000", "0.0200000002")], withdrawals: [] };
    linkSettlementsToFills([filledAt(40, "o3", "0.0200000001"), filledAt(40, "o4", "0.0200000002"), both]);
    expect(tiedTo(both)).toEqual(["o3", "o3", "o4", "o4"]);
  });

  it("ties nothing when two fills before the settlement share its output; a later fill does not count", () => {
    const s = settledAt(31, "T1", "6.0000000000", "0.0114641650");
    linkSettlementsToFills([filledAt(29, "o1", "0.0114641650"), filledAt(30, "o2", "0.011464165"), s]);
    expect(tiedTo(s)).toEqual([undefined, undefined]);
    // MainNet 2026-10-18: two CBTC fills got 0.0000073805, twenty minutes
    // apart. The first settlement sees one fill with its output; the second
    // sees two (one tied already) and stays untied.
    const first = settledAt(21, "T0", "6.0000000000", "0.0000073805");
    const second = settledAt(31, "T1", "6.0000000000", "0.0000073805");
    linkSettlementsToFills([filledAt(20, "o5", "0.0000073805"), first, filledAt(30, "o6", "0.0000073805"), second]);
    expect([tiedTo(first), tiedTo(second)]).toEqual([["o5", "o5"], [undefined, undefined]]);
  });

  it("ties nothing when a fill in the settlement's own transaction shares its output", () => {
    const sameTx: TcUpdate = { ...filledAt(31, "oT", "0.0114641650"), allocations: tradeAllocs(31, "T1", "6.0000000000", "0.0114641650") };
    linkSettlementsToFills([filledAt(30, "oX", "0.0114641650"), sameTx]);
    expect(tiedTo(sameTx)).toEqual([undefined, undefined]);
  });

  it("ties no fill whose pool and input are not known", () => {
    const s = settledAt(31, "T1", "6.0000000000", "0.0114641650");
    linkSettlementsToFills([filledAt(30, "o1", "0.0114641650", { sell: null, ammId: null }), s]);
    expect(tiedTo(s)).toEqual([undefined, undefined]);
  });

  it("does not tie a settlement before or in the same transaction as the fill, on another pool or input, nor top-ups, nor a trade id on two legs of one side", () => {
    const early = settledAt(30, "T0", "6.0000000000", "0.0114641650");
    const otherPool = settledAt(41, "T2", "6.0000000000", "0.0100000000", "TC CC/eXAU LP");
    const otherInput = settledAt(42, "T3", "7.0000000000", "0.0200000000");
    const topUp: TcUpdate = {
      offset: 43,
      updateId: "u43",
      orders: [],
      allocations: [{ allocationCid: "t1", ammId: "TC CC/eXAG LP", instrument: CC, fundingAfter: {}, legs: [{ side: "receive", amount: "6.0000000000", instrumentId: "Amulet", counterparty: P, transferLegId: "top-up-leg" }] }],
      withdrawals: [],
    };
    const sameTx: TcUpdate = { ...filledAt(44, "o4", "0.0300000000"), allocations: tradeAllocs(44, "T4", "6.0000000000", "0.0300000000") };
    const doubled: TcUpdate = {
      offset: 46,
      updateId: "u46",
      orders: [],
      allocations: [...tradeAllocs(46, "T5", "6.0000000000", "0.0400000000"), ...tradeAllocs(46, "T5", "7.0000000000", "0.0400000001")],
      withdrawals: [],
    };
    linkSettlementsToFills([
      early,
      filledAt(31, "o1", "0.0114641650"),
      filledAt(40, "o2", "0.0100000000", { ammId: "TC CC/eXAG LP" }),
      filledAt(40, "o3", "0.0200000000", { sell: "6.0000000000" }),
      otherPool,
      otherInput,
      topUp,
      sameTx,
      filledAt(45, "o5", "0.0400000000"),
      doubled,
    ]);
    expect([tiedTo(early), tiedTo(otherPool), tiedTo(otherInput), tiedTo(topUp), tiedTo(sameTx), tiedTo(doubled)]).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [undefined],
      [undefined, undefined],
      [undefined, undefined, undefined, undefined],
    ]);
  });
});

describe("linkSettlementsWithLookback", () => {
  // A fill as the ledger shows it to the party, its order created before.
  // An order created and filled before the page, as the ledger shows it.
  const fillTx = (offset: number, cid: string, out: string) =>
    tx(offset, [
      created(cid, ORDER_T, ccOrder("6.0000000000")),
      helper(EXAG, [[cid, out]]),
      exercised(cid, ORDER_T, "Order_Complete", {}, "r"),
    ]);

  it("reads the window before the page whole, then ties a fill found there", async () => {
    const page = [settledAt(50_001, "T1", "6.0000000000", "0.0114641650")];
    const read = vi.fn(async () => ({ transactions: [fillTx(49_990, "o1", "0.0114641650")], rows: 1 }));
    expect(await linkSettlementsWithLookback(P, page, 50_000, read)).toEqual({ reads: 1, complete: true });
    expect(read).toHaveBeenCalledWith(40_000, 50_000, 200);
    expect(tiedTo(page[0]!)).toEqual(["o1", "o1"]);
  });

  it("does not tie on the page alone: a fill with the same output just before it leaves the trade untied", async () => {
    const page = [filledAt(50_002, "o2", "0.0000076000"), settledAt(50_005, "T1", "6.0000000000", "0.0000076000")];
    const read = vi.fn(async () => ({ transactions: [fillTx(49_995, "o1", "0.0000076000")], rows: 1 }));
    expect(await linkSettlementsWithLookback(P, page, 50_000, read)).toEqual({ reads: 1, complete: true });
    expect(tiedTo(page[1]!)).toEqual([undefined, undefined]);
  });

  it("pages through a full read, and ties nothing when the window is not read whole", async () => {
    const page = [settledAt(50_001, "T1", "6.0000000000", "0.0114641650")];
    const read = vi
      .fn()
      .mockResolvedValueOnce({ transactions: [], rows: 200, lastOffset: 45_000 })
      .mockResolvedValueOnce({ transactions: [fillTx(49_990, "o1", "0.0114641650")], rows: 1 });
    expect(await linkSettlementsWithLookback(P, page, 50_000, read)).toEqual({ reads: 2, complete: true });
    expect(read.mock.calls).toEqual([[40_000, 50_000, 200], [45_000, 50_000, 200]]);
    expect(tiedTo(page[0]!)).toEqual(["o1", "o1"]);

    const busy = [filledAt(50_000, "o9", "0.0114641650"), settledAt(50_001, "T1", "6.0000000000", "0.0114641650")];
    const full = vi.fn(async (from: number) => ({ transactions: [], rows: 200, lastOffset: from + 100 }));
    expect(await linkSettlementsWithLookback(P, busy, 50_000, full)).toEqual({ reads: 3, complete: false });
    expect(tiedTo(busy[1]!)).toEqual([undefined, undefined]);
  });

  it("stops when the read budget or the deadline refuses, and ties nothing", async () => {
    const read = vi.fn();
    const page = [filledAt(50_000, "o9", "0.0114641650"), settledAt(50_001, "T1", "6.0000000000", "0.0114641650")];
    expect(await linkSettlementsWithLookback(P, page, 50_000, read, { allowRead: () => false })).toEqual({ reads: 0, complete: false });
    expect(await linkSettlementsWithLookback(P, page, 50_000, read, { deadlineMs: -1 })).toEqual({ reads: 0, complete: false });
    expect(read).not.toHaveBeenCalled();
    expect(tiedTo(page[1]!)).toEqual([undefined, undefined]);
  });

  it("ties nothing when what was read holds a fill without an output or an order closed by an unknown choice", async () => {
    const page = [settledAt(50_001, "T1", "6.0000000000", "0.0114641650")];
    const noOutput = tx(49_980, [created("o0", ORDER_T, ccOrder("6.0000000000")), exercised("o0", ORDER_T, "Order_Complete", {}, "r")]);
    const read = vi.fn(async () => ({ transactions: [noOutput, fillTx(49_990, "o1", "0.0114641650")], rows: 2 }));
    expect(await linkSettlementsWithLookback(P, page, 50_000, read)).toEqual({ reads: 1, complete: false });
    expect(tiedTo(page[0]!)).toEqual([undefined, undefined]);
    const odd = [filledAt(10, "o2", "0.0114641650", { kind: "archived" }), filledAt(11, "o1", "0.0114641650"), settledAt(12, "T1", "6.0000000000", "0.0114641650")];
    expect(await linkSettlementsWithLookback(P, odd, 0, vi.fn())).toEqual({ reads: 0, complete: false });
    expect(tiedTo(odd[2]!)).toEqual([undefined, undefined]);
    const flagged = [{ ...filledAt(11, "o1", "0.0114641650"), anomalies: [{ detail: "x: Order_Complete with no acsDelta" }] }, settledAt(12, "T1", "6.0000000000", "0.0114641650")];
    expect(await linkSettlementsWithLookback(P, flagged, 0, vi.fn())).toEqual({ reads: 0, complete: false });
  });

  it("known limit: an unread unsettled fill's settlement takes a read fill with the same terms, and the chain stops there", async () => {
    // The old fill is before the window. Its settlement lands on the page
    // before B fills: it takes A. A's settlement then sees A and B, B's sees
    // both too: neither is tied.
    const page = [
      settledAt(50_001, "TOLD", "6.0000000000", "0.0000073805"),
      filledAt(50_010, "oB", "0.0000073805"),
      settledAt(50_020, "TA", "6.0000000000", "0.0000073805"),
      settledAt(50_030, "TB", "6.0000000000", "0.0000073805"),
    ];
    const read = vi.fn(async () => ({ transactions: [fillTx(49_990, "oA", "0.0000073805")], rows: 1 }));
    await linkSettlementsWithLookback(P, page, 50_000, read);
    expect([tiedTo(page[0]!), tiedTo(page[2]!), tiedTo(page[3]!)]).toEqual([["oA", "oA"], [undefined, undefined], [undefined, undefined]]);
  });

  it("ties on the page alone only from the ledger's start, and reads nothing for a page with no trade", async () => {
    const read = vi.fn();
    const fromStart = [filledAt(10, "o1", "0.0114641650"), settledAt(11, "T1", "6.0000000000", "0.0114641650")];
    expect(await linkSettlementsWithLookback(P, fromStart, 0, read)).toEqual({ reads: 0, complete: true });
    expect(tiedTo(fromStart[1]!)).toEqual(["o1", "o1"]);
    expect(await linkSettlementsWithLookback(P, [filledAt(10, "o1", "0.0114641650")], 5, read)).toEqual({ reads: 0, complete: true });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("GET /v1/wallet/:party/tradecraft-updates with orderCids", () => {
  const ownAlloc = (cid: string, instrumentId: string) =>
    created(cid, `${PKG}:Splice.AmuletAllocationV2:AmuletAllocationV2`, {}, allocView(P, { "tradecraft.fi/amm-id": "TC CC/eXAG LP", "tradecraft.fi/instrument-id": instrumentId }, {}));
  const legSettle = (oldCid: string, newCid: string, side: string, amount: string, instrumentId: string, transferLegId: string) =>
    exercised(
      oldCid,
      `${PKG}:Splice.AmuletAllocationV2:AmuletAllocationV2`,
      "Allocation_Settle",
      { actors: [DSO, VENUE], extraTransferLegSides: [{ transferLegId, side, otherside: { owner: VAULT, provider: null, id: "" }, amount, instrumentId, meta: { values: {} } }] },
      { output: { tag: "AllocationResult_Settled", value: { nextIterationAllocationCid: newCid } } }
    );
  const settlement = tx(501, [
    legSettle("c-old", "c-new", "SenderSide", "6.0000000000", "Amulet", "T1-from-actor"),
    ownAlloc("c-new", "Amulet"),
    legSettle("e-old", "e-new", "ReceiverSide", "0.0114641650", "eXAG", "T1-to-actor"),
    ownAlloc("e-new", "eXAG"),
  ]);
  const fill = tx(450, [created("o1", ORDER_T, ccOrder("6.0000000000")), helper(EXAG, [["o1", "0.0114641650"]]), exercised("o1", ORDER_T, "Order_Complete", {}, "r")]);
  function app(readBefore: () => Promise<unknown>, readRateMaxPerIp?: number) {
    const getUpdatesPage = vi.fn(async (q: { beginExclusive: number }) =>
      q.beginExclusive === 500 ? { transactions: [settlement], rows: 1, lastOffset: 501 } : readBefore()
    );
    const s = {
      client: {
        getLedgerEnd: vi.fn(async () => ({ offset: 1000 })),
        getUpdatesPage,
        getPartyDetails: vi.fn(async (party: string) => ({ isLocal: party === P })),
      },
      facilitatorParty: "facilitator::1220fac",
      synchronizerId: "global-domain::12201",
      userId: "facilitator@clients",
      scanUrl: "http://scan.test",
      enableAgentWallet: true,
      walletSubmitChoices: ["TransferFactory_Transfer"],
      agentWalletApiKey: undefined,
      walletReadIds: [ORDER_ID, ALLOC_ID],
      ...(readRateMaxPerIp !== undefined ? { readRateMaxPerIp } : {}),
    } as unknown as WalletRelayServices;
    const a = Fastify();
    return { ready: registerWalletRoutes(a, s).then(() => a), getUpdatesPage };
  }
  const url = (q: string) => `/v1/wallet/${encodeURIComponent(P)}/tradecraft-updates?after=500${q}`;
  const legsOf = (body: { updates: Array<{ allocations: Array<{ legs: Array<{ orderCid?: string }> }> }> }) =>
    body.updates[0]!.allocations.flatMap((c) => c.legs.map((l) => l.orderCid));

  it("reads nothing more and gives no order ids unless asked", async () => {
    const { ready, getUpdatesPage } = app(async () => ({ transactions: [fill], rows: 1, lastOffset: 450 }));
    const body = (await (await ready).inject({ method: "GET", url: url("") })).json();
    expect(getUpdatesPage).toHaveBeenCalledTimes(1);
    expect(legsOf(body)).toEqual([undefined, undefined]);
    expect(body.orderCidsComplete).toBeUndefined();
  });

  it("ties a settlement to a fill read before the page when asked", async () => {
    const { ready, getUpdatesPage } = app(async () => ({ transactions: [fill], rows: 1, lastOffset: 450 }));
    const body = (await (await ready).inject({ method: "GET", url: url("&orderCids=true") })).json();
    expect(legsOf(body)).toEqual(["o1", "o1"]);
    expect(body.orderCidsComplete).toBe(true);
    expect(getUpdatesPage.mock.calls[1]?.[0]).toMatchObject({ beginExclusive: 0, endInclusive: 500, limit: 200 });
  });

  it("still answers the page, without order ids, when the read before it fails", async () => {
    const { ready } = app(async () => {
      throw new Error("participant timeout");
    });
    const r = await (await ready).inject({ method: "GET", url: url("&orderCids=true") });
    expect(r.statusCode).toBe(200);
    expect(legsOf(r.json())).toEqual([undefined, undefined]);
    expect(r.json().orderCidsComplete).toBe(false);
  });

  it("charges each read before the page to the caller's read budget", async () => {
    // Every read before the page is full, so the lookup would take three. A
    // budget of two a minute pays for the request and one of them.
    const { ready, getUpdatesPage } = app(async () => ({ transactions: [], rows: 200, lastOffset: 100 }), 2);
    const a = await ready;
    const first = await a.inject({ method: "GET", url: url("&orderCids=true") });
    expect(first.statusCode).toBe(200);
    expect(first.json().orderCidsComplete).toBe(false);
    expect(getUpdatesPage).toHaveBeenCalledTimes(2);
    expect((await a.inject({ method: "GET", url: url("&orderCids=true") })).statusCode).toBe(429);
  });

  it("says the order ids are complete on an empty answer at the ledger end", async () => {
    const { ready } = app(async () => ({ transactions: [], rows: 0 }));
    const body = (await (await ready).inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(P)}/tradecraft-updates?after=1000&orderCids=true` })).json();
    expect(body).toMatchObject({ complete: true, orderCidsComplete: true, updates: [] });
  });

  it("refuses an orderCids value other than true or false", async () => {
    const { ready } = app(async () => ({ transactions: [], rows: 0 }));
    expect((await (await ready).inject({ method: "GET", url: url("&orderCids=yes") })).statusCode).toBe(400);
    expect(parseTradecraftUpdatesQuery({ orderCids: "false" })).toMatchObject({ ok: true, orderCids: false });
  });
});
