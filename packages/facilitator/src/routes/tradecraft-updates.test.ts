import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { LedgerTransaction } from "@ftptech/x402-canton-ledger";
import { registerWalletRoutes, type WalletRelayServices } from "./wallet.js";
import {
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
  /** The allocations the settlement spends, as the party's setup created them. */
  const setup = tx(100, [ownAlloc("c-old", "Amulet"), ownAlloc("e-old", "eXAG")]);
  function relay(getUpdatesPage: unknown, end: () => number, readRateMaxPerIp?: number) {
    const s = {
      client: {
        getLedgerEnd: vi.fn(async () => ({ offset: end() })),
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
    return registerWalletRoutes(a, s).then(() => a);
  }
  function app(readBefore: () => Promise<unknown>, readRateMaxPerIp?: number) {
    const getUpdatesPage = vi.fn(async (q: { beginExclusive: number }) =>
      q.beginExclusive === 500 ? { transactions: [settlement], rows: 1, lastOffset: 501 } : readBefore()
    );
    return { ready: relay(getUpdatesPage, () => 1000, readRateMaxPerIp), getUpdatesPage };
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
    const { ready, getUpdatesPage } = app(async () => ({ transactions: [setup, fill], rows: 2, lastOffset: 450 }));
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
    // Every read before the page is full, so the index would take more. A
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

  describe("from the party's fill index", () => {
    const OUT = "0.0114641650";
    const OUT2 = "0.0222222222";
    const fillOf = (offset: number, cid: string, out: string) =>
      tx(offset, [created(cid, ORDER_T, ccOrder("6.0000000000")), helper(EXAG, [[cid, out]]), exercised(cid, ORDER_T, "Order_Complete", {}, "r")]);
    const createdAt = (offset: number, cid: string) => tx(offset, [created(cid, ORDER_T, ccOrder("6.0000000000"))]);
    /** A fill whose create is in another read: the participant marks it the party's. */
    const filledLater = (offset: number, cid: string, out: string) =>
      tx(offset, [helper(EXAG, [[cid, out]]), acs(exercised(cid, ORDER_T, "Order_Complete", {}, "r"), true)]);
    /** The allocations these trades' settlements spend, as the party's setup created them. */
    const setupFor = (...trades: string[]) => tx(1, trades.flatMap((t) => [ownAlloc(`c-${t}-old`, "Amulet"), ownAlloc(`e-${t}-old`, "eXAG")]));
    const settlementOf = (offset: number, trade: string, out: string) =>
      tx(offset, [
        legSettle(`c-${trade}-old`, `c-${trade}`, "SenderSide", "6.0000000000", "Amulet", `${trade}-from-actor`),
        ownAlloc(`c-${trade}`, "Amulet"),
        legSettle(`e-${trade}-old`, `e-${trade}`, "ReceiverSide", out, "eXAG", `${trade}-to-actor`),
        ownAlloc(`e-${trade}`, "eXAG"),
      ]);
    /** A participant that answers each range from these transactions. */
    function ledger(txs: LedgerTransaction[], end: () => number, gate?: (q: { beginExclusive: number; endInclusive: number }) => Promise<void>) {
      const getUpdatesPage = vi.fn(async (q: { beginExclusive: number; endInclusive: number; limit: number }) => {
        await gate?.(q);
        const rows = txs.filter((t) => t.offset > q.beginExclusive && t.offset <= q.endInclusive).sort((x, y) => x.offset - y.offset).slice(0, q.limit);
        return { transactions: rows, rows: rows.length, lastOffset: rows.at(-1)?.offset };
      });
      const ready = relay(getUpdatesPage, end);
      const get = async (after: number, more = "") =>
        (await (await ready).inject({ method: "GET", url: `/v1/wallet/${encodeURIComponent(P)}/tradecraft-updates?after=${after}&orderCids=true${more}` })).json();
      return { get, getUpdatesPage };
    }
    const allLegs = (body: { updates: Array<{ allocations: Array<{ legs: Array<{ orderCid?: string }> }> }> }) =>
      body.updates.flatMap((u) => u.allocations.flatMap((c) => c.legs.map((l) => l.orderCid)));
    const atTime = async (t: string, run: () => Promise<void>) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(t));
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    };

    it("ties a settlement two days after its fill for a reader that follows the ledger, with no read beyond its pages", async () => {
      let end = 35_000;
      const { get, getUpdatesPage } = ledger(
        [setupFor("T1", "T2"), fillOf(450, "o1", OUT), settlementOf(501, "T1", OUT), fillOf(36_000, "o2", OUT2), settlementOf(76_000, "T2", OUT2)],
        () => end
      );
      expect(allLegs(await get(0))).toEqual(["o1", "o1"]);
      end = 50_000;
      expect(await get(35_000)).toMatchObject({ next: 50_000, orderCidsComplete: true });
      end = 90_000;
      const body = await get(50_000);
      expect([allLegs(body), body.orderCidsComplete]).toEqual([["o2", "o2"], true]);
      expect(getUpdatesPage).toHaveBeenCalledTimes(3);
    });

    it("builds the index from the ledger's start for a reader that starts late, then answers by lookup", async () => {
      const { get, getUpdatesPage } = ledger([setupFor("T1"), fillOf(450, "o1", OUT), settlementOf(40_501, "T1", OUT)], () => 50_000);
      expect(allLegs(await get(30_000))).toEqual(["o1", "o1"]);
      expect(getUpdatesPage.mock.calls[1]?.[0]).toMatchObject({ beginExclusive: 0, endInclusive: 30_000, limit: 200 });
      expect(allLegs(await get(30_000))).toEqual(["o1", "o1"]);
      expect(getUpdatesPage).toHaveBeenCalledTimes(3);
    });

    it("reads nothing for the index on a page with no trade to tag", async () => {
      const { get, getUpdatesPage } = ledger([fillOf(450, "o1", OUT), fillOf(30_500, "o2", OUT2)], () => 50_000);
      expect(await get(30_000)).toMatchObject({ orderCidsComplete: true });
      expect(getUpdatesPage).toHaveBeenCalledTimes(1);
    });

    it("does not tie a settlement to a newer fill with the same terms while an older one is unsettled", async () => {
      // A window of the 10k offsets before the page would see only the newer fill.
      const { get } = ledger([setupFor("T1"), fillOf(450, "oOld", OUT), fillOf(25_001, "oNew", OUT), settlementOf(35_000, "T1", OUT)], () => 50_000);
      const body = await get(34_999);
      expect([allLegs(body), body.orderCidsComplete]).toEqual([[undefined, undefined], true]);
    });

    it("takes an order's terms from its create in an earlier read of the history", async () => {
      const filler = Array.from({ length: 300 }, (_, i) => tx(i + 101, []));
      const { get } = ledger([setupFor("T1"), createdAt(100, "o1"), ...filler, filledLater(450, "o1", OUT), settlementOf(30_100, "T1", OUT)], () => 50_000);
      expect(allLegs(await get(30_000))).toEqual(["o1", "o1"]);
    });

    it("tags a full page and goes on from where it stopped", async () => {
      const { get } = ledger(
        [setupFor("T1", "T2"), fillOf(450, "o1", OUT), settlementOf(30_100, "T1", OUT), fillOf(30_200, "o2", OUT2), settlementOf(30_300, "T2", OUT2)],
        () => 50_000
      );
      const first = await get(30_000, "&limit=1");
      expect([first.next, first.complete, allLegs(first), first.orderCidsComplete]).toEqual([30_100, false, ["o1", "o1"], true]);
      const second = await get(30_100, "&limit=2");
      expect([second.next, second.complete, allLegs(second), second.orderCidsComplete]).toEqual([30_300, false, ["o2", "o2"], true]);
    });

    it("says the order ids are not complete while the index catches up over several requests", async () => {
      const filler = Array.from({ length: 1_200 }, (_, i) => tx(i + 2, []));
      const { get, getUpdatesPage } = ledger([setupFor("T1"), ...filler, fillOf(1_300, "o1", OUT), settlementOf(40_501, "T1", OUT)], () => 50_000);
      const first = await get(30_000);
      expect([allLegs(first), first.orderCidsComplete]).toEqual([[undefined, undefined], false]);
      // The page and five reads for the index.
      expect(getUpdatesPage).toHaveBeenCalledTimes(6);
      const second = await get(30_000);
      expect([allLegs(second), second.orderCidsComplete]).toEqual([["o1", "o1"], true]);
      expect(getUpdatesPage).toHaveBeenCalledTimes(9);
    });

    it("stops reading for the index at the deadline, and the next request goes on", async () => {
      await atTime("2026-11-09T00:00:00Z", async () => {
        const filler = Array.from({ length: 400 }, (_, i) => tx(i + 2, []));
        // Each read for the index takes six seconds.
        const { get, getUpdatesPage } = ledger([setupFor("T1"), ...filler, fillOf(500, "o1", OUT), settlementOf(40_501, "T1", OUT)], () => 50_000, async (q) => {
          if (q.beginExclusive < 30_000) vi.setSystemTime(new Date(Date.now() + 6_000));
        });
        expect((await get(30_000)).orderCidsComplete).toBe(false);
        expect((await get(30_000)).orderCidsComplete).toBe(false);
        expect(allLegs(await get(30_000))).toEqual(["o1", "o1"]);
        expect(getUpdatesPage).toHaveBeenCalledTimes(6);
      });
    });

    it("gives no order ids for good when the party's history holds a record the index cannot read", async () => {
      const odd = tx(100, [created("oZ", ORDER_T, ccOrder("6.0000000000")), exercised("oZ", ORDER_T, "Order_SomethingNew", {}, "r")]);
      const { get, getUpdatesPage } = ledger([setupFor("T1"), odd, fillOf(29_500, "o1", OUT), settlementOf(30_100, "T1", OUT)], () => 50_000);
      for (let i = 0; i < 2; i++) {
        const body = await get(30_000);
        expect([allLegs(body), body.orderCidsComplete]).toEqual([[undefined, undefined], false]);
      }
      // The page and the index's read, then the page alone.
      expect(getUpdatesPage).toHaveBeenCalledTimes(3);
    });

    it("gives no order ids for a party whose history here starts after its first allocation (an ACS import)", async () => {
      // No setup: the settlement spends allocations from before the party's history here.
      const { get } = ledger([fillOf(450, "o1", OUT), settlementOf(30_100, "T1", OUT)], () => 50_000);
      const body = await get(30_000);
      expect([allLegs(body), body.orderCidsComplete]).toEqual([[undefined, undefined], false]);
    });

    it("after a failed read for the index, says so and reads for it again a minute later", async () => {
      await atTime("2026-11-09T00:00:00Z", async () => {
        let fail = true;
        const { get, getUpdatesPage } = ledger([setupFor("T1"), fillOf(450, "o1", OUT), settlementOf(30_100, "T1", OUT)], () => 50_000, async (q) => {
          if (q.beginExclusive === 0 && fail) {
            fail = false;
            throw new Error("participant timeout");
          }
        });
        expect((await get(30_000)).orderCidsComplete).toBe(false);
        expect((await get(30_000)).orderCidsComplete).toBe(false);
        expect(getUpdatesPage.mock.calls.filter(([q]) => q.beginExclusive === 0)).toHaveLength(1);
        vi.setSystemTime(new Date("2026-11-09T00:01:01Z"));
        expect(allLegs(await get(30_000))).toEqual(["o1", "o1"]);
      });
    });

    it("serves two requests at once: one reads the index while the other extends it, and both tie", async () => {
      let release!: () => void;
      const opened = new Promise<void>((r) => (release = r));
      let end = 35_000;
      const { get, getUpdatesPage } = ledger(
        [setupFor("T1", "T2"), fillOf(450, "o1", OUT), settlementOf(30_100, "T1", OUT), fillOf(36_000, "o2", OUT2), settlementOf(45_000, "T2", OUT2)],
        () => end,
        async (q) => {
          if (q.beginExclusive === 35_000 && q.endInclusive === 40_000) await opened;
        }
      );
      expect(allLegs(await get(0))).toEqual(["o1", "o1"]);
      end = 50_000;
      const slow = get(40_000);
      await vi.waitFor(() => expect(getUpdatesPage).toHaveBeenCalledTimes(3));
      const quick = await get(35_000);
      expect([allLegs(quick), quick.orderCidsComplete]).toEqual([["o2", "o2"], true]);
      release();
      const late = await slow;
      expect([allLegs(late), late.orderCidsComplete]).toEqual([["o2", "o2"], true]);
    });

    it("drops the index when another request sees the ledger go back, even if it grew past the index since", async () => {
      let end = 50_000;
      const txs = [setupFor("T1"), fillOf(450, "o1", OUT), settlementOf(40_501, "T1", OUT)];
      const { get } = ledger(txs, () => end);
      expect(allLegs(await get(30_000))).toEqual(["o1", "o1"]);
      txs.splice(0, txs.length, setupFor("T9"), fillOf(450, "o9", OUT));
      end = 1_000;
      expect(await get(0)).toMatchObject({ orderCidsComplete: true });
      txs.push(settlementOf(59_000, "T9", OUT));
      end = 60_000;
      const body = await get(0);
      expect([allLegs(body), body.orderCidsComplete]).toEqual([["o9", "o9"], true]);
    });

    it("drops the index when the ledger goes back, and builds it again", async () => {
      let end = 50_000;
      const txs = [setupFor("T1"), fillOf(450, "o1", OUT), settlementOf(40_501, "T1", OUT)];
      const { get } = ledger(txs, () => end);
      expect(allLegs(await get(30_000))).toEqual(["o1", "o1"]);
      // A reset: offsets start again, with another history.
      txs.splice(0, txs.length, setupFor("T9"), fillOf(450, "o9", OUT), settlementOf(20_000, "T9", OUT));
      end = 30_000;
      const body = await get(0);
      expect([allLegs(body), body.orderCidsComplete]).toEqual([["o9", "o9"], true]);
    });
  });
});
