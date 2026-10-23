/**
 * Tradecraft queued-mode verify-before-sign, against REAL MainNet prepared
 * transactions captured on 2026-10-17 (a test agent on node 2, pool
 * "TC CBTC/CC LP"). The batcher, CC allocation, empty CBTC allocation, orders
 * and withdrawal request were then executed (the bytes authorize nothing more);
 * the funded CBTC allocation was prepared only. Tampered variants edit those
 * bytes with equal-length replacements so the protobuf framing stays valid.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTcCancelOrder,
  assertPreparedTcCreateAllocation,
  assertPreparedTcCreateBatcher,
  assertPreparedTcFundAllocation,
  assertPreparedTcCreateOrders,
  assertPreparedTcWithdrawalRequest,
  PreparedDecodeError,
  PreparedTransferMismatchError,
  type TcCreateAllocationExpectation,
  type TcCreateOrdersExpectation,
  type TcFundAllocationExpectation,
} from "./prepared-transfer.js";

const fixture = (n: string): string =>
  readFileSync(new URL(`../../agent-wallet/src/__fixtures__/${n}`, import.meta.url), "utf8").trim();

const AGENT = "agent::12203c17fd2cf108dcb766b7ee23d30e9d21c60a04d10a48abc41bfa51331472fe09";
const VENUE = "CantonSwap::122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";
const VAULT = "cs-vault::1220b4cd6098eebafd4c88efd2b3986e86542bdc391060675432cd195ad26bcf013b";
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const CBTC_ADMIN = "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262";
const DA_OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const SYNC = "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const AMM_ID = "TC CBTC/CC LP";
const CC = { admin: DSO, id: "Amulet" };
const CBTC = { admin: CBTC_ADMIN, id: "CBTC" };
const tradecraft = { venue: VENUE, vault: VAULT };
/** preparation_time (µs) of each capture → ms, plus a realistic 5 s signing delay. */
const at = (micros: bigint): number => Number(micros / 1000n) + 5_000;

const BATCHER = { b64: fixture("mainnet-tc-create-batcher.b64"), nowMs: at(1792242259548689n) };
const ALLOC_CC = { b64: fixture("mainnet-tc-allocation-cc-funded.b64"), nowMs: at(1792243023798011n) };
const ALLOC_CBTC_EMPTY = { b64: fixture("mainnet-tc-allocation-cbtc-empty.b64"), nowMs: at(1792243108208720n) };
const ALLOC_CBTC_FUNDED = { b64: fixture("mainnet-tc-allocation-cbtc-funded.b64"), nowMs: at(1792243595921304n) };
const ORDERS = { b64: fixture("mainnet-tc-orders-2.b64"), nowMs: at(1792243120072657n) };
const WITHDRAW = { b64: fixture("mainnet-tc-withdrawal-request-cc.b64"), nowMs: at(1792243400682338n) };
const BATCHER_CID =
  "0077114414d6371721317b7e970a813aa29375c532296c0df780676595e62ac297ca121220f980259f817846f7c3302e3b9d17b8bc4265ac9ee25817cd230caaa71cc8fe43";

/** Replace EVERY occurrence of `from` with the equal-length `to`. */
function swapAll(b64: string, from: string | Buffer, to: string | Buffer): string {
  const f = Buffer.isBuffer(from) ? from : Buffer.from(from, "utf8");
  const t = Buffer.isBuffer(to) ? to : Buffer.from(to, "utf8");
  expect(t.length).toBe(f.length);
  const buf = Buffer.from(b64, "base64");
  let hits = 0;
  for (let i = buf.indexOf(f); i !== -1; i = buf.indexOf(f, i + 1)) {
    t.copy(buf, i);
    hits++;
  }
  expect(hits).toBeGreaterThan(0);
  return buf.toString("base64");
}

/** Replace the first `from` that follows each occurrence of the record label
 *  `label` (within `window` bytes) — a targeted edit of one field's value. */
function swapAfterLabel(b64: string, label: string, from: string | Buffer, to: string | Buffer, window = 200): string {
  const f = Buffer.isBuffer(from) ? from : Buffer.from(from, "utf8");
  const t = Buffer.isBuffer(to) ? to : Buffer.from(to, "utf8");
  expect(t.length).toBe(f.length);
  const buf = Buffer.from(b64, "base64");
  const l = Buffer.from(label, "utf8");
  let hits = 0;
  for (let i = buf.indexOf(l); i !== -1; i = buf.indexOf(l, i + 1)) {
    const j = buf.indexOf(f, i + l.length);
    if (j !== -1 && j - i < window) {
      t.copy(buf, j);
      hits++;
    }
  }
  expect(hits).toBeGreaterThan(0);
  return buf.toString("base64");
}

const refused = (fn: () => void, re?: RegExp): void => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err instanceof PreparedTransferMismatchError || err instanceof PreparedDecodeError).toBe(true);
  if (re) expect((err as Error).message).toMatch(re);
};

describe("assertPreparedTcCreateBatcher", () => {
  const ok = { party: AGENT, tradecraft, synchronizerId: SYNC, nowMs: BATCHER.nowMs };

  it("passes the honest MainNet capture", () => {
    expect(() => assertPreparedTcCreateBatcher(BATCHER.b64, ok)).not.toThrow();
  });

  it("refuses another wallet's batcher", () => {
    refused(() => assertPreparedTcCreateBatcher(BATCHER.b64, { ...ok, party: "agent::1220aa" }));
  });

  it("refuses when the AMMRules is not signed by the pinned venue and vault", () => {
    refused(
      () => assertPreparedTcCreateBatcher(BATCHER.b64, { ...ok, tradecraft: { venue: VENUE, vault: "cs-vault::1220bb" } }),
      /signed by/
    );
  });

  it("refuses a batcher naming a different vault (equal-length edit everywhere)", () => {
    const evil = swapAll(BATCHER.b64, "cs-vault::", "cs-vaulX::");
    refused(() => assertPreparedTcCreateBatcher(evil, ok), /signed by/);
  });
});

describe("assertPreparedTcCreateAllocation", () => {
  const cc: TcCreateAllocationExpectation = {
    party: AGENT,
    tradecraft,
    ammId: AMM_ID,
    instrument: CC,
    funding: "20",
    dso: DSO,
    synchronizerId: SYNC,
    nowMs: ALLOC_CC.nowMs,
  };
  const cbtcEmpty: TcCreateAllocationExpectation = {
    ...cc,
    instrument: CBTC,
    funding: undefined,
    trustedRegistryParties: new Set([DA_OPERATOR]),
    nowMs: ALLOC_CBTC_EMPTY.nowMs,
  };
  const cbtcFunded: TcCreateAllocationExpectation = {
    ...cbtcEmpty,
    funding: "0.000015",
    nowMs: ALLOC_CBTC_FUNDED.nowMs,
  };

  it("passes the honest funded Canton Coin allocation", () => {
    expect(() => assertPreparedTcCreateAllocation(ALLOC_CC.b64, cc)).not.toThrow();
  });

  it("passes the honest empty CBTC receiving allocation", () => {
    expect(() => assertPreparedTcCreateAllocation(ALLOC_CBTC_EMPTY.b64, cbtcEmpty)).not.toThrow();
  });

  it("passes the honest funded CBTC allocation", () => {
    expect(() => assertPreparedTcCreateAllocation(ALLOC_CBTC_FUNDED.b64, cbtcFunded)).not.toThrow();
  });

  it("refuses a different funding amount than intended", () => {
    refused(() => assertPreparedTcCreateAllocation(ALLOC_CC.b64, { ...cc, funding: "2" }), /initialFunding is/);
  });

  it("refuses funding where an empty allocation was intended", () => {
    refused(() => assertPreparedTcCreateAllocation(ALLOC_CC.b64, { ...cc, funding: undefined }), /empty allocation/);
  });

  it("refuses the wrong instrument", () => {
    refused(() => assertPreparedTcCreateAllocation(ALLOC_CBTC_EMPTY.b64, { ...cbtcEmpty, instrument: CC }));
  });

  it("refuses an allocation bound to another pool", () => {
    refused(() => assertPreparedTcCreateAllocation(ALLOC_CC.b64, { ...cc, ammId: "TC CBTC/USDCx LP" }), /pool/);
  });

  it("refuses when the allocation's pool meta was rewritten", () => {
    const evil = swapAll(ALLOC_CC.b64, AMM_ID, "TC CBTC/XX LP");
    refused(() => assertPreparedTcCreateAllocation(evil, cc), /pool/);
  });

  it("refuses when the executor is not the venue (only the executor field edited)", () => {
    const evil = swapAfterLabel(ALLOC_CC.b64, "executors", "CantonSwap::", "CantonSwaX::");
    refused(() => assertPreparedTcCreateAllocation(evil, cc), /executors are .* not the venue alone/);
  });

  it("refuses an allocation that is not committed", () => {
    // `committed` = Value{bool: true} = 0x12 0x02 0x10 0x01 after its label.
    const evil = swapAfterLabel(
      ALLOC_CC.b64,
      "committed",
      Buffer.from([0x12, 0x02, 0x10, 0x01]),
      Buffer.from([0x12, 0x02, 0x10, 0x00]),
      16
    );
    refused(() => assertPreparedTcCreateAllocation(evil, cc), /not committed/);
  });

  /** The Value bytes of `party` as a direct record field value (label "owner"
   *  then Value{party}) — so an edit hits holding owners, not the authorizer's
   *  Optional owner. */
  const ownerField = (party: string): Buffer =>
    Buffer.concat([
      Buffer.from([0x0a, 5]),
      Buffer.from("owner"),
      Buffer.from([0x12, party.length + 2, 0x3a, party.length]),
      Buffer.from(party),
    ]);
  const otherAgent = AGENT.slice(0, -4) + "dead";

  it("refuses a change Amulet / LockedAmulet owned by someone else", () => {
    const evil = swapAll(ALLOC_CC.b64, ownerField(AGENT), ownerField(otherAgent));
    refused(() => assertPreparedTcCreateAllocation(evil, cc), /creates a Splice\.Amulet:(Locked)?Amulet owned by/);
  });

  it("refuses a registry Holding owned by someone else", () => {
    const evil = swapAll(ALLOC_CBTC_FUNDED.b64, ownerField(AGENT), ownerField(otherAgent));
    refused(() => assertPreparedTcCreateAllocation(evil, cbtcFunded), /creates a Utility\.Registry\.Holding\.V0\.Holding:Holding owned by/);
  });

  it("refuses a create of any template outside the allocation family", () => {
    const evil = swapAll(ALLOC_CC.b64, "LockedAmulet", "LockedAmuleX");
    refused(() => assertPreparedTcCreateAllocation(evil, cc), /creates "Splice\.Amulet:LockedAmuleX"/);
  });

  it("refuses the CBTC allocation without the registry operator trusted", () => {
    refused(
      () => assertPreparedTcCreateAllocation(ALLOC_CBTC_FUNDED.b64, { ...cbtcFunded, trustedRegistryParties: new Set() }),
      /unexpected part/
    );
  });

  it("refuses a pinned venue that is not the one in the bytes", () => {
    refused(() =>
      assertPreparedTcCreateAllocation(ALLOC_CC.b64, { ...cc, tradecraft: { venue: "CantonSwap::1220cc", vault: VAULT } })
    );
  });

  it("refuses another wallet", () => {
    refused(() => assertPreparedTcCreateAllocation(ALLOC_CC.b64, { ...cc, party: "agent::1220aa" }), /not this wallet/);
  });
});

describe("assertPreparedTcFundAllocation", () => {
  // Prepared only (never signed) on 2026-10-17: a 6 CC top-up of the empty CC
  // allocation on TC CC/USDCx LP, and a 0.000015 CBTC top-up of the empty CBTC
  // allocation on TC CBTC/CC LP.
  const FUND_CC = { b64: fixture("mainnet-tc-fund-cc.b64"), nowMs: at(1792248875467357n) };
  const FUND_CBTC = { b64: fixture("mainnet-tc-fund-cbtc.b64"), nowMs: at(1792248905207381n) };
  const cc: TcFundAllocationExpectation = {
    party: AGENT,
    tradecraft,
    ammId: "TC CC/USDCx LP",
    instrument: CC,
    allocationCid:
      "0066384937ba8b874e35c0e37a6de851dce8cd84ea07452ba834a59201a4cb4f9dca1212202090ed4333ef37961013357e13e0bcdc5e3f9699c5fd9db46fa8cd1a2a79f9ac",
    additionalFunding: "6",
    currentFunding: "0",
    dso: DSO,
    synchronizerId: SYNC,
    nowMs: FUND_CC.nowMs,
  };
  const cbtc: TcFundAllocationExpectation = {
    ...cc,
    ammId: AMM_ID,
    instrument: CBTC,
    allocationCid:
      "000be9d885530767d7ea2f13df901429fb189b669021564e85d2026dca2af751beca1212203ceb182be66160c67f27e7b33448874b914231dda84ec1a4fdd70c874c472b96",
    additionalFunding: "0.000015",
    trustedRegistryParties: new Set([DA_OPERATOR]),
    nowMs: FUND_CBTC.nowMs,
  };

  it("passes the honest Canton Coin top-up", () => {
    expect(() => assertPreparedTcFundAllocation(FUND_CC.b64, cc)).not.toThrow();
  });

  it("passes the honest CBTC top-up", () => {
    expect(() => assertPreparedTcFundAllocation(FUND_CBTC.b64, cbtc)).not.toThrow();
  });

  it("refuses a different top-up amount", () => {
    refused(() => assertPreparedTcFundAllocation(FUND_CC.b64, { ...cc, additionalFunding: "5" }), /additionalFunding is/);
  });

  it("refuses when the successor would carry a funding the wallet did not expect", () => {
    refused(() => assertPreparedTcFundAllocation(FUND_CC.b64, { ...cc, currentFunding: "3" }), /no successor allocation carries the topped-up funding 9\.0000000000/);
  });

  it("refuses a top-up of another allocation", () => {
    refused(() => assertPreparedTcFundAllocation(FUND_CC.b64, { ...cc, allocationCid: "00" + "ab".repeat(68) }), /allocationCid/);
  });

  it("refuses when a created holding is not the agent's", () => {
    const owner = (p: string): Buffer =>
      Buffer.concat([Buffer.from([0x0a, 5]), Buffer.from("owner"), Buffer.from([0x12, p.length + 2, 0x3a, p.length]), Buffer.from(p)]);
    const evil = swapAll(FUND_CBTC.b64, owner(AGENT), owner(AGENT.slice(0, -4) + "dead"));
    refused(() => assertPreparedTcFundAllocation(evil, cbtc), /owned by/);
  });

  it("refuses when an allocation's executor is not the venue", () => {
    const evil = swapAfterLabel(FUND_CC.b64, "executors", "CantonSwap::", "CantonSwaX::");
    refused(() => assertPreparedTcFundAllocation(evil, cc), /executors are .* not the venue alone/);
  });
});

describe("assertPreparedTcCreateOrders", () => {
  const ok: TcCreateOrdersExpectation = {
    party: AGENT,
    tradecraft,
    ammId: AMM_ID,
    sellInstrument: CC,
    orders: [
      { amount: "6", minOut: "0.0000072118" },
      { amount: "6", minOut: "0.0000072118" },
    ],
    batcherCid: BATCHER_CID,
    synchronizerId: SYNC,
    nowMs: ORDERS.nowMs,
  };

  it("passes the honest two-order MainNet capture", () => {
    expect(() => assertPreparedTcCreateOrders(ORDERS.b64, ok)).not.toThrow();
  });

  it("refuses a different order count", () => {
    refused(() => assertPreparedTcCreateOrders(ORDERS.b64, { ...ok, orders: [ok.orders[0]!] }), /2 orders, not 1/);
  });

  it("refuses an inflated amount", () => {
    refused(
      () => assertPreparedTcCreateOrders(ORDERS.b64, { ...ok, orders: ok.orders.map((o) => ({ ...o, amount: "5" })) }),
      /amount is/
    );
  });

  it("refuses a lowered minimum output (slippage strip)", () => {
    const evil = swapAll(ORDERS.b64, "0.0000072118", "0.0000000001");
    refused(() => assertPreparedTcCreateOrders(evil, ok), /minOut/);
  });

  it("refuses a dropped minimum the caller did not intend to drop", () => {
    refused(
      () =>
        assertPreparedTcCreateOrders(ORDERS.b64, { ...ok, orders: ok.orders.map((o) => ({ ...o, minOut: null })) }),
      /minOut that was not intended/
    );
  });

  it("refuses another pool", () => {
    refused(() => assertPreparedTcCreateOrders(ORDERS.b64, { ...ok, ammId: "TC CBTC/USDCx LP" }), /ammId/);
  });

  it("refuses selling another instrument", () => {
    refused(() => assertPreparedTcCreateOrders(ORDERS.b64, { ...ok, sellInstrument: CBTC }));
  });

  it("refuses a batcher other than the agent's own", () => {
    refused(() => assertPreparedTcCreateOrders(ORDERS.b64, { ...ok, batcherCid: "00" + BATCHER_CID.slice(2, -2) + "00" }));
  });
});

describe("assertPreparedTcCancelOrder", () => {
  // Executed 2026-10-17: abandon a pending 6 CC order whose minimum the pool
  // could not meet. One exercise, no consequences, no creates.
  const CANCEL = { b64: fixture("mainnet-tc-cancel-order.b64"), nowMs: at(1792254314557232n) };
  const ok = {
    party: AGENT,
    tradecraft,
    orderCid:
      "0048b7592c7917bb56ccc671264242ac9b785c957b7a9440188d2fb4b190992322ca12122090eec475f0218623e4a3c8cdb6dafb626ab1f3e8e4d556fdedcbaeb1759721ec",
    instrumentAdmins: [DSO, CBTC_ADMIN],
    synchronizerId: SYNC,
    nowMs: CANCEL.nowMs,
  };

  it("passes the honest MainNet capture", () => {
    expect(() => assertPreparedTcCancelOrder(CANCEL.b64, ok)).not.toThrow();
  });

  it("refuses another order than the one intended", () => {
    refused(() => assertPreparedTcCancelOrder(CANCEL.b64, { ...ok, orderCid: "00" + "ab".repeat(68) }));
  });

  it("refuses another wallet's order", () => {
    refused(() => assertPreparedTcCancelOrder(CANCEL.b64, { ...ok, party: "agent::1220aa" }));
  });

  it("refuses an order not co-signed by the pinned vault", () => {
    refused(() => assertPreparedTcCancelOrder(CANCEL.b64, { ...ok, tradecraft: { venue: VENUE, vault: "cs-vault::1220bb" } }), /signed by/);
  });

  it("refuses any other transaction shape", () => {
    refused(() => assertPreparedTcCancelOrder(ORDERS.b64, { ...ok, nowMs: ORDERS.nowMs }), /SwapOrder_WithdrawV3/);
  });
});

describe("assertPreparedTcWithdrawalRequest", () => {
  const ok = { party: AGENT, tradecraft, ammId: AMM_ID, instrument: CC, synchronizerId: SYNC, nowMs: WITHDRAW.nowMs };

  it("passes the honest MainNet capture", () => {
    expect(() => assertPreparedTcWithdrawalRequest(WITHDRAW.b64, ok)).not.toThrow();
  });

  it("refuses a request for another instrument or pool", () => {
    refused(() => assertPreparedTcWithdrawalRequest(WITHDRAW.b64, { ...ok, instrument: CBTC }));
    refused(() => assertPreparedTcWithdrawalRequest(WITHDRAW.b64, { ...ok, ammId: "TC CBTC/USDCx LP" }), /ammId/);
  });

  it("refuses a request addressed to another venue", () => {
    const evil = swapAll(WITHDRAW.b64, "CantonSwap::", "CantonSwaX::");
    refused(() => assertPreparedTcWithdrawalRequest(evil, ok), /stakeholders|venue is/);
  });

  it("refuses a request template from any package but Tradecraft's (look-alike package)", () => {
    const evil = swapAll(WITHDRAW.b64, "97571dd8610f5d98", "deadbeefdeadbeef");
    refused(() => assertPreparedTcWithdrawalRequest(evil, ok), /package "deadbeefdeadbeef/);
    refused(() => assertPreparedTcWithdrawalRequest(WITHDRAW.b64, { ...ok, trustedPackageIds: ["00".repeat(32)] }), /not Tradecraft's/);
  });

  it("refuses any other transaction shape", () => {
    refused(() => assertPreparedTcWithdrawalRequest(ORDERS.b64, { ...ok, nowMs: ORDERS.nowMs }), /exercises a choice/);
  });
});

describe("timing", () => {
  it("allows the ledger-time bound to have just lapsed, but not by minutes", () => {
    const ok = { party: AGENT, tradecraft, synchronizerId: SYNC };
    expect(() => assertPreparedTcCreateBatcher(BATCHER.b64, { ...ok, nowMs: BATCHER.nowMs })).not.toThrow();
    // The orders capture bounds max_ledger_effective_time at its prepare instant.
    const o: TcCreateOrdersExpectation = {
      party: AGENT,
      tradecraft,
      ammId: AMM_ID,
      sellInstrument: CC,
      orders: [
        { amount: "6", minOut: "0.0000072118" },
        { amount: "6", minOut: "0.0000072118" },
      ],
      nowMs: ORDERS.nowMs + 10 * 60_000,
    };
    refused(() => assertPreparedTcCreateOrders(ORDERS.b64, o), /max_ledger_effective_time/);
  });
});
