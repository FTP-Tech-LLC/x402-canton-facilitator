import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type {
  FacilitatorRequest,
  SettleResponse,
  CantonNetwork,
} from "@ftptech/x402-canton-core";
import {
  registerSettleRoute,
  selectActiveOpenRound,
  type SettleRouteServices,
} from "./settle.js";
import { CantonError } from "@ftptech/x402-canton-ledger";
import { createMetrics } from "../metrics.js";
import {
  createInMemoryTfStashStore,
  type TfStashStore,
  type TfStashRecord,
} from "../db/stash-store.js";

const FACILITATOR = "ftp_facilitator::1220fff";
const PAYER = "agent::1220abc";
const MERCHANT = "merchant::1220def";
const DSO = "dso::1220dso";
const SYNC = "global-domain::1220xyz";
const TF_AMOUNT_WIRE = "1000000000"; // wire (atomic) form of 0.1 CC under scheme "exact"
const TF_UPDATE_ID = "1220-tf-settle";

async function callSettle(
  svc: SettleRouteServices,
  body: FacilitatorRequest
): Promise<SettleResponse> {
  const app = Fastify();
  await registerSettleRoute(app, svc);
  const res = await app.inject({
    method: "POST",
    url: "/settle",
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  const json = res.json() as SettleResponse;
  await app.close();
  return json;
}

// ---------------------------------------------------------------------------
// H2 regression: deterministic active open-mining-round selection
// ---------------------------------------------------------------------------
// Splice exposes several OpenMiningRounds at once; on the SV scan flavor
// they arrive in arbitrary (contractId-key) order. Settle must pick the
// CURRENT active round — the highest round.number whose opensAt is already
// in the past (opensAt = "Time after which transfers can use this mining
// round", splice-amulet Round.daml) — NOT the positional [0], which could
// be a not-yet-open or superseded round and make TransferCommand_Send fail.

describe("selectActiveOpenRound (unit)", () => {
  const NOW = Date.parse("2026-05-30T12:00:00Z");
  const mk = (id: string, number: string, opensAt?: string) => ({
    contract: { contract_id: id, payload: { round: { number }, ...(opensAt ? { opensAt } : {}) } },
  });

  it("returns undefined for an empty list", () => {
    expect(selectActiveOpenRound([], NOW)).toBeUndefined();
  });

  it("picks the highest round.number among already-open rounds (ignores arbitrary order)", () => {
    const past = "2026-05-30T11:00:00Z";
    const rounds = [
      mk("omr-lo", "41", past),
      mk("omr-hi", "43", past),
      mk("omr-mid", "42", past),
    ];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-hi");
  });

  it("does NOT pick a not-yet-open round even if its number is higher", () => {
    const past = "2026-05-30T11:00:00Z";
    const future = "2026-05-30T13:00:00Z";
    const rounds = [
      mk("omr-future-hi", "99", future), // higher number but opensAt > now
      mk("omr-open", "42", past),
    ];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-open");
  });

  it("treats a missing opensAt as eligible (validator scan-proxy / older shapes)", () => {
    const rounds = [mk("omr-a", "7"), mk("omr-b", "9"), mk("omr-c", "8")];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-b");
  });

  it("falls back to the highest-number round when none are open yet (never worse than [0])", () => {
    const future = "2026-05-30T13:00:00Z";
    const rounds = [mk("omr-x", "50", future), mk("omr-y", "51", future)];
    // No eligible round → fall back to highest number overall.
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-y");
  });

  it("a malformed round.number sorts last but a valid round still wins", () => {
    const rounds = [mk("omr-bad", "not-a-number"), mk("omr-ok", "5")];
    expect(selectActiveOpenRound(rounds, NOW)?.contract.contract_id).toBe("omr-ok");
  });
});

// ---------------------------------------------------------------------------
// transfer-factory ("V3") settle harness — the ONLY remaining settle path.
// The operational-guard, metrics and observability tests below are
// method-agnostic (they only care about HTTP status / metric counters / log
// lines), so they drive the transfer-factory harness: a happy tf settle
// returns 200 success; the breaker tests override `execute` (the relay leg) to
// throw the relevant CantonError.
// ---------------------------------------------------------------------------

/** In-memory stash exposing a `_seed` to force a specific ref + recordSettled. */
function makeStash(): TfStashStore & {
  _seed: (r: string, rec: TfStashRecord) => void;
} {
  const base = createInMemoryTfStashStore();
  const rows = new Map<string, TfStashRecord>();
  return {
    ...base,
    _seed(r, rec) {
      rows.set(r, rec);
    },
    async get(ref) {
      return rows.get(ref) ?? null;
    },
    async recordSettled(ref, updateId) {
      const row = rows.get(ref);
      if (!row) return false;
      if (row.settledUpdateId) return false;
      row.settledUpdateId = updateId;
      return true;
    },
  };
}

/** Seed a committed (signed) tf stash row keyed "REF" for the given payer. */
function seedRow(
  stash: TfStashStore & { _seed: (r: string, rec: TfStashRecord) => void },
  payer: string = PAYER
): void {
  stash._seed("REF", {
    ref: "REF",
    payer,
    receiver: MERCHANT,
    amount: "0.1000000000",
    instrumentAdmin: DSO,
    instrumentId: "Amulet",
    executeBefore: new Date(Date.now() + 60_000).toISOString(),
    txHash: "hash",
    preparedTx: "prepared",
    signature: JSON.stringify({
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      partySignatures: { signatures: [{ party: payer, signatures: [{}] }] },
    }),
  });
}

function makeServices(opts: {
  network?: CantonNetwork;
  /** Omit the TransferFactoryService entirely (fail-closed dep test → ledger_error). */
  omitTf?: boolean;
  /** execute (the relay leg) throws. */
  execute?: () => Promise<{
    updateId: string;
    transferred: boolean;
    confirmInconclusive: boolean;
  }>;
} = {}): { svc: SettleRouteServices; stash: ReturnType<typeof makeStash> } {
  const stash = makeStash();
  const execute =
    opts.execute ??
    (async () => ({
      updateId: TF_UPDATE_ID,
      transferred: true,
      confirmInconclusive: false,
    }));
  const svc: SettleRouteServices = {
    facilitatorParty: FACILITATOR,
    network: opts.network ?? "canton:devnet",
    tfEnabled: true,
    tf: { stash, tfEnabled: true },
    tfStash: stash,
    ...(opts.omitTf
      ? {}
      : {
          transferFactory: {
            preapprovalKind: vi.fn(async () => "yes" as const),
            execute: vi.fn(execute),
          },
        }),
  } as unknown as SettleRouteServices;
  return { svc, stash };
}

/** A well-formed transfer-factory /settle body keyed at ref "REF". */
function tfBody(
  over: { payTo?: string; amount?: string; network?: CantonNetwork; payer?: string } = {}
): FacilitatorRequest {
  const network = over.network ?? ("canton:devnet" as const);
  const reqs = {
    scheme: "exact" as const,
    network,
    amount: over.amount ?? TF_AMOUNT_WIRE,
    asset: "CC",
    payTo: over.payTo ?? MERCHANT,
    maxTimeoutSeconds: 60,
    extra: {
      assetTransferMethod: "transfer-factory" as const,
      feePayer: FACILITATOR,
      synchronizerId: SYNC,
      instrumentId: { admin: DSO, id: "Amulet" },
      executeBeforeSeconds: 120,
    },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network,
      resource: { url: "https://api.example.com/data" },
      accepted: reqs,
      payload: {
        assetTransferMethod: "transfer-factory",
        payer: over.payer ?? PAYER,
        submissionRef: "REF",
      },
    },
    paymentRequirements: reqs,
  };
}

/** Build a services + seed the stash for the given payer in one step. */
function svcFor(
  opts: Parameters<typeof makeServices>[0] & { payer?: string } = {}
): SettleRouteServices {
  const { svc, stash } = makeServices(opts);
  seedRow(stash, opts.payer ?? PAYER);
  return svc;
}

describe("settle route — operational guards (rate limit + circuit breaker)", () => {
  // Rate-limiting + the breaker are enforced BEFORE settle validation/execution
  // (the breaker first, then shape, then the per-payer/IP limiter, all ahead of
  // runValidation). These tests therefore only care about the HTTP status
  // (200 vs 429 vs 503), so they drive the transfer-factory harness — the only
  // remaining settle path. A happy transfer-factory settle returns 200; the
  // breaker tests override execute (the relay leg) to throw the relevant CantonError.

  it("rate-limits a second settle from the same payer (429)", async () => {
    const svc = {
      ...svcFor({}),
      settleRateLimit: { maxPerPayer: 1, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const body = tfBody();
    const r1 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r1.statusCode).toBe(200); // first settle allowed
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r2.statusCode).toBe(429);
    expect(r2.json()).toMatchObject({ error: "rate_limited" });
    await app.close();
  });

  it("per-payer cap CANNOT be evaded by rotating payer (IP is a 2nd key)", async () => {
    // The audit-hardening fix: keying only on the payer let one caller mint a
    // fresh per-payer bucket every request by changing the party. The client IP
    // is now a second per-key dimension, so a same-IP burst is capped even when
    // every request carries a different payer.
    const { svc: base, stash } = makeServices({});
    // Seed rows for every payer used below so validation passes and only the
    // rate limiter can bite.
    for (const p of ["agent::aaa", "agent::bbb", "agent::ccc"]) {
      stash._seed(`REF-${p}`, {
        ref: `REF-${p}`,
        payer: p,
        receiver: MERCHANT,
        amount: "0.1000000000",
        instrumentAdmin: DSO,
        instrumentId: "Amulet",
        executeBefore: new Date(Date.now() + 60_000).toISOString(),
        txHash: "hash",
        preparedTx: "prepared",
        signature: JSON.stringify({
          hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
          partySignatures: { signatures: [{ party: p, signatures: [{}] }] },
        }),
      });
    }
    const svc = {
      ...base,
      // IP key now has its OWN cap (maxPerIp), separate from per-payer; set it
      // to 2 so a same-IP burst of distinct payers is capped at the IP key.
      settleRateLimit: { maxPerPayer: 2, maxPerIp: 2, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const bodyFor = (party: string) => {
      const b = tfBody({ payer: party });
      (b.paymentPayload.payload as Record<string, unknown>).submissionRef =
        `REF-${party}`;
      return b;
    };
    const ip = "203.0.113.77";
    // 2 distinct payers from the same IP → both allowed (IP cap = 2).
    const r1 = await app.inject({ method: "POST", url: "/settle", payload: bodyFor("agent::aaa"), remoteAddress: ip });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: bodyFor("agent::bbb"), remoteAddress: ip });
    expect(r2.statusCode).toBe(200);
    // 3rd from the SAME IP, with yet another fresh payer → blocked by the IP key.
    const r3 = await app.inject({ method: "POST", url: "/settle", payload: bodyFor("agent::ccc"), remoteAddress: ip });
    expect(r3.statusCode).toBe(429);
    expect(r3.json()).toMatchObject({ error: "rate_limited" });
    await app.close();
  });

  it("a different client IP keeps its own settle quota (IP isolation)", async () => {
    const { svc: base, stash } = makeServices({});
    for (const p of ["agent::x", "agent::y", "agent::z"]) {
      stash._seed(`REF-${p}`, {
        ref: `REF-${p}`,
        payer: p,
        receiver: MERCHANT,
        amount: "0.1000000000",
        instrumentAdmin: DSO,
        instrumentId: "Amulet",
        executeBefore: new Date(Date.now() + 60_000).toISOString(),
        txHash: "hash",
        preparedTx: "prepared",
        signature: JSON.stringify({
          hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
          partySignatures: { signatures: [{ party: p, signatures: [{}] }] },
        }),
      });
    }
    const svc = {
      ...base,
      settleRateLimit: { maxPerPayer: 1, maxPerIp: 1, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const bodyFor = (party: string) => {
      const b = tfBody({ payer: party });
      (b.paymentPayload.payload as Record<string, unknown>).submissionRef =
        `REF-${party}`;
      return b;
    };
    // IP A, payer X → ok; second from IP A (fresh payer Y) → blocked by IP cap.
    const a1 = await app.inject({ method: "POST", url: "/settle", payload: bodyFor("agent::x"), remoteAddress: "198.51.100.10" });
    expect(a1.statusCode).toBe(200);
    const a2 = await app.inject({ method: "POST", url: "/settle", payload: bodyFor("agent::y"), remoteAddress: "198.51.100.10" });
    expect(a2.statusCode).toBe(429);
    // IP B is independent → a fresh payer Z from IP B is allowed (its own
    // per-IP + per-payer buckets, untouched by IP A's traffic).
    const b1 = await app.inject({ method: "POST", url: "/settle", payload: bodyFor("agent::z"), remoteAddress: "198.51.100.11" });
    expect(b1.statusCode).toBe(200);
    await app.close();
  });

  it("the same payer is still capped from one IP (per-payer key intact)", async () => {
    // Regression guard: adding the IP key must not weaken the original
    // per-payer cap — same payer, same IP, cap 1 → 2nd is 429.
    const svc = {
      ...svcFor({}),
      settleRateLimit: { maxPerPayer: 1, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const body = tfBody(); // payer = PAYER (constant)
    const r1 = await app.inject({ method: "POST", url: "/settle", payload: body, remoteAddress: "198.51.100.20" });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: body, remoteAddress: "198.51.100.20" });
    expect(r2.statusCode).toBe(429);
    await app.close();
  });

  it("opens the circuit breaker after a traffic-failure settle and returns 503", async () => {
    const trafficErr = new CantonError(
      "execute failed",
      "HTTP_ERROR",
      500,
      "ABORTED: sequencer traffic limit exceeded"
    );
    const svc = {
      ...svcFor({
        execute: async () => {
          throw trafficErr;
        },
      }),
      settleBreaker: { threshold: 1, cooldownMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const body = tfBody();
    // 1st: the settle fails for traffic -> failed() (200, success:false) AND trips the breaker.
    const r1 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ success: false });
    // 2nd: breaker OPEN -> refused with 503 before any ledger work.
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r2.statusCode).toBe(503);
    expect(r2.json()).toMatchObject({ error: "facilitator_traffic_unavailable" });
    await app.close();
  });

  it("non-traffic settle failures do NOT trip the breaker", async () => {
    const otherErr = new CantonError("nope", "HTTP_ERROR", 500, "CONTRACT_NOT_FOUND");
    const svc = {
      ...svcFor({
        execute: async () => {
          throw otherErr;
        },
      }),
      settleBreaker: { threshold: 1, cooldownMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const body = tfBody();
    const r1 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r2.statusCode).toBe(200); // breaker did NOT trip on a non-traffic error
    await app.close();
  });

  it("is disabled when no guard config is wired (settles flow freely)", async () => {
    const svc = svcFor({});
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const body = tfBody();
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "POST", url: "/settle", payload: body });
      expect(r.statusCode).toBe(200);
    }
    await app.close();
  });

  // --- trustProxy policy end-to-end (adversarial-review HIGH fix) ----------
  // These build Fastify with `trustProxy: ["loopback"]` — the SAFE production
  // default — and exercise the REAL proxy-addr resolution, modelling the
  // documented Caddy-on-127.0.0.1 deploy where Caddy APPENDS the real client to
  // the right of X-Forwarded-For. The pre-fix `trustProxy: true` trusted the
  // whole chain, making req.ip the leftmost (client-forged) XFF entry and
  // letting an attacker mint a fresh per-IP bucket per request.

  // Each request uses a FRESH payer so the per-payer key never trips —
  // this isolates the IP key, which is the dimension the HIGH fix is about
  // (the finding is "rotate payer AND spoofed IP"; we rotate the party and
  // try to also rotate the spoofed IP via XFF).
  const seedParties = (
    stash: ReturnType<typeof makeStash>,
    parties: string[]
  ): void => {
    for (const p of parties) {
      stash._seed(`REF-${p}`, {
        ref: `REF-${p}`,
        payer: p,
        receiver: MERCHANT,
        amount: "0.1000000000",
        instrumentAdmin: DSO,
        instrumentId: "Amulet",
        executeBefore: new Date(Date.now() + 60_000).toISOString(),
        txHash: "hash",
        preparedTx: "prepared",
        signature: JSON.stringify({
          hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
          partySignatures: { signatures: [{ party: p, signatures: [{}] }] },
        }),
      });
    }
  };
  const bodyForParty = (party: string): FacilitatorRequest => {
    const b = tfBody({ payer: party });
    (b.paymentPayload.payload as Record<string, unknown>).submissionRef =
      `REF-${party}`;
    return b;
  };

  it("loopback-trust: rotating payer AND the FORGED (left) XFF cannot evade the per-IP settle cap", async () => {
    const { svc: base, stash } = makeServices({});
    seedParties(stash, ["agent::a", "agent::b", "agent::c"]);
    const svc = {
      ...base,
      // Per-key cap of 1: with a rotating payer, only the IP key can bite.
      settleRateLimit: { maxPerPayer: 1, maxPerIp: 1, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify({ trustProxy: ["loopback"] });
    await registerSettleRoute(app, svc);
    // The trusted loopback proxy (the inject socket = 127.0.0.1) appends the
    // attacker's REAL address (9.9.9.9) to the right; the attacker forges and
    // rotates the left-hand entry AND rotates payer per request.
    const mk = (party: string, forgedLeft: string) => ({
      method: "POST" as const,
      url: "/settle",
      payload: bodyForParty(party),
      headers: { "x-forwarded-for": `${forgedLeft}, 9.9.9.9` },
    });
    const r1 = await app.inject(mk("agent::a", "1.1.1.1"));
    expect(r1.statusCode).toBe(200); // fills the IP bucket keyed on 9.9.9.9
    const r2 = await app.inject(mk("agent::b", "2.2.2.2")); // fresh party + fresh forged left
    expect(r2.statusCode).toBe(429); // same real client (9.9.9.9) → still capped
    const r3 = await app.inject(mk("agent::c", "3.3.3.3, 4.4.4.4"));
    expect(r3.statusCode).toBe(429);
    await app.close();
  });

  it("loopback-trust: req.ip resolves to the proxy-appended real client (distinct clients keep own quota)", async () => {
    const { svc: base, stash } = makeServices({});
    seedParties(stash, ["agent::a", "agent::b", "agent::c"]);
    const svc = {
      ...base,
      settleRateLimit: { maxPerPayer: 1, maxPerIp: 1, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify({ trustProxy: ["loopback"] });
    await registerSettleRoute(app, svc);
    const mk = (party: string, realClient: string) => ({
      method: "POST" as const,
      url: "/settle",
      payload: bodyForParty(party),
      // Caddy appends the real client on the right; the left entry is whatever
      // the client sent and must be ignored.
      headers: { "x-forwarded-for": `forged-junk, ${realClient}` },
    });
    const a1 = await app.inject(mk("agent::a", "203.0.113.50"));
    expect(a1.statusCode).toBe(200);
    const a2 = await app.inject(mk("agent::b", "203.0.113.50"));
    expect(a2.statusCode).toBe(429); // same real client over cap (fresh party didn't help)
    const b1 = await app.inject(mk("agent::c", "203.0.113.51"));
    expect(b1.statusCode).toBe(200); // different real client, own quota
    await app.close();
  });

  it("trustProxy:true (legacy unsafe mode) DOES let a forged XFF evade — documents why it is not the default", async () => {
    // The vulnerable behaviour the fix moves AWAY from: with whole-chain trust,
    // req.ip = the leftmost client-forged entry, so rotating it (plus the party)
    // mints a fresh IP bucket every time. Asserted here so a future change to
    // Fastify's resolution that silently alters this is caught.
    const { svc: base, stash } = makeServices({});
    seedParties(stash, ["agent::a", "agent::b"]);
    const svc = {
      ...base,
      // IP cap enabled so the test genuinely shows a forged XFF EVADING it.
      settleRateLimit: { maxPerPayer: 1, maxPerIp: 1, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify({ trustProxy: true });
    await registerSettleRoute(app, svc);
    const mk = (party: string, forgedLeft: string) => ({
      method: "POST" as const,
      url: "/settle",
      payload: bodyForParty(party),
      headers: { "x-forwarded-for": `${forgedLeft}, 9.9.9.9` },
    });
    const r1 = await app.inject(mk("agent::a", "1.1.1.1"));
    expect(r1.statusCode).toBe(200);
    // Different forged LEFT entry → trustProxy:true keys req.ip on it → the IP
    // bucket is fresh, and the party is fresh too → NOT capped (the bug).
    const r2 = await app.inject(mk("agent::b", "2.2.2.2"));
    expect(r2.statusCode).toBe(200); // NOT capped — the bug, intentionally shown
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// WS3 observability: settle_total{result}, breaker_open_total,
// ratelimit_rejected_total{scope=settle}, settle-latency histogram, the
// validation-failure log line, and breaker-OPEN raised warn -> error.
// Reuses the transfer-factory helpers (makeServices / svcFor / tfBody) above.
// ---------------------------------------------------------------------------
describe("settle route — WS3 metrics", () => {
  it("settle_total{result=ok} + a duration-histogram sample on a successful settle", async () => {
    const metrics = createMetrics({ collectDefault: false });
    const r = await callSettle({ ...svcFor({}), metrics }, tfBody());
    expect(r).toMatchObject({ success: true });
    const settle = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_settle_total"
    );
    expect(settle).toMatch(/result="ok"\} 1/);
    const hist = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_settle_duration_seconds"
    );
    expect(hist).toMatch(/x402_facilitator_settle_duration_seconds_count 1/);
  });

  it("settle_total{result=ledger_error} when the TF service/stash is not wired", async () => {
    // A transfer-factory payload whose TransferFactoryService is absent fails
    // closed with unexpected_canton_ledger_error → ledger_error.
    const metrics = createMetrics({ collectDefault: false });
    await callSettle(
      {
        ...svcFor({ omitTf: true }),
        metrics,
      },
      tfBody()
    );
    const settle = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_settle_total"
    );
    expect(settle).toMatch(/result="ledger_error"\} 1/);
  });

  it("settle_total{result=validation_failed} on a malformed body (400)", async () => {
    const metrics = createMetrics({ collectDefault: false });
    const app = Fastify();
    await registerSettleRoute(app, { ...svcFor({}), metrics });
    const res = await app.inject({
      method: "POST",
      url: "/settle",
      payload: { garbage: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    const settle = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_settle_total"
    );
    expect(settle).toMatch(/result="validation_failed"\} 1/);
  });

  it("429 → ratelimit_rejected_total{scope=settle} + settle_total{result=rate_limited}", async () => {
    const metrics = createMetrics({ collectDefault: false });
    const svc = {
      ...svcFor({}),
      metrics,
      settleRateLimit: { maxPerPayer: 1, maxGlobal: 0, windowMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const body = tfBody();
    const r1 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r2.statusCode).toBe(429);
    await app.close();
    const rl = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_ratelimit_rejected_total"
    );
    expect(rl).toMatch(/scope="settle"\} 1/);
    const settle = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_settle_total"
    );
    expect(settle).toMatch(/result="rate_limited"\} 1/);
  });

  it("503 (breaker OPEN) → breaker_open_total + settle_total{result=breaker_open}", async () => {
    const metrics = createMetrics({ collectDefault: false });
    const trafficErr = new CantonError(
      "execute failed",
      "HTTP_ERROR",
      500,
      "ABORTED: sequencer traffic limit exceeded"
    );
    // execute throwing a TRAFFIC error trips the breaker AND records
    // ledger_error is NOT emitted here — the relay failure maps to
    // execute_failed (validation_failed bucket); the breaker-OPEN refusal on the
    // 2nd call is the breaker_open bucket.
    const svc = {
      ...svcFor({
        execute: async () => {
          throw trafficErr;
        },
      }),
      metrics,
      settleBreaker: { threshold: 1, cooldownMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    // 1st trips the breaker; the 2nd is refused at the breaker gate (breaker_open)
    // BEFORE any ledger work.
    const body = tfBody();
    const r1 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: body });
    expect(r2.statusCode).toBe(503);
    await app.close();
    const breaker = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_breaker_open_total"
    );
    expect(breaker).toMatch(/x402_facilitator_breaker_open_total 1/);
    const settle = await metrics.registry.getSingleMetricAsString(
      "x402_facilitator_settle_total"
    );
    expect(settle).toMatch(/result="breaker_open"\} 1/);
  });

  it("works with metrics UNWIRED (no crash, settles normally)", async () => {
    // metrics is optional; absence must not break settle.
    const r = await callSettle(svcFor({}), tfBody());
    expect(r).toMatchObject({ success: true });
  });
});

describe("settle route — WS3 observability logging", () => {
  it("logs a WARN with {reason, payer, method} on a validation failure (was silent)", async () => {
    // A wrong-network payment is rejected by runValidation → previously no log.
    const svc = svcFor({ network: "canton:devnet" });
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const warn = vi.fn();
    app.addHook("onRequest", async (req) => {
      req.log.warn = warn as never;
    });
    // svc.network is devnet; send a mainnet payment → network mismatch reject.
    await app.inject({
      method: "POST",
      url: "/settle",
      payload: tfBody({ network: "canton:mainnet" }),
    });
    await app.close();
    const line = warn.mock.calls.find((c) => c[1] === "settle validation failed");
    expect(line).toBeDefined();
    expect(line![0]).toMatchObject({
      reason: "unexpected_canton_ledger_error",
      payer: PAYER,
      method: "transfer-factory",
    });
  });

  it("breaker-OPEN refusal logs at ERROR (not warn) for paging/grep", async () => {
    const trafficErr = new CantonError(
      "execute failed",
      "HTTP_ERROR",
      500,
      "ABORTED: sequencer traffic limit exceeded"
    );
    const svc = {
      ...svcFor({
        execute: async () => {
          throw trafficErr;
        },
      }),
      settleBreaker: { threshold: 1, cooldownMs: 60_000 },
    };
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const error = vi.fn();
    const warn = vi.fn();
    app.addHook("onRequest", async (req) => {
      req.log.error = error as never;
      req.log.warn = warn as never;
    });
    const body = tfBody();
    await app.inject({ method: "POST", url: "/settle", payload: body }); // trip
    const r2 = await app.inject({ method: "POST", url: "/settle", payload: body }); // refused
    expect(r2.statusCode).toBe(503);
    await app.close();
    const onError = error.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("circuit breaker OPEN")
    );
    expect(onError).toBeDefined();
    const onWarn = warn.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("circuit breaker OPEN")
    );
    expect(onWarn).toBeUndefined();
  });

  it("a funded settle logs an INFO 'relayed to the merchant' line (success was silent before)", async () => {
    // Regression for the observability gap surfaced in live e2e: the success path
    // emitted NO log, making a healthy facilitator look broken. A funded
    // transfer-factory settle must log one info line carrying
    // payer/merchant/amount/updateId.
    const svc = svcFor({});
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const info = vi.fn();
    app.addHook("onRequest", async (req) => {
      req.log.info = info as never;
    });
    const r = await app.inject({ method: "POST", url: "/settle", payload: tfBody() });
    await app.close();
    expect((r.json() as SettleResponse).success).toBe(true);
    const line = info.mock.calls.find(
      (c) =>
        c[1] ===
        "/settle: transfer-factory relayed to the merchant (one transaction, sponsored gas, no escrow)"
    );
    expect(line).toBeDefined();
    expect(line![0]).toMatchObject({
      payer: PAYER,
      merchant: MERCHANT,
      updateId: TF_UPDATE_ID,
    });
  });
});
