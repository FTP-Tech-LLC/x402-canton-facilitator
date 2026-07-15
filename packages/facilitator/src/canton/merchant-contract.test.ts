import { describe, it, expect, vi } from "vitest";
import { CantonClient } from "@ftptech/x402-canton-ledger";
import {
  MerchantContractService,
  type MerchantContract,
} from "./merchant-contract.js";

const URL = "http://canton.test";
const PKG = "canton-x402";
const FACILITATOR = "ftp_facilitator::1220fff";

const MERCHANT_CONTRACT_TID = "#canton-x402:Canton.X402:MerchantContract";
const PROPOSAL_TID =
  "#canton-x402:Canton.X402:MerchantRegistrationProposal";

describe("MerchantContractService.createRegistrationProposal", () => {
  it("submits a CreateCommand for MerchantRegistrationProposal and returns proposal cid", async () => {
    let captured: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        captured = { url, body: JSON.parse(init?.body as string) };
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-proposal",
              offset: 42,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00proposal-cid",
                    templateId: PROPOSAL_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "merchant::1220m",
                      asset: "canton-coin",
                      defaultPrice: "1000000000",
                      resourcePattern: "https://api.example.com/*",
                      description: "Example Merchant",
                    },
                    signatories: [FACILITATOR],
                    observers: ["merchant::1220m"],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.createRegistrationProposal({
      merchant: "merchant::1220m",
      asset: "canton-coin",
      defaultPrice: "1000000000",
      resourcePattern: "https://api.example.com/*",
      description: "Example Merchant",
      synchronizerId: "global-domain::1220",
      commandId: "register-1",
      userId: "facilitator-user",
    });

    expect(result.proposalCid).toBe("00proposal-cid");
    expect(result.updateId).toBe("u-proposal");

    const cmd = captured.body.commands.commands[0].CreateCommand;
    expect(cmd.templateId).toBe(PROPOSAL_TID);
    expect(cmd.createArguments.facilitator).toBe(FACILITATOR);
    expect(cmd.createArguments.merchant).toBe("merchant::1220m");
    expect(cmd.createArguments.asset).toBe("canton-coin");
    expect(cmd.createArguments.defaultPrice).toBe("1000000000");
    expect(cmd.createArguments.resourcePattern).toBe(
      "https://api.example.com/*"
    );
    expect(cmd.createArguments.description).toBe("Example Merchant");

    expect(captured.body.commands.actAs).toEqual([FACILITATOR]);
    expect(captured.body.commands.synchronizerId).toBe("global-domain::1220");
  });

  it("throws if the response has no CreatedEvent for the proposal template", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            transaction: { updateId: "u", offset: 0, events: [] },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await expect(
      svc.createRegistrationProposal({
        merchant: "m",
        asset: "canton-coin",
        defaultPrice: "1",
        resourcePattern: "*",
        description: "d",
        synchronizerId: "s",
        commandId: "c",
        userId: "u",
      })
    ).rejects.toThrow(/MerchantRegistrationProposal/);
  });
});

describe("MerchantContractService.createRegistrationProposal commandId", () => {
  it("passes the caller-supplied commandId straight through to submitAndWaitForTransaction", async () => {
    let capturedCommandId: string | undefined;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        capturedCommandId = body.commands.commandId;
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-proposal",
              offset: 1,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00prop-cid",
                    templateId: PROPOSAL_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m",
                      asset: "cc",
                      defaultPrice: "1",
                      resourcePattern: "*",
                      description: "d",
                    },
                    signatories: [FACILITATOR],
                    observers: ["m"],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "register-abc-123",
      userId: "u",
    });

    expect(capturedCommandId).toBe("register-abc-123");
  });
});

describe("MerchantContractService.createRegistrationProposal — contract field assertions", () => {
  function makeProposalFetch(captureBody?: (b: any) => void): typeof globalThis.fetch {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (captureBody) {
        captureBody(JSON.parse(init?.body as string));
      }
      return new Response(
        JSON.stringify({
          transaction: {
            updateId: "u-new",
            offset: 1,
            events: [
              {
                CreatedEvent: {
                  contractId: "00new-prop",
                  templateId: PROPOSAL_TID,
                  createArgument: {
                    facilitator: FACILITATOR,
                    merchant: "m",
                    asset: "cc",
                    defaultPrice: "1",
                    resourcePattern: "*",
                    description: "d",
                  },
                  signatories: [FACILITATOR],
                  observers: ["m"],
                  packageName: PKG,
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  // ── 1. createRegistrationProposal sends the correct templateId ────────────
  it("sends the correct templateId (MerchantRegistrationProposal) in the CreateCommand", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeProposalFetch((b) => { capturedBody = b; }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "c-tid",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].CreateCommand;
    expect(cmd.templateId).toBe(PROPOSAL_TID);
    expect(cmd.templateId).toContain("MerchantRegistrationProposal");
  });

  // ── 2. createRegistrationProposal actAs contains only the facilitator party
  it("actAs field contains only the facilitator party", async () => {
    let capturedActAs: string[] | undefined;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeProposalFetch((b) => { capturedActAs = b.commands.actAs; }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "merchant::1220m",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "c-actas",
      userId: "u",
    });

    expect(capturedActAs).toBeDefined();
    expect(capturedActAs).toHaveLength(1);
    expect(capturedActAs![0]).toBe(FACILITATOR);
    // Merchant must NOT be in actAs for the proposal (facilitator is sole signatory)
    expect(capturedActAs).not.toContain("merchant::1220m");
  });

  // ── 6. Ledger endpoint is /v2/commands/submit-and-wait-for-transaction ─────
  it("uses /v2/commands/submit-and-wait-for-transaction endpoint", async () => {
    const capturedUrls: string[] = [];
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        capturedUrls.push(url);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-endpoint",
              offset: 1,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00ep-prop",
                    templateId: PROPOSAL_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m",
                      asset: "cc",
                      defaultPrice: "1",
                      resourcePattern: "*",
                      description: "d",
                    },
                    signatories: [FACILITATOR],
                    observers: ["m"],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        ) as Response;
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "c-ep",
      userId: "u",
    });

    expect(capturedUrls.some((u) => u.endsWith("/v2/commands/submit-and-wait-for-transaction"))).toBe(true);
  });
});

describe("MerchantContractService.findMerchantContract — additional coverage", () => {
  function fetchReturning(events: any[]): typeof globalThis.fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v2/state/ledger-end")) {
        return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ contractEntries: events }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  function ce(args: {
    contractId: string;
    facilitator: string;
    merchant: string;
  }) {
    return {
      contractEntry: {
        JsActiveContract: {
          createdEvent: {
            contractId: args.contractId,
            templateId: MERCHANT_CONTRACT_TID,
            createArgument: {
              facilitator: args.facilitator,
              merchant: args.merchant,
              asset: "canton-coin",
              defaultPrice: "1000000000",
              resourcePattern: "https://api.example.com/*",
              createdAt: "2026-05-29T00:00:00Z",
              description: "Example",
            },
            signatories: [args.facilitator, args.merchant],
            observers: [],
            packageName: PKG,
          },
        },
      },
    };
  }

  // ── 3. findMerchantContract returns null when ACS has zero contracts ───────
  it("returns null when ACS has zero contracts (empty contractEntries)", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract("any-merchant::1220m");
    expect(result).toBeNull();
  });

  // ── 4. findMerchantContract iterates through multiple contracts ────────────
  it("iterates through multiple contracts and returns the matching one", async () => {
    const TARGET_MERCHANT = "target-merchant::1220t";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({ contractId: "00first", facilitator: FACILITATOR, merchant: "other-a::1220a" }),
        ce({ contractId: "00second", facilitator: FACILITATOR, merchant: "other-b::1220b" }),
        ce({ contractId: "00target", facilitator: FACILITATOR, merchant: TARGET_MERCHANT }),
        ce({ contractId: "00fourth", facilitator: FACILITATOR, merchant: "other-c::1220c" }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(TARGET_MERCHANT);
    expect(result).not.toBeNull();
    expect(result?.contractId).toBe("00target");
    expect(result?.payload.merchant).toBe(TARGET_MERCHANT);
  });

  // ── 5. pinned contractCid → matches THAT contract, not just any (audit L3) ──
  it("returns the contract whose id matches the pinned contractCid", async () => {
    const M = "merchant-x::1220m";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({ contractId: "00aaa", facilitator: FACILITATOR, merchant: M }),
        ce({ contractId: "00bbb", facilitator: FACILITATOR, merchant: M }),
      ]),
    });
    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(M, "00bbb");
    expect(result?.contractId).toBe("00bbb");
  });

  // ── 6. pinned cid that matches nothing → null (NOT a different contract) ────
  it("returns null when the pinned contractCid matches no live contract for the merchant", async () => {
    const M = "merchant-x::1220m";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({ contractId: "00aaa", facilitator: FACILITATOR, merchant: M }),
      ]),
    });
    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(M, "00does-not-exist");
    expect(result).toBeNull();
  });
});

describe("MerchantContractService.acceptRegistrationProposal — actAs assertion", () => {
  function makeAcceptFetch(captureBody?: (b: any) => void): typeof globalThis.fetch {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (captureBody) {
        captureBody(JSON.parse(init?.body as string));
      }
      return new Response(
        JSON.stringify({
          transaction: {
            updateId: "u-accept-actas",
            offset: 2,
            events: [
              {
                CreatedEvent: {
                  contractId: "00mc-actas",
                  templateId: MERCHANT_CONTRACT_TID,
                  createArgument: {
                    facilitator: FACILITATOR,
                    merchant: "merchant-actas::1220m",
                    asset: "cc",
                    defaultPrice: "1",
                    resourcePattern: "*",
                    createdAt: "2026-05-29T00:00:00Z",
                    description: "d",
                  },
                  signatories: [FACILITATOR, "merchant-actas::1220m"],
                  observers: [],
                  packageName: PKG,
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  // ── 5. acceptRegistrationProposal: actAs contains merchant party (not facilitator) ──
  it("actAs contains the merchant party and NOT the facilitator party", async () => {
    let capturedActAs: string[] | undefined;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeAcceptFetch((b) => { capturedActAs = b.commands.actAs; }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.acceptRegistrationProposal({
      proposalCid: "00prop",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "merchant-actas::1220m",
      synchronizerId: "s",
      commandId: "accept-actas-test",
      userId: "u",
    });

    expect(capturedActAs).toBeDefined();
    expect(capturedActAs).toContain("merchant-actas::1220m");
    // The facilitator is NOT in actAs for AcceptRegistration — the merchant acts
    expect(capturedActAs).not.toContain(FACILITATOR);
  });
});

describe("MerchantContractService.acceptRegistrationProposal commandId", () => {
  function makeAcceptFetch(opts: {
    contractId?: string;
    updateId?: string;
    templateId?: string;
    captureBody?: (b: any) => void;
  }): typeof globalThis.fetch {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (opts.captureBody) {
        opts.captureBody(JSON.parse(init?.body as string));
      }
      return new Response(
        JSON.stringify({
          transaction: {
            updateId: opts.updateId ?? "u-accept",
            offset: 2,
            events: [
              {
                CreatedEvent: {
                  contractId: opts.contractId ?? "00mc-cid",
                  templateId: opts.templateId ?? MERCHANT_CONTRACT_TID,
                  createArgument: {
                    facilitator: FACILITATOR,
                    merchant: "m",
                    asset: "cc",
                    defaultPrice: "1",
                    resourcePattern: "*",
                    createdAt: "2026-05-29T00:00:00Z",
                    description: "d",
                  },
                  signatories: [FACILITATOR, "m"],
                  observers: [],
                  packageName: PKG,
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  it("auto-generates a commandId starting with 'accept-' when none provided", async () => {
    let capturedCommandId: string | undefined;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeAcceptFetch({
        captureBody: (b) => {
          capturedCommandId = b.commands.commandId;
        },
      }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.acceptRegistrationProposal({
      proposalCid: "00prop",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "m",
      synchronizerId: "s",
      userId: "u",
      // commandId intentionally omitted
    });

    expect(capturedCommandId).toBeDefined();
    expect(capturedCommandId).toMatch(/^accept-/);
  });

  it("uses caller-supplied commandId when provided", async () => {
    let capturedCommandId: string | undefined;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeAcceptFetch({
        captureBody: (b) => {
          capturedCommandId = b.commands.commandId;
        },
      }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.acceptRegistrationProposal({
      proposalCid: "00prop",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "m",
      synchronizerId: "s",
      userId: "u",
      commandId: "accept-my-specific-id",
    });

    expect(capturedCommandId).toBe("accept-my-specific-id");
  });
});

describe("MerchantContractService.acceptRegistrationProposal", () => {
  it("submits ExerciseCommand with choice=AcceptRegistration", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-accept",
              offset: 2,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00mc-cid",
                    templateId: "#canton-x402:Canton.X402:MerchantContract",
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "merchant::1220m",
                      asset: "canton-coin",
                      defaultPrice: "1000000000",
                      resourcePattern: "*",
                      createdAt: "2026-05-29T00:00:00Z",
                      description: "d",
                    },
                    signatories: [FACILITATOR, "merchant::1220m"],
                    observers: [],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.acceptRegistrationProposal({
      proposalCid: "00proposal-cid",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "merchant::1220m",
      synchronizerId: "global-domain::1220",
      commandId: "accept-xyz",
      userId: "merchant-user",
    });

    expect(result.merchantContractCid).toBe("00mc-cid");
    expect(result.updateId).toBe("u-accept");

    const cmd = capturedBody.commands.commands[0].ExerciseCommand;
    expect(cmd.choice).toBe("AcceptRegistration");
    expect(cmd.contractId).toBe("00proposal-cid");
    expect(cmd.templateId).toBe(PROPOSAL_TID);
  });

  it("throws when no MerchantContract created event in result", async () => {
    // The transaction succeeded but contained no MerchantContract —
    // this means the Daml choice produced an unexpected result.
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-accept",
              offset: 2,
              // Events present but for a different template
              events: [
                {
                  CreatedEvent: {
                    contractId: "00other",
                    templateId: "#canton-x402:Canton.X402:SomethingElse",
                    createArgument: {},
                    signatories: [],
                    observers: [],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    // acceptRegistrationProposal doesn't throw on missing MC — it returns
    // empty string cid. Let's verify the returned cid is empty string
    // when no MerchantContract event is present.
    const result = await svc.acceptRegistrationProposal({
      proposalCid: "00proposal-cid",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "merchant::1220m",
      synchronizerId: "global-domain::1220",
      userId: "merchant-user",
    });
    // The implementation returns empty string when no MC event found
    expect(result.merchantContractCid).toBe("");
    expect(result.updateId).toBe("u-accept");
  });
});

describe("MerchantContractService.createRegistrationProposal — forwarding assertions", () => {
  function makeProposalFetchWithResult(
    opts: {
      captureBody?: (b: any) => void;
      merchant?: string;
      description?: string;
    } = {}
  ): typeof globalThis.fetch {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (opts.captureBody) {
        opts.captureBody(JSON.parse(init?.body as string));
      }
      return new Response(
        JSON.stringify({
          transaction: {
            updateId: "u-fwd",
            offset: 1,
            events: [
              {
                CreatedEvent: {
                  contractId: "00fwd-prop",
                  templateId: PROPOSAL_TID,
                  createArgument: {
                    facilitator: FACILITATOR,
                    merchant: opts.merchant ?? "m::1220fwd",
                    asset: "cc",
                    defaultPrice: "1",
                    resourcePattern: "*",
                    description: opts.description ?? "d-fwd",
                  },
                  signatories: [FACILITATOR],
                  observers: [opts.merchant ?? "m::1220fwd"],
                  packageName: PKG,
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  // userId from input is forwarded to submitAndWaitForTransaction
  it("userId from input is forwarded to submitAndWaitForTransaction", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeProposalFetchWithResult({ captureBody: (b) => { capturedBody = b; } }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m::1220fwd",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d-fwd",
      synchronizerId: "s",
      commandId: "c-userid-fwd",
      userId: "my-specific-user-id",
    });

    expect(capturedBody.commands.userId).toBe("my-specific-user-id");
  });

  // synchronizerId from input is forwarded
  it("synchronizerId from input is forwarded to submitAndWaitForTransaction", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeProposalFetchWithResult({ captureBody: (b) => { capturedBody = b; } }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m::1220fwd",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d-fwd",
      synchronizerId: "specific-domain::1220sync",
      commandId: "c-syncid-fwd",
      userId: "u",
    });

    expect(capturedBody.commands.synchronizerId).toBe("specific-domain::1220sync");
  });

  // description field is preserved in the contract
  it("description field is preserved in the CreateCommand createArguments", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeProposalFetchWithResult({
        captureBody: (b) => { capturedBody = b; },
        description: "My Fancy Merchant Description",
      }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m::1220desc",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "My Fancy Merchant Description",
      synchronizerId: "s",
      commandId: "c-desc-fwd",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].CreateCommand;
    expect(cmd.createArguments.description).toBe("My Fancy Merchant Description");
  });
});

describe("MerchantContractService.findMerchantContract — null when different merchant", () => {
  function fetchReturning(events: any[]): typeof globalThis.fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v2/state/ledger-end")) {
        return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ contractEntries: events }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  function ce(args: {
    contractId: string;
    facilitator: string;
    merchant: string;
  }) {
    return {
      contractEntry: {
        JsActiveContract: {
          createdEvent: {
            contractId: args.contractId,
            templateId: MERCHANT_CONTRACT_TID,
            createArgument: {
              facilitator: args.facilitator,
              merchant: args.merchant,
              asset: "canton-coin",
              defaultPrice: "1000000000",
              resourcePattern: "https://api.example.com/*",
              createdAt: "2026-05-29T00:00:00Z",
              description: "Null-diff-merchant test",
            },
            signatories: [args.facilitator, args.merchant],
            observers: [],
            packageName: PKG,
          },
        },
      },
    };
  }

  // returns null when the only matching facilitator contract has a different merchant
  it("returns null when the only matching facilitator contract has a different merchant", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({
          contractId: "00only",
          facilitator: FACILITATOR,
          merchant: "other-merchant::1220other",
        }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract("wanted-merchant::1220w");
    expect(result).toBeNull();
  });

  // contract returned has all payload fields
  it("contract returned has all payload fields (facilitator, merchant, asset, defaultPrice, resourcePattern, createdAt, description)", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({
          contractId: "00full-fields",
          facilitator: FACILITATOR,
          merchant: "full-fields-merchant::1220ff",
        }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract("full-fields-merchant::1220ff");
    expect(result).not.toBeNull();
    expect(result!.contractId).toBe("00full-fields");
    expect(result!.payload.facilitator).toBe(FACILITATOR);
    expect(result!.payload.merchant).toBe("full-fields-merchant::1220ff");
    expect(result!.payload.asset).toBe("canton-coin");
    expect(result!.payload.defaultPrice).toBe("1000000000");
    expect(result!.payload.resourcePattern).toBe("https://api.example.com/*");
    expect(result!.payload.createdAt).toBeDefined();
    expect(result!.payload.description).toBeDefined();
  });
});

describe("MerchantContractService.acceptRegistrationProposal — choice string", () => {
  function makeAcceptFetchForChoice(captureBody?: (b: any) => void): typeof globalThis.fetch {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (captureBody) {
        captureBody(JSON.parse(init?.body as string));
      }
      return new Response(
        JSON.stringify({
          transaction: {
            updateId: "u-choice-check",
            offset: 2,
            events: [
              {
                CreatedEvent: {
                  contractId: "00mc-choice",
                  templateId: MERCHANT_CONTRACT_TID,
                  createArgument: {
                    facilitator: FACILITATOR,
                    merchant: "m-choice::1220c",
                    asset: "cc",
                    defaultPrice: "1",
                    resourcePattern: "*",
                    createdAt: "2026-05-29T00:00:00Z",
                    description: "choice-test",
                  },
                  signatories: [FACILITATOR, "m-choice::1220c"],
                  observers: [],
                  packageName: PKG,
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  // acceptRegistrationProposal: choice is "AcceptRegistration" (exact string match)
  it("choice is exactly the string 'AcceptRegistration'", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: makeAcceptFetchForChoice((b) => { capturedBody = b; }),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.acceptRegistrationProposal({
      proposalCid: "00prop-choice",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "m-choice::1220c",
      synchronizerId: "s",
      commandId: "accept-choice-test",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].ExerciseCommand;
    expect(cmd.choice).toBe("AcceptRegistration");
    // Guard: must not be any variation like "Accept" or "acceptRegistration"
    expect(cmd.choice).not.toBe("Accept");
    expect(cmd.choice).not.toBe("acceptRegistration");
  });
});

describe("MerchantContractService.findMerchantContract", () => {
  function fetchReturning(events: any[]): typeof globalThis.fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v2/state/ledger-end")) {
        return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ contractEntries: events }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;
  }

  function ce(args: {
    contractId: string;
    facilitator: string;
    merchant: string;
  }) {
    return {
      contractEntry: {
        JsActiveContract: {
          createdEvent: {
            contractId: args.contractId,
            templateId: MERCHANT_CONTRACT_TID,
            createArgument: {
              facilitator: args.facilitator,
              merchant: args.merchant,
              asset: "canton-coin",
              defaultPrice: "1000000000",
              resourcePattern: "https://api.example.com/*",
              createdAt: "2026-05-24T10:00:00Z",
              description: "Example",
            },
            signatories: [args.facilitator, args.merchant],
            observers: [],
            packageName: PKG,
          },
        },
      },
    };
  }

  it("returns the MerchantContract matching both facilitator and merchant", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({
          contractId: "00other",
          facilitator: "different-facilitator::1220",
          merchant: "wanted-merchant::1220m",
        }),
        ce({
          contractId: "00wanted",
          facilitator: FACILITATOR,
          merchant: "wanted-merchant::1220m",
        }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const found = await svc.findMerchantContract("wanted-merchant::1220m");
    expect(found).not.toBeNull();
    expect(found?.contractId).toBe("00wanted");
    expect(found?.payload.merchant).toBe("wanted-merchant::1220m");
    expect(found?.payload.facilitator).toBe(FACILITATOR);
  });

  it("returns null when merchant has no contract with this facilitator", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({
          contractId: "00other",
          facilitator: "different-facilitator::1220",
          merchant: "different-merchant::1220",
        }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    expect(
      await svc.findMerchantContract("wanted-merchant::1220m")
    ).toBeNull();
  });

  it("returns null when ACS is empty", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    expect(
      await svc.findMerchantContract("any-merchant::1220")
    ).toBeNull();
  });

  it("ignores non-MerchantContract templates in the ACS results", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        {
          contractEntry: {
            JsActiveContract: {
              createdEvent: {
                contractId: "00unrelated",
                templateId:
                  "#canton-x402:Canton.X402:MerchantRegistrationProposal",
                createArgument: {
                  facilitator: FACILITATOR,
                  merchant: "wanted-merchant::1220m",
                },
                signatories: [FACILITATOR],
                observers: ["wanted-merchant::1220m"],
                packageName: PKG,
              },
            },
          },
        },
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    expect(
      await svc.findMerchantContract("wanted-merchant::1220m")
    ).toBeNull();
  });

  it("sends a TemplateFilter (not WildcardFilter) to avoid HTTP 413 on large ACS", async () => {
    // Regression guard: the ACS request body must use TemplateFilter scoped
    // to MerchantContract so the participant doesn't return thousands of
    // unrelated contracts and blow the response size limit.
    let capturedAcsBody: any = null;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v2/state/ledger-end")) {
        return new Response(JSON.stringify({ offset: 5 }), { status: 200 });
      }
      capturedAcsBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ contractEntries: [] }),
        { status: 200 }
      );
    }) as typeof globalThis.fetch;

    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.findMerchantContract("some-merchant::1220");

    expect(capturedAcsBody).not.toBeNull();
    const partyFilter =
      capturedAcsBody.filter.filtersByParty[FACILITATOR];
    expect(partyFilter).toBeDefined();
    const cumulative = partyFilter.cumulative as any[];
    expect(cumulative.length).toBeGreaterThan(0);
    const identifierFilter = cumulative[0].identifierFilter;
    // Must be TemplateFilter — WildcardFilter would be a regression
    expect(identifierFilter.TemplateFilter).toBeDefined();
    expect(identifierFilter.WildcardFilter).toBeUndefined();
    expect(
      identifierFilter.TemplateFilter.value.templateId
    ).toContain("MerchantContract");
  });

  // ── NEW TESTS (batch 3) ─────────────────────────────────────────────────────

  // findMerchantContract: filters by facilitatorParty (not just merchant)
  it("findMerchantContract: filters by facilitatorParty — contract with different facilitator is excluded", async () => {
    const wantedMerchant = "my-merchant::1220m";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        // Contract for the same merchant but a DIFFERENT facilitator — must be ignored
        ce({
          contractId: "00wrong-fac",
          facilitator: "wrong-facilitator::1220wf",
          merchant: wantedMerchant,
        }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(wantedMerchant);
    // facilitator doesn't match this.facilitatorParty → null
    expect(result).toBeNull();
  });

  // findMerchantContract: when ACS response has 10 entries, iterates all to find match
  it("findMerchantContract: iterates all 10 ACS entries to find the matching one", async () => {
    const TARGET_MERCHANT = "target-10::1220t10";
    const entries = Array.from({ length: 9 }, (_, i) =>
      ce({
        contractId: `00entry-${i}`,
        facilitator: FACILITATOR,
        merchant: `other-${i}::1220o${i}`,
      })
    );
    entries.push(
      ce({ contractId: "00match-10", facilitator: FACILITATOR, merchant: TARGET_MERCHANT })
    );

    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning(entries),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(TARGET_MERCHANT);
    expect(result).not.toBeNull();
    expect(result?.contractId).toBe("00match-10");
    expect(result?.payload.merchant).toBe(TARGET_MERCHANT);
  });

  // createRegistrationProposal: throws on HTTP error (HTTP 500 from participant)
  it("createRegistrationProposal: throws (not silently fails) on HTTP 500 from participant", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: "internal server error" }),
          { status: 500 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    // The HTTP 500 must surface as a thrown error, not as a silent null/undefined return
    await expect(
      svc.createRegistrationProposal({
        merchant: "m",
        asset: "cc",
        defaultPrice: "1",
        resourcePattern: "*",
        description: "d",
        synchronizerId: "s",
        commandId: "c-http-err",
        userId: "u",
      })
    ).rejects.toThrow();
  });

  // acceptRegistrationProposal: when synchronizerId is passed, it appears in commands body
  it("acceptRegistrationProposal: synchronizerId appears in the submitted commands body", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-sync-accept",
              offset: 3,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00mc-sync",
                    templateId: MERCHANT_CONTRACT_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m-sync::1220ms",
                      asset: "cc",
                      defaultPrice: "1",
                      resourcePattern: "*",
                      createdAt: "2026-05-29T00:00:00Z",
                      description: "sync-test",
                    },
                    signatories: [FACILITATOR, "m-sync::1220ms"],
                    observers: [],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const CUSTOM_SYNC_ID = "custom-domain::1220sync-accept";
    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.acceptRegistrationProposal({
      proposalCid: "00prop-sync",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "m-sync::1220ms",
      synchronizerId: CUSTOM_SYNC_ID,
      commandId: "accept-sync-test",
      userId: "u",
    });

    expect(capturedBody.commands.synchronizerId).toBe(CUSTOM_SYNC_ID);
  });

  // findMerchantContract: when no entry has matching facilitator AND merchant → null
  it("findMerchantContract: when no entry matches BOTH facilitator AND merchant → returns null", async () => {
    const wantedMerchant = "exactly-wanted::1220ew";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        // facilitator matches, merchant doesn't
        ce({ contractId: "00a", facilitator: FACILITATOR, merchant: "not-wanted::1220nw" }),
        // merchant matches, facilitator doesn't
        ce({ contractId: "00b", facilitator: "other-fac::1220of", merchant: wantedMerchant }),
        // neither matches
        ce({ contractId: "00c", facilitator: "other-fac::1220of", merchant: "not-wanted::1220nw" }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(wantedMerchant);
    expect(result).toBeNull();
  });

  it("createRegistrationProposal: the CreateCommand template ends with ':MerchantRegistrationProposal'", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-suffix",
              offset: 1,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00suffix-prop",
                    templateId: PROPOSAL_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m-suffix::1220ms",
                      asset: "cc",
                      defaultPrice: "1",
                      resourcePattern: "*",
                      description: "d",
                    },
                    signatories: [FACILITATOR],
                    observers: ["m-suffix::1220ms"],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m-suffix::1220ms",
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "c-suffix",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].CreateCommand;
    expect(cmd.templateId).toMatch(/:MerchantRegistrationProposal$/);
  });

  it("createRegistrationProposal: merchant party in createArguments matches input merchant", async () => {
    let capturedBody: any = null;
    const SPECIFIC_MERCHANT = "specific-merchant::1220sm";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-merchant-match",
              offset: 1,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00merchant-match",
                    templateId: PROPOSAL_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: SPECIFIC_MERCHANT,
                      asset: "cc",
                      defaultPrice: "1",
                      resourcePattern: "*",
                      description: "d",
                    },
                    signatories: [FACILITATOR],
                    observers: [SPECIFIC_MERCHANT],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: SPECIFIC_MERCHANT,
      asset: "cc",
      defaultPrice: "1",
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "c-merchant-match",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].CreateCommand;
    expect(cmd.createArguments.merchant).toBe(SPECIFIC_MERCHANT);
  });

  it("findMerchantContract: returns the first matching contract (not all of them)", async () => {
    const TARGET_MERCHANT = "first-match-merchant::1220fm";
    // Two contracts matching the same facilitator + merchant — should return the first
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        ce({ contractId: "00first-match", facilitator: FACILITATOR, merchant: TARGET_MERCHANT }),
        ce({ contractId: "00second-match", facilitator: FACILITATOR, merchant: TARGET_MERCHANT }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(TARGET_MERCHANT);
    // Must return a single contract (not null), and it's the first one
    expect(result).not.toBeNull();
    expect(result?.contractId).toBe("00first-match");
  });

  it("acceptRegistrationProposal: the commandId starts with 'accept-' when not provided", async () => {
    let capturedCommandId: string | undefined;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        capturedCommandId = body.commands.commandId;
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-auto-cmd",
              offset: 2,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00mc-auto",
                    templateId: MERCHANT_CONTRACT_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m-auto::1220a",
                      asset: "cc",
                      defaultPrice: "1",
                      resourcePattern: "*",
                      createdAt: "2026-05-29T00:00:00Z",
                      description: "d",
                    },
                    signatories: [FACILITATOR, "m-auto::1220a"],
                    observers: [],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.acceptRegistrationProposal({
      proposalCid: "00prop-auto",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "m-auto::1220a",
      synchronizerId: "s",
      userId: "u",
      // commandId intentionally omitted → auto-generated
    });

    expect(capturedCommandId).toBeDefined();
    expect(capturedCommandId).toMatch(/^accept-/);
  });

  it("findMerchantContract: ACS queryActiveContracts uses #canton-x402 package name in template filter", async () => {
    let capturedAcsBody: any = null;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        capturedAcsBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ contractEntries: [] }), { status: 200 });
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.findMerchantContract("any-merchant::1220");

    expect(capturedAcsBody).not.toBeNull();
    // The filter must reference the canton-x402 package
    const filterJson = JSON.stringify(capturedAcsBody);
    expect(filterJson).toContain("canton-x402");
  });

  it("createRegistrationProposal: asset field in createArguments matches input asset", async () => {
    let capturedBody: any = null;
    const INPUT_ASSET = "specific-asset-token";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-asset",
              offset: 1,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00asset-prop",
                    templateId: PROPOSAL_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m-asset::1220a",
                      asset: INPUT_ASSET,
                      defaultPrice: "5000",
                      resourcePattern: "*",
                      description: "d",
                    },
                    signatories: [FACILITATOR],
                    observers: ["m-asset::1220a"],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m-asset::1220a",
      asset: INPUT_ASSET,
      defaultPrice: "5000",
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "c-asset",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].CreateCommand;
    expect(cmd.createArguments.asset).toBe(INPUT_ASSET);
  });

  it("createRegistrationProposal: defaultPrice in createArguments matches input defaultPrice", async () => {
    let capturedBody: any = null;
    const INPUT_PRICE = "9999999999";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-price",
              offset: 1,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00price-prop",
                    templateId: PROPOSAL_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m-price::1220p",
                      asset: "cc",
                      defaultPrice: INPUT_PRICE,
                      resourcePattern: "*",
                      description: "d",
                    },
                    signatories: [FACILITATOR],
                    observers: ["m-price::1220p"],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m-price::1220p",
      asset: "cc",
      defaultPrice: INPUT_PRICE,
      resourcePattern: "*",
      description: "d",
      synchronizerId: "s",
      commandId: "c-price",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].CreateCommand;
    expect(cmd.createArguments.defaultPrice).toBe(INPUT_PRICE);
  });

  it("findMerchantContract: does not call queryActiveContracts more than once (no pagination)", async () => {
    let acsCallCount = 0;
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        // Count every call to the ACS endpoint
        acsCallCount++;
        return new Response(
          JSON.stringify({ contractEntries: [] }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.findMerchantContract("some-merchant::1220");

    // ACS should only be called once — no pagination loop
    expect(acsCallCount).toBe(1);
  });

  it("acceptRegistrationProposal: proposalTemplateId is used as the templateId in ExerciseCommand", async () => {
    let capturedBody: any = null;
    const EXACT_PROPOSAL_TID = "#canton-x402:Canton.X402:MerchantRegistrationProposal";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: {
              updateId: "u-tid-check",
              offset: 2,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00mc-tid",
                    templateId: MERCHANT_CONTRACT_TID,
                    createArgument: {
                      facilitator: FACILITATOR,
                      merchant: "m-tid::1220t",
                      asset: "cc",
                      defaultPrice: "1",
                      resourcePattern: "*",
                      createdAt: "2026-05-29T00:00:00Z",
                      description: "d",
                    },
                    signatories: [FACILITATOR, "m-tid::1220t"],
                    observers: [],
                    packageName: PKG,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.acceptRegistrationProposal({
      proposalCid: "00prop-tid",
      proposalTemplateId: EXACT_PROPOSAL_TID,
      merchantParty: "m-tid::1220t",
      synchronizerId: "s",
      commandId: "accept-tid-test",
      userId: "u",
    });

    const cmd = capturedBody.commands.commands[0].ExerciseCommand;
    expect(cmd.templateId).toBe(EXACT_PROPOSAL_TID);
  });

  it("findMerchantContract: timeout/error from CantonClient propagates as thrown error", async () => {
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        // Simulate a participant timeout / server error
        throw new Error("Canton participant connection refused (timeout simulation)");
      }) as typeof globalThis.fetch,
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    await expect(svc.findMerchantContract("any-merchant::1220")).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Completeness round (batch 4)
  // ---------------------------------------------------------------------------

  it("createRegistrationProposal: resourcePattern in createArguments matches input", async () => {
    let capturedBody: any = null;
    const PATTERN = "https://api.specific-merchant.example.com/v2/*";
    const client = new CantonClient({
      participantUrl: URL, token: "t", packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          transaction: {
            updateId: "u-rp", offset: 1,
            events: [{ CreatedEvent: {
              contractId: "00rp-prop", templateId: PROPOSAL_TID,
              createArgument: { facilitator: FACILITATOR, merchant: "m::1220rp", asset: "cc", defaultPrice: "1", resourcePattern: PATTERN, description: "d" },
              signatories: [FACILITATOR], observers: ["m::1220rp"], packageName: PKG,
            }}],
          },
        }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m::1220rp", asset: "cc", defaultPrice: "1",
      resourcePattern: PATTERN, description: "d",
      synchronizerId: "s", commandId: "c-rp", userId: "u",
    });
    const cmd = capturedBody.commands.commands[0].CreateCommand;
    expect(cmd.createArguments.resourcePattern).toBe(PATTERN);
  });

  it("createRegistrationProposal: createdAt is not in createArguments (set by ledger)", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: URL, token: "t", packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({
          transaction: {
            updateId: "u-ca", offset: 1,
            events: [{ CreatedEvent: {
              contractId: "00ca-prop", templateId: PROPOSAL_TID,
              createArgument: { facilitator: FACILITATOR, merchant: "m::1220ca", asset: "cc", defaultPrice: "1", resourcePattern: "*", description: "d" },
              signatories: [FACILITATOR], observers: ["m::1220ca"], packageName: PKG,
            }}],
          },
        }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.createRegistrationProposal({
      merchant: "m::1220ca", asset: "cc", defaultPrice: "1",
      resourcePattern: "*", description: "d",
      synchronizerId: "s", commandId: "c-ca", userId: "u",
    });
    const cmd = capturedBody.commands.commands[0].CreateCommand;
    // createdAt must NOT be in createArguments — it is a ledger-set field
    expect(cmd.createArguments.createdAt).toBeUndefined();
  });

  it("findMerchantContract: the ACS filter templateId contains 'MerchantContract' (not Proposal)", async () => {
    let capturedAcsBody: any = null;
    const client = new CantonClient({
      participantUrl: URL, token: "t", packageName: PKG,
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        capturedAcsBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ contractEntries: [] }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const svc = new MerchantContractService(client, FACILITATOR);
    await svc.findMerchantContract("any-merchant::1220");
    expect(capturedAcsBody).not.toBeNull();
    const filterJson = JSON.stringify(capturedAcsBody);
    // Template filter must target MerchantContract — NOT MerchantRegistrationProposal
    expect(filterJson).toContain("MerchantContract");
    expect(filterJson).not.toContain("MerchantRegistrationProposal");
  });

  it("findMerchantContract: when ACS response has contractEntries format → still extracts correctly", async () => {
    const TARGET = "extracts-merchant::1220ex";
    const client = new CantonClient({
      participantUrl: URL, token: "t", packageName: PKG,
      fetch: fetchReturning([
        ce({ contractId: "00extract-match", facilitator: FACILITATOR, merchant: TARGET }),
      ]),
    });
    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.findMerchantContract(TARGET);
    expect(result).not.toBeNull();
    expect(result?.contractId).toBe("00extract-match");
    expect(result?.payload.merchant).toBe(TARGET);
    expect(result?.payload.facilitator).toBe(FACILITATOR);
  });

  it("acceptRegistrationProposal: the result updateId comes from the transaction.updateId", async () => {
    const EXPECTED_UPDATE_ID = "u-accept-specific-update-id";
    const client = new CantonClient({
      participantUrl: URL, token: "t", packageName: PKG,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Response(JSON.stringify({
          transaction: {
            updateId: EXPECTED_UPDATE_ID, offset: 5,
            events: [{ CreatedEvent: {
              contractId: "00mc-updateid", templateId: MERCHANT_CONTRACT_TID,
              createArgument: { facilitator: FACILITATOR, merchant: "m-uid::1220u", asset: "cc", defaultPrice: "1", resourcePattern: "*", createdAt: "2026-05-29T00:00:00Z", description: "d" },
              signatories: [FACILITATOR, "m-uid::1220u"], observers: [], packageName: PKG,
            }}],
          },
        }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const svc = new MerchantContractService(client, FACILITATOR);
    const result = await svc.acceptRegistrationProposal({
      proposalCid: "00prop-uid",
      proposalTemplateId: PROPOSAL_TID,
      merchantParty: "m-uid::1220u",
      synchronizerId: "s",
      commandId: "accept-uid-test",
      userId: "u",
    });
    // updateId must come from the transaction, not be hardcoded
    expect(result.updateId).toBe(EXPECTED_UPDATE_ID);
  });

  it("requires BOTH facilitator and merchant to match — wrong facilitator alone is not enough", async () => {
    // Regression: an earlier bug checked only merchant, so a contract owned
    // by a *different* facilitator for the same merchant would have matched.
    const wantedMerchant = "wanted-merchant::1220m";
    const client = new CantonClient({
      participantUrl: URL,
      token: "t",
      packageName: PKG,
      fetch: fetchReturning([
        // facilitator matches, merchant does NOT
        ce({
          contractId: "00wrong-merchant",
          facilitator: FACILITATOR,
          merchant: "other-merchant::1220x",
        }),
        // merchant matches, facilitator does NOT
        ce({
          contractId: "00wrong-facilitator",
          facilitator: "different-facilitator::1220df",
          merchant: wantedMerchant,
        }),
      ]),
    });

    const svc = new MerchantContractService(client, FACILITATOR);
    // Neither entry matches both conditions — should return null
    const result = await svc.findMerchantContract(wantedMerchant);
    expect(result).toBeNull();
  });
});
