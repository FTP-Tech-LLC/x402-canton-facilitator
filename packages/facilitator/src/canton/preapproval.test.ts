import { describe, it, expect, vi } from "vitest";
import {
  PreapprovalService,
  UnfundedFeePartyError,
  type PreapprovalServiceDeps,
} from "./preapproval.js";

const AMULET = {
  amulet_rules: {
    contract: {
      contract_id: "00amuletrules",
      template_id: "#splice-amulet:Splice.AmuletRules:AmuletRules",
      created_event_blob: "blob-ar",
      payload: { dso: "dso::1220", isDevNet: false },
    },
    domain_id: "global-domain::1220sync",
  },
};
const ROUNDS = {
  open_mining_rounds: [
    {
      contract: {
        contract_id: "00omr",
        template_id: "#splice:OpenMiningRound",
        created_event_blob: "blob-omr",
        payload: { round: { number: "100" } },
      },
    },
  ],
  issuing_mining_rounds: [
    {
      contract: {
        contract_id: "00imr",
        template_id: "#splice:IssuingMiningRound",
        created_event_blob: "blob-imr",
        payload: { round: { number: "99" } },
      },
    },
  ],
};

const AMULETS = [
  {
    contractId: "00amulet1",
    templateId: "#splice-amulet:Splice.Amulet:Amulet",
    createArgument: { amount: { initialAmount: "100.0000000000" } },
  },
];

function makeService(
  rounds: unknown = ROUNDS,
  submit = vi.fn(async () => ({ updateId: "u-pa", offset: 1, events: [] })),
  amulets: unknown = AMULETS
) {
  const scan = {
    getAmuletRules: vi.fn(async () => AMULET),
    getOpenAndIssuingMiningRounds: vi.fn(async () => rounds),
  } as unknown as PreapprovalServiceDeps["scan"];
  const client = {
    submitAndWaitForTransaction: submit,
    queryActiveContracts: vi.fn(async () => amulets),
  } as unknown as PreapprovalServiceDeps["client"];
  const svc = new PreapprovalService({
    client,
    scan,
    facilitatorParty: "ftp_facilitator::1220fff",
    userId: "facilitator-user",
  });
  return { svc, submit };
}

describe("PreapprovalService.createTransferPreapproval", () => {
  it("exercises AmuletRules_CreateTransferPreapproval acting as BOTH provider and receiver", async () => {
    const { svc, submit } = makeService();
    const r = await svc.createTransferPreapproval({
      merchant: "merchant::1220m",
      expiresAt: "2026-09-01T00:00:00Z",
    });
    expect(r).toMatchObject({
      updateId: "u-pa",
      receiver: "merchant::1220m",
      provider: "ftp_facilitator::1220fff",
    });

    const body = submit.mock.calls[0]![0] as {
      actAs: string[];
      synchronizerId?: string;
      disclosedContracts: Array<{ contractId: string }>;
      commands: Array<{
        ExerciseCommand: {
          templateId: string;
          contractId: string;
          choice: string;
          choiceArgument: Record<string, unknown>;
        };
      }>;
    };

    // Both controllers (provider + receiver via CanActAs delegation).
    expect(body.actAs).toEqual([
      "ftp_facilitator::1220fff",
      "merchant::1220m",
    ]);
    expect(body.synchronizerId).toBe("global-domain::1220sync");

    const cmd = body.commands[0]!.ExerciseCommand;
    expect(cmd.choice).toBe("AmuletRules_CreateTransferPreapproval");
    expect(cmd.contractId).toBe("00amuletrules");
    const ca = cmd.choiceArgument as {
      receiver: string;
      provider: string;
      expectedDso: string;
      expiresAt: string;
      inputs: unknown[];
      context: { amuletRules: string; context: { openMiningRound: string } };
    };
    expect(ca.receiver).toBe("merchant::1220m");
    expect(ca.provider).toBe("ftp_facilitator::1220fff");
    expect(ca.expectedDso).toBe("dso::1220");
    expect(ca.expiresAt).toBe("2026-09-01T00:00:00Z");
    expect(ca.inputs).toEqual([{ tag: "InputAmulet", value: "00amulet1" }]);
    expect(ca.context.amuletRules).toBe("00amuletrules");
    expect(ca.context.context.openMiningRound).toBe("00omr");

    // AmuletRules + open round + issuing round are disclosed.
    const disclosed = body.disclosedContracts.map((d) => d.contractId);
    expect(disclosed).toContain("00amuletrules");
    expect(disclosed).toContain("00omr");
    expect(disclosed).toContain("00imr");
  });

  it("funds the fee with the provider's largest Amulet holdings first", async () => {
    const { svc, submit } = makeService(ROUNDS, undefined, [
      {
        contractId: "00small",
        templateId: "#splice-amulet:Splice.Amulet:Amulet",
        createArgument: { amount: { initialAmount: "5.0000000000" } },
      },
      {
        contractId: "00big",
        templateId: "#splice-amulet:Splice.Amulet:Amulet",
        createArgument: { amount: { initialAmount: "60.0000000000" } },
      },
    ]);
    await svc.createTransferPreapproval({
      merchant: "merchant::1220m",
      expiresAt: "2026-09-01T00:00:00Z",
    });
    const body = submit.mock.calls[0]![0] as {
      commands: Array<{
        ExerciseCommand: { choiceArgument: { inputs: unknown[] } };
      }>;
    };
    // Largest first; one 60 CC holding already clears the fee target.
    expect(
      body.commands[0]!.ExerciseCommand.choiceArgument.inputs
    ).toEqual([{ tag: "InputAmulet", value: "00big" }]);
  });

  it("throws UnfundedFeePartyError naming the FACILITATOR when it has no Amulet for the fee", async () => {
    const { svc } = makeService(ROUNDS, undefined, []);
    const err = await svc
      .createTransferPreapproval({
        merchant: "merchant::1220m",
        expiresAt: "2026-09-01T00:00:00Z",
      })
      .then(
        () => null,
        (e: unknown) => e as UnfundedFeePartyError
      );
    expect(err).toBeInstanceOf(UnfundedFeePartyError);
    expect(err!.party).toBe("ftp_facilitator::1220fff");
    expect(err!.message).toContain("ftp_facilitator::1220fff");
  });

  it("SELF path: an unfunded MERCHANT names the merchant party, never the facilitator", async () => {
    // Regression for a live reviewer report: the old hardcoded message blamed
    // "the facilitator" when the MERCHANT wallet was the empty one, sending the
    // integrator to debug the wrong side.
    const { svc } = makeService(ROUNDS, undefined, []);
    const err = await svc
      .prepareSelfPreapproval({
        party: "merchant::1220aabbcc",
        expiresAt: "2026-09-01T00:00:00Z",
      })
      .then(
        () => null,
        (e: unknown) => e as UnfundedFeePartyError
      );
    expect(err).toBeInstanceOf(UnfundedFeePartyError);
    expect(err!.party).toBe("merchant::1220aabbcc");
    expect(err!.message).toContain("merchant::1220aabbcc");
    expect(err!.message).not.toContain("facilitator");
  });

  it("throws when no open mining round is available", async () => {
    const { svc } = makeService({
      open_mining_rounds: [],
      issuing_mining_rounds: [],
    });
    await expect(
      svc.createTransferPreapproval({ merchant: "m::1220", expiresAt: "t" })
    ).rejects.toThrow(/open mining round/);
  });
});

/**
 * Past a 200 from interactiveSubmissionExecute the submission is ACCEPTED and
 * will be sequenced; the completion read only classifies it. This is the third
 * copy of that rule in the codebase (transfer-factory.ts execute and the relay
 * submit/execute route are the other two) and the last one to get the guard —
 * without it a merchant whose preapproval committed was told it failed, and ran
 * the flow again for a second creation fee.
 */
describe("executeSelfPreapproval: an unreadable completion is not a failed submission", () => {
  const run = async (poll: () => Promise<string>) => {
    const client = {
      getLedgerEnd: vi.fn(async () => ({ offset: 1 })),
      interactiveSubmissionExecute: vi.fn(async () => ({ updateId: undefined })),
      pollCompletionUpdateId: vi.fn(poll),
    } as unknown as PreapprovalServiceDeps["client"];
    const svc = new PreapprovalService({
      client,
      scan: {} as never,
      facilitatorParty: "ftp_facilitator::1220fff",
      userId: "facilitator-user",
    });
    return svc
      .executeSelfPreapproval({
        party: "merchant::1220m",
        preparedTransaction: "pt",
        hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
        partySignatures: { signatures: [] },
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
  };

  it("wraps an unreadable completion as an unknown outcome", async () => {
    const err = await run(async () => {
      throw Object.assign(new Error("no completion for submissionId within timeout"), {
        code: "INVALID_RESPONSE",
      });
    });
    expect((err as Error).name).toBe("SubmissionOutcomeUnknownError");
  });

  it("lets a definitive participant refusal through unchanged", async () => {
    // The discriminator: SUBMISSION_FAILED means the completion ARRIVED and the
    // participant refused. Wrapping that too would hide a real, safe failure
    // behind a warning about a preapproval that never existed.
    const err = await run(async () => {
      throw Object.assign(new Error("interactive submission rejected: bad"), {
        code: "SUBMISSION_FAILED",
      });
    });
    expect((err as Error).name).not.toBe("SubmissionOutcomeUnknownError");
    expect((err as { code?: string }).code).toBe("SUBMISSION_FAILED");
  });
})

describe("createTransferPreapproval — stale disclosed round", () => {
  const STALE = "00omr-stale";
  const LIVE = "00omr-live";
  const roundsWith = (cid: string) => ({
    open_mining_rounds: [
      {
        contract: {
          contract_id: cid,
          template_id: "#splice:OpenMiningRound",
          created_event_blob: "blob-omr",
          payload: { round: { number: "100" } },
        },
      },
    ],
    issuing_mining_rounds: [],
  });

  /** A Scan whose cached read is stale until `Fresh` invalidates it. */
  function staleThenFresh(submit: ReturnType<typeof vi.fn>) {
    const cached = vi.fn(async () => roundsWith(STALE));
    const fresh = vi.fn(async () => roundsWith(LIVE));
    const scan = {
      getAmuletRules: vi.fn(async () => AMULET),
      getAmuletRulesFresh: vi.fn(async () => AMULET),
      getOpenAndIssuingMiningRounds: cached,
      getOpenAndIssuingMiningRoundsFresh: fresh,
    } as unknown as PreapprovalServiceDeps["scan"];
    const client = {
      submitAndWaitForTransaction: submit,
      queryActiveContracts: vi.fn(async () => AMULETS),
    } as unknown as PreapprovalServiceDeps["client"];
    return {
      svc: new PreapprovalService({
        client,
        scan,
        facilitatorParty: "ftp_facilitator::1220fff",
        userId: "facilitator-user",
      }),
      cached,
      fresh,
    };
  }
  const disclosedIds = (call: unknown) =>
    (call as { disclosedContracts: Array<{ contractId: string }> }).disclosedContracts.map(
      (d) => d.contractId
    );

  it("retries with the LIVE round after the ledger refuses the cached one", async () => {
    // Within one cache TTL of a round rotation, the cached cid names a contract
    // the ledger has already archived. Before the retry, every preapproval
    // create in that window simply failed.
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("LOCAL_VERDICT_INACTIVE_CONTRACTS"))
      .mockResolvedValueOnce({ updateId: "u-retry", offset: 2, events: [] });
    const { svc, fresh } = staleThenFresh(submit);
    const r = await svc.createTransferPreapproval({
      merchant: "merchant::1220m",
      expiresAt: "2026-09-01T00:00:00Z",
    });
    expect(r.updateId).toBe("u-retry");
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(disclosedIds(submit.mock.calls[0]![0])).toContain(STALE);
    expect(disclosedIds(submit.mock.calls[1]![0])).toContain(LIVE);
  });

  it("does NOT retry an ambiguous failure — a timeout may have created it", async () => {
    // The retry is safe only because a contention rejection is a DEFINITE
    // verdict that created nothing. Re-submitting after "maybe it worked"
    // would risk a second preapproval.
    const submit = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const { svc, fresh } = staleThenFresh(submit);
    await expect(
      svc.createTransferPreapproval({
        merchant: "merchant::1220m",
        expiresAt: "2026-09-01T00:00:00Z",
      })
    ).rejects.toThrow(/socket hang up/);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(fresh).not.toHaveBeenCalled();
  });

  it("retries at most once — a second refusal is the caller's answer", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("have been archived"));
    const { svc, fresh } = staleThenFresh(submit);
    await expect(
      svc.createTransferPreapproval({
        merchant: "merchant::1220m",
        expiresAt: "2026-09-01T00:00:00Z",
      })
    ).rejects.toThrow(/have been archived/);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("the happy path never touches the cache-bypassing read", async () => {
    const submit = vi.fn(async () => ({ updateId: "u-ok", offset: 1, events: [] }));
    const { svc, cached, fresh } = staleThenFresh(submit);
    await svc.createTransferPreapproval({
      merchant: "merchant::1220m",
      expiresAt: "2026-09-01T00:00:00Z",
    });
    expect(cached).toHaveBeenCalledTimes(1);
    expect(fresh).not.toHaveBeenCalled();
  });
});
