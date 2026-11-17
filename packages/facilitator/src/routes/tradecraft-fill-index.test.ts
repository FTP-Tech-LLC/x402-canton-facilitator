import { describe, it, expect, vi } from "vitest";
import { TcFillIndex, TcFillIndexes, tagFromFillIndex, type FillIndexIo } from "./tradecraft-fill-index.js";
import type { TcUpdate } from "./tradecraft-updates.js";

const CC = { admin: "DSO::1220dso", id: "Amulet" };
const EXAG = { admin: "exag::1220ex", id: "eXAG" };
const POOL = "TC CC/eXAG LP";
const A = "0.0114641650";
const B = "0.0200000000";

/** Summaries as the relay builds them. A fill carries no terms of its own:
 *  the index takes them from the order's create. */
const created = (offset: number, orderCid: string, sell = "6.0000000000", ammId = POOL): TcUpdate => ({
  offset,
  updateId: `u${offset}`,
  orders: [{ kind: "created", orderCid, ammId, sell: { instrument: CC, amount: sell } }],
  allocations: [],
  withdrawals: [],
});
const filled = (offset: number, orderCid: string, out: string): TcUpdate => ({
  offset,
  updateId: `u${offset}`,
  orders: [{ kind: "filled", orderCid, choice: "Order_Complete", output: { instrument: EXAG, amount: out } }],
  allocations: [],
  withdrawals: [],
});
const tradeAllocs = (offset: number, trade: string, sent: string, got: string, ammId = POOL): TcUpdate["allocations"] => [
  { allocationCid: `cc${offset}${trade}`, ammId, instrument: CC, fundingAfter: {}, legs: [{ side: "send", amount: sent, instrumentId: "Amulet", transferLegId: `${trade}-from-actor` }] },
  { allocationCid: `ex${offset}${trade}`, ammId, instrument: EXAG, fundingAfter: {}, legs: [{ side: "receive", amount: got, instrumentId: "eXAG", transferLegId: `${trade}-to-actor` }] },
];
const settled = (offset: number, trade: string, got: string, sent = "6.0000000000", ammId = POOL): TcUpdate => ({
  offset,
  updateId: `u${offset}`,
  orders: [],
  allocations: tradeAllocs(offset, trade, sent, got, ammId),
  withdrawals: [],
});
/** Several records in one transaction. */
const at = (offset: number, ...parts: TcUpdate[]): TcUpdate => ({
  offset,
  updateId: `u${offset}`,
  orders: parts.flatMap((p) => p.orders),
  allocations: parts.flatMap((p) => p.allocations),
  withdrawals: [],
});
/** An allocation the party got, replacing `previous` when a settlement made it. */
const alloc = (offset: number, allocationCid: string, previous?: string): TcUpdate => ({
  offset,
  updateId: `u${offset}`,
  orders: [],
  allocations: [{ allocationCid, ...(previous ? { previousAllocationCid: previous } : {}), ammId: POOL, instrument: CC, fundingAfter: {}, legs: [] }],
  withdrawals: [],
});
const built = (updates: TcUpdate[], upTo = 1_000_000): TcFillIndex => {
  const idx = new TcFillIndex();
  idx.apply(updates, upTo);
  return idx;
};
const tiesOf = (idx: TcFillIndex, ...trades: Array<[number, string]>) => trades.map(([offset, t]) => idx.orderCidOf(offset, t));

describe("TcFillIndex", () => {
  it("ties a settlement two days after its fill, across reads, with the terms of the order's create read before", () => {
    const idx = new TcFillIndex();
    idx.apply([created(10, "o1")], 100);
    idx.apply([filled(200, "o1", A)], 1_000);
    idx.apply([], 30_000);
    idx.apply([settled(41_000, "T1", "0.011464165")], 50_000);
    expect([idx.orderCidOf(41_000, "T1"), idx.orderCidOf(41_001, "T1"), idx.orderCidOf(41_000, undefined)]).toEqual(["o1", undefined, undefined]);
    expect(idx.builtTo).toBe(50_000);
    expect(idx.broken).toBeUndefined();
  });

  it("ties each trade of a batch to its own fill, whatever the settlement order, also two trades in one transaction", () => {
    const idx = built([
      created(1, "o1"), created(2, "o2"), created(3, "o3"), created(4, "o4"),
      at(10, filled(10, "o1", A), filled(10, "o2", "0.0114638532")),
      at(20, filled(20, "o3", "0.0200000001"), filled(20, "o4", "0.0200000002")),
      settled(32, "TB", "0.0114638532"), settled(33, "TA", A),
      at(41, settled(41, "TC", "0.0200000001"), settled(41, "TD", "0.0200000002")),
    ]);
    expect(tiesOf(idx, [33, "TA"], [32, "TB"], [41, "TC"], [41, "TD"])).toEqual(["o1", "o2", "o3", "o4"]);
  });

  it("ties neither of two unsettled fills with one pool, input and output, and ties again once both have settled", () => {
    const idx = built([
      created(1, "o1"), created(2, "o2"), filled(3, "o1", "0.0000073805"), filled(4, "o2", "0.00000738050"),
      settled(5, "T1", "0.0000073805"), settled(6, "T2", "0.0000073805"),
      created(7, "o3"), filled(8, "o3", "0.0000073805"), settled(9, "T3", "0.0000073805"),
    ]);
    expect(tiesOf(idx, [5, "T1"], [6, "T2"], [9, "T3"])).toEqual([undefined, undefined, "o3"]);
  });

  it("ties nothing to a fill that joins unsettled twins until every fill with those terms has settled", () => {
    // After T1 one of o1 and o2 is unsettled, which one is not known. o3 joins
    // them: T2 and T3 settle two of the three, so the one T3 settles is not
    // known either. Once all three have settled the terms tie again.
    const idx = built([
      created(1, "o1"), created(2, "o2"), created(3, "o3"), created(4, "o4"),
      filled(10, "o1", "0.0000073805"), filled(11, "o2", "0.0000073805"), settled(12, "T1", "0.0000073805"),
      filled(13, "o3", "0.0000073805"), settled(14, "T2", "0.0000073805"), settled(15, "T3", "0.0000073805"),
      filled(16, "o4", "0.0000073805"), settled(17, "T4", "0.0000073805"),
    ]);
    expect(tiesOf(idx, [12, "T1"], [14, "T2"], [15, "T3"], [17, "T4"])).toEqual([undefined, undefined, undefined, "o4"]);
  });

  it("does not count a settled fill against a later one with the same terms (MainNet 2026-10-18)", () => {
    // Two CBTC fills got 0.0000073805, twenty minutes apart, each settled within
    // seconds: by the second settlement the first fill has settled.
    const idx = built([created(1, "o5"), filled(20, "o5", "0.0000073805"), settled(21, "T0", "0.0000073805"), created(22, "o6"), filled(30, "o6", "0.0000073805"), settled(31, "T1", "0.0000073805")]);
    expect(tiesOf(idx, [21, "T0"], [31, "T1"])).toEqual(["o5", "o6"]);
  });

  it("counts a fill in the settlement's own transaction against the tie, and as settled", () => {
    const withFill = (offset: number, orderCid: string, trade: string): TcUpdate => at(offset, filled(offset, orderCid, A), settled(offset, trade, A));
    // An earlier fill and one in the settlement's transaction: one of the two
    // is left, not known which, so the next settlement is not tied either.
    const a = built([created(1, "oX"), created(2, "oT"), created(3, "o9"), filled(30, "oX", A), withFill(31, "oT", "T1"), settled(40, "T2", A), filled(50, "o9", A), settled(51, "T3", A)]);
    expect(tiesOf(a, [31, "T1"], [40, "T2"], [51, "T3"])).toEqual([undefined, undefined, "o9"]);
    // Only the fill in the settlement's transaction: it is the one settled, and
    // nothing is left behind to count against the next fill.
    const b = built([created(1, "oT"), created(2, "o8"), withFill(31, "oT", "T1"), filled(50, "o8", A), settled(51, "T4", A)]);
    expect(tiesOf(b, [31, "T1"], [51, "T4"])).toEqual([undefined, "o8"]);
  });

  it("ties none of two settlements in one transaction for the one fill it saw, and leaves fills of other terms alone", () => {
    // One of the two settles a fill from before the party's history here.
    const idx = built([
      created(1, "o1"), created(2, "o2"), created(3, "o3"), created(4, "o4"),
      filled(10, "o1", A), filled(15, "o3", B),
      at(20, settled(20, "Ta", A), settled(20, "Tb", A), filled(20, "o2", B)),
      settled(30, "T2", B),
      filled(40, "o4", A), settled(41, "T4", A),
    ]);
    expect(tiesOf(idx, [20, "Ta"], [20, "Tb"], [30, "T2"], [41, "T4"])).toEqual([undefined, undefined, undefined, "o4"]);
  });

  it("a fill it never saw takes a tie that is not its own: why a history that starts late stops the index", () => {
    // The fill TOld settles is from before the party's history here (an ACS
    // import). These records carry no allocations, so nothing stops the index.
    const idx = built([created(1, "oNew"), filled(10, "oNew", A), settled(20, "TOld", A), settled(30, "TNew", A)]);
    expect(tiesOf(idx, [20, "TOld"], [30, "TNew"])).toEqual(["oNew", undefined]);
  });

  it("stops at a settlement of an allocation it never saw created: the party's history here starts later", () => {
    const whole = built([alloc(1, "a1"), alloc(5, "a2", "a1"), at(7, alloc(7, "b1"), alloc(7, "b2", "b1")), alloc(9, "a3", "a2")]);
    expect(whole.broken).toBeUndefined();
    const imported = built([created(1, "o1"), filled(2, "o1", A), alloc(5, "a2", "a0")]);
    expect(imported.broken).toContain("an allocation from before the party's history on this participant");
  });

  it("ties no settlement of a fill it never saw, on another pool or input, nor a top-up or a trade id on two legs of one side", () => {
    const topUp: TcUpdate = {
      offset: 43,
      updateId: "u43",
      orders: [],
      allocations: [{ allocationCid: "t1", ammId: POOL, instrument: CC, fundingAfter: {}, legs: [{ side: "receive", amount: "0.0300000000", instrumentId: "eXAG", transferLegId: "top-up-leg" }] }],
      withdrawals: [],
    };
    const idx = built([
      settled(5, "T0", A),
      created(10, "o2"), created(11, "o3"), created(12, "o4"), created(13, "o5"),
      filled(38, "o2", "0.0100000000"), filled(39, "o3", B), filled(40, "o4", "0.0300000000"), filled(45, "o5", "0.0400000000"),
      settled(41, "T2", "0.0100000000", "6.0000000000", "TC CC/eXAU LP"),
      settled(42, "T3", B, "7.0000000000"),
      topUp,
      at(46, settled(46, "T5", "0.0400000000"), settled(46, "T5", "0.0400000000")),
    ]);
    expect(tiesOf(idx, [5, "T0"], [41, "T2"], [42, "T3"], [43, "top-up-leg"], [46, "T5"])).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("applies each record once: a page read again, or a record twice in one read, changes nothing", () => {
    const idx = new TcFillIndex();
    idx.apply([], 500);
    expect(idx.builtTo).toBe(500);
    const page = [created(510, "o1"), filled(520, "o1", A)];
    idx.apply(page, 600);
    idx.apply(page, 600);
    idx.apply([...page, settled(700, "T1", A)], 800);
    expect([idx.orderCidOf(700, "T1"), idx.builtTo]).toEqual(["o1", 800]);
    idx.apply([], 700);
    expect(idx.builtTo).toBe(800);
    // Twins, and the first settlement twice in one read: one fill is left,
    // still uncertain, so the next settlement is not tied to o3.
    const twice = built([created(1, "o1"), created(2, "o2"), created(3, "o3"), filled(10, "o1", A), filled(11, "o2", A), settled(12, "S1", A), settled(12, "S1", A), filled(13, "o3", A), settled(14, "S2", A)]);
    expect(tiesOf(twice, [12, "S1"], [14, "S2"])).toEqual([undefined, undefined]);
  });

  it("drops the oldest ties past its limit and says which pages it can no longer tag", () => {
    const idx = new TcFillIndex({ maxOpen: 100, maxTies: 2 });
    idx.apply([created(1, "o1"), created(2, "o2"), created(3, "o3"), filled(10, "o1", A), filled(11, "o2", B), filled(12, "o3", "0.0300000000"), settled(20, "T1", A), settled(21, "T2", B), settled(22, "T3", "0.0300000000")], 30);
    expect([...tiesOf(idx, [20, "T1"], [21, "T2"], [22, "T3"]), idx.forgotTo]).toEqual([undefined, "o2", "o3", 20]);
  });

  it("stops at a record it cannot read, lets go of what it held and applies nothing more", () => {
    const before = [created(1, "o1"), filled(2, "o1", A), settled(3, "T1", A), created(4, "o2")];
    const odd: Array<[string, TcUpdate]> = [
      ["could not read", { ...created(10, "oA"), anomalies: [{ detail: "x: Order_Complete with no acsDelta" }] }],
      ["Order_SomethingNew", { offset: 10, updateId: "u10", orders: [{ kind: "archived", orderCid: "o2", choice: "Order_SomethingNew" }], allocations: [], withdrawals: [] }],
      ["output or terms", { offset: 10, updateId: "u10", orders: [{ kind: "filled", orderCid: "o2", choice: "Order_Complete" }], allocations: [], withdrawals: [] }],
      ["output or terms", filled(10, "oNeverCreated", A)],
      // A record the summary should never hold: the index stops rather than
      // keep a record applied halfway.
      [
        "offset 10: ",
        {
          offset: 10,
          updateId: "u10",
          orders: [
            { kind: "created", orderCid: "oQ", ammId: POOL, sell: { amount: "6.0000000000" } as never },
            { kind: "filled", orderCid: "oQ", choice: "Order_Complete", output: { instrument: EXAG, amount: A } },
          ],
          allocations: [],
          withdrawals: [],
        },
      ],
    ];
    for (const [why, u] of odd) {
      const idx = built(before, 5);
      expect(idx.orderCidOf(3, "T1")).toBe("o1");
      idx.apply([u], 20);
      expect(idx.broken).toContain(why);
      expect([idx.orderCidOf(3, "T1"), idx.entries, idx.builtTo]).toEqual([undefined, 0, 5]);
      idx.apply([created(30, "o3")], 40);
      expect([idx.entries, idx.builtTo]).toEqual([0, 5]);
    }
  });

  it("stops when it would hold more open orders and unsettled fills than its limit", () => {
    const idx = new TcFillIndex({ maxOpen: 2, maxTies: 10 });
    idx.apply([created(1, "o1"), created(2, "o2")], 5);
    expect(idx.broken).toBeUndefined();
    idx.apply([created(6, "o3")], 10);
    expect([idx.broken, idx.entries]).toEqual(["more open orders and unsettled fills than an index keeps", 0]);
  });
});

describe("TcFillIndexes", () => {
  it("keeps one index per participant and party and drops the least recently used one", () => {
    const ix = new TcFillIndexes(2, 1_000);
    const a = ix.for("p1", "A", 1);
    ix.for("p1", "B", 2);
    expect(ix.for("p1", "A", 3)).toBe(a);
    const a2 = ix.for("p2", "A", 4);
    expect([a2 === a, ix.size, ix.get("p1", "B")]).toEqual([false, 2, undefined]);
    expect(ix.get("p1", "A", 5)).toBe(a);
    ix.for("p1", "C", 6);
    expect([ix.get("p2", "A"), ix.get("p1", "A")]).toEqual([undefined, a]);
  });

  it("drops every index of a participant whose ledger went back, and only then", async () => {
    const ix = new TcFillIndexes();
    const a = ix.for("p1", "A");
    const b = ix.for("p2", "B");
    expect(await ix.wentBack("p1", 1_000, async () => 1_000)).toBe(false);
    // An end read before a later one: the ledger did not go back.
    expect(await ix.wentBack("p1", 900, async () => 1_005)).toBe(false);
    expect(ix.get("p1", "A")).toBe(a);
    expect(await ix.wentBack("p1", 400, async () => 410)).toBe(true);
    expect([ix.get("p1", "A"), ix.get("p2", "B")]).toEqual([undefined, b]);
    expect(await ix.wentBack("p1", 420, async () => 420)).toBe(false);
  });

  it("drops the least recently used indexes while all of them together hold too much", () => {
    const ix = new TcFillIndexes(10, 5);
    const a = ix.for("p1", "A", 1);
    a.apply([created(1, "o1"), created(2, "o2"), created(3, "o3")], 10);
    const b = ix.for("p1", "B", 2);
    b.apply([created(1, "o4"), created(2, "o5"), created(3, "o6")], 10);
    ix.trim(b);
    expect([ix.size, ix.get("p1", "B", 3), ix.get("p1", "A")]).toEqual([1, b, undefined]);
  });
});

describe("tagFromFillIndex", () => {
  const key = { participant: "p1", party: "P" };
  const io = (read: FillIndexIo["read"]): FillIndexIo => ({ read, ledgerEnd: async () => 1_000, allowRead: () => true, warn: () => {} });
  const legsOf = (u: TcUpdate) => u.allocations.flatMap((c) => c.legs.map((l) => l.orderCid));

  it("reads for an index from one request at a time; another answers false without reading", async () => {
    const indexes = new TcFillIndexes();
    let release!: () => void;
    const opened = new Promise<void>((r) => (release = r));
    const read = vi.fn(async () => {
      await opened;
      return { transactions: [], rows: 0 };
    });
    const page = () => ({ after: 500, next: 1_000, end: 1_000, updates: [settled(600, "T1", A)] });
    const first = tagFromFillIndex(indexes, key, page(), io(read));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(await tagFromFillIndex(indexes, key, page(), io(read))).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(true);
  });

  it("answers false for a page older than the ties it kept", async () => {
    const indexes = new TcFillIndexes(10, 1_000, { maxOpen: 100, maxTies: 1 });
    const read = vi.fn();
    indexes.for(key.participant, key.party).apply([created(1, "o1"), created(2, "o2"), filled(10, "o1", A), filled(11, "o2", B), settled(20, "T1", A), settled(21, "T2", B)], 1_000);
    const old = { after: 19, next: 1_000, end: 1_000, updates: [settled(20, "T1", A), settled(21, "T2", B)] };
    expect(await tagFromFillIndex(indexes, key, old, io(read))).toBe(false);
    const recent = { after: 20, next: 1_000, end: 1_000, updates: [settled(21, "T2", B)] };
    expect([await tagFromFillIndex(indexes, key, recent, io(read)), legsOf(recent.updates[0]!)]).toEqual([true, ["o2", "o2"]]);
    expect(read).not.toHaveBeenCalled();
  });
});
