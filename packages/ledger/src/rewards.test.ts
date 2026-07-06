import { describe, it, expect, vi } from "vitest";
import {
  X402_PROVIDER_CONTEXT_TEMPLATE,
  buildCreateProviderContextCommand,
  buildRecordX402PaymentCommand,
  buildRecordX402PaymentBatchCommand,
  recordX402Payment,
  recordX402PaymentBatch,
  createX402ProviderContext,
  claimAppRewards,
  sumDecimals10,
  parseAppRewardCoupons,
  emitX402RoundMarker,
  FEATURED_APP_RIGHT_V2_TEMPLATE,
} from "./rewards.js";
import type { CantonClient, CreatedEvent } from "./client.js";

const APP = "merchant::1220app";
const FAR = "00featuredappright";
const CTX = "00providercontext";

function makeSubmit() {
  return vi.fn(async () => ({ updateId: "tx", offset: 1, events: [] }));
}
function asClient(
  submit: ReturnType<typeof makeSubmit>
): Pick<CantonClient, "submitAndWaitForTransaction"> {
  return { submitAndWaitForTransaction: submit } as unknown as Pick<
    CantonClient,
    "submitAndWaitForTransaction"
  >;
}

describe("rewards command builders", () => {
  it("buildCreateProviderContextCommand binds app -> featuredAppRight", () => {
    const c = buildCreateProviderContextCommand({
      app: APP,
      featuredAppRightCid: FAR,
    });
    expect(c.CreateCommand.templateId).toBe(X402_PROVIDER_CONTEXT_TEMPLATE);
    expect(c.CreateCommand.createArguments).toEqual({
      app: APP,
      featuredAppRightCid: FAR,
    });
  });

  it("buildRecordX402PaymentCommand targets RecordX402Payment with the payment fields", () => {
    const c = buildRecordX402PaymentCommand({
      providerContextCid: CTX,
      resourceUrl: "https://api/x",
      updateId: "u1",
      amount: "1.0000000000",
      recordedAt: "2026-06-02T00:00:00Z",
    });
    expect(c.ExerciseCommand.templateId).toBe(X402_PROVIDER_CONTEXT_TEMPLATE);
    expect(c.ExerciseCommand.contractId).toBe(CTX);
    expect(c.ExerciseCommand.choice).toBe("RecordX402Payment");
    expect(c.ExerciseCommand.choiceArgument).toEqual({
      resourceUrl: "https://api/x",
      updateId: "u1",
      amount: "1.0000000000",
      recordedAt: "2026-06-02T00:00:00Z",
    });
  });

  it("buildRecordX402PaymentBatchCommand targets the batch choice", () => {
    const c = buildRecordX402PaymentBatchCommand({
      providerContextCid: CTX,
      payments: [{ resourceUrl: "r", updateId: "u", amount: "1" }],
      recordedAt: "2026-06-02T00:00:00Z",
    });
    expect(c.ExerciseCommand.choice).toBe("RecordX402PaymentBatch");
    const arg = c.ExerciseCommand.choiceArgument as {
      payments: unknown[];
    };
    expect(arg.payments).toHaveLength(1);
  });

  it("honors a templateId override (e.g. a hash-prefixed id)", () => {
    const c = buildRecordX402PaymentCommand({
      providerContextCid: CTX,
      resourceUrl: "r",
      updateId: "u",
      amount: "1",
      recordedAt: "t",
      templateId: "#pkg-hash:Canton.X402Provider:X402ProviderContext",
    });
    expect(c.ExerciseCommand.templateId).toBe(
      "#pkg-hash:Canton.X402Provider:X402ProviderContext"
    );
  });
});

describe("rewards submitters act as the integrator party (never the facilitator)", () => {
  it("recordX402Payment submits as app with a per-updateId (idempotent) commandId", async () => {
    const submit = makeSubmit();
    await recordX402Payment(asClient(submit), {
      providerContextCid: CTX,
      app: APP,
      userId: "u",
      synchronizerId: "global-domain::1220",
      resourceUrl: "https://api/x",
      updateId: "u1",
      amount: "1.0000000000",
      recordedAt: "2026-06-02T00:00:00Z",
    });
    const body = submit.mock.calls[0]![0] as {
      actAs: string[];
      commandId: string;
      synchronizerId?: string;
      disclosedContracts?: unknown[];
      commands: Array<{ ExerciseCommand: { choice: string } }>;
    };
    expect(body.actAs).toEqual([APP]);
    expect(body.commandId).toBe("x402-marker-u1");
    expect(body.synchronizerId).toBe("global-domain::1220");
    expect(body.commands[0]!.ExerciseCommand.choice).toBe("RecordX402Payment");
    // No disclosedContracts: app is signatory of the context + observer of its
    // own FeaturedAppRight, so both are already visible to its participant.
    expect(body.disclosedContracts).toBeUndefined();
  });

  it("createX402ProviderContext submits a CreateCommand as app", async () => {
    const submit = makeSubmit();
    await createX402ProviderContext(asClient(submit), {
      app: APP,
      featuredAppRightCid: FAR,
      userId: "u",
      synchronizerId: "global-domain::1220",
    });
    const body = submit.mock.calls[0]![0] as {
      actAs: string[];
      commands: Array<{ CreateCommand: { templateId: string } }>;
    };
    expect(body.actAs).toEqual([APP]);
    expect(body.commands[0]!.CreateCommand.templateId).toBe(
      X402_PROVIDER_CONTEXT_TEMPLATE
    );
  });

  it("recordX402PaymentBatch submits one transaction for many payments", async () => {
    const submit = makeSubmit();
    await recordX402PaymentBatch(asClient(submit), {
      providerContextCid: CTX,
      app: APP,
      userId: "u",
      synchronizerId: "global-domain::1220",
      payments: [
        { resourceUrl: "r1", updateId: "u1", amount: "1" },
        { resourceUrl: "r2", updateId: "u2", amount: "1" },
      ],
      recordedAt: "2026-06-02T00:00:00Z",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const body = submit.mock.calls[0]![0] as {
      actAs: string[];
      commands: Array<{ ExerciseCommand: { choice: string } }>;
    };
    expect(body.actAs).toEqual([APP]);
    expect(body.commands[0]!.ExerciseCommand.choice).toBe(
      "RecordX402PaymentBatch"
    );
  });
});

describe("sumDecimals10 (precise 10-dp sum, no float loss)", () => {
  it("sums simple decimals", () => {
    expect(sumDecimals10(["1.0000000000", "2.5000000000"])).toBe("3.5000000000");
  });
  it("keeps sub-unit precision", () => {
    expect(sumDecimals10(["0.0000000001", "0.0000000002"])).toBe("0.0000000003");
  });
  it("does not corrupt large values the way float would", () => {
    expect(sumDecimals10(["9999999999.9999999999", "0.0000000001"])).toBe(
      "10000000000.0000000000"
    );
  });
  it("pads variable decimal places", () => {
    expect(sumDecimals10(["2", "0.5"])).toBe("2.5000000000");
  });
});

describe("parseAppRewardCoupons", () => {
  const ev = (over: Partial<CreatedEvent> & { createArgument: unknown }) =>
    ({
      contractId: "00c",
      templateId: "#splice-amulet:Splice.Amulet:AppRewardCoupon",
      signatories: [],
      observers: [],
      packageName: "splice-amulet",
      ...over,
    }) as CreatedEvent;

  it("extracts amount/round/featured and ignores non-coupon events", () => {
    const coupons = parseAppRewardCoupons([
      ev({
        contractId: "00c1",
        createArgument: { amount: "1.5", round: { number: "99" }, featured: true },
      }),
      ev({
        contractId: "00other",
        templateId: "#splice-amulet:Splice.Amulet:Amulet",
        createArgument: { amount: "9" },
      }),
    ]);
    expect(coupons).toHaveLength(1);
    expect(coupons[0]).toMatchObject({
      contractId: "00c1",
      amount: "1.5",
      roundNumber: "99",
      featured: true,
    });
  });
});

describe("claimAppRewards (AmuletRules_Transfer with InputAppRewardCoupon)", () => {
  const AMULET = {
    amulet_rules: {
      contract: {
        contract_id: "00ar",
        template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
        created_event_blob: "blob-ar",
        payload: { dso: "dso::1220", isDevNet: false },
      },
      domain_id: "global-domain::1220",
    },
  };
  const ROUNDS = {
    open_mining_rounds: [
      {
        contract: {
          contract_id: "00omr",
          template_id: "#omr",
          created_event_blob: "b",
          payload: { round: { number: "100" } },
        },
      },
    ],
    issuing_mining_rounds: [
      {
        contract: {
          contract_id: "00imr",
          template_id: "#imr",
          created_event_blob: "b",
          payload: { round: { number: "99" } },
        },
      },
    ],
  };
  const coupon = (cid: string, amount: string, round: string) =>
    ({
      contractId: cid,
      templateId: "#splice-amulet:Splice.Amulet:AppRewardCoupon",
      createArgument: { amount, round: { number: round }, featured: true },
      signatories: [],
      observers: [],
      packageName: "splice-amulet",
    }) as CreatedEvent;

  const scan = {
    getAmuletRules: vi.fn(async () => AMULET),
    getOpenAndIssuingMiningRounds: vi.fn(async () => ROUNDS),
  } as unknown as Parameters<typeof claimAppRewards>[1];

  function makeClient(coupons: CreatedEvent[]) {
    const submit = vi.fn(async () => ({ updateId: "claim-tx", offset: 1, events: [] }));
    const query = vi.fn(async () => coupons);
    return {
      client: {
        queryActiveContracts: query,
        submitAndWaitForTransaction: submit,
      } as unknown as Parameters<typeof claimAppRewards>[0],
      submit,
    };
  }

  it("returns null when there are no coupons", async () => {
    const { client } = makeClient([]);
    expect(await claimAppRewards(client, scan, { app: APP, userId: "u" })).toBeNull();
  });

  it("returns null when coupons exist but none are in an issuing round", async () => {
    const { client } = makeClient([coupon("00c2", "2.0", "100")]); // 100 = open, not issuing
    expect(await claimAppRewards(client, scan, { app: APP, userId: "u" })).toBeNull();
  });

  it("claims only issuing-round coupons, building AmuletRules_Transfer as the app", async () => {
    const { client, submit } = makeClient([
      coupon("00c1", "1.0000000000", "99"), // issuing -> claimable
      coupon("00c2", "2.0000000000", "100"), // open -> skipped
    ]);
    const r = await claimAppRewards(client, scan, {
      app: APP,
      userId: "u",
      nowMs: Date.parse("2026-06-02T00:00:00Z"),
    });
    expect(r).not.toBeNull();
    expect(r!.claimedCount).toBe(1);
    expect(r!.amount).toBe("1.0000000000");

    const body = submit.mock.calls[0]![0] as {
      actAs: string[];
      disclosedContracts?: Array<{ contractId: string }>;
      commands: Array<{
        ExerciseCommand: { choice: string; choiceArgument: Record<string, unknown> };
      }>;
    };
    expect(body.actAs).toEqual([APP]);
    const ex = body.commands[0]!.ExerciseCommand;
    expect(ex.choice).toBe("AmuletRules_Transfer");
    const ca = ex.choiceArgument as {
      transfer: {
        sender: string;
        inputs: Array<{ tag: string; value: string }>;
        outputs: Array<{ receiver: string; amount: string }>;
      };
      context: { openMiningRound: string };
      expectedDso: string;
    };
    expect(ca.transfer.sender).toBe(APP);
    expect(ca.transfer.inputs).toEqual([
      { tag: "InputAppRewardCoupon", value: "00c1" },
    ]);
    expect(ca.transfer.outputs[0]!.receiver).toBe(APP);
    expect(ca.transfer.outputs[0]!.amount).toBe("1.0000000000");
    expect(ca.context.openMiningRound).toBe("00omr");
    expect(ca.expectedDso).toBe("dso::1220");
    // AmuletRules + open round + issuing round disclosed.
    const ids = (body.disclosedContracts ?? []).map((d) => d.contractId);
    expect(ids).toEqual(expect.arrayContaining(["00ar", "00omr", "00imr"]));
  });
});

// ─── emitX402RoundMarker ──────────────────────────────────────────────────────

describe("emitX402RoundMarker", () => {
  const FTP_PARTY = "facilitator::ftp1220";
  const FAR_CID = "00far";
  const SYNC_ID = "global-domain::1220";

  it("exercises FeaturedAppRight_CreateActivityMarker with correct templateId", async () => {
    const submit = makeSubmit();
    await emitX402RoundMarker(asClient(submit), {
      app: FTP_PARTY,
      userId: "facilitator",
      synchronizerId: SYNC_ID,
      featuredAppRightCid: FAR_CID,
      weight: 3.14,
      roundNumber: 42,
    });
    const body = submit.mock.calls[0]![0] as {
      actAs: string[];
      commandId: string;
      synchronizerId: string;
      commands: Array<{
        ExerciseCommand: {
          templateId: string;
          contractId: string;
          choice: string;
          choiceArgument: {
            beneficiaries: Array<{ beneficiary: string; weight: string }>;
            weight: string;
          };
        };
      }>;
    };
    expect(body.actAs).toEqual([FTP_PARTY]);
    expect(body.commandId).toBe("x402-round-marker-42");
    expect(body.synchronizerId).toBe(SYNC_ID);
    const cmd = body.commands[0]!.ExerciseCommand;
    expect(cmd.templateId).toBe(FEATURED_APP_RIGHT_V2_TEMPLATE);
    expect(cmd.contractId).toBe(FAR_CID);
    expect(cmd.choice).toBe("FeaturedAppRight_CreateActivityMarker");
    expect(cmd.choiceArgument.beneficiaries).toEqual([
      { beneficiary: FTP_PARTY, weight: "1.0000000000" },
    ]);
    expect(cmd.choiceArgument.weight).toBe("3.1400000000");
  });

  it("commandId is deterministic on roundNumber (idempotent retries)", async () => {
    const submit = makeSubmit();
    await emitX402RoundMarker(asClient(submit), {
      app: FTP_PARTY,
      userId: "facilitator",
      synchronizerId: SYNC_ID,
      featuredAppRightCid: FAR_CID,
      weight: 1.0,
      roundNumber: 99,
    });
    const body = submit.mock.calls[0]![0] as { commandId: string };
    expect(body.commandId).toBe("x402-round-marker-99");
  });

  it("returns TransactionResult with updateId", async () => {
    const submit = vi.fn(async () => ({ updateId: "marker-tx-1", offset: 5, events: [] }));
    const result = await emitX402RoundMarker(
      { submitAndWaitForTransaction: submit } as unknown as Pick<CantonClient, "submitAndWaitForTransaction">,
      {
        app: FTP_PARTY,
        userId: "facilitator",
        synchronizerId: SYNC_ID,
        featuredAppRightCid: FAR_CID,
        weight: 0.06,
        roundNumber: 10,
      }
    );
    expect(result.updateId).toBe("marker-tx-1");
  });
});

