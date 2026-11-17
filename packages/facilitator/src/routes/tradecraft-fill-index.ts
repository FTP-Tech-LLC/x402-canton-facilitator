/**
 * A party's Tradecraft settlements tied to the fills they settle, over the
 * party's whole history on one participant.
 *
 * Why the whole history: the venue settles each fill in a transaction of its
 * own, and that can come long after the fill. On 2026-11-08 a MainNet agent's
 * TC CC/USDXLR fills settled 28k to 35k offsets (about 40 to 47 hours) after
 * the fill. A window of offsets before a page misses such fills, and it can
 * tie a settlement to a newer fill with the same terms while the fill it
 * settles lies before the window. The index applies the party's records in
 * offset order from the ledger's start and keeps what a tie needs: the open
 * orders with their terms, the fills not settled yet, and the ties made.
 *
 * The rule: a settled trade (one receive and one send leg with one trade id,
 * on one pool) ties to the one unsettled fill before it with the trade's pool,
 * input and output. When two or more fit, none is tied, and which of them are
 * still unsettled stays unknown until every fill with those terms has settled:
 * until then no settlement with those terms is tied, also not for a fill that
 * joins them later. A fill in the settlement's own transaction counts against
 * a tie but cannot take one. A wrong order id is worse than none.
 *
 * What it relies on: the venue settles each fill once, in one trade, no
 * earlier than the fill's own transaction, sending exactly the order's input
 * and paying the fill's output (see tradecraft-updates.ts); and every fill of
 * the party's is in its history on this participant. A party added by an ACS
 * import breaks the last, and one fill the index never saw would shift every
 * later tie with its terms. Such a history starts after the party's first
 * Tradecraft allocation, so a settlement of an allocation the index never saw
 * created stops it. So does a record the relay cannot read (a fill without its
 * output or terms, an order closed by a choice it does not know, an anomaly):
 * the party's pages then go out without order ids.
 *
 * In memory only, and bounded: the oldest ties go first, then the least
 * recently used indexes. A restart rebuilds an index from the next request
 * that needs it.
 */
import type { LedgerTransaction } from "@ftptech/x402-canton-ledger";
import {
  TC_UPDATES_MAX_LIMIT,
  canonAmount,
  hasTrade,
  summarizeTradecraftPage,
  tradeOf,
  type TcAllocationLeg,
  type TcUpdate,
} from "./tradecraft-updates.js";

/** Indexes kept, the least recently used dropped first. */
export const TC_INDEX_MAX_PARTIES = 200;
/** Records (allocations, open orders, unsettled fills, ties) all indexes keep
 *  together, well under 1 kB each. */
export const TC_INDEX_MAX_ENTRIES = 100_000;
/** Open orders plus unsettled fills one index may hold before it stops. */
export const TC_INDEX_MAX_OPEN = 20_000;
/** Ties one index keeps. Older ones are dropped first, and a page before them
 *  then goes out without order ids. */
export const TC_INDEX_MAX_TIES = 20_000;
/** Reads one request may spend bringing an index up to its page. */
export const TC_INDEX_CATCHUP_READS = 5;
/** Time a request may start those reads in (each read has its own timeout). */
export const TC_INDEX_DEADLINE_MS = 5_000;
/** How long an index waits after a read for it failed. */
export const TC_INDEX_RETRY_MS = 60_000;

/** An order's pool and input, one spelling per amount. */
const orderTerms = (ammId: string, sellId: string, sellAmount: string): string =>
  JSON.stringify([ammId, sellId, canonAmount(sellAmount)]);
/** What a settlement must match: the order's pool and input, and the fill's output. */
const fillTerms = (order: string, outId: string, outAmount: string): string =>
  `${order} ${JSON.stringify([outId, canonAmount(outAmount)])}`;
const tieKey = (offset: number, trade: string): string => `${offset} ${trade}`;

/** The party's unsettled fills with one pool, input and output. */
interface Pool {
  orderCids: string[];
  /** A settlement of these terms took no tie, so which of these fills are
   *  still unsettled is not known until none is left. */
  uncertain: boolean;
}

/** The trades settled in one transaction, by their terms: one receive and one
 *  send leg each, on one pool. */
function tradesByTerms(u: TcUpdate): Map<string, string[]> {
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
  const out = new Map<string, string[]>();
  for (const [trade, { receive, send, doubled }] of trades) {
    if (!receive || !send || doubled || receive.ammId !== send.ammId) continue;
    const key = fillTerms(orderTerms(send.ammId, send.leg.instrumentId, send.leg.amount), receive.leg.instrumentId, receive.leg.amount);
    out.set(key, [...(out.get(key) ?? []), trade]);
  }
  return out;
}

export class TcFillIndex {
  /** Every record of the party's at or below this offset has been applied. */
  builtTo = 0;
  /** Ties at or below this offset may have been dropped. */
  forgotTo = 0;
  /** Why this index cannot be used; once set, it stays. */
  broken: string | undefined;
  usedAt = 0;
  /** After a failed read, no read for it before this time (ms). */
  retryAt = 0;
  /** A request is reading the party's history for it; another one does not. */
  catchingUp = false;
  /** The party's Tradecraft allocations not replaced yet. */
  private readonly allocations = new Set<string>();
  /** Open orders: their pool and input. */
  private readonly orders = new Map<string, string>();
  /** Unsettled fills by their pool, input and output. */
  private readonly open = new Map<string, Pool>();
  private openCount = 0;
  /** Order ids by settlement offset and trade id, oldest first. */
  private readonly ties = new Map<string, string>();

  constructor(private readonly limits: TcFillIndexLimits = { maxOpen: TC_INDEX_MAX_OPEN, maxTies: TC_INDEX_MAX_TIES }) {}

  /** Records held: allocations, open orders, unsettled fills and ties. */
  get entries(): number {
    return this.allocations.size + this.orders.size + this.openCount + this.ties.size;
  }

  /** Apply the party's records in (builtTo, upTo]: every one of them must be in
   *  `updates`, which may also hold records at or below builtTo (skipped). */
  apply(updates: readonly TcUpdate[], upTo: number): void {
    if (this.broken !== undefined) return;
    let last = this.builtTo;
    for (const u of [...updates].sort((a, b) => a.offset - b.offset)) {
      if (u.offset <= last || u.offset > upTo) continue;
      try {
        this.applyOne(u);
      } catch (err) {
        // A record applied halfway would be applied again on the next read.
        this.stop(`offset ${u.offset}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.broken !== undefined) return;
      last = u.offset;
    }
    if (upTo > this.builtTo) this.builtTo = upTo;
  }

  /** The order the trade settled at this offset settles, when the index tied it. */
  orderCidOf(offset: number, trade: string | undefined): string | undefined {
    return trade === undefined ? undefined : this.ties.get(tieKey(offset, trade));
  }

  /** Give up on this party, and let go of what the index held. */
  stop(reason: string): void {
    this.broken = reason;
    this.allocations.clear();
    this.orders.clear();
    this.open.clear();
    this.openCount = 0;
    this.ties.clear();
  }

  private applyOne(u: TcUpdate): void {
    if ((u.anomalies?.length ?? 0) > 0) return this.stop(`offset ${u.offset}: a record of the party's the relay could not read`);
    for (const c of u.allocations) this.allocations.add(c.allocationCid);
    for (const c of u.allocations) {
      if (c.previousAllocationCid !== undefined && !this.allocations.has(c.previousAllocationCid)) {
        return this.stop(`offset ${u.offset}: a settlement of an allocation from before the party's history on this participant`);
      }
    }
    for (const c of u.allocations) if (c.previousAllocationCid !== undefined) this.allocations.delete(c.previousAllocationCid);
    const fills: Array<{ orderCid: string; key: string }> = [];
    for (const o of u.orders) {
      if (o.kind === "created") {
        if (o.ammId !== undefined && o.sell) this.orders.set(o.orderCid, orderTerms(o.ammId, o.sell.instrument.id, o.sell.amount));
        continue;
      }
      if (o.kind === "archived") return this.stop(`offset ${u.offset}: an order closed by ${o.choice ?? "a choice"}, which the relay does not interpret`);
      const terms = o.ammId !== undefined && o.sell ? orderTerms(o.ammId, o.sell.instrument.id, o.sell.amount) : this.orders.get(o.orderCid);
      this.orders.delete(o.orderCid);
      if (o.kind !== "filled") continue;
      if (!o.output || terms === undefined) return this.stop(`offset ${u.offset}: a fill whose output or terms could not be read`);
      fills.push({ orderCid: o.orderCid, key: fillTerms(terms, o.output.instrument.id, o.output.amount) });
    }
    // Settlements before this transaction's own fills, so those cannot take a tie.
    const settled = tradesByTerms(u);
    for (const [key, trades] of settled) {
      const own = fills.filter((f) => f.key === key).length;
      let pool = this.open.get(key);
      if ((pool?.orderCids.length ?? 0) + own === 0) continue; // no fill of the party's this index saw
      if (pool === undefined) {
        pool = { orderCids: [], uncertain: false };
        this.open.set(key, pool);
      }
      if (trades.length === 1 && pool.orderCids.length === 1 && own === 0 && !pool.uncertain) {
        this.tie(u.offset, trades[0]!, pool.orderCids[0]!);
      } else {
        pool.uncertain = true;
      }
      // As many fills with these terms have settled as there are trades: the
      // unsettled ones first, then this transaction's. With more trades than
      // that, one settled a fill the index never saw.
      for (let n = trades.length; n > 0; n--) {
        if (pool.orderCids.length > 0) {
          pool.orderCids.shift();
          this.openCount--;
          continue;
        }
        const i = fills.findIndex((f) => f.key === key);
        if (i < 0) break;
        fills.splice(i, 1);
      }
    }
    for (const f of fills) {
      let pool = this.open.get(f.key);
      if (pool === undefined) {
        pool = { orderCids: [], uncertain: false };
        this.open.set(f.key, pool);
      }
      pool.orderCids.push(f.orderCid);
      this.openCount++;
    }
    for (const key of settled.keys()) if (this.open.get(key)?.orderCids.length === 0) this.open.delete(key);
    if (this.orders.size + this.openCount > this.limits.maxOpen) this.stop("more open orders and unsettled fills than an index keeps");
  }

  private tie(offset: number, trade: string, orderCid: string): void {
    this.ties.set(tieKey(offset, trade), orderCid);
    // Ties are made in offset order, so the first is the oldest.
    while (this.ties.size > this.limits.maxTies) {
      const oldest = this.ties.keys().next().value as string;
      this.ties.delete(oldest);
      this.forgotTo = Number(oldest.slice(0, oldest.indexOf(" ")));
    }
  }
}

export interface TcFillIndexLimits {
  maxOpen: number;
  maxTies: number;
}

/** One index per participant and party. */
export class TcFillIndexes {
  private readonly byKey = new Map<string, TcFillIndex>();
  /** The highest ledger end seen per participant. */
  private readonly endSeen = new Map<string, number>();
  constructor(
    private readonly maxParties = TC_INDEX_MAX_PARTIES,
    private readonly maxEntries = TC_INDEX_MAX_ENTRIES,
    private readonly limits?: TcFillIndexLimits
  ) {}

  /**
   * Whether the participant's ledger went back (a reset or a restore): then
   * every index of it is of another history and is dropped. `end` was read
   * earlier in the request, so one below the highest end seen is checked
   * against `fresh()` first: another request may have read a later one.
   */
  async wentBack(participant: string, end: number, fresh: () => Promise<number>): Promise<boolean> {
    const seen = this.endSeen.get(participant) ?? 0;
    if (end >= seen) {
      this.endSeen.set(participant, end);
      return false;
    }
    const now = await fresh();
    if (now >= (this.endSeen.get(participant) ?? 0)) return false;
    for (const k of [...this.byKey.keys()]) if (k.startsWith(`${participant} `)) this.byKey.delete(k);
    this.endSeen.set(participant, now);
    return true;
  }

  /** The party's index on this participant, if there is one. */
  get(participant: string, party: string, now = Date.now()): TcFillIndex | undefined {
    const idx = this.byKey.get(`${participant} ${party}`);
    if (idx !== undefined) idx.usedAt = now;
    return idx;
  }

  /** The party's index on this participant, a new one when there is none. */
  for(participant: string, party: string, now = Date.now()): TcFillIndex {
    let idx = this.get(participant, party, now);
    if (idx === undefined) {
      idx = new TcFillIndex(this.limits);
      idx.usedAt = now;
      this.byKey.set(`${participant} ${party}`, idx);
      this.trim(idx);
    }
    return idx;
  }

  /** Drop the least recently used indexes but `keep` and those being read for
   *  while there are too many of them or they hold too much together. */
  trim(keep: TcFillIndex): void {
    let entries = 0;
    for (const idx of this.byKey.values()) entries += idx.entries;
    while (this.byKey.size > this.maxParties || entries > this.maxEntries) {
      let oldest: [string, TcFillIndex] | undefined;
      for (const e of this.byKey) {
        if (e[1] !== keep && !e[1].catchingUp && (oldest === undefined || e[1].usedAt < oldest[1].usedAt)) oldest = e;
      }
      if (oldest === undefined) return;
      this.byKey.delete(oldest[0]);
      entries -= oldest[1].entries;
    }
  }

  get size(): number {
    return this.byKey.size;
  }
}

/** What `tagFromFillIndex` reads with, and where it reports. */
export interface FillIndexIo {
  /** The party's records in (beginExclusive, endInclusive], at most `limit` rows. */
  read: (
    beginExclusive: number,
    endInclusive: number,
    limit: number
  ) => Promise<{ transactions: readonly LedgerTransaction[]; rows: number; lastOffset?: number | undefined }>;
  /** The participant's ledger end, read now. */
  ledgerEnd: () => Promise<number>;
  /** One more read on the caller's budget; false = refused. */
  allowRead: () => boolean;
  warn: (detail: Record<string, unknown>, message: string) => void;
}

/**
 * Tag a page's settlement legs from the party's index (`page.end` is the ledger
 * end the page was read against). An index behind the page is extended first,
 * by one request at a time: at most TC_INDEX_CATCHUP_READS reads, each allowed
 * by `io.allowRead` and started within TC_INDEX_DEADLINE_MS; the next request
 * goes on from where this one stopped. Returns whether the legs carry every
 * order id that can be told: true for a page with no trade; false while the
 * index is behind or another request reads for it, after a read failed, for a
 * page older than the ties kept, and for good once the index stopped. Only a
 * page with a trade makes an index.
 */
export async function tagFromFillIndex(
  indexes: TcFillIndexes,
  key: { participant: string; party: string },
  page: { after: number; next: number; end: number; updates: TcUpdate[] },
  io: FillIndexIo
): Promise<boolean> {
  if (await indexes.wentBack(key.participant, page.end, io.ledgerEnd)) {
    io.warn({ end: page.end }, "the participant's ledger went back; its fill indexes start again");
  }
  const trades = hasTrade(page.updates);
  const idx = trades ? indexes.for(key.participant, key.party) : indexes.get(key.participant, key.party);
  if (idx === undefined) return true;
  if (idx.broken !== undefined) return !trades;
  if (trades && idx.builtTo < page.after && !idx.catchingUp) {
    idx.catchingUp = true;
    const started = Date.now();
    try {
      for (let reads = 0; idx.builtTo < page.after && reads < TC_INDEX_CATCHUP_READS; reads++) {
        if (Date.now() < idx.retryAt || Date.now() - started > TC_INDEX_DEADLINE_MS || !io.allowRead()) break;
        const from = idx.builtTo;
        const back = await io.read(from, page.after, TC_UPDATES_MAX_LIMIT);
        const upTo = back.rows < TC_UPDATES_MAX_LIMIT ? page.after : back.lastOffset;
        if (upTo === undefined || upTo <= from) break;
        idx.apply(await summarizeTradecraftPage(key.party, back.transactions), upTo);
        if (idx.broken !== undefined) break;
      }
    } catch (err) {
      idx.retryAt = Date.now() + TC_INDEX_RETRY_MS;
      io.warn({ err: err instanceof Error ? err.message : String(err) }, "could not read the party's history for its fill index");
    } finally {
      idx.catchingUp = false;
    }
  }
  if (idx.broken === undefined && idx.builtTo >= page.after) idx.apply(page.updates, page.next);
  indexes.trim(idx);
  if (idx.broken !== undefined) {
    io.warn({ reason: idx.broken }, "the party's fill index stopped; its pages go out without order ids");
    return !trades;
  }
  if (!trades) return true;
  if (idx.builtTo < page.next || page.after < idx.forgotTo) return false;
  for (const u of page.updates) {
    for (const c of u.allocations) {
      for (const l of c.legs) {
        const orderCid = idx.orderCidOf(u.offset, tradeOf(l.transferLegId));
        if (orderCid !== undefined) l.orderCid = orderCid;
        else delete l.orderCid;
      }
    }
  }
  return true;
}
