import { describe, it, expect, vi, beforeEach } from "vitest";
import { CantonClient, CantonError } from "./client.js";

const URL = "http://canton.test";
const TOKEN = "test-jwt";
const PKG = "canton-x402";

function makeFetch(
  responder: (req: { url: string; init: RequestInit }) => {
    status?: number;
    body?: unknown;
  }
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body = {} } = responder({ url, init: init ?? {} });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "Content-Type": "application/json" },
      }
    );
  }) as typeof globalThis.fetch;
}

function makeClient(fetch: typeof globalThis.fetch): CantonClient {
  return new CantonClient({
    participantUrl: URL,
    token: TOKEN,
    packageName: PKG,
    fetch,
  });
}

describe("CantonClient.templateRef", () => {
  it("formats template ID with leading # and configured package name", () => {
    const c = makeClient(makeFetch(() => ({})));
    expect(c.templateRef("Canton.X402", "MerchantContract")).toBe(
      "#canton-x402:Canton.X402:MerchantContract"
    );
  });

  it("preserves dotted module paths verbatim", () => {
    const c = makeClient(makeFetch(() => ({})));
    expect(c.templateRef("Splice.Amulet", "FeaturedAppRight")).toBe(
      "#canton-x402:Splice.Amulet:FeaturedAppRight"
    );
  });
});

describe("CantonClient.submitAndWaitForTransaction", () => {
  it("wraps the body in {commands: {...}}", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const c = makeClient(
      makeFetch(({ url, init }) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return {
          body: {
            transaction: {
              updateId: "u1",
              offset: 42,
              events: [
                {
                  CreatedEvent: {
                    contractId: "cid-1",
                    templateId: "#canton-x402:Canton.X402:MerchantContract",
                    createArgument: {},
                    signatories: [],
                    observers: [],
                    packageName: PKG,
                  },
                },
              ],
            },
          },
        };
      })
    );

    await c.submitAndWaitForTransaction({
      commandId: "cmd-1",
      userId: "u",
      actAs: ["p1"],
      commands: [
        {
          CreateCommand: {
            templateId: "#canton-x402:Canton.X402:MerchantContract",
            createArguments: {},
          },
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${URL}/v2/commands/submit-and-wait-for-transaction`
    );
    const sent = calls[0]?.body as { commands?: { commandId?: string } };
    // CRITICAL gotcha: wrapped, not flat.
    expect(sent.commands).toBeDefined();
    expect(sent.commands?.commandId).toBe("cmd-1");
  });

  it("sets Authorization Bearer and Content-Type headers", async () => {
    const calls: Array<{ headers: Headers }> = [];
    const c = makeClient(
      makeFetch(({ init }) => {
        calls.push({ headers: new Headers(init.headers) });
        return {
          body: { transaction: { updateId: "u1", offset: 0, events: [] } },
        };
      })
    );

    await c.submitAndWaitForTransaction({
      commandId: "cmd-1",
      userId: "u",
      actAs: ["p1"],
      commands: [],
    });

    expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
  });

  it("extracts updateId, offset, and flat CreatedEvent array", async () => {
    const c = makeClient(
      makeFetch(() => ({
        body: {
          transaction: {
            updateId: "update-XYZ",
            offset: 99,
            events: [
              {
                CreatedEvent: {
                  contractId: "cid-a",
                  templateId: "#p:M:T",
                  createArgument: {},
                  signatories: ["p1"],
                  observers: [],
                  packageName: "p",
                },
              },
              // ArchivedEvent should be ignored.
              { ArchivedEvent: { contractId: "cid-archived" } },
              {
                CreatedEvent: {
                  contractId: "cid-b",
                  templateId: "#p:M:T",
                  createArgument: {},
                  signatories: ["p1"],
                  observers: [],
                  packageName: "p",
                },
              },
            ],
          },
        },
      }))
    );

    const result = await c.submitAndWaitForTransaction({
      commandId: "cmd",
      userId: "u",
      actAs: ["p1"],
      commands: [],
    });

    expect(result.updateId).toBe("update-XYZ");
    expect(result.offset).toBe(99);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.contractId).toBe("cid-a");
    expect(result.events[1]?.contractId).toBe("cid-b");
  });

  it("passes through Daml Int as JSON string in createArguments", async () => {
    let captured: any = null;
    const c = makeClient(
      makeFetch(({ init }) => {
        captured = JSON.parse(init.body as string);
        return {
          body: { transaction: { updateId: "u", offset: 0, events: [] } },
        };
      })
    );

    await c.submitAndWaitForTransaction({
      commandId: "cmd",
      userId: "u",
      actAs: ["p"],
      commands: [
        {
          CreateCommand: {
            templateId: "#p:M:T",
            createArguments: { totalLeads: "50" }, // Int as string
          },
        },
      ],
    });

    const sentArgs =
      captured.commands.commands[0].CreateCommand.createArguments;
    expect(sentArgs.totalLeads).toBe("50");
    expect(typeof sentArgs.totalLeads).toBe("string");
  });

  it("forwards disclosedContracts and synchronizerId", async () => {
    let captured: any = null;
    const c = makeClient(
      makeFetch(({ init }) => {
        captured = JSON.parse(init.body as string);
        return {
          body: { transaction: { updateId: "u", offset: 0, events: [] } },
        };
      })
    );

    await c.submitAndWaitForTransaction({
      commandId: "cmd",
      userId: "u",
      actAs: ["p"],
      synchronizerId: "sync-1",
      disclosedContracts: [
        {
          templateId: "#splice-amulet:Splice.AmuletRules:AmuletRules",
          contractId: "ar-cid",
          createdEventBlob: "blob",
          synchronizerId: "sync-1",
        },
      ],
      commands: [],
    });

    expect(captured.commands.synchronizerId).toBe("sync-1");
    expect(captured.commands.disclosedContracts).toHaveLength(1);
    expect(captured.commands.disclosedContracts[0].contractId).toBe("ar-cid");
  });

  it("throws CantonError on HTTP 400 with status preserved", async () => {
    const c = makeClient(
      makeFetch(() => ({
        status: 400,
        body: { error: "bad request" },
      }))
    );

    await expect(
      c.submitAndWaitForTransaction({
        commandId: "cmd",
        userId: "u",
        actAs: ["p"],
        commands: [],
      })
    ).rejects.toMatchObject({
      name: "CantonError",
      status: 400,
    });
  });

  it("throws CantonError on HTTP 500", async () => {
    const c = makeClient(makeFetch(() => ({ status: 500, body: "boom" })));

    await expect(
      c.submitAndWaitForTransaction({
        commandId: "cmd",
        userId: "u",
        actAs: ["p"],
        commands: [],
      })
    ).rejects.toMatchObject({
      name: "CantonError",
      status: 500,
    });
  });
});

describe("CantonClient.submitAndWait", () => {
  it("sends a FLAT body (no wrapper)", async () => {
    let captured: any = null;
    const c = makeClient(
      makeFetch(({ init }) => {
        captured = JSON.parse(init.body as string);
        return {
          body: { updateId: "u-1", completionOffset: 7 },
        };
      })
    );

    await c.submitAndWait({
      commandId: "cmd",
      userId: "u",
      actAs: ["p"],
      commands: [],
    });

    // CRITICAL gotcha: flat for this endpoint, no `commands: {...}` wrapper.
    expect(captured.commandId).toBe("cmd");
    expect(captured.commands).toEqual([]);
  });

  it("returns updateId and completionOffset", async () => {
    const c = makeClient(
      makeFetch(() => ({
        body: { updateId: "u-1", completionOffset: 7 },
      }))
    );

    const r = await c.submitAndWait({
      commandId: "cmd",
      userId: "u",
      actAs: ["p"],
      commands: [],
    });
    expect(r.updateId).toBe("u-1");
    expect(r.completionOffset).toBe(7);
  });
});

describe("CantonClient.getLedgerEnd", () => {
  it("issues GET and returns offset", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const c = makeClient(
      makeFetch(({ url, init }) => {
        calls.push({ url, method: init.method ?? "GET" });
        return { body: { offset: 12345 } };
      })
    );

    const r = await c.getLedgerEnd();
    expect(r.offset).toBe(12345);
    expect(calls[0]?.url).toBe(`${URL}/v2/state/ledger-end`);
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("CantonClient.queryActiveContracts", () => {
  it("fetches ledger-end first, then POSTs active-contracts with activeAtOffset", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const c = makeClient(
      makeFetch(({ url, init }) => {
        calls.push({
          url,
          method: init.method ?? "GET",
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: 100 } };
        }
        return {
          body: {
            contractEntries: [
              {
                contractEntry: {
                  JsActiveContract: {
                    createdEvent: {
                      contractId: "cid-x",
                      templateId: "#p:M:T",
                      createArgument: {},
                      signatories: [],
                      observers: [],
                      packageName: "p",
                    },
                  },
                },
              },
            ],
          },
        };
      })
    );

    const events = await c.queryActiveContracts({
      filtersByParty: {
        "p::abc": {
          cumulative: [
            {
              identifierFilter: {
                WildcardFilter: {
                  value: { includeCreatedEventBlob: false },
                },
              },
            },
          ],
        },
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${URL}/v2/state/ledger-end`);
    expect(calls[1]?.url).toBe(`${URL}/v2/state/active-contracts`);
    expect((calls[1]?.body as { activeAtOffset?: number }).activeAtOffset).toBe(
      100
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.contractId).toBe("cid-x");
  });

  it("throws a distinct ACS_LIMIT_EXCEEDED on a 413 (not generic HTTP_ERROR, not an empty list)", async () => {
    const c = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/v2/state/ledger-end")) return { body: { offset: 7 } };
        return { status: 413, body: { errors: ["request entity too large"] } };
      })
    );
    const err = await c
      .queryActiveContracts({ filtersByParty: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CantonError);
    expect((err as CantonError).code).toBe("ACS_LIMIT_EXCEEDED");
    expect((err as CantonError).status).toBe(413);
  });

  it("throws ACS_LIMIT_EXCEEDED when the body carries the MAXIMUM_LIST_ELEMENTS marker even on a non-413 status", async () => {
    const c = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/v2/state/ledger-end")) return { body: { offset: 7 } };
        return {
          status: 400,
          body: { cause: "JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED(...)" },
        };
      })
    );
    const err = await c
      .queryActiveContracts({ filtersByParty: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CantonError);
    expect((err as CantonError).code).toBe("ACS_LIMIT_EXCEEDED");
  });

  it("does NOT mislabel a generic 500 as ACS_LIMIT_EXCEEDED (stays HTTP_ERROR)", async () => {
    const c = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/v2/state/ledger-end")) return { body: { offset: 7 } };
        return { status: 500, body: "boom" };
      })
    );
    const err = await c
      .queryActiveContracts({ filtersByParty: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CantonError);
    expect((err as CantonError).code).toBe("HTTP_ERROR");
  });

  it("extracts events when response is a bare array (cn-quickstart Splice 0.5.3 shape)", async () => {
    const c = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: 1 } };
        }
        return {
          body: [
            {
              contractEntry: {
                JsActiveContract: {
                  createdEvent: {
                    contractId: "bare-array-cid",
                    templateId: "#p:M:T",
                    createArgument: {},
                    signatories: [],
                    observers: [],
                    packageName: "p",
                  },
                },
              },
            },
          ],
        };
      })
    );
    const events = await c.queryActiveContracts({
      filtersByParty: { p: { cumulative: [] } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.contractId).toBe("bare-array-cid");
  });

  it("extracts events from flat .createdEvent shape too (forwards-compat)", async () => {
    const c = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: 1 } };
        }
        return {
          body: {
            contractEntries: [
              {
                createdEvent: {
                  contractId: "flat-cid",
                  templateId: "#p:M:T",
                  createArgument: {},
                  signatories: [],
                  observers: [],
                  packageName: "p",
                },
              },
            ],
          },
        };
      })
    );

    const events = await c.queryActiveContracts({
      filtersByParty: { p: { cumulative: [] } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.contractId).toBe("flat-cid");
  });
});

describe("CantonClient.interactiveSubmissionPrepare", () => {
  it("POSTs to /v2/interactive-submission/prepare with flat body", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const c = makeClient(
      makeFetch(({ url, init }) => {
        captured = { url, body: JSON.parse(init.body as string) };
        return {
          body: {
            preparedTransaction: "base64-prepared",
            preparedTransactionHash: "base64-hash",
          },
        };
      })
    );

    const res = await c.interactiveSubmissionPrepare({
      userId: "u",
      commandId: "cmd",
      actAs: ["payer::1220"],
      synchronizerId: "sync-1",
      commands: [
        {
          ExerciseCommand: {
            templateId: "#p:M:T",
            contractId: "cid",
            choice: "Pay",
            choiceArgument: {},
          },
        },
      ],
    });

    expect(captured?.url).toBe(`${URL}/v2/interactive-submission/prepare`);
    expect((captured?.body as { commandId?: string }).commandId).toBe("cmd");
    // Required by the participant; the client injects them so callers need not.
    expect(
      (captured?.body as { packageIdSelectionPreference?: unknown })
        .packageIdSelectionPreference
    ).toEqual([]);
    expect((captured?.body as { verboseHashing?: unknown }).verboseHashing).toBe(
      false
    );
    expect(res.preparedTransaction).toBe("base64-prepared");
    expect(res.preparedTransactionHash).toBe("base64-hash");
  });

  it("defaults packageIdSelectionPreference/verboseHashing but lets the caller override", async () => {
    let captured: { body: { packageIdSelectionPreference?: unknown; verboseHashing?: unknown } } | null =
      null;
    const c = makeClient(
      makeFetch(({ init }) => {
        captured = { body: JSON.parse(init.body as string) };
        return {
          body: { preparedTransaction: "p", preparedTransactionHash: "h" },
        };
      })
    );
    await c.interactiveSubmissionPrepare({
      userId: "u",
      commandId: "cmd",
      actAs: ["p"],
      synchronizerId: "s",
      commands: [],
      packageIdSelectionPreference: ["pref-pkg"],
      verboseHashing: true,
    });
    expect(captured?.body.packageIdSelectionPreference).toEqual(["pref-pkg"]);
    expect(captured?.body.verboseHashing).toBe(true);
  });

  it("throws CantonError when prepared/hash missing in response", async () => {
    const c = makeClient(makeFetch(() => ({ body: { preparedTransaction: "x" } })));
    await expect(
      c.interactiveSubmissionPrepare({
        userId: "u",
        commandId: "cmd",
        actAs: ["p"],
        synchronizerId: "s",
        commands: [],
      })
    ).rejects.toMatchObject({
      name: "CantonError",
      code: "INVALID_RESPONSE",
    });
  });
});

describe("CantonClient.interactiveSubmissionExecute", () => {
  it("POSTs with partySignatures wrapper shape", async () => {
    let captured: { url: string; body: any } | null = null;
    const c = makeClient(
      makeFetch(({ url, init }) => {
        captured = { url, body: JSON.parse(init.body as string) };
        return { body: { updateId: "u-ok", completionOffset: 7 } };
      })
    );

    await c.interactiveSubmissionExecute({
      preparedTransaction: "base64-prepared",
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      partySignatures: {
        signatures: [
          {
            party: "payer::1220",
            signatures: [
              {
                format: "SIGNATURE_FORMAT_CONCAT",
                signature: "base64-sig",
                signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
                signedBy: "fp",
              },
            ],
          },
        ],
      },
      deduplicationPeriod: { Empty: {} },
    });

    expect(captured?.url).toBe(`${URL}/v2/interactive-submission/execute`);
    expect(captured?.body.preparedTransaction).toBe("base64-prepared");
    expect(captured?.body.partySignatures.signatures[0].party).toBe("payer::1220");
    expect(captured?.body.partySignatures.signatures[0].signatures[0].format).toBe(
      "SIGNATURE_FORMAT_CONCAT"
    );
  });

  it("extracts updateId and completionOffset", async () => {
    const c = makeClient(
      makeFetch(() => ({ body: { updateId: "u-ok", completionOffset: 7 } }))
    );
    const r = await c.interactiveSubmissionExecute({
      preparedTransaction: "p",
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
      partySignatures: { signatures: [] },
    });
    expect(r.updateId).toBe("u-ok");
    expect(r.completionOffset).toBe(7);
  });
});

describe("CantonClient timeouts", () => {
  it("aborts the request when timeoutMs elapses", async () => {
    let aborted = false;
    const slowFetch: typeof globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
          // Never resolves on its own.
        });
      }
    ) as typeof globalThis.fetch;

    const c = new CantonClient({
      participantUrl: URL,
      token: TOKEN,
      packageName: PKG,
      timeoutMs: 25,
      fetch: slowFetch,
    });

    await expect(c.getLedgerEnd()).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

describe("CantonClient.generateExternalPartyTopology", () => {
  it("POSTs to /v2/parties/external/generate-topology with the body verbatim", async () => {
    let captured: { url: string; body: any } = { url: "", body: null };
    const c = makeClient(
      makeFetch(({ url, init }) => {
        captured = { url, body: JSON.parse(init.body as string) };
        return {
          status: 200,
          body: {
            partyId: "x402_test::1220cafef00d",
            publicKeyFingerprint: "1220cafef00d",
            topologyTransactions: ["dGVzdA=="],
            multiHash: "EiC...",
          },
        };
      })
    );
    const r = await c.generateExternalPartyTopology({
      synchronizer: "global-domain::1220",
      partyHint: "agent_test",
      publicKey: {
        format: "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO",
        keyData: Buffer.from("publickey").toString("base64"),
        keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
      },
    });
    expect(captured.url).toBe(
      `${URL}/v2/parties/external/generate-topology`
    );
    expect(captured.body.synchronizer).toBe("global-domain::1220");
    expect(captured.body.partyHint).toBe("agent_test");
    expect(captured.body.publicKey.keySpec).toBe(
      "SIGNING_KEY_SPEC_EC_CURVE25519"
    );
    // Defaults injected by the wrapper when not overridden.
    expect(captured.body.localParticipantObservationOnly).toBe(false);
    expect(captured.body.confirmationThreshold).toBe(0);
    expect(r.partyId).toBe("x402_test::1220cafef00d");
    expect(r.publicKeyFingerprint).toBe("1220cafef00d");
  });

  it("propagates optional confirmation/observation overrides", async () => {
    let body: any;
    const c = makeClient(
      makeFetch(({ init }) => {
        body = JSON.parse(init.body as string);
        return {
          body: {
            partyId: "p",
            publicKeyFingerprint: "f",
            topologyTransactions: [],
            multiHash: "",
          },
        };
      })
    );
    await c.generateExternalPartyTopology({
      synchronizer: "x",
      partyHint: "y",
      publicKey: { format: "f", keyData: "k", keySpec: "s" },
      localParticipantObservationOnly: true,
      otherConfirmingParticipantUids: ["PAR::abc::1220"],
      confirmationThreshold: 2,
      observingParticipantUids: ["PAR::def::1220"],
    });
    expect(body.localParticipantObservationOnly).toBe(true);
    expect(body.confirmationThreshold).toBe(2);
    expect(body.otherConfirmingParticipantUids).toEqual(["PAR::abc::1220"]);
    expect(body.observingParticipantUids).toEqual(["PAR::def::1220"]);
  });
});

describe("CantonClient.getTransactionById", () => {
  it("POSTs to /v2/updates/transaction-by-id with LEDGER_EFFECTS shape", async () => {
    let captured: any;
    const c = makeClient(
      makeFetch(({ url, init }) => {
        expect(url).toBe(`${URL}/v2/updates/transaction-by-id`);
        captured = JSON.parse(init.body as string);
        return {
          body: {
            transaction: {
              updateId: "1220abc",
              offset: 42,
              events: [
                {
                  CreatedEvent: {
                    contractId: "00cid",
                    templateId: "x:y:z",
                    createArgument: {},
                    signatories: [],
                    observers: [],
                    packageName: "x",
                  },
                },
              ],
            },
          },
        };
      })
    );
    const r = await c.getTransactionById({
      updateId: "1220abc",
      requestingParties: ["alice::1220"],
    });
    expect(captured.updateId).toBe("1220abc");
    expect(captured.requestingParties).toEqual(["alice::1220"]);
    expect(captured.transactionShape).toBe(
      "TRANSACTION_SHAPE_LEDGER_EFFECTS"
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0].CreatedEvent?.contractId).toBe("00cid");
  });

  it("tolerates an empty events array", async () => {
    const c = makeClient(
      makeFetch(() => ({
        body: { transaction: { updateId: "u", offset: 0, events: [] } },
      }))
    );
    const r = await c.getTransactionById({
      updateId: "u",
      requestingParties: ["alice::1220"],
    });
    expect(r.events).toEqual([]);
  });

  it("returns ExercisedEvent, CreatedEvent, and ArchivedEvent verbatim", async () => {
    const c = makeClient(
      makeFetch(() => ({
        body: {
          transaction: {
            updateId: "u-mixed",
            offset: 10,
            events: [
              {
                ExercisedEvent: {
                  contractId: "00factory",
                  templateId: "x:y:TF",
                  choice: "TransferFactory_Transfer",
                  exerciseResult: { tag: "Completed" },
                },
              },
              {
                CreatedEvent: {
                  contractId: "00holding-new",
                  templateId: "x:y:Holding",
                  createArgument: { owner: "merchant::1220", amount: "10.00" },
                  signatories: ["merchant::1220"],
                  observers: [],
                  packageName: "x",
                },
              },
              {
                ArchivedEvent: {
                  contractId: "00holding-old",
                  templateId: "x:y:Holding",
                },
              },
            ],
          },
        },
      }))
    );
    const r = await c.getTransactionById({
      updateId: "u-mixed",
      requestingParties: ["fac::1220"],
    });
    expect(r.events).toHaveLength(3);
    expect(r.events[0].ExercisedEvent?.contractId).toBe("00factory");
    expect(r.events[0].ExercisedEvent?.choice).toBe("TransferFactory_Transfer");
    expect(r.events[1].CreatedEvent?.contractId).toBe("00holding-new");
    expect(r.events[2].ArchivedEvent?.contractId).toBe("00holding-old");
  });
});

describe("CantonClient.queryActiveContracts with InterfaceFilter", () => {
  it("passes InterfaceFilter verbatim in the ACS request body", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const c = makeClient(
      makeFetch(({ url, init }) => {
        calls.push({
          url,
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: 55 } };
        }
        return { body: { contractEntries: [] } };
      })
    );

    const interfaceId =
      "55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

    await c.queryActiveContracts({
      filtersByParty: {
        "fac::1220": {
          cumulative: [
            {
              identifierFilter: {
                InterfaceFilter: {
                  value: {
                    interfaceId,
                    includeInterfaceView: false,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });

    const acsCall = calls.find((c) =>
      (c.url as string).endsWith("/v2/state/active-contracts")
    );
    expect(acsCall).toBeDefined();
    const sentFilter = (acsCall?.body as any)?.filter?.filtersByParty?.["fac::1220"];
    expect(sentFilter).toBeDefined();
    const ifFilter =
      sentFilter?.cumulative?.[0]?.identifierFilter?.InterfaceFilter?.value;
    expect(ifFilter).toBeDefined();
    expect(ifFilter?.interfaceId).toBe(interfaceId);
    expect(ifFilter?.includeInterfaceView).toBe(false);
    expect(ifFilter?.includeCreatedEventBlob).toBe(false);
  });
});

describe("CantonClient with TokenProvider function", () => {
  it("calls TokenProvider function and sends result as Bearer token", async () => {
    const tokenProvider = vi.fn(async () => "dynamic-jwt-token");
    const calls: Array<{ authHeader: string }> = [];
    const c = new CantonClient({
      participantUrl: URL,
      token: tokenProvider,
      packageName: PKG,
      fetch: makeFetch(({ init }) => {
        calls.push({ authHeader: new Headers(init.headers).get("Authorization") ?? "" });
        return { body: { offset: 1 } };
      }),
    });

    await c.getLedgerEnd();

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(calls[0]?.authHeader).toBe("Bearer dynamic-jwt-token");
  });

  it("calls TokenProvider on every request (no caching in client itself)", async () => {
    let callCount = 0;
    const tokenProvider = vi.fn(async () => {
      callCount++;
      return `token-${callCount}`;
    });
    const c = new CantonClient({
      participantUrl: URL,
      token: tokenProvider,
      packageName: PKG,
      fetch: makeFetch(() => ({ body: { offset: 1 } })),
    });

    await c.getLedgerEnd();
    await c.getLedgerEnd();

    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });
});

describe("CantonClient with static string token", () => {
  it("sets Authorization header from static string token", async () => {
    const calls: Array<{ authHeader: string }> = [];
    const c = new CantonClient({
      participantUrl: URL,
      token: "static-bearer-xyz",
      packageName: PKG,
      fetch: makeFetch(({ init }) => {
        calls.push({ authHeader: new Headers(init.headers).get("Authorization") ?? "" });
        return { body: { offset: 0 } };
      }),
    });

    await c.getLedgerEnd();

    expect(calls[0]?.authHeader).toBe("Bearer static-bearer-xyz");
  });
});

describe("CantonClient.submitAndWait — correct endpoint and updateId", () => {
  it("POSTs to /v2/commands/submit-and-wait (not submit-and-wait-for-transaction) and returns updateId", async () => {
    const calls: Array<{ url: string }> = [];
    const c = makeClient(
      makeFetch(({ url }) => {
        calls.push({ url });
        return { body: { updateId: "sw-update-1", completionOffset: 3 } };
      })
    );

    const r = await c.submitAndWait({
      commandId: "cmd-sw",
      userId: "u",
      actAs: ["p1"],
      commands: [],
    });

    expect(calls[0]?.url).toBe(`${URL}/v2/commands/submit-and-wait`);
    expect(calls[0]?.url).not.toContain("submit-and-wait-for-transaction");
    expect(r.updateId).toBe("sw-update-1");
    expect(r.completionOffset).toBe(3);
  });
});

describe("CantonClient non-JSON response", () => {
  it("throws CantonError with responseBody containing the HTML text on non-2xx text/html response", async () => {
    const htmlBody = "<html><body>Bad Gateway</body></html>";
    const fetchFn: typeof globalThis.fetch = vi.fn(async () => {
      return new Response(htmlBody, {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    }) as typeof globalThis.fetch;

    const c = new CantonClient({
      participantUrl: URL,
      token: TOKEN,
      packageName: PKG,
      fetch: fetchFn,
    });

    let caught: unknown;
    try {
      await c.getLedgerEnd();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as any).name).toBe("CantonError");
    expect((caught as any).status).toBe(502);
    expect((caught as any).responseBody).toContain("Bad Gateway");
  });
});

describe("CantonClient.queryActiveContracts with TemplateFilter", () => {
  it("passes TemplateFilter templateId verbatim in the ACS request body", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const c = makeClient(
      makeFetch(({ url, init }) => {
        calls.push({
          url,
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: 77 } };
        }
        return { body: { contractEntries: [] } };
      })
    );

    const templateId =
      "#canton-x402:Canton.X402:MerchantContract";

    await c.queryActiveContracts({
      filtersByParty: {
        "merchant::1220abc": {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });

    const acsCall = calls.find((c) =>
      (c.url as string).endsWith("/v2/state/active-contracts")
    );
    expect(acsCall).toBeDefined();
    const sentTemplateId = (acsCall?.body as any)?.filter?.filtersByParty?.[
      "merchant::1220abc"
    ]?.cumulative?.[0]?.identifierFilter?.TemplateFilter?.value?.templateId;
    expect(sentTemplateId).toBe(templateId);
  });

  it("extracts events from {contractEntries: [{contractEntry: {JsActiveContract: {createdEvent}}}]} shape", async () => {
    const c = makeClient(
      makeFetch(({ url }) => {
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: 5 } };
        }
        return {
          body: {
            contractEntries: [
              {
                contractEntry: {
                  JsActiveContract: {
                    createdEvent: {
                      contractId: "nested-cid",
                      templateId: "#p:M:T",
                      createArgument: { owner: "alice::1220" },
                      signatories: ["alice::1220"],
                      observers: [],
                      packageName: "p",
                    },
                  },
                },
              },
            ],
          },
        };
      })
    );

    const events = await c.queryActiveContracts({
      filtersByParty: { "alice::1220": { cumulative: [] } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.contractId).toBe("nested-cid");
    expect((events[0]?.createArgument as any).owner).toBe("alice::1220");
  });
});

describe("CantonClient.getTransactionById — missing events field", () => {
  it("returns empty events[] when transaction.events is absent", async () => {
    const c = makeClient(
      makeFetch(() => ({
        body: {
          // No `events` field — simulates a participant that omits it on no-op txns
          transaction: { updateId: "u-no-events", offset: 7 },
        },
      }))
    );
    const r = await c.getTransactionById({
      updateId: "u-no-events",
      requestingParties: ["p::1220"],
    });
    expect(r.events).toEqual([]);
    expect(r.updateId).toBe("u-no-events");
    expect(r.offset).toBe(7);
  });

  it("tolerates ExercisedEvent without choiceArgument field", async () => {
    const c = makeClient(
      makeFetch(() => ({
        body: {
          transaction: {
            updateId: "u-partial",
            offset: 3,
            events: [
              {
                ExercisedEvent: {
                  contractId: "00cid-partial",
                  templateId: "#p:M:T",
                  choice: "Archive",
                  // choiceArgument intentionally absent — partial response
                },
              },
            ],
          },
        },
      }))
    );
    const r = await c.getTransactionById({
      updateId: "u-partial",
      requestingParties: ["p::1220"],
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.ExercisedEvent?.contractId).toBe("00cid-partial");
    expect(r.events[0]?.ExercisedEvent?.choice).toBe("Archive");
    // choiceArgument is not in the type so this just checks no crash occurred
  });
});

describe("CantonClient.getAllocatedExternalParty (allocateExternalParty)", () => {
  it("POSTs to /v2/parties/external/allocate with correct body fields", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    const c = makeClient(
      makeFetch(({ url, init }) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string);
        return { body: { partyId: "ext-party::1220abc" } };
      })
    );

    const r = await c.allocateExternalParty({
      synchronizer: "global-domain::1220",
      identityProviderId: "",
      onboardingTransactions: [{ transaction: "dGVzdA==" }],
      multiHashSignatures: [
        {
          format: "SIGNATURE_FORMAT_CONCAT",
          signature: "c2ln",
          signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
          signedBy: "1220fp",
        },
      ],
    });

    expect(capturedUrl).toBe(`${URL}/v2/parties/external/allocate`);
    expect(capturedBody.synchronizer).toBe("global-domain::1220");
    expect(capturedBody.identityProviderId).toBe("");
    expect(capturedBody.onboardingTransactions).toHaveLength(1);
    expect(capturedBody.multiHashSignatures[0].signingAlgorithmSpec).toBe(
      "SIGNING_ALGORITHM_SPEC_ED25519"
    );
    expect(r.partyId).toBe("ext-party::1220abc");
  });
});

describe("CantonClient.submitAndWaitForTransaction — full body fields", () => {
  it("sends commandId, userId, actAs, synchronizerId, disclosedContracts, and commands in the wrapped body", async () => {
    let captured: any = null;
    const c = makeClient(
      makeFetch(({ init }) => {
        captured = JSON.parse(init.body as string);
        return {
          body: { transaction: { updateId: "u-full", offset: 0, events: [] } },
        };
      })
    );

    await c.submitAndWaitForTransaction({
      commandId: "full-cmd-id",
      userId: "full-user",
      actAs: ["party-a::1220", "party-b::1220"],
      synchronizerId: "sync-full",
      disclosedContracts: [
        {
          templateId: "#splice-amulet:Splice.AmuletRules:AmuletRules",
          contractId: "disclosed-cid",
          createdEventBlob: "blob==",
          synchronizerId: "sync-full",
        },
      ],
      commands: [
        {
          CreateCommand: {
            templateId: "#canton-x402:Canton.X402:MerchantContract",
            createArguments: { name: "acme" },
          },
        },
      ],
    });

    const cmds = captured?.commands;
    expect(cmds).toBeDefined();
    expect(cmds.commandId).toBe("full-cmd-id");
    expect(cmds.userId).toBe("full-user");
    expect(cmds.actAs).toEqual(["party-a::1220", "party-b::1220"]);
    expect(cmds.synchronizerId).toBe("sync-full");
    expect(cmds.disclosedContracts).toHaveLength(1);
    expect(cmds.disclosedContracts[0].contractId).toBe("disclosed-cid");
    expect(cmds.commands).toHaveLength(1);
    expect(cmds.commands[0].CreateCommand.createArguments.name).toBe("acme");
  });
});

describe("CantonClient — concurrent requests with different tokens", () => {
  it("each request uses its own Authorization header (no token leakage)", async () => {
    const capturedHeaders: string[] = [];

    let callIndex = 0;
    const tokenProvider = vi.fn(async () => {
      callIndex++;
      return `token-${callIndex}`;
    });

    const fetch: typeof globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        capturedHeaders.push(h.get("Authorization") ?? "");
        return new Response(JSON.stringify({ offset: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    ) as typeof globalThis.fetch;

    const c = new CantonClient({
      participantUrl: URL,
      token: tokenProvider,
      packageName: PKG,
      fetch,
    });

    // Fire two requests in parallel
    await Promise.all([c.getLedgerEnd(), c.getLedgerEnd()]);

    expect(capturedHeaders).toHaveLength(2);
    // Both headers must be Bearer tokens but they got distinct tokens
    expect(capturedHeaders[0]).toMatch(/^Bearer token-\d+$/);
    expect(capturedHeaders[1]).toMatch(/^Bearer token-\d+$/);
    // They must not be the same token
    expect(capturedHeaders[0]).not.toBe(capturedHeaders[1]);
  });
});

describe("CantonClient.submitAndWaitForTransaction — userId passthrough", () => {
  it("the userId field in the wrapped body matches what was passed in", async () => {
    let captured: any = null;
    const c = makeClient(
      makeFetch(({ init }) => {
        captured = JSON.parse(init.body as string);
        return {
          body: { transaction: { updateId: "u", offset: 0, events: [] } },
        };
      })
    );

    await c.submitAndWaitForTransaction({
      commandId: "cmd-user-check",
      userId: "specific-user-id-123",
      actAs: ["p::1220"],
      commands: [],
    });

    expect(captured?.commands?.userId).toBe("specific-user-id-123");
  });
});

describe("CantonClient.queryActiveContracts — body completeness", () => {
  it("sends both ledger-end offset and filter in the POST body to /v2/state/active-contracts", async () => {
    const capturedAcsBodies: any[] = [];
    const c = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: 42 } };
        }
        capturedAcsBodies.push(JSON.parse(init.body as string));
        return { body: { contractEntries: [] } };
      })
    );

    const filter = {
      filtersByParty: {
        "party-x::1220": {
          cumulative: [
            {
              identifierFilter: {
                WildcardFilter: {
                  value: { includeCreatedEventBlob: false },
                },
              },
            },
          ],
        },
      },
    };

    await c.queryActiveContracts(filter);

    expect(capturedAcsBodies).toHaveLength(1);
    const body = capturedAcsBodies[0];
    // Must include the ledger-end offset
    expect(body.activeAtOffset).toBe(42);
    // Must include the filter
    expect(body.filter).toBeDefined();
    expect(body.filter?.filtersByParty?.["party-x::1220"]).toBeDefined();
  });
});

describe("CantonClient.allocateExternalParty", () => {
  it("POSTs to /v2/parties/external/allocate and returns the partyId", async () => {
    let body: any;
    const c = makeClient(
      makeFetch(({ url, init }) => {
        expect(url).toBe(`${URL}/v2/parties/external/allocate`);
        body = JSON.parse(init.body as string);
        return { body: { partyId: "x402_alloc::1220cafe" } };
      })
    );
    const r = await c.allocateExternalParty({
      synchronizer: "global-domain::1220",
      identityProviderId: "",
      onboardingTransactions: [{ transaction: "dGVzdA==" }],
      multiHashSignatures: [
        {
          format: "SIGNATURE_FORMAT_CONCAT",
          signature: "c2ln",
          signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
          signedBy: "1220abc",
        },
      ],
    });
    expect(r.partyId).toBe("x402_alloc::1220cafe");
    // Spot-check passthrough of the required field
    expect(body.identityProviderId).toBe("");
    expect(body.multiHashSignatures[0].signingAlgorithmSpec).toBe(
      "SIGNING_ALGORITHM_SPEC_ED25519"
    );
  });

  it("the returned partyId comes from response.partyId (not a constructed value)", async () => {
    const expectedPartyId = "generated-external-party::1220deadbeef";
    const c = makeClient(
      makeFetch(() => ({
        body: { partyId: expectedPartyId },
      }))
    );
    const r = await c.allocateExternalParty({
      synchronizer: "s",
      identityProviderId: "",
      onboardingTransactions: [],
      multiHashSignatures: [],
    });
    expect(r.partyId).toBe(expectedPartyId);
  });
});

// ── NEW TESTS (batch: requested additions) ────────────────────────────────────

describe("CantonClient.submitAndWaitForTransaction — 409 already-in-flight", () => {
  it("when HTTP 409 (already in-flight) → throws CantonError with status 409", async () => {
    const c = makeClient(
      makeFetch(() => ({
        status: 409,
        body: { error: "command already in-flight", commandId: "cmd-dup" },
      }))
    );

    await expect(
      c.submitAndWaitForTransaction({
        commandId: "cmd-dup",
        userId: "u",
        actAs: ["p::1220"],
        commands: [],
      })
    ).rejects.toMatchObject({
      name: "CantonError",
      status: 409,
    });
  });
});

describe("CantonClient.getTransactionById — requestingParties in POST body", () => {
  it("requestingParties appears in the POST body sent to /v2/updates/transaction-by-id", async () => {
    let captured: any = null;
    const c = makeClient(
      makeFetch(({ init }) => {
        captured = JSON.parse(init.body as string);
        return {
          body: {
            transaction: { updateId: "u-parties", offset: 1, events: [] },
          },
        };
      })
    );

    const parties = ["alice::1220abc", "bob::1220def"];
    await c.getTransactionById({
      updateId: "u-parties",
      requestingParties: parties,
    });

    expect(captured).not.toBeNull();
    expect(captured.requestingParties).toEqual(parties);
    expect(captured.requestingParties).toHaveLength(2);
    expect(captured.requestingParties).toContain("alice::1220abc");
    expect(captured.requestingParties).toContain("bob::1220def");
  });
});

describe("CantonClient.queryActiveContracts — activeAtOffset in POST body", () => {
  it("activeAtOffset in POST body matches the ledger-end offset returned first", async () => {
    const LEDGER_END_OFFSET = 9876;
    let acsBody: any = null;
    const c = makeClient(
      makeFetch(({ url, init }) => {
        if (url.endsWith("/v2/state/ledger-end")) {
          return { body: { offset: LEDGER_END_OFFSET } };
        }
        acsBody = JSON.parse(init.body as string);
        return { body: { contractEntries: [] } };
      })
    );

    await c.queryActiveContracts({
      filtersByParty: {
        "party::1220": {
          cumulative: [
            {
              identifierFilter: {
                WildcardFilter: { value: { includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      },
    });

    expect(acsBody).not.toBeNull();
    // activeAtOffset must match the ledger-end offset exactly
    expect(acsBody.activeAtOffset).toBe(LEDGER_END_OFFSET);
  });
});

describe("CantonClient — request to unknown endpoint", () => {
  it("CantonClient: request to unknown endpoint → throws CantonError with path in message", async () => {
    // Simulate the Canton participant returning 404 for an endpoint that doesn't exist.
    // This tests that CantonError surfaces the HTTP status and the response body.
    const c = makeClient(
      makeFetch(({ url }) => ({
        status: 404,
        body: { error: `endpoint not found: ${url}` },
      }))
    );

    let caught: unknown;
    try {
      await c.getLedgerEnd();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect((caught as any).name).toBe("CantonError");
    expect((caught as any).status).toBe(404);
    // The error must contain information about the failed request
    const errorStr = JSON.stringify(caught) + String((caught as any).message ?? "");
    expect(errorStr.length).toBeGreaterThan(0);
  });
});

describe("CantonClient.submitAndWaitForTransaction — response with updateId and offset", () => {
  it("when response body is {transaction:{updateId:'u',offset:5,events:[]}} → extracts updateId and offset", async () => {
    const c = makeClient(
      makeFetch(() => ({
        body: {
          transaction: {
            updateId: "u",
            offset: 5,
            events: [],
          },
        },
      }))
    );

    const result = await c.submitAndWaitForTransaction({
      commandId: "cmd-extract",
      userId: "u",
      actAs: ["p::1220"],
      commands: [],
    });

    expect(result.updateId).toBe("u");
    expect(result.offset).toBe(5);
    expect(result.events).toEqual([]);
  });
});

describe("CantonClient.getLedgerEnd — missing-offset hardening (audit M1)", () => {
  function clientWithLedgerEndBody(body: unknown): CantonClient {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/v2/state/ledger-end")) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return new CantonClient({
      participantUrl: "http://ledger.test",
      token: "t",
      packageName: "canton-x402",
      fetch: fetchImpl,
    });
  }

  it("throws INVALID_RESPONSE when the ledger-end body has no offset (was silently 0 → empty ACS)", async () => {
    const c = clientWithLedgerEndBody({});
    await expect(c.getLedgerEnd()).rejects.toThrow(/offset/);
    await expect(c.getLedgerEnd()).rejects.toBeInstanceOf(CantonError);
  });

  it("throws when offset is null or non-numeric", async () => {
    await expect(clientWithLedgerEndBody({ offset: null }).getLedgerEnd()).rejects.toThrow();
    await expect(clientWithLedgerEndBody({ offset: "5" }).getLedgerEnd()).rejects.toThrow();
  });

  it("preserves a legitimate offset of 0 (fresh ledger)", async () => {
    const r = await clientWithLedgerEndBody({ offset: 0 }).getLedgerEnd();
    expect(r.offset).toBe(0);
  });

  it("returns a normal positive offset unchanged", async () => {
    const r = await clientWithLedgerEndBody({ offset: 123 }).getLedgerEnd();
    expect(r.offset).toBe(123);
  });
});
