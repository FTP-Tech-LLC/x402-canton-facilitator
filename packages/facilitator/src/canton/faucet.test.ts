import { describe, it, expect, vi } from "vitest";
import { CantonError } from "@ftptech/x402-canton-ledger";
import {
  FaucetService,
  FaucetPreSubmitError,
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

describe("FaucetService.claim — payout queue + contention retry", () => {
  const contention = (status: number) =>
    new CantonError(
      `POST /v2/commands/submit-and-wait-for-transaction returned HTTP ${status}`,
      "http_error",
      status
    );

  it("serializes CONCURRENT claims: submissions never overlap (no shared-input race)", async () => {
    let inFlight = 0;
    let peak = 0;
    const submit = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return { updateId: "u-fc", offset: 1, events: [] };
    });
    const { svc } = makeService({ submit });
    const results = await Promise.all([
      svc.claim({ recipient: "agent::1220a" }),
      svc.claim({ recipient: "agent::1220b" }),
      svc.claim({ recipient: "agent::1220c" }),
    ]);
    expect(results).toHaveLength(3);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1); // one payout on the wire at a time
  });

  it("retries ONCE on 409/404 contention with FRESH input selection, then succeeds", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(contention(409))
      .mockResolvedValueOnce({ updateId: "u-retry", offset: 2, events: [] });
    const { svc } = makeService({ submit });
    const r = await svc.claim({ recipient: "agent::1220a" });
    expect(r.updateId).toBe("u-retry");
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("a SECOND consecutive contention is NOT retried (bounded), and non-contention errors never retry", async () => {
    const submit409 = vi
      .fn()
      .mockRejectedValueOnce(contention(404))
      .mockRejectedValueOnce(contention(409));
    const { svc: svc1 } = makeService({ submit: submit409 });
    await expect(svc1.claim({ recipient: "agent::1220a" })).rejects.toMatchObject(
      { status: 409 }
    );
    expect(submit409).toHaveBeenCalledTimes(2); // exactly one retry

    const submit500 = vi
      .fn()
      .mockRejectedValue(
        new CantonError("HTTP 500", "http_error", 500)
      );
    const { svc: svc2 } = makeService({ submit: submit500 });
    await expect(svc2.claim({ recipient: "agent::1220b" })).rejects.toMatchObject(
      { status: 500 }
    );
    expect(submit500).toHaveBeenCalledTimes(1); // no retry

    // A failed claim must NOT wedge the queue: a fresh claim still runs.
    const submitOk = vi.fn(async () => ({ updateId: "u-after", offset: 3, events: [] }));
    const { svc: svc3 } = makeService({ submit: submitOk });
    await expect(svc3.claim({ recipient: "agent::1220c" })).resolves.toMatchObject({
      updateId: "u-after",
    });
  });
});

describe("FaucetService.claim — 'we never asked the ledger' is a distinct answer", () => {
  // The route's reservation is a ONE-TIME lifetime grant per party. It can only
  // roll it back safely when the failure PROVES nothing moved, so the service
  // has to say which side of the submit it died on. Everything below is the
  // preparation side: a Scan read, an ACS query on our own party, a registry
  // HTTP call — none of which can move CC.
  function svcWith(over: Partial<FaucetServiceDeps>) {
    return new FaucetService({
      client: {
        submitAndWaitForTransaction: vi.fn(async () => ({
          updateId: "u-fc",
          offset: 1,
          events: [],
        })),
        queryActiveContracts: vi.fn(async () => AMULETS),
      } as unknown as FaucetServiceDeps["client"],
      facilitatorParty: "ftp_facilitator::1220fff",
      userId: "facilitator-user",
      synchronizerId: "global-domain::1220sync",
      amountCc: "0.02",
      getDso: vi.fn(async () => "dso::1220"),
      resolveTransferFactory: vi.fn(async () => RESOLVED),
      ...over,
    });
  }

  it("marks a Scan (getDso) failure as pre-submit, keeping the cause", async () => {
    const boom = new CantonError("scan down", "HTTP_ERROR", 503);
    const svc = svcWith({ getDso: vi.fn(async () => { throw boom; }) });
    await expect(svc.claim({ recipient: "agent::1220a" })).rejects.toBeInstanceOf(
      FaucetPreSubmitError
    );
    await svc.claim({ recipient: "agent::1220a" }).catch((e) => {
      expect((e as FaucetPreSubmitError).cause).toBe(boom);
    });
  });

  it("marks a registry-resolve failure as pre-submit", async () => {
    const svc = svcWith({
      resolveTransferFactory: vi.fn(async () => {
        throw new CantonError("registry 500", "HTTP_ERROR", 500);
      }),
    });
    await expect(svc.claim({ recipient: "agent::1220a" })).rejects.toBeInstanceOf(
      FaucetPreSubmitError
    );
  });

  it("marks an unfunded-funder failure as pre-submit", async () => {
    const svc = svcWith({
      client: {
        submitAndWaitForTransaction: vi.fn(),
        queryActiveContracts: vi.fn(async () => []),
      } as unknown as FaucetServiceDeps["client"],
    });
    await expect(svc.claim({ recipient: "agent::1220a" })).rejects.toBeInstanceOf(
      FaucetPreSubmitError
    );
  });

  it("does NOT mark a SUBMIT failure — that one is genuinely ambiguous", async () => {
    // The discriminator, and the whole reason the marker is narrow. A submit
    // that fails may still have committed; if this were wrapped too, the route
    // would release the reservation and the party could be paid twice.
    const boom = new CantonError("gateway", "HTTP_ERROR", 502);
    const svc = svcWith({
      client: {
        submitAndWaitForTransaction: vi.fn(async () => { throw boom; }),
        queryActiveContracts: vi.fn(async () => AMULETS),
      } as unknown as FaucetServiceDeps["client"],
    });
    await expect(svc.claim({ recipient: "agent::1220a" })).rejects.toBe(boom);
  });

  it("a pre-submit 404 is still input contention — the single re-select survives the marker", async () => {
    // isInputContention has to unwrap, or wrapping would silently disable the
    // one retry that exists for a holding consumed mid-flight.
    let n = 0;
    const resolve = vi.fn(async () => {
      if (n++ === 0) throw new CantonError("gone", "HTTP_ERROR", 404);
      return RESOLVED;
    });
    const svc = svcWith({ resolveTransferFactory: resolve });
    await expect(svc.claim({ recipient: "agent::1220a" })).resolves.toMatchObject({
      updateId: "u-fc",
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
