/**
 * A party's Tradecraft queued-mode history, read from the ledger and reduced to
 * what the party itself did and received.
 *
 * Why a summary and not raw events: a Tradecraft settlement is one batch
 * transaction, and every trader in the batch witnesses it, so a party's view of
 * it carries the vault's legs with other traders (measured on MainNet,
 * 2026-11-03). A party's allocation history also holds x402 payments made
 * through allocations, which have nothing to do with Tradecraft. The relay is
 * readable by anyone who knows a party id, like `/contracts`, and answers only
 * for a party this facilitator hosts. It returns only
 *   - the party's own swap orders: created, filled (`Order_Complete`), cancelled
 *     (`Order_Cancel` with its reason), withdrawn (`SwapOrder_WithdrawV3`);
 *   - the party's own allocations carrying Tradecraft metadata, with the legs
 *     each settlement moved and the funding left after it;
 *   - the party's own settlement withdrawal requests, when the operator lists
 *     that template.
 *
 * `Order_Complete` itself carries no amount (its argument is empty). The venue
 * exercises it from its batch helper, `AMMHelperContract_HandleOrderBatches`,
 * whose argument lists each completed order with its output amount, keyed by
 * the output instrument; a fill reports its own order's entry as `output`. The
 * venue settles each fill later in a transaction of its own, which sends
 * exactly the order's input from the party's allocation and pays `output` into
 * the other one. Those legs carry no order id, so the relay ties a settlement
 * to a fill by those exact amounts (see `linkSettlementsToFills`).
 */
import type { ActiveContractsFilter, LedgerTransaction } from "@ftptech/x402-canton-ledger";

export const TC_SWAP_ORDER_SUFFIX = ":TC.V4.SwapOrderV2:SwapOrder";
export const TC_WITHDRAWAL_REQUEST_SUFFIX = ":TC.V4.Settle.WithdrawalRequest:SettlementWithdrawalRequest";
export const TC_AMM_HELPER_SUFFIX = ":TC.V4.AMMHelperContract:AMMHelperContract";
const TC_HANDLE_ORDER_BATCHES = "AMMHelperContract_HandleOrderBatches";
const TC_SWAP_COMPLETION = "OrderCompletion_SwapV2";
export const ALLOCATION_V2_SUFFIX = ":Splice.Api.Token.AllocationV2:Allocation";
const META_AMM_ID = "tradecraft.fi/amm-id";
const META_INSTRUMENT_ID = "tradecraft.fi/instrument-id";
/** A Daml Numeric 10 as the JSON API prints it. */
const AMOUNT = /^\d{1,28}(\.\d{1,10})?$/;

/** Ledger rows the route reads per request by default and at most. The most
 *  is the participant's list cap: a larger `/v2/updates` page is refused with
 *  JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED (measured on both of our
 *  participants, 2026-11-04). */
export const TC_UPDATES_DEFAULT_LIMIT = 50;
export const TC_UPDATES_MAX_LIMIT = 200;

type Instrument = { admin: string; id: string };

export interface TcOrderEvent {
  /** `archived`: closed by a choice this relay does not interpret (see `choice`). */
  kind: "created" | "filled" | "cancelled" | "withdrawn" | "expired" | "archived";
  orderCid: string;
  /** The choice that archived the order (absent on `created`). */
  choice?: string;
  ammId?: string;
  /** What the order sells (a `Short` order); present on `created`. */
  sell?: { instrument: Instrument; amount: string };
  minOut?: string | null;
  createdAt?: string;
  /** The venue's stated reason on a cancellation. */
  reason?: string;
  /** On `filled`: what the venue's batch helper says the order pays out. */
  output?: { instrument: Instrument; amount: string };
}

export interface TcAllocationLeg {
  /** `receive`: the party's allocation got `amount`; `send`: it paid it out. */
  side: "receive" | "send";
  amount: string;
  instrumentId: string;
  /** The other side's account owner (the venue's vault on a fill). */
  counterparty?: string;
  /** The venue's id of the leg: `<trade>-from-actor` and `<trade>-to-actor`
   *  for the two legs of one trade, `top-up-leg` for a top-up. */
  transferLegId?: string;
  /** The party's filled order this trade settles, when exactly one fits. */
  orderCid?: string;
}

export interface TcAllocationChange {
  allocationCid: string;
  /** The allocation this one replaced, when a settlement or top-up produced it. */
  previousAllocationCid?: string;
  ammId: string;
  instrument: Instrument;
  fundingAfter: Record<string, string>;
  legs: TcAllocationLeg[];
}

export interface TcWithdrawalEvent {
  kind: "requested" | "fulfilled" | "rejected" | "cancelled" | "archived";
  requestCid: string;
  choice?: string;
  ammId?: string;
  instrument?: Instrument;
  reason?: unknown;
}

export interface TcUpdate {
  offset: number;
  updateId: string;
  recordTime?: string;
  orders: TcOrderEvent[];
  allocations: TcAllocationChange[];
  withdrawals: TcWithdrawalEvent[];
  /** The party's records in this transaction that could not be read. */
  anomalies?: TcAnomaly[];
}

/** A record of the party's the relay could not read, with its pool when known. */
export interface TcAnomaly {
  ammId?: string;
  detail: string;
}

/** The allowlisted ids this read uses; a missing swap-order id turns it off. */
export function tradecraftReadIds(allowed: readonly string[]): {
  swapOrder?: string;
  withdrawalRequest?: string;
  allocation?: string;
} {
  const pick = (suffix: string) => allowed.find((id) => id.endsWith(suffix));
  const swapOrder = pick(TC_SWAP_ORDER_SUFFIX);
  const withdrawalRequest = pick(TC_WITHDRAWAL_REQUEST_SUFFIX);
  const allocation = pick(ALLOCATION_V2_SUFFIX);
  return {
    ...(swapOrder ? { swapOrder } : {}),
    ...(withdrawalRequest ? { withdrawalRequest } : {}),
    ...(allocation ? { allocation } : {}),
  };
}

/** The venue's batch helper in the package of the allowlisted swap-order id.
 *  A trader only witnesses its exercises that complete or cancel the trader's
 *  own orders; the summary keeps only those orders' entries. */
export function tradecraftHelperTemplate(swapOrder: string | undefined): string | undefined {
  return swapOrder?.endsWith(TC_SWAP_ORDER_SUFFIX)
    ? swapOrder.slice(0, -TC_SWAP_ORDER_SUFFIX.length) + TC_AMM_HELPER_SUFFIX
    : undefined;
}

/** The ledger filter for one party: the allowlisted Tradecraft templates, the
 *  venue's batch helper of the swap order's package (for fill amounts) and, if
 *  listed, the allocation interface with its views. */
export function tradecraftUpdatesFilter(
  party: string,
  ids: ReturnType<typeof tradecraftReadIds>
): ActiveContractsFilter {
  const cumulative: ActiveContractsFilter["filtersByParty"][string]["cumulative"] = [];
  for (const templateId of [ids.swapOrder, tradecraftHelperTemplate(ids.swapOrder), ids.withdrawalRequest]) {
    if (templateId) {
      cumulative.push({ identifierFilter: { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } } });
    }
  }
  if (ids.allocation) {
    cumulative.push({
      identifierFilter: {
        InterfaceFilter: {
          value: { interfaceId: ids.allocation, includeInterfaceView: true, includeCreatedEventBlob: false },
        },
      },
    });
  }
  return { filtersByParty: { [party]: { cumulative } } };
}

/** Parse `after` (an offset, default 0), `limit` (1..200, default 50) and
 *  `orderCids` (`true` asks for the order each settlement leg settles). */
export function parseTradecraftUpdatesQuery(q: {
  after?: string;
  limit?: string;
  orderCids?: string;
}): { ok: true; after: number; limit: number; orderCids: boolean } | { ok: false; error: string } {
  const after = q.after === undefined || q.after === "" ? 0 : Number(q.after);
  if (!/^\d*$/.test(q.after ?? "") || !Number.isSafeInteger(after) || after < 0) {
    return { ok: false, error: "after must be a ledger offset (a non-negative integer)" };
  }
  const raw = q.limit === undefined || q.limit === "" ? TC_UPDATES_DEFAULT_LIMIT : Number(q.limit);
  if (!/^\d*$/.test(q.limit ?? "") || !Number.isSafeInteger(raw) || raw < 1) {
    return { ok: false, error: "limit must be a positive integer" };
  }
  if (q.orderCids !== undefined && q.orderCids !== "" && q.orderCids !== "true" && q.orderCids !== "false") {
    return { ok: false, error: "orderCids must be true or false" };
  }
  return { ok: true, after, limit: Math.min(raw, TC_UPDATES_MAX_LIMIT), orderCids: q.orderCids === "true" };
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asInstrument = (v: unknown): Instrument | undefined => {
  const r = asRecord(v);
  const admin = asString(r?.admin);
  const id = asString(r?.id);
  return admin !== undefined && id !== undefined ? { admin, id } : undefined;
};
const asStringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(asRecord(v) ?? {})) if (typeof x === "string") out[k] = x;
  return out;
};

/** What an order's create argument says about it. */
function orderTerms(arg: Record<string, unknown>): Pick<TcOrderEvent, "ammId" | "sell" | "minOut" | "createdAt"> {
  const what = asRecord(arg.what);
  const value = asRecord(what?.value);
  const instrument = asInstrument(value?.instrument);
  const amount = asString(value?.amount);
  return {
    ...(asString(arg.ammId) ? { ammId: arg.ammId as string } : {}),
    ...(what?.tag === "Short" && instrument && amount ? { sell: { instrument, amount } } : {}),
    minOut: asString(arg.minOut) ?? null,
    ...(asString(arg.createdAt) ? { createdAt: arg.createdAt as string } : {}),
  };
}

/**
 * What a choice that archived an order means. Fill and cancellation are the
 * venue's `Order_Complete` and `Order_Cancel` (integration guide 3.5);
 * withdrawals and expiries are named after their kind in DAR 1.3.17. Any other
 * choice stays `archived` with its name: the reader cannot tell a fill from it.
 */
function orderOutcome(choice: string): TcOrderEvent["kind"] {
  if (choice === "Order_Complete") return "filled";
  if (/^(Order_Cancel|SwapOrder_Cancel(V2|V3|AndRefund)?)$/.test(choice)) return "cancelled";
  if (/^(Order_Withdraw|SwapOrder_Withdraw(V2|V3)?)$/.test(choice)) return "withdrawn";
  if (/^(Order_Expire|SwapOrder_Expire(V2|V3)?)$/.test(choice)) return "expired";
  return "archived";
}

/**
 * The orders a `HandleOrderBatches` argument completes, with their output.
 * `completions` is a Daml map, printed as [key, value] pairs: the key names
 * the output instrument (as `{_1: instrument}`), the value lists completions.
 * An entry that does not have this shape is skipped: the fill is still
 * reported, only without its output.
 */
function batchOutputs(arg: unknown, into: Map<string, { instrument: Instrument; amount: string }>): void {
  const entries = asRecord(arg)?.completions;
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, list] = entry as [unknown, unknown];
    // Exactly `{_1: instrument}`: a key of another shape could name another
    // instrument than the output.
    const k = asRecord(key);
    const instrument = k && Object.keys(k).length === 1 ? asInstrument(k._1) : undefined;
    if (!instrument || !Array.isArray(list)) continue;
    for (const c of list) {
      const r = asRecord(c);
      if (r?.tag !== TC_SWAP_COMPLETION) continue;
      const v = asRecord(r.value);
      const orderCid = asString(v?.swapCidV2);
      const amount = asString(v?.outputAmount);
      if (orderCid !== undefined && amount !== undefined && AMOUNT.test(amount)) into.set(orderCid, { instrument, amount });
    }
  }
}

function requestOutcome(choice: string): TcWithdrawalEvent["kind"] {
  if (choice === "SettlementWithdrawalRequest_Fulfill") return "fulfilled";
  if (choice === "SettlementWithdrawalRequest_Reject") return "rejected";
  if (choice === "SettlementWithdrawalRequest_Cancel") return "cancelled";
  return "archived";
}

/**
 * Reduce one transaction to the party's own Tradecraft events, or undefined
 * when nothing in it is the party's.
 *
 * Ownership:
 *   - An order or withdrawal request is the party's when its create has
 *     `actor` = the party, and an allocation when its view names the party as
 *     owner and it carries Tradecraft metadata. Another trader's contracts in
 *     the same settlement batch fail these checks.
 *   - An archive of an order or request is the party's when its create is in
 *     this transaction or in `createdEarlier` (the party's own creates on the
 *     same page), or when the participant marks it `acsDelta`: it removes a
 *     contract the party is a stakeholder of. A witnessed archive of another
 *     trader's order is false. An archive whose create is not at hand carries
 *     no terms; the reader matches it to the create it read before.
 *   - A settlement is kept when its result names one of the party's
 *     allocations as the successor.
 * Nothing is looked up on the ledger: a public read must not turn into one
 * request per contract.
 *
 * A record of the party's that cannot be read is listed in `anomalies` rather
 * than dropped: a reader must not take it for "nothing happened".
 */
export async function summarizeTradecraftTransaction(
  party: string,
  tx: LedgerTransaction,
  createdEarlier: ReadonlyMap<string, Record<string, unknown>> = new Map()
): Promise<TcUpdate | undefined> {
  const orders: TcOrderEvent[] = [];
  const withdrawals: TcWithdrawalEvent[] = [];
  const anomalies: TcAnomaly[] = [];
  const ownCreated = new Map<string, Record<string, unknown>>();
  const isOrder = (t: string) => t.endsWith(TC_SWAP_ORDER_SUFFIX);
  const isRequest = (t: string) => t.endsWith(TC_WITHDRAWAL_REQUEST_SUFFIX);
  const amm = (id: unknown) => (typeof id === "string" ? { ammId: id } : {});

  // Pass 1: creates: own orders, own requests, own Tradecraft allocations.
  const ownAllocations = new Map<string, TcAllocationChange>();
  for (const e of tx.events) {
    const c = e.CreatedEvent;
    if (!c) continue;
    if (isOrder(c.templateId) || isRequest(c.templateId)) {
      const arg = asRecord(c.createArgument);
      if (!arg) {
        if (c.acsDelta !== false) {
          anomalies.push({ detail: `${c.contractId}: a ${isOrder(c.templateId) ? "swap order" : "withdrawal request"} created without its argument` });
        }
        continue;
      }
      if (arg.actor !== party) continue;
      ownCreated.set(c.contractId, arg);
      if (isOrder(c.templateId)) {
        const terms = orderTerms(arg);
        if (!terms.sell) anomalies.push({ ...amm(arg.ammId), detail: `${c.contractId}: an order whose sale cannot be read` });
        orders.push({ kind: "created", orderCid: c.contractId, ...terms });
      } else {
        const instrument = asInstrument(arg.instrument);
        withdrawals.push({ kind: "requested", requestCid: c.contractId, ...amm(arg.ammId), ...(instrument ? { instrument } : {}) });
      }
      continue;
    }
    const view = asRecord(c.interfaceViews?.find((v) => v.interfaceId.endsWith(ALLOCATION_V2_SUFFIX))?.viewValue);
    const alloc = asRecord(view?.allocation);
    if (!alloc || asRecord(alloc.authorizer)?.owner !== party) continue;
    const meta = asStringMap(asRecord(alloc.meta)?.values);
    const ammId = meta[META_AMM_ID];
    const instrumentId = meta[META_INSTRUMENT_ID];
    if (ammId === undefined || instrumentId === undefined) continue; // not a Tradecraft allocation
    const admin = asString(alloc.admin);
    if (admin === undefined) {
      anomalies.push({ ammId, detail: `${c.contractId}: a Tradecraft allocation without its instrument admin` });
      continue;
    }
    ownAllocations.set(c.contractId, {
      allocationCid: c.contractId,
      ammId,
      instrument: { admin, id: instrumentId },
      fundingAfter: asStringMap(alloc.nextIterationFunding),
      legs: [],
    });
  }

  // Pass 2: exercises: what archived the party's orders and requests, the
  // venue's batch helper with each completed order's output, and the
  // settlements whose successor is one of the party's allocations.
  const outputs = new Map<string, { instrument: Instrument; amount: string }>();
  for (const e of tx.events) {
    const x = e.ExercisedEvent;
    if (!x) continue;
    if (x.templateId.endsWith(TC_AMM_HELPER_SUFFIX)) {
      // Other traders' orders in the same batch are listed too; only the
      // party's own fills below take their entry.
      if (x.choice === TC_HANDLE_ORDER_BATCHES) batchOutputs(x.choiceArgument, outputs);
      continue;
    }
    if (isOrder(x.templateId) || isRequest(x.templateId)) {
      if (x.consuming !== true) continue;
      const createArg = ownCreated.get(x.contractId) ?? createdEarlier.get(x.contractId);
      if (createArg === undefined && x.acsDelta !== true) {
        if (x.acsDelta === undefined) {
          anomalies.push({ detail: `${x.contractId}: ${x.choice} with no acsDelta, so whose contract it closed cannot be told` });
        }
        continue;
      }
      const arg = asRecord(x.choiceArgument);
      if (isOrder(x.templateId)) {
        const reason = asString(arg?.reason);
        orders.push({
          kind: orderOutcome(x.choice),
          orderCid: x.contractId,
          choice: x.choice,
          ...(createArg ? orderTerms(createArg) : {}),
          ...(reason !== undefined ? { reason } : {}),
        });
      } else {
        const instrument = asInstrument(createArg?.instrument);
        withdrawals.push({
          kind: requestOutcome(x.choice),
          requestCid: x.contractId,
          choice: x.choice,
          ...amm(createArg?.ammId),
          ...(instrument ? { instrument } : {}),
          ...(arg && "reason" in arg ? { reason: arg.reason } : {}),
        });
      }
      continue;
    }
    if (x.choice !== "Allocation_Settle") continue;
    const out = asRecord(asRecord(x.exerciseResult)?.output);
    const successor = asString(asRecord(out?.value)?.nextIterationAllocationCid);
    const change = successor !== undefined ? ownAllocations.get(successor) : undefined;
    if (!change) continue;
    change.previousAllocationCid = x.contractId;
    const sides = asRecord(x.choiceArgument)?.extraTransferLegSides;
    if (!Array.isArray(sides)) {
      anomalies.push({ ammId: change.ammId, detail: `${x.contractId}: a settlement whose legs cannot be read` });
      continue;
    }
    for (const s of sides) {
      const leg = asRecord(s);
      const amount = asString(leg?.amount);
      const instrumentId = asString(leg?.instrumentId);
      const side = leg?.side === "ReceiverSide" ? "receive" : leg?.side === "SenderSide" ? "send" : undefined;
      if (!leg || amount === undefined || instrumentId === undefined || side === undefined) {
        anomalies.push({ ammId: change.ammId, detail: `${x.contractId}: a settlement leg that cannot be read` });
        continue;
      }
      const counterparty = asString(asRecord(leg.otherside)?.owner);
      const transferLegId = asString(leg.transferLegId);
      change.legs.push({
        side,
        amount,
        instrumentId,
        ...(counterparty !== undefined ? { counterparty } : {}),
        ...(transferLegId !== undefined ? { transferLegId } : {}),
      });
    }
  }
  for (const o of orders) {
    const output = o.kind === "filled" ? outputs.get(o.orderCid) : undefined;
    if (output) o.output = output;
  }
  const allocations = [...ownAllocations.values()];

  if (orders.length + allocations.length + withdrawals.length + anomalies.length === 0) return undefined;
  return {
    offset: tx.offset,
    updateId: tx.updateId,
    ...(tx.recordTime ? { recordTime: tx.recordTime } : {}),
    orders,
    allocations,
    withdrawals,
    ...(anomalies.length > 0 ? { anomalies } : {}),
  };
}

/** One page of the party's transactions, summarized. An archive on the page
 *  gets the terms of the party's own create earlier on the same page. */
export async function summarizeTradecraftPage(party: string, transactions: readonly LedgerTransaction[]): Promise<TcUpdate[]> {
  const createdEarlier = new Map<string, Record<string, unknown>>();
  for (const tx of transactions) {
    for (const e of tx.events) {
      const c = e.CreatedEvent;
      if (!c || !(c.templateId.endsWith(TC_SWAP_ORDER_SUFFIX) || c.templateId.endsWith(TC_WITHDRAWAL_REQUEST_SUFFIX))) continue;
      const arg = asRecord(c.createArgument);
      if (arg && arg.actor === party) createdEarlier.set(c.contractId, arg);
    }
  }
  const updates: TcUpdate[] = [];
  for (const tx of transactions) {
    const s = await summarizeTradecraftTransaction(party, tx, createdEarlier);
    if (s) updates.push(s);
  }
  return updates;
}

/** The trade a leg belongs to, from its id; undefined for a top-up or an id
 *  of another shape. */
function tradeOf(transferLegId: string | undefined): string | undefined {
  return transferLegId?.match(/^(.+)-(from|to)-actor$/)?.[1];
}

/** One spelling per amount: `"0.0114640"` and `"0.011464"` are the same. */
function canonAmount(x: string): string {
  const [i = "", f = ""] = x.split(".");
  const frac = f.replace(/0+$/, "");
  return `${i.replace(/^0+(?=\d)/, "")}${frac ? `.${frac}` : ""}`;
}

function sameAmount(a: string, b: string): boolean {
  return canonAmount(a) === canonAmount(b);
}

/** Whether these updates hold a settled trade (a leg with a trade id). */
function hasTrade(updates: readonly TcUpdate[]): boolean {
  return updates.some((u) => u.allocations.some((c) => c.legs.some((l) => tradeOf(l.transferLegId) !== undefined)));
}

/** Records this read cannot weigh: a fill with no output read, an order
 *  closed by a choice the relay does not interpret, or any record of the
 *  party's it could not read. Each could be a settlement's order without being
 *  seen as one. */
function hasUnreadableFill(updates: readonly TcUpdate[]): boolean {
  return updates.some(
    (u) => (u.anomalies?.length ?? 0) > 0 || u.orders.some((o) => (o.kind === "filled" && !o.output) || o.kind === "archived")
  );
}

/**
 * Tie each settled trade to the party's fill it settles, in place.
 *
 * A trade is the pair of legs with one trade id: the `receive` leg pays the
 * order's output, the `send` leg takes its input. It is tied only when exactly
 * one fill before the settlement has that output (instrument and amount),
 * counting fills already tied, and that fill is not tied yet, has known terms
 * (its create is in `updates`), and the trade's pool and input are the
 * fill's. Small outputs do repeat (two CBTC fills of 6 CC each got
 * 0.0000073805 on MainNet, 2026-10-18): when two fills before a settlement
 * share its output, neither is tied, so a trade whose own fill was read is
 * never tied to another one. A wrong order id is worse than none.
 */
export function linkSettlementsToFills(updates: readonly TcUpdate[]): void {
  type Fill = {
    orderCid: string;
    offset: number;
    ammId?: string;
    sell?: { instrument: Instrument; amount: string };
    tied?: boolean;
  };
  const key = (instrumentId: string, amount: string) => `${instrumentId} ${canonAmount(amount)}`;
  const known = new Map<string, Pick<TcOrderEvent, "ammId" | "sell">>();
  for (const u of updates) {
    for (const o of u.orders) if (o.kind === "created" && (o.ammId !== undefined || o.sell)) known.set(o.orderCid, o);
  }
  const fills = new Map<string, Fill[]>();
  for (const u of updates) {
    for (const o of u.orders) {
      if (o.kind !== "filled" || !o.output) continue;
      const k = key(o.output.instrument.id, o.output.amount);
      const t = known.get(o.orderCid);
      const ammId = o.ammId ?? t?.ammId;
      const sell = o.sell ?? t?.sell;
      fills.set(k, [
        ...(fills.get(k) ?? []),
        { orderCid: o.orderCid, offset: u.offset, ...(ammId !== undefined ? { ammId } : {}), ...(sell ? { sell } : {}) },
      ]);
    }
  }
  for (const u of [...updates].sort((a, b) => a.offset - b.offset)) {
    type Side = { leg: TcAllocationLeg; ammId: string };
    const trades = new Map<string, { receive?: Side; send?: Side; doubled?: boolean }>();
    for (const c of u.allocations) {
      for (const leg of c.legs) {
        const trade = tradeOf(leg.transferLegId);
        if (trade === undefined) continue;
        const t = trades.get(trade) ?? {};
        // One trade id on two legs of one side is not one trade: tie neither.
        if (t[leg.side]) t.doubled = true;
        t[leg.side] = { leg, ammId: c.ammId };
        trades.set(trade, t);
      }
    }
    for (const t of trades.values()) {
      const { receive, send } = t;
      if (!receive || !send || t.doubled) continue;
      // A fill in the settlement's own transaction counts against a tie but
      // cannot take one.
      const before = (fills.get(key(receive.leg.instrumentId, receive.leg.amount)) ?? []).filter((f) => f.offset <= u.offset);
      const fill = before.length === 1 ? before[0] : undefined;
      if (
        !fill ||
        fill.offset >= u.offset ||
        fill.tied ||
        fill.ammId !== receive.ammId ||
        fill.ammId !== send.ammId ||
        fill.sell === undefined ||
        fill.sell.instrument.id !== send.leg.instrumentId ||
        !sameAmount(fill.sell.amount, send.leg.amount)
      ) {
        continue;
      }
      fill.tied = true;
      receive.leg.orderCid = fill.orderCid;
      send.leg.orderCid = fill.orderCid;
    }
  }
}

/** How far before a page the relay reads the party's fills, in ledger
 *  offsets, and in at most how many reads. */
export const TC_LINK_LOOKBACK_SPAN = 10_000;
export const TC_LINK_LOOKBACK_READS = 3;

/**
 * Tie the page's settled trades to fills (see `linkSettlementsToFills`).
 *
 * A fill before the page can still be unsettled, and the relay can only weigh
 * the fills it has read. So unless the page starts at the ledger's start,
 * nothing is tied until the `TC_LINK_LOOKBACK_SPAN` offsets before the page
 * have been read whole: at most `TC_LINK_LOOKBACK_READS` reads of
 * `TC_UPDATES_MAX_LIMIT` rows, each allowed by `allowRead` (the caller's read
 * budget), started within `deadlineMs`. Nothing is tied either when what was
 * read holds a fill whose output could not be read or an order closed by an
 * unknown choice. `complete` says whether the ties could be weighed; when not,
 * the page goes out with no order ids.
 *
 * Known limit: a fill the relay has not read is not weighed. That is a fill
 * older than the window that is still unsettled (a settlement backlog of
 * hours has happened), or one from before the party's history on this
 * participant (a party added by an ACS import). If exactly one fill read
 * before its settlement has the same pool, input and output to the tenth
 * decimal, that settlement is tied to it, and that fill's own settlement then
 * stays untied. An order id is the best reading of what was read, not proof.
 * Closing this needs the unsettled fills carried from page to page in the
 * cursor.
 */
export async function linkSettlementsWithLookback(
  party: string,
  page: readonly TcUpdate[],
  after: number,
  read: (
    beginExclusive: number,
    endInclusive: number,
    limit: number
  ) => Promise<{ transactions: readonly LedgerTransaction[]; rows: number; lastOffset?: number | undefined }>,
  opts: { allowRead?: () => boolean; deadlineMs?: number } = {}
): Promise<{ reads: number; complete: boolean }> {
  for (const u of page) for (const c of u.allocations) for (const l of c.legs) delete l.orderCid;
  if (!hasTrade(page)) return { reads: 0, complete: true };
  if (after <= 0) {
    if (hasUnreadableFill(page)) return { reads: 0, complete: false };
    linkSettlementsToFills(page);
    return { reads: 0, complete: true };
  }
  const started = Date.now();
  const earlier: LedgerTransaction[] = [];
  let cursor = Math.max(0, after - TC_LINK_LOOKBACK_SPAN);
  let reads = 0;
  while (reads < TC_LINK_LOOKBACK_READS) {
    if (opts.deadlineMs !== undefined && Date.now() - started > opts.deadlineMs) break;
    if (opts.allowRead && !opts.allowRead()) break;
    const back = await read(cursor, after, TC_UPDATES_MAX_LIMIT);
    reads++;
    earlier.push(...back.transactions);
    if (back.rows < TC_UPDATES_MAX_LIMIT) {
      const before = await summarizeTradecraftPage(party, earlier);
      if (hasUnreadableFill(before) || hasUnreadableFill(page)) return { reads, complete: false };
      linkSettlementsToFills([...before, ...page]);
      return { reads, complete: true };
    }
    if (back.lastOffset === undefined || back.lastOffset <= cursor) break;
    cursor = back.lastOffset;
  }
  return { reads, complete: false };
}
