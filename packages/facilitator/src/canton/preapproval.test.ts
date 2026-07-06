import { describe, it, expect, vi } from "vitest";
import {
  PreapprovalService,
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

  it("throws when the facilitator has no Amulet holdings for the fee", async () => {
    const { svc } = makeService(ROUNDS, undefined, []);
    await expect(
      svc.createTransferPreapproval({
        merchant: "merchant::1220m",
        expiresAt: "2026-09-01T00:00:00Z",
      })
    ).rejects.toThrow(/no Amulet holdings/);
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
