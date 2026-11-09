import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerWalletRoutes, type WalletRelayServices } from "./wallet.js";
import {
  READ_PROOF_HEADER,
  READ_PROOF_ROUTES,
  createReadProofGuard,
  PARTY_RE,
  parseReadProofMode,
  readProofMessage,
  type ReadProofGuardOptions,
  type ReadProofMode,
  type ReadProofResult,
} from "./read-proof.js";
import { TopologyLookupError } from "../canton/topology-reader-client.js";
import { createMetrics } from "../metrics.js";
import { PARTY_RE as READER_PARTY_RE } from "../../../topology-reader/src/topology-client.js";

const FP = "1220" + "ab".repeat(30);
const PARTY = `agent::${FP}`;
const OTHER = `other::1220${"cd".repeat(30)}`;
const HOST = "relay.test";
const TRUSTED_KEY = "trusted-relay-key-for-tests-only-000000";
const T0 = 1_800_000_000_000;

const pair = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const spki = (k: KeyObject) => k.export({ type: "spki", format: "der" }) as Buffer;
const good = async () => [spki(pair.publicKey)];
const down = async (): Promise<Buffer[]> => {
  throw new TopologyLookupError("down", "unavailable");
};

const pathFor = (party: string, route = "balance") => `/v1/wallet/${encodeURIComponent(party)}/${route}`;

function proof(o: {
  key?: KeyObject;
  method?: string;
  host?: string;
  pathname?: string;
  query?: string;
  party?: string;
  ts?: number;
  route?: string;
}): string {
  const party = o.party ?? PARTY;
  const ts = o.ts ?? T0;
  const msg = readProofMessage({
    method: o.method ?? "GET",
    host: o.host ?? HOST,
    pathname: o.pathname ?? `/v1/wallet/${party}/${o.route ?? "balance"}`,
    query: o.query ?? "",
    party,
    timestampMs: ts,
  });
  return `v1.${ts}.${sign(null, msg, o.key ?? pair.privateKey).toString("base64url")}`;
}

function build(
  mode: ReadProofMode,
  lookup: ((p: string) => Promise<Buffer[]>) | undefined,
  guardOpts: Partial<ReadProofGuardOptions> = {},
  extra: Partial<WalletRelayServices> = {}
) {
  const seen: ReadProofResult[] = [];
  const clock = { now: T0 };
  const queryActiveContracts = vi.fn().mockResolvedValue([]);
  const guard = createReadProofGuard({
    mode,
    lookup,
    now: () => clock.now,
    record: (r) => seen.push(r),
    ...guardOpts,
  });
  const app = Fastify();
  const svc = {
    client: { queryActiveContracts } as never,
    facilitatorParty: "facilitator::1220fac",
    synchronizerId: "global-domain::12201",
    userId: "facilitator@clients",
    scanUrl: "http://scan.test",
    enableAgentWallet: true,
    walletSubmitChoices: ["TransferFactory_Transfer"],
    trustedKeys: [TRUSTED_KEY],
    readProofGuard: guard,
    ...extra,
  } as WalletRelayServices;
  return { app, svc, seen, clock, guard, queryActiveContracts };
}

async function get(
  mode: ReadProofMode,
  header: string | undefined,
  lookup: ((p: string) => Promise<Buffer[]>) | undefined,
  opts: { url?: string; headers?: Record<string, string>; guardOpts?: Partial<ReadProofGuardOptions> } = {}
) {
  const b = build(mode, lookup, opts.guardOpts);
  await registerWalletRoutes(b.app, b.svc);
  const headers: Record<string, string> = { host: HOST, ...(opts.headers ?? {}) };
  if (header !== undefined) headers[READ_PROOF_HEADER] = header;
  const res = await b.app.inject({ method: "GET", url: opts.url ?? pathFor(PARTY), headers });
  await b.guard.settled();
  return { res, ...b };
}

describe("parseReadProofMode", () => {
  it("defaults to observe", () => {
    expect(parseReadProofMode(undefined)).toBe("observe");
    expect(parseReadProofMode("")).toBe("observe");
    expect(parseReadProofMode("  ")).toBe("observe");
  });
  it("accepts the three modes, any case", () => {
    expect(parseReadProofMode("off")).toBe("off");
    expect(parseReadProofMode("Observe")).toBe("observe");
    expect(parseReadProofMode(" ENFORCE ")).toBe("enforce");
  });
  it("refuses anything else", () => {
    expect(() => parseReadProofMode("on")).toThrow(/off, observe or enforce/);
    expect(() => parseReadProofMode("true")).toThrow();
  });
});

describe("metric wiring", () => {
  it("counts each result on x402_facilitator_wallet_read_proof_total{result}", async () => {
    const m = createMetrics({ collectDefault: false });
    const guard = createReadProofGuard({
      mode: "observe",
      lookup: good,
      now: () => T0,
      record: (r) => m.recordWalletReadProof(r),
    });
    const app = Fastify();
    await registerWalletRoutes(app, {
      client: { queryActiveContracts: async () => [] } as never,
      facilitatorParty: "f::1220fac",
      synchronizerId: "s::1",
      userId: "u",
      scanUrl: "http://scan.test",
      enableAgentWallet: true,
      walletSubmitChoices: ["X"],
      readProofGuard: guard,
    } as WalletRelayServices);
    const send = (h?: string) =>
      app.inject({ method: "GET", url: pathFor(PARTY), headers: { host: HOST, ...(h ? { [READ_PROOF_HEADER]: h } : {}) } });
    await send();
    await send(proof({}));
    await send(proof({ key: stranger.privateKey }));
    await send(proof({ ts: T0 - 200_000 }));
    await guard.settled();
    const text = await m.registry.metrics();
    for (const r of ["absent", "valid", "invalid", "expired"]) {
      expect(text).toMatch(new RegExp(`x402_facilitator_wallet_read_proof_total\\{[^}]*result="${r}"[^}]*\\} 1`));
    }
  });
});

describe("read proof, observe mode (never refuses)", () => {
  const cases: Array<[string, string | undefined, () => Promise<Buffer[]>, ReadProofResult]> = [
    ["absent", undefined, good, "absent"],
    ["valid", proof({}), good, "valid"],
    ["bad signature", proof({ key: stranger.privateKey }), good, "invalid"],
    ["malformed", "v1.nope", good, "invalid"],
    ["expired", proof({ ts: T0 - 121_000 }), good, "expired"],
    ["from the future", proof({ ts: T0 + 121_000 }), good, "expired"],
    ["wrong path", proof({ pathname: `/v1/wallet/${PARTY}/holdings` }), good, "invalid"],
    ["wrong method", proof({ method: "POST" }), good, "invalid"],
    ["wrong host", proof({ host: "evil.test" }), good, "invalid"],
    ["signed for another party", proof({ party: OTHER }), good, "invalid"],
    ["lookup down", proof({}), down, "unverifiable"],
  ];
  it.each(cases)("%s -> %s counted, request served", async (_n, header, lookup, expected) => {
    const { res, seen } = await get("observe", header, lookup);
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([expected]);
  });

  it("serves at once while the lookup hangs, and counts afterwards", async () => {
    let release!: (k: Buffer[]) => void;
    const lookup = () => new Promise<Buffer[]>((r) => (release = r));
    const b = build("observe", lookup);
    await registerWalletRoutes(b.app, b.svc);
    const res = await b.app.inject({
      method: "GET",
      url: pathFor(PARTY),
      headers: { host: HOST, [READ_PROOF_HEADER]: proof({}) },
    });
    expect(res.statusCode).toBe(200);
    expect(b.seen).toEqual([]);
    release([spki(pair.publicKey)]);
    await b.guard.settled();
    expect(b.seen).toEqual(["valid"]);
  });
});

describe("bound request parts", () => {
  it("the query string, exactly as sent, is signed", async () => {
    const ok = await get("enforce", proof({ route: "pending", query: "registry=1" }), good, {
      url: `${pathFor(PARTY, "pending")}?registry=1`,
    });
    expect(ok.res.statusCode).toBe(200);
    const swapped = await get("enforce", proof({ route: "pending", query: "registry=1" }), good, {
      url: `${pathFor(PARTY, "pending")}?registry=2`,
    });
    expect(swapped.res.statusCode).toBe(401);
    expect(swapped.res.json().error).toBe("read_proof_invalid");
  });
  it("a proof without the query cannot be replayed with one", async () => {
    const { res } = await get("enforce", proof({ route: "pending" }), good, {
      url: `${pathFor(PARTY, "pending")}?registry=1`,
    });
    expect(res.statusCode).toBe(401);
  });
  it("%26 does not pass for &", async () => {
    const { res } = await get("enforce", proof({ route: "tx-amulets", query: "updateId=a&b=1" }), good, {
      url: `${pathFor(PARTY, "tx-amulets")}?updateId=a%26b=1`,
    });
    expect(res.statusCode).toBe(401);
  });
  it("the Host the server received is signed, compared lowercased", async () => {
    const ok = await get("enforce", proof({ host: "relay.test" }), good, { headers: { host: "Relay.TEST" } });
    expect(ok.res.statusCode).toBe(200);
    const bad = await get("enforce", proof({ host: "relay.test" }), good, { headers: { host: "other.test" } });
    expect(bad.res.statusCode).toBe(401);
  });
  it("the path is signed decoded", async () => {
    const { res } = await get("enforce", proof({}), good, { url: pathFor(PARTY) });
    expect(res.statusCode).toBe(200);
  });
});

describe("read proof, enforce mode", () => {
  it("serves a valid proof", async () => {
    expect((await get("enforce", proof({}), good)).res.statusCode).toBe(200);
  });
  it("401 read_proof_required when absent", async () => {
    const { res, queryActiveContracts } = await get("enforce", undefined, good);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("read_proof_required");
    expect(queryActiveContracts).not.toHaveBeenCalled();
  });
  it.each([
    ["bad signature", proof({ key: stranger.privateKey })],
    ["wrong path", proof({ pathname: `/v1/wallet/${PARTY}/outgoing` })],
    ["wrong party", proof({ party: OTHER })],
    ["garbage", "hello"],
  ])("401 read_proof_invalid: %s", async (_n, header) => {
    const { res } = await get("enforce", header, good);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("read_proof_invalid");
  });
  it("clock skew is its own error, read_proof_expired", async () => {
    for (const ts of [T0 - 121_000, T0 + 121_000]) {
      const { res } = await get("enforce", proof({ ts }), good);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("read_proof_expired");
    }
  });
  it("503 read_proof_unverifiable with Retry-After when the key lookup fails", async () => {
    const { res } = await get("enforce", proof({}), down);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("read_proof_unverifiable");
    expect(res.headers["retry-after"]).toBeDefined();
  });
  it("a party with no published key is invalid, not unverifiable", async () => {
    for (const lookup of [
      async () => [] as Buffer[],
      async () => {
        throw new TopologyLookupError("none", "no_key");
      },
    ]) {
      const { res } = await get("enforce", proof({}), lookup);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("read_proof_invalid");
    }
  });
  it("a broken reader is unverifiable", async () => {
    const { res } = await get("enforce", proof({}), async () => {
      throw new TopologyLookupError("401", "reader_error");
    });
    expect(res.statusCode).toBe(503);
  });
  it("waits for the lookup only a bounded time", async () => {
    const { res } = await get("enforce", proof({}), () => new Promise<Buffer[]>(() => {}), {
      guardOpts: { enforceWaitMs: 30 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("read_proof_unverifiable");
  });
  it("refuses to be built with no key lookup", () => {
    expect(() => createReadProofGuard({ mode: "enforce", lookup: undefined })).toThrow(/key lookup/);
    expect(() => createReadProofGuard({ mode: "observe", lookup: undefined })).not.toThrow();
    expect(() => createReadProofGuard({ mode: "off", lookup: undefined })).not.toThrow();
  });
});

describe("cost on the topology reader", () => {
  const BAD_PARTIES = ["x", "no-separator", `a::${"g".repeat(20)}`, `a::${"ab".repeat(3)}`, `ev/il::${FP}`];
  it.each(BAD_PARTIES)("a malformed party (%s) is invalid with no lookup", async (party) => {
    const lookup = vi.fn(good);
    const { res, seen } = await get("observe", proof({ party }), lookup, { url: `/v1/wallet/${encodeURIComponent(party)}/balance` });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(["invalid"]);
    expect(lookup).not.toHaveBeenCalled();
    const e = await get("enforce", proof({ party }), lookup, { url: `/v1/wallet/${encodeURIComponent(party)}/balance` });
    expect(e.res.json().error).toBe("read_proof_invalid");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uncached lookups share a process-wide budget; over it is unverifiable with no call", async () => {
    const lookup = vi.fn(good);
    const b = build("enforce", lookup, { lookupBudgetPerMinute: 2 });
    await registerWalletRoutes(b.app, b.svc);
    const party = (i: number) => `p${i}::${FP}`;
    const status: number[] = [];
    for (let i = 0; i < 4; i++) {
      const p = party(i);
      const r = await b.app.inject({
        method: "GET",
        url: pathFor(p),
        headers: { host: HOST, [READ_PROOF_HEADER]: proof({ party: p }) },
      });
      status.push(r.statusCode);
    }
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(status).toEqual([200, 200, 503, 503]);
    b.clock.now += 61_000; // window passes
    const p = party(9);
    const r = await b.app.inject({ method: "GET", url: pathFor(p), headers: { host: HOST, [READ_PROOF_HEADER]: proof({ party: p, ts: b.clock.now }) } });
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(r.statusCode).toBe(200);
  });

  it("a cached party costs no budget", async () => {
    const lookup = vi.fn(good);
    const b = build("enforce", lookup, { lookupBudgetPerMinute: 1 });
    await registerWalletRoutes(b.app, b.svc);
    for (let i = 0; i < 5; i++) {
      const r = await b.app.inject({ method: "GET", url: pathFor(PARTY), headers: { host: HOST, [READ_PROOF_HEADER]: proof({}) } });
      expect(r.statusCode).toBe(200);
    }
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("one failing party does not open the breaker; three distinct ones do, for ~10 s", async () => {
    for (const reason of ["unavailable", "reader_error"] as const) {
      const lookup = vi.fn(async (): Promise<Buffer[]> => {
        throw new TopologyLookupError("x", reason);
      });
      const b = build("enforce", lookup);
      await registerWalletRoutes(b.app, b.svc);
      const call = (party: string) =>
        b.app.inject({ method: "GET", url: pathFor(party), headers: { host: HOST, [READ_PROOF_HEADER]: proof({ party, ts: b.clock.now }) } });
      const P = (i: number) => `p${i}::${FP}`;
      expect((await call(P(1))).statusCode).toBe(503);
      expect((await call(P(1))).statusCode).toBe(503);
      expect(lookup).toHaveBeenCalledTimes(1); // same party again: brief backoff, no new call
      await call(P(2));
      await call(P(3)); // third distinct party: breaker opens
      expect(lookup).toHaveBeenCalledTimes(3);
      b.clock.now += 5_000;
      expect((await call(P(4))).statusCode).toBe(503);
      expect(lookup).toHaveBeenCalledTimes(3);
      b.clock.now += 6_000;
      await call(P(5));
      expect(lookup).toHaveBeenCalledTimes(4);
    }
  });

  it("no_key is cached briefly, then asked again", async () => {
    const lookup = vi.fn(async (): Promise<Buffer[]> => {
      throw new TopologyLookupError("none", "no_key");
    });
    const b = build("enforce", lookup);
    await registerWalletRoutes(b.app, b.svc);
    const call = () =>
      b.app.inject({ method: "GET", url: pathFor(PARTY), headers: { host: HOST, [READ_PROOF_HEADER]: proof({ ts: b.clock.now }) } });
    await call();
    b.clock.now += 5_000;
    await call();
    expect(lookup).toHaveBeenCalledTimes(1);
    b.clock.now += 26_000; // past 30 s
    await call();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("the cache is LRU: a hot party survives, the least recently used goes", async () => {
    const lookup = vi.fn(good);
    const b = build("observe", lookup, { maxCachedParties: 2 });
    await registerWalletRoutes(b.app, b.svc);
    const call = async (party: string) => {
      await b.app.inject({ method: "GET", url: pathFor(party), headers: { host: HOST, [READ_PROOF_HEADER]: proof({ party }) } });
      await b.guard.settled();
    };
    const A = `a::${FP}`, B = `b::${FP}`, C = `c::${FP}`;
    await call(A);
    await call(B);
    await call(A); // A is now most recent
    await call(C); // evicts B, not A
    expect(lookup).toHaveBeenCalledTimes(3);
    await call(A);
    expect(lookup).toHaveBeenCalledTimes(3);
    await call(B);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("a hung lookup is cut off by the guard's own timeout and trips the breaker", async () => {
    const lookup = vi.fn(() => new Promise<Buffer[]>(() => {}));
    const { res } = await get("enforce", proof({}), lookup, { guardOpts: { lookupTimeoutMs: 20, enforceWaitMs: 1000 } });
    expect(res.statusCode).toBe(503);
  });
});

describe("read proof, exemptions and off", () => {
  it.each(["off", "observe", "enforce"] as const)("a trusted key is exempt in %s", async (mode) => {
    const lookup = vi.fn(good);
    const { res } = await get(mode, undefined, lookup, { headers: { "x-agent-key": TRUSTED_KEY } });
    expect(res.statusCode).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("off does no work: no lookup, no count, even with a header", async () => {
    const lookup = vi.fn(good);
    const { res, seen } = await get("off", proof({}), lookup);
    expect(res.statusCode).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
  it("keys are cached per party", async () => {
    const lookup = vi.fn(good);
    const b = build("observe", lookup);
    await registerWalletRoutes(b.app, b.svc);
    for (let i = 0; i < 3; i++) {
      await b.app.inject({ method: "GET", url: pathFor(PARTY), headers: { host: HOST, [READ_PROOF_HEADER]: proof({}) } });
      await b.guard.settled();
    }
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("a failed lookup is not cached (after the breaker pause)", async () => {
    let fail = true;
    const lookup = vi.fn(async () => {
      if (fail) throw new TopologyLookupError("down", "unavailable");
      return [spki(pair.publicKey)];
    });
    const b = build("enforce", lookup);
    await registerWalletRoutes(b.app, b.svc);
    const call = () =>
      b.app.inject({ method: "GET", url: pathFor(PARTY), headers: { host: HOST, [READ_PROOF_HEADER]: proof({ ts: b.clock.now }) } });
    expect((await call()).statusCode).toBe(503);
    fail = false;
    b.clock.now += 11_000;
    expect((await call()).statusCode).toBe(200);
  });
});

describe("every party read route is guarded, and the lists agree", () => {
  it.each([...READ_PROOF_ROUTES])("enforce refuses /%s without a proof", async (route) => {
    const b = build("enforce", good);
    await registerWalletRoutes(b.app, b.svc);
    const res = await b.app.inject({ method: "GET", url: pathFor(PARTY, route), headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("read_proof_required");
  });

  it("READ_PROOF_ROUTES is exactly the per-party GETs the relay registers", async () => {
    const b = build("enforce", good);
    const registered: string[] = [];
    b.app.addHook("onRoute", (r) => {
      const m = /^\/v1\/wallet\/:party\/([a-z-]+)$/.exec(r.url);
      const methods = ([] as string[]).concat(r.method);
      if (m && methods.includes("GET")) registered.push(m[1]!);
    });
    await registerWalletRoutes(b.app, b.svc);
    expect([...registered].sort()).toEqual([...READ_PROOF_ROUTES].sort());
  });
});

// Real client, real route. The packages do not depend on each other, so the
// client is loaded from its build output; skipped when it is not built.
const clientDist = fileURLToPath(new URL("../../../agent-wallet/dist/relay-client.js", import.meta.url));
const keysDist = fileURLToPath(new URL("../../../agent-wallet/dist/keys.js", import.meta.url));

describe.skipIf(!existsSync(clientDist))("real RelayClient against the real route", () => {
  it("client and server route lists are equal", async () => {
    const { READ_PROOF_ROUTES: clientRoutes } = await import(pathToFileURL(clientDist).href);
    expect([...clientRoutes].sort()).toEqual([...READ_PROOF_ROUTES].sort());
  });

  it("proves its own party over HTTP, query and host included; another party is refused", async () => {
    const { RelayClient } = await import(pathToFileURL(clientDist).href);
    const { generateAgentKey, readSignerFromWallet } = await import(pathToFileURL(keysDist).href);
    const key = generateAgentKey();
    const der = Buffer.from(key.publicKeySpkiB64, "base64");
    const lookup = vi.fn(async (p: string) => (p === PARTY ? [der] : []));
    const b = build("enforce", lookup, { now: Date.now });
    await registerWalletRoutes(b.app, b.svc);
    await b.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const addr = b.app.server.address() as { port: number };
      const client = new RelayClient({
        relayUrl: `http://127.0.0.1:${addr.port}`,
        readSigner: readSignerFromWallet({ party: PARTY, privateKeyPkcs8Pem: key.privateKeyPkcs8Pem }),
      });
      expect((await client.balance(PARTY)).party).toBe(PARTY);
      await client.pending(PARTY); // has a query string
      // fetch re-encodes ' in the query; the proof must cover what is on the wire
      await client.txAmulets(PARTY, "ab'cd").catch(() => undefined);
      await expect(client.balance(OTHER)).rejects.toThrow(/401.*read_proof_required/);
      await b.guard.settled();
      expect(b.seen).toEqual(["valid", "valid", "valid", "absent"]);
    } finally {
      await b.app.close();
    }
  });
});


describe("PARTY_RE is the topology reader's", () => {
  it("same source and flags", () => {
    expect(PARTY_RE.source).toBe(READER_PARTY_RE.source);
    expect(PARTY_RE.flags).toBe(READER_PARTY_RE.flags);
  });
});

describe("a throwing record callback", () => {
  it("never leaves an unhandled rejection (observe) nor breaks the answer (enforce)", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const boom = () => {
        throw new Error("metrics broke");
      };
      const o = build("observe", good, { record: boom });
      await registerWalletRoutes(o.app, o.svc);
      const r1 = await o.app.inject({ method: "GET", url: pathFor(PARTY), headers: { host: HOST, [READ_PROOF_HEADER]: proof({}) } });
      expect(r1.statusCode).toBe(200);
      await o.guard.settled();
      const e = build("enforce", good, { record: boom });
      await registerWalletRoutes(e.app, e.svc);
      const r2 = await e.app.inject({ method: "GET", url: pathFor(PARTY), headers: { host: HOST, [READ_PROOF_HEADER]: proof({}) } });
      expect(r2.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});

describe("honest proven reads survive a cheap attacker", () => {
  const HOUR = 3_600_000;
  const call = (b: ReturnType<typeof build>, party: string, remoteAddress = "203.0.113.5") =>
    b.app.inject({
      method: "GET",
      url: pathFor(party),
      remoteAddress,
      headers: { host: HOST, [READ_PROOF_HEADER]: proof({ party, ts: b.clock.now }) },
    });

  it("a cached key stays usable for ~24 h when a refresh is refused (breaker, budget)", async () => {
    const lookup = vi.fn(good);
    const b = build("enforce", lookup, { lookupBudgetPerMinute: 1 });
    await registerWalletRoutes(b.app, b.svc);
    expect((await call(b, PARTY)).statusCode).toBe(200);
    b.clock.now += 10 * 60_000; // past the fresh time
    // budget spent by another party in the same window
    expect((await call(b, `x::${FP}`)).statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(2);
    b.clock.now += 1_000;
    expect((await call(b, PARTY)).statusCode).toBe(200); // stale, refresh refused by budget
    expect(lookup).toHaveBeenCalledTimes(2);
    b.clock.now += 23 * HOUR;
    expect((await call(b, PARTY)).statusCode).toBe(200); // still inside 24 h of the last good lookup
    b.clock.now += 2 * HOUR;
    expect((await call(b, PARTY)).statusCode).toBe(200); // refresh allowed now (window passed) and succeeds
  });

  it("beyond 24 h with no refresh possible the key is gone", async () => {
    let fail = false;
    const lookup = vi.fn(async () => {
      if (fail) throw new TopologyLookupError("down", "unavailable");
      return [spki(pair.publicKey)];
    });
    const b = build("enforce", lookup);
    await registerWalletRoutes(b.app, b.svc);
    expect((await call(b, PARTY)).statusCode).toBe(200);
    fail = true;
    b.clock.now += 25 * HOUR;
    expect((await call(b, PARTY)).statusCode).toBe(503);
  });

  it("a stale key is refreshed in the background when the budget allows", async () => {
    const lookup = vi.fn(good);
    const b = build("enforce", lookup);
    await registerWalletRoutes(b.app, b.svc);
    await call(b, PARTY);
    b.clock.now += 6 * 60_000;
    expect((await call(b, PARTY)).statusCode).toBe(200);
    await b.guard.settled();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect((await call(b, PARTY)).statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(2); // fresh again
  });

  it("touching an entry does not extend or shorten its fresh time", async () => {
    const lookup = vi.fn(good);
    const b = build("enforce", lookup);
    await registerWalletRoutes(b.app, b.svc);
    await call(b, PARTY);
    b.clock.now += 4 * 60_000;
    await call(b, PARTY);
    expect(lookup).toHaveBeenCalledTimes(1);
    b.clock.now += 2 * 60_000; // 6 min after insert
    await call(b, PARTY);
    await b.guard.settled();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("each source (IPv4, IPv6 /64) has its own share of the lookup budget", async () => {
    const lookup = vi.fn(good);
    const b = build("enforce", lookup, { lookupBudgetPerMinute: 1000, lookupBudgetPerSourcePerMinute: 3 });
    await registerWalletRoutes(b.app, b.svc);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(b, `s${i}::${FP}`, "203.0.113.9")).statusCode);
    expect(codes).toEqual([200, 200, 200, 503, 503]);
    expect((await call(b, `t::${FP}`, "198.51.100.7")).statusCode).toBe(200); // another source is fine
    // two addresses of one /64 share a share
    const v6 = ["2001:db8:1:2::1", "2001:db8:1:2::ffff", "2001:db8:1:2:aaaa::1", "2001:db8:1:2::3"];
    const c6: number[] = [];
    for (let i = 0; i < 4; i++) c6.push((await call(b, `v${i}::${FP}`, v6[i]!)).statusCode);
    expect(c6).toEqual([200, 200, 200, 503]);
  });

  it("junk proofs never strike: an honest client behind a bad proxy is never banned", async () => {
    const strikeCfg = { abuseStrikesToBan: 2, abuseStrikeWindowMs: 60_000, abuseBaseBanMs: 60_000, abuseStrikeSpacingMs: 0 };
    for (const [mode, lookup] of [
      ["enforce", good],
      ["enforce", async () => [] as Buffer[]],
      ["observe", good],
    ] as const) {
      const b = build(mode, lookup, {}, strikeCfg);
      await registerWalletRoutes(b.app, b.svc);
      for (let i = 0; i < 6; i++) {
        const r = await b.app.inject({
          method: "GET",
          url: pathFor(PARTY),
          remoteAddress: "203.0.113.77",
          headers: { host: HOST, [READ_PROOF_HEADER]: proof({ key: stranger.privateKey, ts: b.clock.now + i }) },
        });
        expect(r.statusCode).not.toBe(429);
      }
    }
  });

  it("answers read_proof_wrong_host when the signature fits the host in X-Forwarded-Host", async () => {
    const hdr = proof({ host: "public.test" });
    const e = await get("enforce", hdr, good, { headers: { host: "internal:4021", "x-forwarded-host": "public.test" } });
    expect(e.res.statusCode).toBe(401);
    expect(e.res.json().error).toBe("read_proof_wrong_host");
    expect(e.seen).toEqual(["wrong_host"]);
    const o = await get("observe", hdr, good, { headers: { host: "internal:4021", "x-forwarded-host": "public.test, other" } });
    expect(o.res.statusCode).toBe(200);
    expect(o.seen).toEqual(["wrong_host"]);
    // no forwarded host to try, or a signature that fits nothing: plain invalid
    const none = await get("enforce", hdr, good, { headers: { host: "internal:4021" } });
    expect(none.res.json().error).toBe("read_proof_invalid");
    const junk = await get("enforce", proof({ host: "public.test", key: stranger.privateKey }), good, {
      headers: { host: "internal:4021", "x-forwarded-host": "public.test" },
    });
    expect(junk.res.json().error).toBe("read_proof_invalid");
  });

  it("tries one forwarded host only, and never RFC 7239 Forwarded", async () => {
    // A junk proof with a long host list cost one signature check per entry.
    const hdr = proof({ host: "public.test" });
    const later = await get("enforce", hdr, good, {
      headers: { host: "internal:4021", "x-forwarded-host": "other.test, public.test" },
    });
    expect(later.res.json().error).toBe("read_proof_invalid");
    const fwd = await get("enforce", hdr, good, {
      headers: { host: "internal:4021", forwarded: "host=public.test" },
    });
    expect(fwd.res.json().error).toBe("read_proof_invalid");
    const long = await get("enforce", hdr, good, {
      headers: { host: "internal:4021", forwarded: Array(2000).fill("host=a").join(";") },
    });
    expect(long.res.json().error).toBe("read_proof_invalid");
  });

  it("says why a proof was unverifiable", async () => {
    const reasons: Array<string | undefined> = [];
    const rec = { record: (_r: ReadProofResult, why?: string) => reasons.push(why) } as Partial<ReadProofGuardOptions>;
    const budget = build("enforce", good, { ...rec, lookupBudgetPerMinute: 0 });
    await registerWalletRoutes(budget.app, budget.svc);
    await call(budget, PARTY);
    const err = build("enforce", down, rec);
    await registerWalletRoutes(err.app, err.svc);
    await call(err, `a::${FP}`);
    await call(err, `b::${FP}`);
    await call(err, `c::${FP}`);
    await call(err, `d::${FP}`); // breaker
    expect(reasons).toEqual(["budget", "error", "error", "error", "breaker"]);
  });
});


describe("cache hygiene", () => {
  const call = (b: ReturnType<typeof build>, party: string, remoteAddress = "203.0.113.5") =>
    b.app.inject({ method: "GET", url: pathFor(party), remoteAddress, headers: { host: HOST, [READ_PROOF_HEADER]: proof({ party, ts: b.clock.now }) } });
  const HOUR = 3_600_000;

  it("junk no_key answers live in their own cache and cannot push honest keys out", async () => {
    const lookup = vi.fn(async (p: string) => {
      if (p.startsWith("honest")) return [spki(pair.publicKey)];
      throw new TopologyLookupError("none", "no_key");
    });
    const b = build("enforce", lookup, { maxCachedParties: 3, lookupBudgetPerMinute: 10_000, lookupBudgetPerSourcePerMinute: 10_000 });
    await registerWalletRoutes(b.app, b.svc);
    const H = `honest::${FP}`;
    expect((await call(b, H)).statusCode).toBe(200);
    for (let i = 0; i < 50; i++) await call(b, `junk${i}::${FP}`);
    lookup.mockClear();
    b.clock.now += 4 * 60_000; // still fresh: a miss would be a fresh lookup
    expect((await call(b, H)).statusCode).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("on eviction expired entries go before the least recently used live one", async () => {
    let live = true;
    const lookup = vi.fn(async (p: string) => {
      if (!live && p.startsWith("b")) throw new TopologyLookupError("down", "unavailable");
      return [spki(pair.publicKey)];
    });
    const b = build("enforce", lookup, { maxCachedParties: 2 });
    await registerWalletRoutes(b.app, b.svc);
    const A = `a::${FP}`, B = `b::${FP}`, C = `c::${FP}`;
    await call(b, A);
    b.clock.now += 60_000;
    await call(b, B);
    b.clock.now += 3 * 60_000;
    await call(b, A); // order is now B, A
    b.clock.now += 24 * HOUR - 4 * 60_000 + 30_000; // A is past 24 h, B is not
    live = false;
    await call(b, C); // inserting C overflows: A (expired) must go, not B
    expect((await call(b, B)).statusCode).toBe(200); // stale B still served; its refresh fails
  });

  it("a failed lookup backs a party off briefly: only the first read waits", async () => {
    const lookup = vi.fn(() => new Promise<Buffer[]>(() => {}));
    const b = build("enforce", lookup, { lookupTimeoutMs: 30, enforceWaitMs: 1000 });
    await registerWalletRoutes(b.app, b.svc);
    const t0 = Date.now();
    expect((await call(b, PARTY)).statusCode).toBe(503);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const t1 = Date.now();
    expect((await call(b, PARTY)).statusCode).toBe(503);
    expect(Date.now() - t1).toBeLessThan(20);
    expect(lookup).toHaveBeenCalledTimes(1);
    b.clock.now += 6_000;
    await call(b, PARTY);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("a staged key is only trusted once finalize promotes it; then the first reads need no lookup", async () => {
    const lookup = vi.fn(good);
    const client = {
      queryActiveContracts: vi.fn().mockResolvedValue([]),
      generateExternalPartyTopology: vi.fn().mockResolvedValue({ partyId: PARTY, publicKeyFingerprint: "x", topologyTransactions: ["t"], multiHash: "h" }),
      allocateExternalParty: vi.fn().mockResolvedValue({ partyId: PARTY }),
      grantUserRights: vi.fn().mockResolvedValue(undefined),
    };
    const b = build("enforce", lookup, {}, { client: client as never });
    await registerWalletRoutes(b.app, b.svc);
    const keyData = spki(pair.publicKey).toString("base64");
    const prep = await b.app.inject({
      method: "POST",
      url: "/v1/wallet/onboard/prepare",
      payload: { publicKey: { format: "f", keyData, keySpec: "s" }, partyHint: "agent" },
    });
    expect(prep.statusCode).toBe(200);
    // prepared but not finalized: not trusted, so a read looks the key up
    expect((await call(b, PARTY)).statusCode).toBe(200);
    expect(lookup).toHaveBeenCalledTimes(1);
    // a fresh guard: finalize seeds, the read does not look up
    lookup.mockClear();
    const b2 = build("enforce", lookup, {}, { client: client as never });
    await registerWalletRoutes(b2.app, b2.svc);
    await b2.app.inject({ method: "POST", url: "/v1/wallet/onboard/prepare", payload: { publicKey: { format: "f", keyData, keySpec: "s" }, partyHint: "agent" } });
    const fin = await b2.app.inject({
      method: "POST",
      url: "/v1/wallet/onboard/finalize",
      payload: { onboardingTransactions: ["t"], multiHashSignatures: [{}] },
    });
    expect(fin.statusCode).toBe(200);
    expect((await call(b2, PARTY)).statusCode).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });
});
