import { describe, it, expect, vi } from "vitest";
import {
  FaucetService,
  type FaucetServiceDeps,
  type FaucetTransfer,
} from "./faucet.js";

const AMULETS = [
  {
    contractId: "00amulet1",
    templateId: "#splice-amulet:Splice.Amulet:Amulet",
    createArgument: { amount: { initialAmount: "100.0000000000" } },
  },
];

const RESOLVED = {
  factoryId: "00factory",
  transferFactoryTemplateId:
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory",
  choiceContextData: { values: { ctx: "data" } },
  disclosedContracts: [{ contractId: "00disclosed" }] as never,
};

function makeService(opts?: {
  submit?: ReturnType<typeof vi.fn>;
  amulets?: unknown;
  amountCc?: string;
  resolve?: ReturnType<typeof vi.fn>;
}) {
  const submit =
    opts?.submit ?? vi.fn(async () => ({ updateId: "u-fc", offset: 1, events: [] }));
  const resolve =
    opts?.resolve ?? vi.fn(async () => RESOLVED);
  const client = {
    submitAndWaitForTransaction: submit,
    queryActiveContracts: vi.fn(async () => opts?.amulets ?? AMULETS),
  } as unknown as FaucetServiceDeps["client"];
  const svc = new FaucetService({
    client,
    facilitatorParty: "ftp_facilitator::1220fff",
    userId: "facilitator-user",
    synchronizerId: "global-domain::1220sync",
    amountCc: opts?.amountCc ?? "0.02",
    getDso: vi.fn(async () => "dso::1220"),
    resolveTransferFactory: resolve,
  });
  return { svc, submit, resolve };
}

describe("FaucetService.claim", () => {
  it("transfers the faucet amount from the facilitator to the recipient via TransferFactory_Transfer", async () => {
    const { svc, submit, resolve } = makeService();
    const r = await svc.claim({ recipient: "agent::1220a" });

    expect(r).toEqual({
      updateId: "u-fc",
      amount: "0.02",
      recipient: "agent::1220a",
    });

    // The resolve was asked for a transfer FROM the facilitator TO the agent,
    // with the facilitator's own holding as input and the resolved DSO.
    const resolveArg = resolve.mock.calls[0]![0] as {
      transfer: FaucetTransfer;
      dso: string;
    };
    expect(resolveArg.dso).toBe("dso::1220");
    expect(resolveArg.transfer.sender).toBe("ftp_facilitator::1220fff");
    expect(resolveArg.transfer.receiver).toBe("agent::1220a");
    expect(resolveArg.transfer.amount).toBe("0.02");
    expect(resolveArg.transfer.instrumentId).toEqual({ admin: "dso::1220", id: "Amulet" });
    expect(resolveArg.transfer.inputHoldingCids).toEqual(["00amulet1"]);

    const body = submit.mock.calls[0]![0] as {
      actAs: string[];
      synchronizerId?: string;
      disclosedContracts: Array<{ contractId: string }>;
      commands: Array<{
        ExerciseCommand: {
          templateId: string;
          contractId: string;
          choice: string;
          choiceArgument: {
            expectedAdmin: string;
            transfer: FaucetTransfer;
            extraArgs: { context: unknown };
          };
        };
      }>;
    };

    // Facilitator only — no agent key.
    expect(body.actAs).toEqual(["ftp_facilitator::1220fff"]);
    expect(body.synchronizerId).toBe("global-domain::1220sync");

    const cmd = body.commands[0]!.ExerciseCommand;
    expect(cmd.choice).toBe("TransferFactory_Transfer");
    expect(cmd.contractId).toBe("00factory");
    expect(cmd.templateId).toBe(RESOLVED.transferFactoryTemplateId);
    expect(cmd.choiceArgument.expectedAdmin).toBe("dso::1220");
    expect(cmd.choiceArgument.transfer.receiver).toBe("agent::1220a");
    expect(cmd.choiceArgument.extraArgs.context).toEqual(RESOLVED.choiceContextData);

    // The factory's disclosed contracts are passed through to the submit.
    expect(body.disclosedContracts.map((d) => d.contractId)).toContain("00disclosed");
  });

  it("selects the facilitator's largest Amulet holdings first to cover amount + fee", async () => {
    const { svc, resolve } = makeService({
      amountCc: "0.02",
      amulets: [
        {
          contractId: "00small",
          templateId: "#splice-amulet:Splice.Amulet:Amulet",
          createArgument: { amount: { initialAmount: "0.0050000000" } },
        },
        {
          contractId: "00big",
          templateId: "#splice-amulet:Splice.Amulet:Amulet",
          createArgument: { amount: { initialAmount: "60.0000000000" } },
        },
      ],
    });
    await svc.claim({ recipient: "agent::1220a" });
    const resolveArg = resolve.mock.calls[0]![0] as { transfer: FaucetTransfer };
    // 60 CC clears 0.02 + 0.01 in one input; the small one is not needed.
    expect(resolveArg.transfer.inputHoldingCids).toEqual(["00big"]);
  });

  it("throws when the facilitator has no Amulet holdings", async () => {
    const { svc } = makeService({ amulets: [] });
    await expect(svc.claim({ recipient: "agent::1220a" })).rejects.toThrow(
      /insufficient Amulet holdings/
    );
  });

  it("throws when the facilitator's holdings cannot cover the amount", async () => {
    const { svc } = makeService({
      amountCc: "5",
      amulets: [
        {
          contractId: "00tiny",
          templateId: "#splice-amulet:Splice.Amulet:Amulet",
          createArgument: { amount: { initialAmount: "0.0100000000" } },
        },
      ],
    });
    await expect(svc.claim({ recipient: "agent::1220a" })).rejects.toThrow(
      /insufficient Amulet holdings/
    );
  });
});
