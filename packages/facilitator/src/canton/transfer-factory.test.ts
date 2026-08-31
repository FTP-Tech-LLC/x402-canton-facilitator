/**
 * TransferFactoryService.execute — the funds-moved gate.
 *
 * Everything this file tests happens AFTER the money moved: `execute` only
 * reaches the gate holding a real updateId, which means the payer's Amulet is
 * archived and the merchant is paid. The gate can therefore only CLASSIFY a
 * payment that already happened. It must never be able to unmake one.
 */
import { describe, it, expect, vi } from "vitest";
import {
  TransferFactoryService,
  SubmissionOutcomeUnknownError,
  transferCompletedFromResult,
} from "./transfer-factory.js";

const PAYER = "agent::1220aaaa";
const UPDATE = "1220-settled";

function svc(getTransactionById: unknown) {
  const client = {
    getLedgerEnd: vi.fn(async () => 0),
    interactiveSubmissionExecute: vi.fn(async () => ({ updateId: UPDATE })),
    pollCompletionUpdateId: vi.fn(async () => UPDATE),
    getTransactionById,
  } as unknown as ConstructorParameters<typeof TransferFactoryService>[0]["client"];
  return new TransferFactoryService({
    client,
    scan: { resolveTransferKind: vi.fn() } as never,
    facilitatorParty: "ftp::1220",
    userId: "relay-user",
    confirmRetry: { attempts: 2, delayMs: 0 },
  });
}

const input = {
  payer: PAYER,
  preparedTransaction: "cHJlcA==",
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
  partySignatures: { signatures: [] },
  submissionId: "sub-1",
};

describe("funds-moved gate: an unreadable confirmation is INCONCLUSIVE, never a failure", () => {
  it("a THROWN read falls through to the committed-execute signal", async () => {
    // The bug: the read was unguarded and the retry loop absorbed exactly one
    // failure shape — a 200 with an empty events array. A throw (the 45s abort,
    // or any non-2xx from our own participant) escaped `execute()` entirely,
    // past the `confirmInconclusive` fallback written for precisely this case.
    // /settle then answered success:false for a payment that HAD settled, wrote
    // no idempotency record, and the client paid a second time.
    const s = svc(vi.fn(async () => {
      throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
    }));
    const r = await s.execute(input);
    expect(r.updateId).toBe(UPDATE);
    expect(r.transferred).toBe(true);
    expect(r.confirmInconclusive).toBe(true);
  });

  it("the AMULET read is unchanged — it must not be widened", async () => {
    // Six merchants are paid through this path. The registry arm needs the full
    // effects tree; giving it to Amulet as well would only hand its
    // name/template heuristics more events to trip over, for no gain — its
    // positive signal (an archived Amulet) is already in the narrow shape.
    const getTx = vi.fn(async () => ({ events: [] }));
    const s = svc(getTx);
    await s.execute(input as never);
    expect(getTx.mock.calls[0]?.[0]?.fullEffects).toBeUndefined();
  });

  it("an empty-events read behaves the same — the two are one condition", async () => {
    const s = svc(vi.fn(async () => ({ events: [] })));
    const r = await s.execute(input);
    expect(r).toMatchObject({ transferred: true, confirmInconclusive: true });
  });

  it("a read that RECOVERS on retry is used, not the fallback", async () => {
    // The throw must not short-circuit the retry the author put there for the
    // payer projection lagging the completion by a beat.
    let n = 0;
    const s = svc(
      vi.fn(async () => {
        if (n++ === 0) throw new Error("502");
        return {
          events: [
            { ArchivedEvent: { templateId: "pkg:Splice.Amulet:Amulet" } },
          ],
        };
      })
    );
    const r = await s.execute(input);
    expect(r).toMatchObject({ transferred: true, confirmInconclusive: false });
  });

  it("a CONCLUSIVE read still decides — a pending instruction is not a transfer", async () => {
    // The gate must keep its teeth: this is the case that stops us reporting a
    // Pending escrow as a completed payment.
    const s = svc(
      vi.fn(async () => ({
        events: [
          { ArchivedEvent: { templateId: "pkg:Splice.Amulet:Amulet" } },
          {
            CreatedEvent: {
              templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
            },
          },
        ],
      }))
    );
    const r = await s.execute(input);
    expect(r).toMatchObject({ transferred: false, confirmInconclusive: false });
  });

  // Registry-utility funds-moved: the pending TransferInstruction lives in the
  // token's OWN module, not Splice.Api.Token.TransferInstructionV1 — the gate
  // must still see it, or it reports a pending escrow as settled (false pos).
  const UTIL_ADMIN = "reg::1220util";
  const svcUtil = (getTransactionById: unknown) => {
    const client = {
      getLedgerEnd: vi.fn(async () => 0),
      interactiveSubmissionExecute: vi.fn(async () => ({ updateId: UPDATE })),
      pollCompletionUpdateId: vi.fn(async () => UPDATE),
      getTransactionById,
    } as never;
    return new TransferFactoryService({
      client,
      scan: { resolveTransferKind: vi.fn() } as never,
      facilitatorParty: "ftp::1220",
      userId: "relay-user",
      confirmRetry: { attempts: 2, delayMs: 0 },
      tokenRegistries: { [UTIL_ADMIN]: "https://reg.example" },
    });
  };
  const utilInput = { ...input, instrumentAdmin: UTIL_ADMIN };

  it("a Pending RESULT is not delivery, even with no pending-named created event", async () => {
    // The wiring test, not just the helper test. The old gate read delivery
    // from the ABSENCE of a created event whose template NAME matched a regex,
    // so a two-step transfer whose template is named anything else was reported
    // as a successful settle. The standard's own result tag says otherwise, and
    // this asserts the VERDICT uses it — removing the tag from the verdict must
    // fail here, not merely fail a unit test of the helper.
    const s = svcUtil(
      vi.fn(async () => ({
        events: [
          {
            ExercisedEvent: {
              choice: "TransferFactory_Transfer",
              exerciseResult: {
                output: { tag: "TransferInstructionResult_Pending", value: {} },
              },
            },
          },
          // Deliberately a created event the name-based detector does NOT match.
          { CreatedEvent: { templateId: "pkg:Some.Other.Module:Whatever" } },
        ],
      }))
    );
    const r = await s.execute(utilInput as never);
    expect(r.transferred).toBe(false);
  });

  it("asks for the FULL effects tree for a registry instrument — the proof lives there", async () => {
    // MEASURED on a live MainNet USDCx settle, payer as requesting party:
    //   transaction-by-id + requestingParties -> 2 events, no exercises at all
    //   update-by-id + updateFormat           -> the full tree, including
    //                                            TransferFactory_Transfer + result
    // Without this the tag-based proof is inert, which is exactly what the live
    // "result tag was unreadable" counter reported after the first deploy:
    // 6 of 6 registry payments.
    const getTx = vi.fn(async () => ({ events: [] }));
    const s = svcUtil(getTx);
    await s.execute(utilInput as never);
    expect(getTx.mock.calls[0]?.[0]).toMatchObject({ fullEffects: true });
  });

  it("REPORTS the disagreement when the two signals differ — the point is to count it", async () => {
    // Pending tag + no name-matching created event is exactly the case the old
    // heuristic got wrong. The tag decides; the disagreement is surfaced so a
    // caller can log it and we can finally learn how often that happened.
    const s = svcUtil(
      vi.fn(async () => ({
        events: [
          {
            ExercisedEvent: {
              choice: "TransferFactory_Transfer",
              exerciseResult: {
                output: { tag: "TransferInstructionResult_Pending", value: {} },
              },
            },
          },
        ],
      }))
    );
    const r = await s.execute(utilInput as never);
    expect(r.transferred).toBe(false);
    expect(r.registrySignalDisagreement).toEqual({ tagSaid: false, nameSaid: true });
    expect(r.registryTagUnreadable).toBeUndefined();
  });

  it("stays quiet when the two agree — silence is the useful default", async () => {
    const s = svcUtil(
      vi.fn(async () => ({
        events: [
          {
            ExercisedEvent: {
              choice: "TransferFactory_Transfer",
              exerciseResult: {
                output: { tag: "TransferInstructionResult_Completed", value: {} },
              },
            },
          },
        ],
      }))
    );
    const r = await s.execute(utilInput as never);
    expect(r.registrySignalDisagreement).toBeUndefined();
    expect(r.registryTagUnreadable).toBeUndefined();
  });

  it("flags an unreadable tag separately — that is the verdict having no positive proof", async () => {
    const s = svcUtil(
      vi.fn(async () => ({
        events: [{ CreatedEvent: { templateId: "pkg:Other:Thing" } }],
      }))
    );
    const r = await s.execute(utilInput as never);
    expect(r.registryTagUnreadable).toBe(true);
    expect(r.registrySignalDisagreement).toBeUndefined();
  });

  it("and a Completed RESULT is delivery", async () => {
    const s = svcUtil(
      vi.fn(async () => ({
        events: [
          {
            ExercisedEvent: {
              choice: "TransferFactory_Transfer",
              exerciseResult: {
                output: {
                  tag: "TransferInstructionResult_Completed",
                  value: { receiverHoldingCids: ["00ccead9"] },
                },
              },
            },
          },
        ],
      }))
    );
    const r = await s.execute(utilInput as never);
    expect(r.transferred).toBe(true);
  });

  it("utility pending in the token's own module IS detected — not a false positive", async () => {
    const s = svcUtil(
      vi.fn(async () => ({
        events: [
          {
            CreatedEvent: {
              templateId: "pkg:Utility.Registry.App.V0.Model:TransferInstruction",
            },
          },
        ],
      }))
    );
    const r = await s.execute(utilInput);
    expect(r).toMatchObject({ transferred: false, confirmInconclusive: false });
  });

  it("utility completed (no pending instruction created) is a transfer", async () => {
    const s = svcUtil(
      vi.fn(async () => ({
        events: [
          { ArchivedEvent: { templateId: "pkg:Some.Registry.Impl:Holding" } },
          { CreatedEvent: { templateId: "pkg:Some.Registry.Impl:Holding" } },
        ],
      }))
    );
    const r = await s.execute(utilInput);
    expect(r).toMatchObject({ transferred: true, confirmInconclusive: false });
  });
});

describe("obtaining the updateId: an accepted submit whose outcome cannot be READ", () => {
  // /execute is async — the participant normally answers 200 {} and the
  // updateId arrives on the completion stream. So by the time we poll, the
  // submission is accepted and may be committing. Everything the funds-moved
  // gate below already knows applies here too, and it did not.
  function svcPolling(poll: () => Promise<string>) {
    const client = {
      getLedgerEnd: vi.fn(async () => 0),
      interactiveSubmissionExecute: vi.fn(async () => ({})), // accepted, no updateId
      pollCompletionUpdateId: vi.fn(poll),
      getTransactionById: vi.fn(async () => ({ events: [] })),
    } as unknown as ConstructorParameters<typeof TransferFactoryService>[0]["client"];
    return new TransferFactoryService({
      client,
      scan: { resolveTransferKind: vi.fn() } as never,
      facilitatorParty: "ftp::1220",
      userId: "relay-user",
      confirmRetry: { attempts: 1, delayMs: 0 },
    });
  }

  it("a completion the poll gave up on is UNKNOWN, not a failure", async () => {
    // readCompletions swallows a 401 / participant 5xx / bridge 502 into an
    // empty list, so this one error stands for every unreadable-outcome shape.
    const giveUp = Object.assign(
      new Error("no completion for submissionId within timeout"),
      { code: "INVALID_RESPONSE" }
    );
    await expect(
      svcPolling(async () => { throw giveUp; }).execute(input)
    ).rejects.toBeInstanceOf(SubmissionOutcomeUnknownError);
  });

  it("a completion that ARRIVED carrying a rejection stays a definite failure", async () => {
    // The discriminator. SUBMISSION_FAILED means the participant answered and
    // refused: nothing moved, and the payer must be told so. Marking this
    // unknown too would turn every honest rejection into a 503 the client
    // retries forever.
    const rejected = Object.assign(
      new Error("interactive submission rejected: status 3"),
      { code: "SUBMISSION_FAILED" }
    );
    await expect(
      svcPolling(async () => { throw rejected; }).execute(input)
    ).rejects.toBe(rejected);
  });
});

describe("TransferFactoryService.preapprovalKind — expiry", () => {
  const MERCHANT = "merchant::1220m";
  const gate = (
    kind: unknown,
    byParty: () => Promise<unknown>
  ): TransferFactoryService =>
    new TransferFactoryService({
      client: {} as never,
      scan: {
        resolveTransferKind: vi.fn(async () => kind),
        getTransferPreapprovalByParty: vi.fn(byParty),
      } as never,
      facilitatorParty: "ftp::1220",
      userId: "relay-user",
    });
  const record = (expiresAt: string, receiver = MERCHANT) => ({
    contractId: "00pre",
    dso: "dso::1220",
    receiver,
    provider: "prov::1220",
    expiresAt,
  });
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const args = { merchant: MERCHANT, admin: "dso::1220", id: "Amulet" };

  it("refuses an EXPIRED preapproval that transfer-kind still calls direct", async () => {
    // The whole point: resolveTransferKind says `direct` either way, so routing
    // on it alone relays a transfer that dies at interpretation on expiresAt —
    // after the traffic is spent.
    expect(await gate("direct", async () => record(past)).preapprovalKind(args)).toBe("no");
  });

  it("allows a live one", async () => {
    expect(await gate("direct", async () => record(future)).preapprovalKind(args)).toBe("yes");
  });

  it("a Scan failure on the expiry read does NOT become a refusal", async () => {
    // Over-correction guard: a 429 here must leave the answer where it was, or
    // one flaky read starts refusing payments that would have settled.
    expect(
      await gate("direct", async () => {
        throw new Error("429");
      }).preapprovalKind(args)
    ).toBe("yes");
  });

  it("no record, or one whose expiresAt the reader could not determine, stays yes", async () => {
    expect(await gate("direct", async () => null).preapprovalKind(args)).toBe("yes");
  });

  it("an unparseable expiresAt stays yes", async () => {
    expect(await gate("direct", async () => record("not-a-date")).preapprovalKind(args)).toBe(
      "yes"
    );
  });

  it("an expired record for a DIFFERENT receiver does not refuse this merchant", async () => {
    expect(
      await gate("direct", async () => record(past, "someone-else::1220")).preapprovalKind(args)
    ).toBe("yes");
  });

  it("a non-direct kind still short-circuits without an expiry read", async () => {
    const byParty = vi.fn(async () => record(future));
    expect(await gate("offer", byParty).preapprovalKind(args)).toBe("no");
    expect(byParty).not.toHaveBeenCalled();
  });

  it("a registry-utility instrument passes registryBaseUrl and skips the Amulet expiry read", async () => {
    const USDCX_ADMIN = "decentralized-usdc-interchain-rep::1220abc";
    const REG = "https://registry.example";
    const resolveTransferKind = vi.fn(async () => "direct");
    // If reached, this would wrongly apply the Amulet-only expiry gate to a
    // registry-utility token — it must NOT be called.
    const getTransferPreapprovalByParty = vi.fn(async () => record(past));
    const svc = new TransferFactoryService({
      client: {} as never,
      scan: { resolveTransferKind, getTransferPreapprovalByParty } as never,
      facilitatorParty: "ftp::1220",
      userId: "relay-user",
      tokenRegistries: { [USDCX_ADMIN]: REG },
    });
    const kind = await svc.preapprovalKind({
      merchant: MERCHANT,
      admin: USDCX_ADMIN,
      id: "USDCx",
    });
    expect(kind).toBe("yes");
    expect(getTransferPreapprovalByParty).not.toHaveBeenCalled();
    expect(resolveTransferKind.mock.calls[0]?.[0]).toMatchObject({
      admin: USDCX_ADMIN,
      id: "USDCx",
      registryBaseUrl: REG,
    });
  });

  it("an Amulet instrument (not in tokenRegistries) omits registryBaseUrl and keeps the expiry read", async () => {
    const resolveTransferKind = vi.fn(async () => "direct");
    const getTransferPreapprovalByParty = vi.fn(async () => record(future));
    const svc = new TransferFactoryService({
      client: {} as never,
      scan: { resolveTransferKind, getTransferPreapprovalByParty } as never,
      facilitatorParty: "ftp::1220",
      userId: "relay-user",
      tokenRegistries: { "some-other::1220": "https://x" },
    });
    expect(await svc.preapprovalKind(args)).toBe("yes");
    expect(getTransferPreapprovalByParty).toHaveBeenCalledOnce();
    expect(
      resolveTransferKind.mock.calls[0]?.[0]?.registryBaseUrl
    ).toBeUndefined();
  });

  it("a resolveTransferKind throw is still unknown (fails closed on the money path)", async () => {
    const svc = new TransferFactoryService({
      client: {} as never,
      scan: {
        resolveTransferKind: vi.fn(async () => {
          throw new Error("scan down");
        }),
        getTransferPreapprovalByParty: vi.fn(async () => null),
      } as never,
      facilitatorParty: "ftp::1220",
      userId: "relay-user",
    });
    expect(await svc.preapprovalKind(args)).toBe("unknown");
  });
});

describe("a registry transfer is proven delivered by the standard's own result tag", () => {
  // The shape below is COPIED FROM A LIVE MAINNET USDCx TRANSFER, not invented:
  //   exerciseResult.output.tag = "TransferInstructionResult_Completed"
  //   exerciseResult.output.value.receiverHoldingCids = [...]
  // Before this, the registry arm inferred delivery from the ABSENCE of a
  // created event whose template NAME matched a regex nobody had observed.
  const completed = {
    ExercisedEvent: {
      choice: "TransferFactory_Transfer",
      exerciseResult: {
        output: {
          tag: "TransferInstructionResult_Completed",
          value: { receiverHoldingCids: ["00ccead9"] },
        },
        senderChangeCids: ["00c538e1"],
      },
    },
  };
  const pending = {
    ExercisedEvent: {
      choice: "TransferFactory_Transfer",
      exerciseResult: {
        output: { tag: "TransferInstructionResult_Pending", value: {} },
      },
    },
  };

  it("reads Completed as delivered", () => {
    expect(transferCompletedFromResult([completed] as never)).toBe(true);
  });

  it("reads Pending as NOT delivered — the case the old signal could miss", () => {
    expect(transferCompletedFromResult([pending] as never)).toBe(false);
  });

  it("says 'cannot tell' rather than 'no' when the result is unreadable", () => {
    // The discriminator against over-correcting: an unfamiliar shape must not
    // become a false negative, or a merchant is told a real payment failed.
    expect(
      transferCompletedFromResult([
        { ExercisedEvent: { choice: "TransferFactory_Transfer" } },
      ] as never)
    ).toBeUndefined();
    expect(transferCompletedFromResult([] as never)).toBeUndefined();
    expect(
      transferCompletedFromResult([
        { ExercisedEvent: { choice: "SomethingElse", exerciseResult: {} } },
      ] as never)
    ).toBeUndefined();
  });
});
