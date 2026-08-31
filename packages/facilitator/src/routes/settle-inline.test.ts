/**
 * /settle, INLINE carriage — the parts that cost money and traffic.
 *
 * The validation arm has its own suite. This one drives the real route so the
 * things only the route can get wrong are covered: whether a retry re-relays,
 * whether the traffic we burn is attributed, and which key we name in the
 * signature we hand the participant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FacilitatorRequest, SettleResponse } from "@ftptech/x402-canton-core";
import { encodeInlinePaymentPayload, decodePrepared } from "@ftptech/x402-canton-core";
import { registerSettleRoute, type SettleRouteServices } from "./settle.js";
import { createInMemoryInlineSettleStore } from "../db/inline-settle-store.js";
import { SubmissionOutcomeUnknownError } from "../canton/transfer-factory.js";

const FIXTURES = fileURLToPath(
  new URL("../../../agent-wallet/src/__fixtures__/", import.meta.url)
);
const RAW = Buffer.from(
  readFileSync(FIXTURES + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim(),
  "base64"
);
const META = JSON.parse(
  readFileSync(FIXTURES + "mainnet-0.1.21.json", "utf8")
).transfer as {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
};

const FACILITATOR = "ftp_facilitator::1220" + "ff".repeat(32);
const ATOMIC = "100000000"; // 0.01 CC
const UPDATE_ID = "1220-inline-settled";
/** The hash the VERIFIER recomputes. The route must key idempotency on this. */
const TRUE_HASH_HEX = "cd".repeat(32);

function body(payloadOver: Record<string, unknown> = {}): FacilitatorRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "canton:mainnet",
      resource: { url: "https://api.example.com/x" },
      accepted: {} as never,
      payload: {
        ...encodeInlinePaymentPayload({
          preparedTransactionBytes: RAW,
          preparedTxHash: "1220" + "ab".repeat(32),
          signatureB64: Buffer.alloc(64, 7).toString("base64"),
        }),
        ...payloadOver,
      } as never,
    },
    paymentRequirements: {
      scheme: "exact",
      network: "canton:mainnet",
      amount: ATOMIC,
      asset: "CC",
      payTo: META.receiver,
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: FACILITATOR,
        instrumentId: META.instrumentId,
        executeBeforeSeconds: 60,
      },
    } as never,
  } as FacilitatorRequest;
}

/** The captured transfer carries its own validity window; derive the clock from
 *  the bytes so re-capturing a fixture never strands this suite. */
beforeEach(() => {
  const prepUs = decodePrepared(RAW.toString("base64")).preparationTime;
  // ONLY Date is faked. Faking the timer queue as well stalls fastify's inject,
  // which is a test-harness deadlock rather than anything about the route.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number((prepUs ?? 0n) / 1000n) + 1000);
});
afterEach(() => vi.useRealTimers());

interface Harness {
  svc: SettleRouteServices;
  executes: Array<{ signedBy: string; submissionId: string | undefined }>;
  attributed: string[];
}

function harness(over: Partial<SettleRouteServices> = {}): Harness {
  const executes: Harness["executes"] = [];
  const attributed: string[] = [];
  const svc = {
    network: "canton:mainnet",
    facilitatorParty: FACILITATOR,
    tfEnabled: true,
    inline: {
      verifySignature: async () => ({
        verified: true,
        preparedTxHashHex: TRUE_HASH_HEX,
      }),
      fetchPreapproval: async () => ({
        receiver: META.receiver,
        dso: META.instrumentId.admin,
        expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
      }),
    },
    transferFactory: {
      preapprovalKind: async () => "receiver" as never,
      execute: async (args: {
        partySignatures: {
          signatures: Array<{ signatures: Array<{ signedBy: string }> }>;
        };
        submissionId?: string;
      }) => {
        executes.push({
          signedBy: args.partySignatures.signatures[0]!.signatures[0]!.signedBy,
          submissionId: args.submissionId,
        });
        return { updateId: UPDATE_ID, transferred: true, confirmInconclusive: false };
      },
    },
    inlineSettles: createInMemoryInlineSettleStore(),
    attribution: {
      record: async (e: { updateId: string }) => {
        attributed.push(e.updateId);
      },
      markServed: async () => {},
      updateTrafficSummary: async () => {},
    },
    attributionScanClients: [],
    ...over,
  } as unknown as SettleRouteServices;
  return { svc, executes, attributed };
}

async function settle(svc: SettleRouteServices, b = body()): Promise<SettleResponse> {
  const app = Fastify();
  await registerSettleRoute(app, svc);
  const res = await app.inject({ method: "POST", url: "/settle", payload: b });
  expect(res.statusCode).toBe(200);
  const json = res.json() as SettleResponse;
  await app.close();
  return json;
}

/** Like `settle`, but returns the raw status+body so the 503 arm is assertable
 *  (`settle` insists on 200, which is right for the success paths). */
async function settleRaw(
  svc: SettleRouteServices,
  b = body()
): Promise<{ status: number; body: string }> {
  const app = Fastify();
  await registerSettleRoute(app, svc);
  const res = await app.inject({ method: "POST", url: "/settle", payload: b });
  const out = { status: res.statusCode, body: res.body };
  await app.close();
  return out;
}

describe("/settle inline — a retry must not burn traffic twice", () => {
  it("relays once, then answers the retry from the record", async () => {
    // The ledger already makes a replay harmless: the transfer names input
    // holdings that a second submission finds archived. But we would only learn
    // that BY SUBMITTING, and every submission spends Global-Synchronizer
    // traffic. That is the cost this record exists to avoid.
    const h = harness();
    const first = await settle(h.svc);
    expect(first.success).toBe(true);
    expect(first.transaction).toBe(UPDATE_ID);
    expect(h.executes).toHaveLength(1);

    const second = await settle(h.svc);
    expect(second.success).toBe(true);
    expect(second.transaction).toBe(UPDATE_ID);
    // THE ASSERTION: no second relay.
    expect(h.executes).toHaveLength(1);
  });

  it("keys on the RECOMPUTED hash, so re-spelling the claim cannot buy a second relay", async () => {
    // The claimed hash is deliberately accepted in two spellings (bare digest
    // and `1220`-prefixed). Keying on the claim would let a caller re-spell it
    // and make us relay the same transaction again.
    const h = harness();
    await settle(h.svc, body({ preparedTxHash: "1220" + "ab".repeat(32) }));
    await settle(h.svc, body({ preparedTxHash: "ab".repeat(32) }));
    expect(h.executes).toHaveLength(1);
  });

  it("still settles when no store is wired — degraded, never blocked", async () => {
    // Absence costs traffic, not money. Refusing here would turn a missing
    // cost-guard into a payment outage.
    const h = harness({ inlineSettles: undefined });
    expect((await settle(h.svc)).success).toBe(true);
    expect((await settle(h.svc)).success).toBe(true);
    expect(h.executes).toHaveLength(2);
  });

  it("does NOT record when the funds did not move", async () => {
    // Recording a burn as settled would make every retry return a success that
    // never happened — under-delivery, which is worse than the wasted traffic.
    const store = createInMemoryInlineSettleStore();
    const h = harness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        execute: async () => ({
          updateId: UPDATE_ID,
          transferred: false,
          confirmInconclusive: false,
        }),
      } as never,
    });
    expect((await settle(h.svc)).success).toBe(false);
    // Nothing SETTLED, and no dispatch mark left behind either: the outcome is
    // known (it committed and moved nothing), so the payer must stay free to
    // re-pay rather than meet a permanent 503.
    expect(await store.getRecord(TRUE_HASH_HEX)).toBeNull();
  });
});

/**
 * THE UNKNOWN OUTCOME, AND WHAT THE NEXT REQUEST IS TOLD ABOUT IT.
 *
 * /execute is asynchronous and the completion poll gives up after ~12s, which
 * under load is shorter than sequencing. When it gives up, the submission may
 * still be sequenced — we simply did not see it.
 *
 * Before the dispatch mark, nothing was written in that case, so the retry read
 * "never seen", relayed a second time, hit the archived inputs, and had that
 * classified as `input_contention` — which this route reports as "nothing
 * moved, retryable". The caller acts on that by minting a FRESH transfer: one
 * purchase, two payments, the second recorded nowhere.
 */
describe("/settle inline — an unknown outcome is remembered, not re-relayed", () => {
  it("the retry is answered 503 and does NOT reach the ledger a second time", async () => {
    const store = createInMemoryInlineSettleStore();
    // Counted HERE, not via the harness: overriding transferFactory replaces
    // the harness's own execute, so h.executes would stay at 0 and the
    // assertion would pass without measuring anything.
    let executes = 0;
    const h = harness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        execute: async () => {
          executes += 1;
          throw new SubmissionOutcomeUnknownError(new Error("no completion within timeout"));
        },
      } as never,
    });

    // First attempt: dispatched, answer never arrived -> 503, mark left behind.
    const first = await settleRaw(h.svc);
    expect(first.status).toBe(503);
    // The mark carries the submissionId; the offset is absent here only because
    // this harness's transferFactory stub has no ledgerEnd (the route treats a
    // failed offset read as "still block a relay, just cannot self-resolve").
    expect(await store.getRecord(TRUE_HASH_HEX)).toMatchObject({ state: "dispatched" });
    expect(executes).toBe(1);

    // The retry must NOT execute again. That second submit is what produced the
    // bogus "nothing moved" verdict the caller then paid twice on.
    const second = await settleRaw(h.svc);
    expect(second.status).toBe(503);
    expect(second.body).toMatch(/settle_outcome_unknown/);
    expect(executes).toBe(1);
  });

  it("a mark is written BEFORE the submission leaves, not after it returns", async () => {
    // The ordering is the whole fix. If the row were written after execute()
    // returned, a process killed mid-settle (or a poll that gave up) would
    // leave nothing behind — which is exactly the state this replaces.
    const store = createInMemoryInlineSettleStore();
    let markAtDispatch: unknown = "not-checked";
    const h = harness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        execute: async () => {
          markAtDispatch = await store.getRecord(TRUE_HASH_HEX);
          throw new SubmissionOutcomeUnknownError(new Error("boom"));
        },
      } as never,
    });
    await settleRaw(h.svc);
    expect(markAtDispatch).toMatchObject({ state: "dispatched" });
  });

  it("a SETTLED retry still answers the recorded success, not 503", async () => {
    // Discriminator. The 503 arm must fire only on the unresolved mark; a
    // payment we DID see must keep returning its updateId.
    const store = createInMemoryInlineSettleStore();
    const h = harness({ settleDispatchMark: "enforce", inlineSettles: store });
    const first = await settle(h.svc);
    expect(first.success).toBe(true);
    const second = await settle(h.svc);
    expect(second.success).toBe(true);
    expect(second.transaction).toBe(first.transaction);
    expect(h.executes).toHaveLength(1);
  });

  it("with no store wired, behaviour is unchanged — the mark is optional", async () => {
    // Over-correction guard: a deploy without the store must keep settling.
    const h = harness({ inlineSettles: undefined });
    expect((await settle(h.svc)).success).toBe(true);
    expect((await settle(h.svc)).success).toBe(true);
    expect(h.executes).toHaveLength(2);
  });
});

describe("/settle inline — the traffic we burn is accounted for", () => {
  it("records attribution keyed by the settle updateId", async () => {
    const h = harness();
    await settle(h.svc);
    expect(h.attributed).toEqual([UPDATE_ID]);
  });

  it("does not fail a completed payment when attribution throws", async () => {
    // The execute already committed. Fail-open, exactly like the legacy arm.
    const h = harness({
      attribution: {
        record: async () => {
          throw new Error("attribution store down");
        },
        markServed: async () => {},
        updateTrafficSummary: async () => {},
      } as never,
    });
    expect((await settle(h.svc)).success).toBe(true);
  });
});

describe("/settle inline — naming the key that signed", () => {
  it("names the payer NAMESPACE even when the lookup reports a key id", async () => {
    // A reported key id is NOT a Canton Fingerprint: the only source that
    // publishes one (a JWKS) publishes an RFC 7638 thumbprint, which names no
    // key the participant knows. Naming it would turn a good signature into an
    // execute rejection, so it must not reach the wire.
    const h = harness({
      inline: {
        verifySignature: async () => ({
          verified: true,
          preparedTxHashHex: TRUE_HASH_HEX,
          signingKeyId: "1220" + "77".repeat(32),
        }),
        fetchPreapproval: async () => ({
          receiver: META.receiver,
          dso: META.instrumentId.admin,
          expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
        }),
      },
    } as never);
    await settle(h.svc);
    expect(h.executes[0]?.signedBy).toBe(META.sender.split("::")[1]);
  });

  it("uses the payer namespace when no key id is reported either", async () => {
    // For a single-key external party the namespace IS its signing key's
    // fingerprint, which is what makes this correct rather than merely safe.
    const h = harness();
    await settle(h.svc);
    expect(h.executes[0]?.signedBy).toBe(META.sender.split("::")[1]);
  });
});

describe("/settle inline — per-payer volume, the cap the inline carriage skipped", () => {
  /**
   * One app (so one limiter) across several requests, each carrying a DIFFERENT
   * `preparedTxHash`.
   *
   * That is the attack shape, not a contrivance: the per-payment bucket is
   * keyed on the client-supplied hash, so a payer mints a fresh bucket for
   * free with every request. Varying it is what strips the residual gates away
   * and leaves only the per-payer one. (The signature verifier still returns
   * the one true recomputed hash, exactly as the real one would — the claim is
   * never trusted for anything that matters.)
   */
  async function repeatVaried(svc: SettleRouteServices, n: number): Promise<number[]> {
    const app = Fastify();
    await registerSettleRoute(app, svc);
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/settle",
        payload: body({ preparedTxHash: "1220" + i.toString(16).padStart(2, "0").repeat(32) }),
      });
      codes.push(res.statusCode);
    }
    await app.close();
    return codes;
  }

  it("bounds one payer even when the merchant fronting it is honest and busy", async () => {
    // The hole: a submissionRef only exists because our relay minted it, and
    // the prepare-time cap counts minting — so the LEGACY carriage is bounded
    // upstream. Inline hands us finished bytes, so nothing upstream counted.
    // What was left is per-payment (varied above, free) and per-IP — and the
    // IP here is the MERCHANT's, capped high on purpose so one merchant can
    // front many agents. Without a per-payer bucket, one payer rides that.
    const h = harness({
      inlineSettles: undefined, // force every request down the relay path
      settleRateLimit: { windowMs: 60_000, maxPerPayer: 2, maxPerIp: 1000, max: 1000 },
    } as Partial<SettleRouteServices>);
    expect(await repeatVaried(h.svc, 4)).toEqual([200, 200, 429, 429]);
    // and the refusals cost no traffic
    expect(h.executes).toHaveLength(2);
  });

  it("a retry answered from the idempotency record does NOT spend the payer's budget", async () => {
    // Ordering, not luck: the cap sits after the idempotency check, because a
    // retry that burns no Global Synchronizer traffic must not burn budget
    // either. Room for exactly one relay, and the replays still succeed.
    const h = harness({
      settleRateLimit: { windowMs: 60_000, maxPerPayer: 1, maxPerIp: 1000, max: 1000 },
    } as Partial<SettleRouteServices>);
    expect(await repeatVaried(h.svc, 3)).toEqual([200, 200, 200]);
    expect(h.executes).toHaveLength(1); // relayed once; the rest came from the record
  });
});

describe("the master switch turns the INLINE carriage off too", () => {
  it("with tfEnabled false, an inline payload is refused before any read", async () => {
    // The switch used to sit BELOW the carriage routing, so inline returned
    // above it. /settle had its own gate, so no money moved — but /verify ran
    // the whole inline validation on a deploy the operator had switched off:
    // a Scan read on a caller-chosen merchant party and a participant ACS query
    // on the decoded payer, under our own credentials, per unauthenticated
    // request. The config's stated invariant is that a deploy with TF off never
    // verifies a transfer-factory payment; it now holds for both carriages.
    let preapprovalReads = 0;
    const { svc } = harness({ tfEnabled: false } as never);
    (svc as unknown as { inline: { fetchPreapproval: unknown } }).inline = {
      verifySignature: async () => {
        throw new Error("must not be reached with the switch off");
      },
      fetchPreapproval: async () => {
        preapprovalReads++;
        throw new Error("must not be reached with the switch off");
      },
    };
    const r = await settle(svc);
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("invalid_exact_canton_transfer_factory_disabled");
    expect(preapprovalReads).toBe(0);
  });

  it("with the switch ON but no stash wired, inline still validates", async () => {
    // The discriminator. The inline carriage exists precisely so the
    // facilitator needs no stash; gating it on `tf` (which carries the legacy
    // stash) would switch off the one path that does not use one.
    const { svc, executes } = harness();
    expect((svc as unknown as { tf?: unknown }).tf).toBeUndefined();
    const r = await settle(svc);
    expect(r.success).toBe(true);
    expect(executes.length).toBe(1);
  });
});

/**
 * The legacy carriage has named the ITR_InsufficientFunds rejection since it was
 * written (tf-settle.test.ts). The inline carriage — the live MainNet money path
 * — copied only the contention half of that rule, under a comment claiming it
 * made "the same distinction the legacy arm makes". So the identical ledger
 * verdict came back as `invalid_exact_canton_execute_failed`, the ONE reason the
 * client stops dead on (fetch.ts STOP_ON_FIRST → PAYMENT_UNCONFIRMED): the payer
 * was told the payment might already have settled and refused to retry, over a
 * rejection that provably moved nothing.
 */
describe("/settle inline — a definite rejection must not be reported as ambiguous", () => {
  const reasonOf = async (thrown: unknown): Promise<string> => {
    const h = harness({
      transferFactory: {
        preapprovalKind: async () => "receiver",
        execute: async () => {
          throw thrown;
        },
      },
    } as unknown as Partial<SettleRouteServices>);
    const r = await settle(h.svc);
    expect(r.success).toBe(false);
    return r.success ? "" : r.errorReason;
  };

  it("names ITR_InsufficientFunds exactly as the legacy carriage does", async () => {
    expect(
      await reasonOf(
        new Error(
          "INVALID_ARGUMENT: DAML_INTERPRETATION_ERROR ITR_InsufficientFunds(...) the input holdings do not cover the amount"
        )
      )
    ).toBe("invalid_exact_canton_insufficient_balance");
  });

  it("still names contended inputs", async () => {
    expect(await reasonOf(new Error("INACTIVE_CONTRACTS: input have been archived"))).toBe(
      "invalid_exact_canton_input_contention"
    );
  });

  it("leaves an unrecognised rejection on the generic code", async () => {
    // The discriminator against over-correcting: only rejections we can actually
    // prove moved nothing may be named. Everything else stays ambiguous, which
    // is the direction that protects against a second payment.
    expect(await reasonOf(new Error("ITR_SomeOtherInterpretationError: unrelated"))).toBe(
      "invalid_exact_canton_execute_failed"
    );
  });
});

/**
 * RESOLVING THE UNKNOWN, which is what makes the mark survivable.
 *
 * The mark alone is honest but inert: it turns a wrong "nothing moved" into a
 * correct "I do not know", and then stays that way forever. The mark also
 * carries the submissionId and the ledger offset from just before the submit,
 * so the completion is a READ away — no second submission, no traffic. These
 * pin that the read is actually consulted, and that each of its three answers
 * produces the right outcome.
 */
describe("/settle inline — an unknown outcome is RESOLVED, not just remembered", () => {
  /** Seeds a mark exactly as a dispatch would, offset included. */
  async function seedMark(store: ReturnType<typeof createInMemoryInlineSettleStore>) {
    await store.recordDispatched(TRUE_HASH_HEX, {
      submissionId: "x402-inline-k",
      beginExclusive: 11,
    });
  }

  it("a submission that HAD settled is recorded and answered as success", async () => {
    const store = createInMemoryInlineSettleStore();
    await seedMark(store);
    let executes = 0;
    const h = harness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        ledgerEnd: async () => 11,
        execute: async () => {
          executes += 1;
          throw new Error("must not execute — the answer was already on the ledger");
        },
        resolveDispatched: async () => ({
          state: "settled" as const,
          updateId: "1220RESOLVED",
          transferred: true,
          confirmInconclusive: false,
        }),
      } as never,
    });
    const r = await settle(h.svc);
    expect(r.success).toBe(true);
    if (r.success) expect(r.transaction).toBe("1220RESOLVED");
    expect(executes).toBe(0); // resolved by READING, never by relaying again
    // And it is now a settled record, so the next retry is answered instantly.
    expect(await store.getRecord(TRUE_HASH_HEX)).toEqual({
      state: "settled",
      updateId: "1220RESOLVED",
    });
  });

  it("a submission the participant REJECTED clears the mark so the payer can retry", async () => {
    const store = createInMemoryInlineSettleStore();
    await seedMark(store);
    const h = harness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        ledgerEnd: async () => 11,
        execute: async () => {
          throw new Error("must not execute");
        },
        resolveDispatched: async () => ({
          state: "rejected" as const,
          message: "PARTY_NOT_KNOWN",
        }),
      } as never,
    });
    const r = await settle(h.svc);
    expect(r.success).toBe(false);
    // Nothing moved and we now KNOW it, so the payer must be free to try again.
    expect(await store.getRecord(TRUE_HASH_HEX)).toBeNull();
  });

  it("still 503 when the completion is not there — unknown stays unknown", async () => {
    // The discriminator against the tempting over-correction: resolving must
    // never turn "I could not find it" into a verdict. An absent completion
    // means the submission may still be sequencing.
    const store = createInMemoryInlineSettleStore();
    await seedMark(store);
    const h = harness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        ledgerEnd: async () => 11,
        execute: async () => {
          throw new Error("must not execute");
        },
        resolveDispatched: async () => ({ state: "unknown" as const }),
      } as never,
    });
    const res = await settleRaw(h.svc);
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/settle_outcome_unknown/);
    expect(await store.getRecord(TRUE_HASH_HEX)).toMatchObject({ state: "dispatched" });
  });

  it("a settled-but-funds-did-NOT-move resolve is not reported as success", async () => {
    // The funds-moved verdict comes from the same confirm the live path uses.
    // A committed submission that moved nothing must not release the goods.
    const store = createInMemoryInlineSettleStore();
    await seedMark(store);
    const h = harness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        ledgerEnd: async () => 11,
        execute: async () => {
          throw new Error("must not execute");
        },
        resolveDispatched: async () => ({
          state: "settled" as const,
          updateId: "1220COMMITTED",
          transferred: false,
          confirmInconclusive: false,
        }),
      } as never,
    });
    const res = await settleRaw(h.svc);
    expect(res.status).toBe(503);
    expect(res.body).not.toMatch(/1220COMMITTED/);
  });
});

/**
 * THE ROLLOUT STAGES, because the guard changes a merchant-visible response.
 *
 * Measured against the build running in production: it contains no
 * `settle_outcome_unknown` at all. So turning this on in a deploy would change
 * what every integrator sees, in one step, on the strength of unit tests. And
 * nobody knows how often the unknown outcome actually happens — there has never
 * been a counter for it.
 *
 * `off` therefore has to be indistinguishable from the pre-guard build, and
 * `observe` has to answer the frequency question while changing nothing. These
 * pin both, so the flag is a real staged rollout rather than a comment claiming
 * to be one.
 */
describe("the unknown-outcome guard is staged, and OFF is the default", () => {
  function unknownExecuteHarness(over: Partial<SettleRouteServices>) {
    let executes = 0;
    let ledgerEndCalls = 0;
    const h = harness({
      ...over,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        ledgerEnd: async () => {
          ledgerEndCalls += 1;
          return 11;
        },
        execute: async () => {
          executes += 1;
          throw new SubmissionOutcomeUnknownError(new Error("no completion"));
        },
      } as never,
    });
    return { h, executes: () => executes, ledgerEndCalls: () => ledgerEndCalls };
  }

  it("OFF answers the pre-guard REASON, not merely a non-503 — this is the double-pay seam", async () => {
    // The test that was missing, and its absence is what let a real defect
    // through: the off-stage checks asserted status !== 503 and success ===
    // false, which both hold for EITHER reason string. The reason is the thing
    // that decides whether the payer re-pays.
    //
    // `invalid_exact_canton_execute_failed` is the only member of the shipped
    // client's STOP_ON_FIRST — it never re-pays. `unexpected_canton_ledger_error`
    // is in STOP_IF_REPEATED, which stops only on the SECOND consecutive
    // occurrence, so the first one mints a fresh signed transfer over the
    // payer's remaining holdings. If off substitutes the second for the first,
    // the flag that promised to change nothing has opened a double payment in a
    // case where production is safe.
    //
    // The error shape is the live one: a 502 from the reverse proxy in front of
    // the participant. answerNeverArrived says true (no verdict in it), while
    // isTrafficError says false (the body matches none of its patterns), which
    // is exactly the gap where the two reasons diverge.
    const proxy502 = Object.assign(new Error("502 Bad Gateway"), { code: "HTTP_ERROR" });
    const store = createInMemoryInlineSettleStore();
    const h = harness({
      inlineSettles: store,
      transferFactory: {
        preapprovalKind: async () => "receiver",
        ledgerEnd: async () => 11,
        execute: async () => {
          throw proxy502;
        },
      } as never,
    });
    const res = await settleRaw(h.svc);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { success?: boolean; errorReason?: string };
    expect(body.success).toBe(false);
    expect(body.errorReason).toBe("invalid_exact_canton_execute_failed");
    expect(body.errorReason).not.toBe("unexpected_canton_ledger_error");
  });

  it("OFF makes no extra ledger read — identical latency, not just an identical body", async () => {
    // The offset exists only so a mark can be resolved later. Off writes no
    // mark, so reading it would be a round-trip the production build does not
    // make, on the money path, for nothing. An "off" that is a millisecond
    // slower per settle is not the rollback it claims to be.
    const store = createInMemoryInlineSettleStore();
    const { h, ledgerEndCalls } = unknownExecuteHarness({ inlineSettles: store });
    await settleRaw(h.svc);
    expect(ledgerEndCalls()).toBe(0);
  });

  it("OBSERVE does take the offset — the mark it writes has to be resolvable", async () => {
    // The discriminator in the other direction: skipping the read must be tied
    // to the stage, not deleted outright. A mark without an offset is a mark
    // nothing can ever settle.
    const store = createInMemoryInlineSettleStore();
    const { h, ledgerEndCalls } = unknownExecuteHarness({
      inlineSettles: store,
      settleDispatchMark: "observe",
    } as Partial<SettleRouteServices>);
    await settleRaw(h.svc);
    expect(ledgerEndCalls()).toBe(1);
    expect(await store.getRecord(TRUE_HASH_HEX)).toMatchObject({
      state: "dispatched",
      beginExclusive: 11,
    });
  });

  it("OFF writes no mark at all — the store stays empty", async () => {
    const store = createInMemoryInlineSettleStore();
    const { h } = unknownExecuteHarness({ inlineSettles: store });
    await settleRaw(h.svc);
    expect(await store.getRecord(TRUE_HASH_HEX)).toBeNull();
  });

  it("OFF relays a second time, exactly as the build in production does", async () => {
    // This is the behaviour the guard exists to change. With the flag off it
    // must still be here, or "off" would not be a rollback.
    const store = createInMemoryInlineSettleStore();
    const { h, executes } = unknownExecuteHarness({ inlineSettles: store });
    await settleRaw(h.svc);
    await settleRaw(h.svc);
    expect(executes()).toBe(2);
  });

  it("OFF ignores a mark an earlier observe/enforce run left behind", async () => {
    // Turning the flag back off has to actually restore the old behaviour,
    // including on a database that already has marks in it.
    const store = createInMemoryInlineSettleStore();
    await store.recordDispatched(TRUE_HASH_HEX, { submissionId: "s", beginExclusive: 1 });
    const { h, executes } = unknownExecuteHarness({ inlineSettles: store });
    const res = await settleRaw(h.svc);
    expect(res.status).not.toBe(503);
    expect(executes()).toBe(1);
  });

  it("OFF still answers a SETTLED record — that idempotency predates the guard", async () => {
    // The discriminator against over-reverting: `off` must silence the mark,
    // not the settle-record that has always been there.
    const store = createInMemoryInlineSettleStore();
    await store.recordSettled(TRUE_HASH_HEX, "1220OLD");
    const { h, executes } = unknownExecuteHarness({ inlineSettles: store });
    const r = await settle(h.svc);
    expect(r.success).toBe(true);
    if (r.success) expect(r.transaction).toBe("1220OLD");
    expect(executes()).toBe(0);
  });

  it("OBSERVE records the mark but does NOT change the response", async () => {
    const store = createInMemoryInlineSettleStore();
    const { h, executes } = unknownExecuteHarness({
      settleDispatchMark: "observe",
      inlineSettles: store,
    });
    const first = await settleRaw(h.svc);
    expect(await store.getRecord(TRUE_HASH_HEX)).toMatchObject({ state: "dispatched" });

    // The retry meets the mark — and is answered exactly as `off` answers it.
    const second = await settleRaw(h.svc);
    expect(second.status).toBe(first.status);
    expect(second.body).not.toMatch(/settle_outcome_unknown/);
    expect(executes()).toBe(2); // measurement only: it still relayed
  });

  it("ENFORCE is the only mode that refuses", async () => {
    const store = createInMemoryInlineSettleStore();
    const { h, executes } = unknownExecuteHarness({
      settleDispatchMark: "enforce",
      inlineSettles: store,
    });
    await settleRaw(h.svc);
    const second = await settleRaw(h.svc);
    expect(second.status).toBe(503);
    expect(second.body).toMatch(/settle_outcome_unknown/);
    expect(executes()).toBe(1);
  });
});
