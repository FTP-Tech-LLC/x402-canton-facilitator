import { describe, it, expect, vi } from "vitest";
import { CantonClient, CantonError } from "./client.js";
import {
  CIP56_INTERFACE_IDS,
  CIP56_TEMPLATE_SUFFIXES,
  CIP56_CHOICES,
  findCip56TransferInstruction,
  projectToCip56,
} from "./cip56.js";

const FAC = "ftp_facilitator::1220abc";

// ---------------------------------------------------------------------------
// Local replica of Cip56InstructionService.findCompleted
// (the real implementation lives in packages/facilitator which is outside
// the ledger package's dependency graph — we replicate it here verbatim so
// the tests exercise the real algorithm without a cross-package import).
// ---------------------------------------------------------------------------
interface Cip56CompletedHolding {
  owner: string;
  instrumentAdmin: string;
  amount: string;
  instrumentId?: string;
}

async function findCompleted(
  client: CantonClient,
  facilitatorParty: string,
  updateId: string
): Promise<Cip56CompletedHolding[] | null> {
  let tx: Awaited<ReturnType<typeof client.getTransactionById>>;
  try {
    tx = await client.getTransactionById({
      updateId,
      requestingParties: [facilitatorParty],
    });
  } catch {
    return null;
  }

  const holdings: Cip56CompletedHolding[] = [];

  for (const ev of tx.events) {
    const created = ev.CreatedEvent;
    if (!created) continue;

    // 1. Try HoldingV1 interfaceViews (canonical CIP-56 path).
    //    Real Splice `Splice.Api.Token.HoldingV1:HoldingView` shape:
    //    { owner: Party, instrumentId: {admin,id}, amount: Decimal, ... }
    //    — owner/amount are top-level; lock.holders are escrow holders,
    //    NOT the owner. (Mirrors the corrected parser in
    //    packages/facilitator/src/canton/cip56-instruction.ts.)
    const holdingView = (
      created.interfaceViews as Array<{
        interfaceId?: string;
        viewValue?: {
          owner?: string;
          amount?: string;
          instrumentId?: { admin?: string; id?: string };
        };
      }> | undefined
    )?.find((v) => v.interfaceId?.includes("HoldingV1"));

    const vv = holdingView?.viewValue;
    if (vv) {
      const owner = vv.owner;
      const amount = vv.amount;
      const admin = vv.instrumentId?.admin;
      const tokenId = vv.instrumentId?.id;
      if (
        typeof owner === "string" &&
        typeof amount === "string" &&
        typeof admin === "string"
      ) {
        const h: Cip56CompletedHolding = {
          owner,
          instrumentAdmin: admin,
          amount,
        };
        if (typeof tokenId === "string") h.instrumentId = tokenId;
        holdings.push(h);
        continue;
      }
    }

    // 2. Fallback: createArgument {owner, issuer, amount} (TestToken).
    const arg = created.createArgument as {
      owner?: unknown;
      issuer?: unknown;
      amount?: unknown;
    } | null | undefined;
    if (
      arg &&
      typeof arg.owner === "string" &&
      typeof arg.issuer === "string" &&
      typeof arg.amount === "string"
    ) {
      holdings.push({
        owner: arg.owner,
        instrumentAdmin: arg.issuer,
        amount: arg.amount,
      });
    }
  }

  return holdings.length > 0 ? holdings : null;
}

describe("CIP-56 constants — additional", () => {
  it("CIP56_INTERFACE_IDS.holdingV1 hash is 64 hex chars (valid sha256)", () => {
    // A SHA-256 package hash is always exactly 64 lowercase hex characters.
    // Guards against copy-paste truncation or wrong-length substitution.
    const hash = CIP56_INTERFACE_IDS.holdingV1;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("CIP-56 constants", () => {
  it("transferInstructionV1 package hash matches the Splice 0.5.3 DAR", () => {
    // From `splice-api-token-transfer-instruction-v1-1.0.0` DAR
    // filename inside the splice container. Pinning this ensures
    // a forward-compatible Splice upgrade doesn't silently change
    // our wire shape; the hash will need an explicit bump.
    expect(CIP56_INTERFACE_IDS.transferInstructionV1).toBe(
      "55ba4deb0ad4662c4168b39859738a0e91388d252286480c7331b3f71a517281"
    );
  });

  it("holdingV1 package hash matches the Splice 0.5.3 DAR", () => {
    expect(CIP56_INTERFACE_IDS.holdingV1).toBe(
      "718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b"
    );
  });

  it("template suffixes target the v1 interface modules", () => {
    expect(CIP56_TEMPLATE_SUFFIXES.transferInstruction).toBe(
      ":Splice.Api.Token.TransferInstructionV1:TransferInstruction"
    );
    expect(CIP56_TEMPLATE_SUFFIXES.transferFactory).toBe(
      ":Splice.Api.Token.TransferInstructionV1:TransferFactory"
    );
    expect(CIP56_TEMPLATE_SUFFIXES.holding).toBe(
      ":Splice.Api.Token.HoldingV1:Holding"
    );
  });

  it("choice names match the interface declarations", () => {
    expect(CIP56_CHOICES.transferFactoryTransfer).toBe(
      "TransferFactory_Transfer"
    );
    expect(CIP56_CHOICES.transferInstructionAccept).toBe(
      "TransferInstruction_Accept"
    );
  });
});

describe("projectToCip56", () => {
  it("handles empty inputHoldingCids array — should be empty array not undefined", () => {
    const event = {
      contractId: "00empty",
      templateId:
        "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "agent::1220",
          receiver: "merchant::1220",
          amount: "10.00",
          instrumentId: { admin: "issuer::1220", id: "USDC" },
          requestedAt: "2026-05-24T00:00:00Z",
          executeBefore: "2026-05-24T01:00:00Z",
          inputHoldingCids: [],
          meta: { values: {} },
        },
        status: { tag: "TransferPendingInternalWorkflow" },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.transfer.inputHoldingCids).toEqual([]);
    expect(Array.isArray(v.transfer.inputHoldingCids)).toBe(true);
  });

  it("handles Map Text Text encoded as array-of-pairs (legacy format) for meta.values", () => {
    const event = {
      contractId: "00pairs",
      templateId:
        "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "agent::1220",
          receiver: "merchant::1220",
          amount: "5.00",
          instrumentId: { admin: "issuer::1220", id: "USDC" },
          requestedAt: "2026-05-24T00:00:00Z",
          executeBefore: "2026-05-24T01:00:00Z",
          inputHoldingCids: [],
          // Legacy: Canton may send Map Text Text as array of [k, v] pairs
          meta: { values: [["order", "ord-123"], ["ref", "ref-456"]] },
        },
        status: { tag: "TransferPendingInternalWorkflow" },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    // Must be normalized to plain object regardless of wire format
    expect(v.transfer.meta.values).toEqual({ order: "ord-123", ref: "ref-456" });
  });

  it("TransferPendingInternalWorkflow tag — maps correctly including pendingActions as object", () => {
    const event = {
      contractId: "00wi",
      templateId:
        "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "a",
          receiver: "b",
          amount: "1.00",
          instrumentId: { admin: "i", id: "X" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: [],
          meta: { values: {} },
        },
        status: {
          tag: "TransferPendingInternalWorkflow",
          pendingActions: { "registry::1220": "accept" },
        },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.status.tag).toBe("TransferPendingInternalWorkflow");
    expect(
      (v.status as { tag: "TransferPendingInternalWorkflow"; pendingActions: Record<string, string> })
        .pendingActions
    ).toEqual({ "registry::1220": "accept" });
  });

  it("TransferPendingInternalWorkflow pendingActions as array-of-pairs (legacy) normalizes to object", () => {
    const event = {
      contractId: "00wipairs",
      templateId:
        "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "a",
          receiver: "b",
          amount: "1.00",
          instrumentId: { admin: "i", id: "X" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: [],
          meta: { values: {} },
        },
        status: {
          tag: "TransferPendingInternalWorkflow",
          pendingActions: [["registry::1220", "review"]],
        },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.status.tag).toBe("TransferPendingInternalWorkflow");
    expect(
      (v.status as { tag: "TransferPendingInternalWorkflow"; pendingActions: Record<string, string> })
        .pendingActions
    ).toEqual({ "registry::1220": "review" });
  });

  it("extracts the transfer + status view fields", () => {
    const event = {
      contractId: "00inst",
      templateId:
        "issuer-pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "agent::1220",
          receiver: "merchant::1220",
          amount: "50.00",
          instrumentId: { admin: "issuer::1220", id: "USDC" },
          requestedAt: "2026-05-24T19:00:00Z",
          executeBefore: "2026-05-24T19:02:00Z",
          inputHoldingCids: ["00hold1"],
          meta: { values: { k: "v" } },
        },
        status: { tag: "TransferPendingReceiverAcceptance" },
      },
      signatories: [],
      observers: [],
      packageName: "issuer-pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.contractId).toBe("00inst");
    expect(v.transfer.amount).toBe("50.00");
    expect(v.transfer.instrumentId.id).toBe("USDC");
    expect(v.transfer.inputHoldingCids).toEqual(["00hold1"]);
    expect(v.status.tag).toBe("TransferPendingReceiverAcceptance");
  });

  it("tolerates missing fields with sane defaults", () => {
    const v = projectToCip56({
      contractId: "00x",
      templateId: "x:y:z",
      createArgument: {},
      signatories: [],
      observers: [],
      packageName: "x",
    } as any);
    expect(v.transfer.sender).toBe("");
    expect(v.transfer.instrumentId).toEqual({ admin: "", id: "" });
    expect(v.status.tag).toBe("TransferPendingInternalWorkflow");
  });

  it("meta with no values field → defaults to { values: {} }", () => {
    // When transfer.meta exists but has no values key, normalizeDamlMap
    // receives undefined and should return an empty object.
    const event = {
      contractId: "00nometa",
      templateId:
        "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "agent::1220",
          receiver: "merchant::1220",
          amount: "1.00",
          instrumentId: { admin: "issuer::1220", id: "USDC" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: [],
          meta: {}, // no values key
        },
        status: { tag: "TransferPendingInternalWorkflow" },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.transfer.meta).toEqual({ values: {} });
  });

  it("transfer with all 8 required fields present in output", () => {
    // Ensures projectToCip56 maps every field from the wire shape —
    // a missing field surfaces immediately rather than silently defaulting.
    const event = {
      contractId: "00full",
      templateId:
        "issuer:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "sender::1220",
          receiver: "receiver::1220",
          amount: "42.00",
          instrumentId: { admin: "admin::1220", id: "TOKEN" },
          requestedAt: "2026-06-01T10:00:00Z",
          executeBefore: "2026-06-01T11:00:00Z",
          inputHoldingCids: ["00hold1", "00hold2"],
          meta: { values: { key1: "val1" } },
        },
        status: { tag: "TransferPendingReceiverAcceptance" },
      },
      signatories: [],
      observers: [],
      packageName: "issuer",
    };
    const v = projectToCip56(event as any);
    const t = v.transfer;
    expect(t.sender).toBe("sender::1220");
    expect(t.receiver).toBe("receiver::1220");
    expect(t.amount).toBe("42.00");
    expect(t.instrumentId).toEqual({ admin: "admin::1220", id: "TOKEN" });
    expect(t.requestedAt).toBe("2026-06-01T10:00:00Z");
    expect(t.executeBefore).toBe("2026-06-01T11:00:00Z");
    expect(t.inputHoldingCids).toEqual(["00hold1", "00hold2"]);
    expect(t.meta).toEqual({ values: { key1: "val1" } });
  });

  it("status with different tag value round-trips correctly", () => {
    // TransferPendingReceiverAcceptance has no pendingActions field —
    // the discriminated union must map correctly.
    const event = {
      contractId: "00rtag",
      templateId:
        "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "a",
          receiver: "b",
          amount: "1.00",
          instrumentId: { admin: "i", id: "X" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: [],
          meta: { values: {} },
        },
        status: { tag: "TransferPendingReceiverAcceptance" },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.status.tag).toBe("TransferPendingReceiverAcceptance");
    // The ReceiverAcceptance branch must NOT carry pendingActions
    expect((v.status as any).pendingActions).toBeUndefined();
  });
});

describe("findCip56TransferInstruction", () => {
  function makeClientCapture(events: any[]): { client: CantonClient; capturedBody: () => any } {
    let lastBody: any = null;
    const client = new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        if (init?.body) {
          lastBody = JSON.parse(init.body as string);
        }
        return new Response(
          JSON.stringify({
            contractEntries: events.map((e) => ({
              contractEntry: { JsActiveContract: { createdEvent: e } },
            })),
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });
    return { client, capturedBody: () => lastBody };
  }

  function makeClient(events: any[]): CantonClient {
    return makeClientCapture(events).client;
  }

  it("InterfaceFilter's interfaceId contains the CIP56_INTERFACE_IDS.transferInstructionV1 hash", async () => {
    // Regression: if the hash is wrong or missing, the filter targets the
    // wrong interface and the ledger returns empty results silently.
    const { client, capturedBody } = makeClientCapture([]);
    await findCip56TransferInstruction(client, FAC, "00any");

    const body = capturedBody();
    const partyFilters = body.filter?.filtersByParty ?? {};
    const cumulative: any[] = Object.values(partyFilters).flatMap(
      (f: any) => f.cumulative ?? []
    );
    const interfaceFilters = cumulative
      .map((f: any) => f.identifierFilter?.InterfaceFilter?.value)
      .filter(Boolean);
    expect(interfaceFilters.length).toBeGreaterThan(0);
    // Every InterfaceFilter must reference the known Splice 0.5.3 hash
    for (const ifv of interfaceFilters) {
      expect(ifv.interfaceId).toContain(CIP56_INTERFACE_IDS.transferInstructionV1);
    }
  });

  it("returns null when multiple contracts are in the ACS but none match the target cid", async () => {
    // Verifies the search is by cid equality, not "first result"
    const c = makeClient([
      {
        contractId: "00contract-a",
        templateId:
          "issuer:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        createArgument: { transfer: { sender: "a" }, status: { tag: "TransferPendingInternalWorkflow" } },
        signatories: [],
        observers: [],
        packageName: "issuer",
      },
      {
        contractId: "00contract-b",
        templateId:
          "issuer:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        createArgument: { transfer: { sender: "b" }, status: { tag: "TransferPendingInternalWorkflow" } },
        signatories: [],
        observers: [],
        packageName: "issuer",
      },
      {
        contractId: "00contract-c",
        templateId:
          "issuer:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        createArgument: { transfer: { sender: "c" }, status: { tag: "TransferPendingInternalWorkflow" } },
        signatories: [],
        observers: [],
        packageName: "issuer",
      },
    ]);
    // None of the three contracts have cid "00target"
    expect(await findCip56TransferInstruction(c, FAC, "00target")).toBeNull();
  });

  it("uses InterfaceFilter (not WildcardFilter) in the ACS query", async () => {
    // Regression guard: using WildcardFilter on a busy DevNet
    // network returns 200+ contracts and hits the Canton 413 limit.
    // The implementation must use InterfaceFilter scoped to the
    // TransferInstructionV1 interface.
    const { client, capturedBody } = makeClientCapture([]);
    await findCip56TransferInstruction(client, FAC, "00any");

    const body = capturedBody();
    expect(body).not.toBeNull();
    // The CantonClient posts { filter, verbose, activeAtOffset } to
    // /v2/state/active-contracts. Drill into filter.filtersByParty.
    const partyFilters = body.filter?.filtersByParty ?? {};
    const cumulative: any[] = Object.values(partyFilters).flatMap(
      (f: any) => f.cumulative ?? []
    );
    expect(cumulative.length).toBeGreaterThan(0);
    const hasWildcard = cumulative.some((f: any) => "WildcardFilter" in (f.identifierFilter ?? {}));
    const hasInterface = cumulative.some((f: any) => "InterfaceFilter" in (f.identifierFilter ?? {}));
    expect(hasWildcard).toBe(false);
    expect(hasInterface).toBe(true);
  });

  it("returns null when TransferInstruction cid is not in ACS results (cid mismatch)", async () => {
    // ACS returns a valid TransferInstruction, but with a different cid
    const c = makeClient([
      {
        contractId: "00different-cid",
        templateId:
          "issuer:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        createArgument: {
          transfer: { sender: "agent::1220" },
          status: { tag: "TransferPendingInternalWorkflow" },
        },
        signatories: [],
        observers: [],
        packageName: "issuer",
      },
    ]);
    // We're asking for "00wanted" but ACS only has "00different-cid"
    expect(await findCip56TransferInstruction(c, FAC, "00wanted")).toBeNull();
  });

  it("skips results whose templateId suffix does not match TransferInstruction (defence-in-depth)", async () => {
    // InterfaceFilter should prevent this in production, but in case
    // the ledger returns a stale/mis-routed contract we skip it.
    const c = makeClient([
      {
        contractId: "00wanted",
        // Same cid, but wrong template suffix — not a TransferInstruction
        templateId: "issuer:Splice.Api.Token.HoldingV1:Holding",
        createArgument: { transfer: { sender: "agent::1220" } },
        signatories: [],
        observers: [],
        packageName: "issuer",
      },
    ]);
    expect(await findCip56TransferInstruction(c, FAC, "00wanted")).toBeNull();
  });

  it("returns the projected view when the cid matches a TransferInstruction", async () => {
    const c = makeClient([
      {
        contractId: "00other",
        templateId:
          "abc:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        createArgument: { transfer: { sender: "x" } },
        signatories: [],
        observers: [],
        packageName: "abc",
      },
      {
        contractId: "00wanted",
        templateId:
          "issuer:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        createArgument: {
          transfer: {
            sender: "agent::1220",
            receiver: "merchant::1220",
            amount: "25.00",
            instrumentId: { admin: "issuer::1220", id: "USDC" },
            requestedAt: "2026-05-24T00:00:00Z",
            executeBefore: "2026-05-24T01:00:00Z",
            inputHoldingCids: [],
            meta: { values: {} },
          },
          status: { tag: "TransferPendingInternalWorkflow", pendingActions: {} },
        },
        signatories: [],
        observers: [],
        packageName: "issuer",
      },
    ]);
    const r = await findCip56TransferInstruction(c, FAC, "00wanted");
    expect(r).not.toBeNull();
    expect(r?.contractId).toBe("00wanted");
    expect(r?.transfer.amount).toBe("25.00");
    expect(r?.transfer.instrumentId.id).toBe("USDC");
  });

  it("skips contracts whose templateId is NOT a TransferInstruction", async () => {
    const c = makeClient([
      {
        contractId: "00wrong",
        templateId: "abc:Splice.Amulet:Amulet", // an amulet, not a TI
        createArgument: {},
        signatories: [],
        observers: [],
        packageName: "abc",
      },
    ]);
    expect(await findCip56TransferInstruction(c, FAC, "00wrong")).toBeNull();
  });

  it("returns null when the cid is not in the ACS", async () => {
    const c = makeClient([]);
    expect(await findCip56TransferInstruction(c, FAC, "00missing")).toBeNull();
  });

  it("the queryActiveContracts call includes facilitatorParty as the key in filtersByParty", async () => {
    // Guards that the filter is scoped to the correct party so the
    // facilitator can observe the instruction (it must be a stakeholder).
    const { client, capturedBody } = makeClientCapture([]);
    await findCip56TransferInstruction(client, FAC, "00any");

    const body = capturedBody();
    const partyKeys = Object.keys(body.filter?.filtersByParty ?? {});
    expect(partyKeys).toContain(FAC);
  });

  it("contract matching cid but wrong templateId suffix → skipped (returns null)", async () => {
    // Defence-in-depth: if the ledger returns an event whose cid matches
    // but whose templateId is not a TransferInstruction, the implementation
    // must skip it and return null. This overlaps with the existing
    // "templateId suffix does not match" test but explicitly checks both
    // conditions (cid match AND wrong suffix) together to confirm the cid
    // check alone is not sufficient for a positive result.
    const c = makeClient([
      {
        contractId: "00wanted",
        // cid matches, but templateId ends with HoldingV1:Holding (wrong suffix)
        templateId: "issuer:Splice.Api.Token.HoldingV1:Holding",
        createArgument: {
          transfer: { sender: "agent::1220" },
          status: { tag: "TransferPendingInternalWorkflow" },
        },
        signatories: [],
        observers: [],
        packageName: "issuer",
      },
    ]);
    expect(await findCip56TransferInstruction(c, FAC, "00wanted")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findCompleted tests
// ---------------------------------------------------------------------------

function makeGetTxClient(
  txEvents: Array<{
    CreatedEvent?: any;
    ExercisedEvent?: any;
    ArchivedEvent?: any;
  }>
): CantonClient {
  return new CantonClient({
    participantUrl: "http://canton.test",
    token: "t",
    packageName: "canton-x402",
    fetch: vi.fn(async () => {
      return new Response(
        JSON.stringify({
          transaction: {
            updateId: "u-completed",
            offset: 1,
            events: txEvents,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch,
  });
}

describe("findCip56TransferInstruction — additional coverage", () => {
  function makeClient(events: any[]): CantonClient {
    return new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            contractEntries: events.map((e) => ({
              contractEntry: { JsActiveContract: { createdEvent: e } },
            })),
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });
  }

  it("findCip56TransferInstruction: returns null when ACS response is empty object {}", async () => {
    // Some Canton versions may return {} instead of { contractEntries: [] }
    // when the ACS has no matching contracts. The implementation must not throw.
    const client = new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        // Empty object response — no contractEntries key
        return new Response(JSON.stringify({}), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const result = await findCip56TransferInstruction(client, FAC, "00any-cid");
    expect(result).toBeNull();
  });

  it("projectToCip56: when transfer.inputHoldingCids has 3 elements → all 3 preserved", () => {
    const event = {
      contractId: "00three-holdings",
      templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "a",
          receiver: "b",
          amount: "1.00",
          instrumentId: { admin: "i", id: "X" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: ["00hold1", "00hold2", "00hold3"],
          meta: { values: {} },
        },
        status: { tag: "TransferPendingInternalWorkflow" },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.transfer.inputHoldingCids).toHaveLength(3);
    expect(v.transfer.inputHoldingCids).toEqual(["00hold1", "00hold2", "00hold3"]);
  });

  it("CIP56_CHOICES.transferFactoryTransfer equals 'TransferFactory_Transfer'", () => {
    expect(CIP56_CHOICES.transferFactoryTransfer).toBe("TransferFactory_Transfer");
  });

  it("CIP56_TEMPLATE_SUFFIXES.holding ends with ':Holding'", () => {
    expect(CIP56_TEMPLATE_SUFFIXES.holding).toMatch(/:Holding$/);
  });

  it("findCip56TransferInstruction: contract with matching cid and correct suffix → returns the contract data", async () => {
    const WANTED_CID = "00exactly-matching-cid";
    const c = makeClient([
      {
        contractId: WANTED_CID,
        templateId: "issuer-pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
        createArgument: {
          transfer: {
            sender: "agent::1220",
            receiver: "merchant::1220",
            amount: "77.00",
            instrumentId: { admin: "issuer::1220", id: "USDC" },
            requestedAt: "2026-05-29T00:00:00Z",
            executeBefore: "2026-05-29T01:00:00Z",
            inputHoldingCids: [],
            meta: { values: {} },
          },
          status: { tag: "TransferPendingInternalWorkflow", pendingActions: {} },
        },
        signatories: [],
        observers: [],
        packageName: "issuer-pkg",
      },
    ]);

    const result = await findCip56TransferInstruction(c, FAC, WANTED_CID);
    expect(result).not.toBeNull();
    expect(result?.contractId).toBe(WANTED_CID);
    expect(result?.transfer.amount).toBe("77.00");
  });
});

describe("CIP56_TEMPLATE_SUFFIXES — suffix shape guarantees", () => {
  it("CIP56_TEMPLATE_SUFFIXES.transferFactory ends with ':TransferFactory'", () => {
    expect(CIP56_TEMPLATE_SUFFIXES.transferFactory).toMatch(/:TransferFactory$/);
  });

  it("CIP56_TEMPLATE_SUFFIXES.transferInstruction ends with ':TransferInstruction'", () => {
    expect(CIP56_TEMPLATE_SUFFIXES.transferInstruction).toMatch(/:TransferInstruction$/);
  });

  it("projectToCip56: status.tag is preserved in the status field output", () => {
    const tag = "TransferPendingReceiverAcceptance";
    const event = {
      contractId: "00tag-preserved",
      templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "a",
          receiver: "b",
          amount: "1.00",
          instrumentId: { admin: "i", id: "X" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: [],
          meta: { values: {} },
        },
        status: { tag },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.status.tag).toBe(tag);
  });

  it("findCip56TransferInstruction: when called with empty cid string → returns null (no match)", async () => {
    const client = new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            contractEntries: [
              {
                contractEntry: {
                  JsActiveContract: {
                    createdEvent: {
                      contractId: "00some-real-cid",
                      templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
                      createArgument: {
                        transfer: {
                          sender: "a",
                          receiver: "b",
                          amount: "1.00",
                          instrumentId: { admin: "i", id: "X" },
                          requestedAt: "2026-01-01T00:00:00Z",
                          executeBefore: "2026-01-01T01:00:00Z",
                          inputHoldingCids: [],
                          meta: { values: {} },
                        },
                        status: { tag: "TransferPendingInternalWorkflow" },
                      },
                      signatories: [],
                      observers: [],
                      packageName: "pkg",
                    },
                  },
                },
              },
            ],
          }),
          { status: 200 }
        );
      }) as typeof globalThis.fetch,
    });
    // Empty string cid will not match "00some-real-cid"
    const result = await findCip56TransferInstruction(client, FAC, "");
    expect(result).toBeNull();
  });

  it("projectToCip56: meta.values as empty object → { values: {} } preserved", () => {
    const event = {
      contractId: "00meta-empty",
      templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "a",
          receiver: "b",
          amount: "1.00",
          instrumentId: { admin: "i", id: "X" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: [],
          meta: { values: {} },
        },
        status: { tag: "TransferPendingInternalWorkflow" },
      },
      signatories: [],
      observers: [],
      packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.transfer.meta).toEqual({ values: {} });
    expect(v.transfer.meta.values).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Completeness round (batch 4) — additional targeted tests
// ---------------------------------------------------------------------------

describe("CIP56 constants and findCip56TransferInstruction — completeness round (batch 4)", () => {
  it("CIP56_INTERFACE_IDS: both keys are lowercase hex strings (no uppercase)", () => {
    // Canton package hashes are always lowercase hex. Uppercase chars
    // would cause the InterfaceFilter to silently miss all matching contracts.
    expect(CIP56_INTERFACE_IDS.transferInstructionV1).toMatch(/^[0-9a-f]+$/);
    expect(CIP56_INTERFACE_IDS.holdingV1).toMatch(/^[0-9a-f]+$/);
    // Sanity: neither contains any uppercase letter
    expect(CIP56_INTERFACE_IDS.transferInstructionV1).toBe(
      CIP56_INTERFACE_IDS.transferInstructionV1.toLowerCase()
    );
    expect(CIP56_INTERFACE_IDS.holdingV1).toBe(
      CIP56_INTERFACE_IDS.holdingV1.toLowerCase()
    );
  });

  it("findCip56TransferInstruction: result contractId matches the input cid exactly", async () => {
    const EXACT_CID = "00exact-contractid-match-cid";
    const client = new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        return new Response(JSON.stringify({
          contractEntries: [{
            contractEntry: {
              JsActiveContract: {
                createdEvent: {
                  contractId: EXACT_CID,
                  templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
                  createArgument: {
                    transfer: {
                      sender: "a", receiver: "b", amount: "1.00",
                      instrumentId: { admin: "i", id: "X" },
                      requestedAt: "2026-01-01T00:00:00Z",
                      executeBefore: "2026-01-01T01:00:00Z",
                      inputHoldingCids: [], meta: { values: {} },
                    },
                    status: { tag: "TransferPendingInternalWorkflow", pendingActions: {} },
                  },
                  signatories: [], observers: [], packageName: "pkg",
                },
              },
            },
          }],
        }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    const result = await findCip56TransferInstruction(client, FAC, EXACT_CID);
    expect(result).not.toBeNull();
    // contractId in result must exactly match what we searched for
    expect(result?.contractId).toBe(EXACT_CID);
  });

  it("projectToCip56: when transfer has 5 inputHoldingCids → all 5 preserved", () => {
    const holdingCids = ["00h1", "00h2", "00h3", "00h4", "00h5"];
    const event = {
      contractId: "00five-holdings",
      templateId: "pkg:Splice.Api.Token.TransferInstructionV1:TransferInstruction",
      createArgument: {
        transfer: {
          sender: "a", receiver: "b", amount: "5.00",
          instrumentId: { admin: "i", id: "X" },
          requestedAt: "2026-01-01T00:00:00Z",
          executeBefore: "2026-01-01T01:00:00Z",
          inputHoldingCids: holdingCids,
          meta: { values: {} },
        },
        status: { tag: "TransferPendingInternalWorkflow" },
      },
      signatories: [], observers: [], packageName: "pkg",
    };
    const v = projectToCip56(event as any);
    expect(v.transfer.inputHoldingCids).toHaveLength(5);
    expect(v.transfer.inputHoldingCids).toEqual(holdingCids);
  });

  it("CIP56_CHOICES: all values are non-empty strings", () => {
    for (const [key, value] of Object.entries(CIP56_CHOICES)) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it("findCip56TransferInstruction: ACS query uses facilitatorParty as the top-level party key", async () => {
    const SPECIFIC_FAC = "specific-facilitator::1220sf";
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v2/state/ledger-end")) {
          return new Response(JSON.stringify({ offset: 1 }), { status: 200 });
        }
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ contractEntries: [] }), { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await findCip56TransferInstruction(client, SPECIFIC_FAC, "00any");
    expect(capturedBody).not.toBeNull();
    // The filtersByParty object must use the facilitatorParty as its key
    const partyKeys = Object.keys(capturedBody.filter?.filtersByParty ?? {});
    expect(partyKeys).toContain(SPECIFIC_FAC);
  });
});

describe("findCompleted", () => {
  it("calls getTransactionById with the provided updateId and facilitatorParty as requestingParty", async () => {
    let capturedBody: any = null;
    const client = new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(
          JSON.stringify({
            transaction: { updateId: "u-1", offset: 0, events: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof globalThis.fetch,
    });

    await findCompleted(client, FAC, "u-1");

    expect(capturedBody.updateId).toBe("u-1");
    expect(capturedBody.requestingParties).toEqual([FAC]);
    expect(capturedBody.transactionShape).toBe("TRANSACTION_SHAPE_LEDGER_EFFECTS");
  });

  it("returns null when getTransactionById throws (transaction not visible)", async () => {
    const client = new CantonClient({
      participantUrl: "http://canton.test",
      token: "t",
      packageName: "canton-x402",
      fetch: vi.fn(async () => {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof globalThis.fetch,
    });

    const result = await findCompleted(client, FAC, "u-missing");
    expect(result).toBeNull();
  });

  it("extracts holdings from CreatedEvent createArgument {owner, issuer, amount}", async () => {
    const client = makeGetTxClient([
      {
        CreatedEvent: {
          contractId: "00holding-rcv",
          templateId: "x:y:Holding",
          createArgument: {
            owner: "merchant::1220",
            issuer: "issuer::1220",
            amount: "25.00",
          },
          signatories: ["merchant::1220"],
          observers: [],
          packageName: "x",
        },
      },
    ]);

    const result = await findCompleted(client, FAC, "u-completed");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].owner).toBe("merchant::1220");
    expect(result![0].instrumentAdmin).toBe("issuer::1220");
    expect(result![0].amount).toBe("25.00");
  });

  it("returns null when no CreatedEvents have owner/issuer/amount fields (all ArchivedEvents)", async () => {
    const client = makeGetTxClient([
      {
        ArchivedEvent: {
          contractId: "00holding-spent",
          templateId: "x:y:Holding",
        },
      },
      {
        ArchivedEvent: {
          contractId: "00holding-spent-2",
          templateId: "x:y:Holding",
        },
      },
    ]);

    const result = await findCompleted(client, FAC, "u-archived-only");
    expect(result).toBeNull();
  });

  it("populates instrumentId from HoldingV1 interfaceView when present", async () => {
    const client = makeGetTxClient([
      {
        CreatedEvent: {
          contractId: "00holding-cip56",
          templateId: "x:HoldingV1:Holding",
          createArgument: {},
          signatories: [],
          observers: [],
          packageName: "x",
          interfaceViews: [
            {
              interfaceId:
                "718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding",
              viewValue: {
                owner: "merchant::1220",
                amount: "50.00",
                instrumentId: { admin: "issuer::1220", id: "USDC" },
              },
            },
          ],
        },
      },
    ]);

    const result = await findCompleted(client, FAC, "u-holdingv1");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].owner).toBe("merchant::1220");
    expect(result![0].instrumentAdmin).toBe("issuer::1220");
    expect(result![0].amount).toBe("50.00");
    expect(result![0].instrumentId).toBe("USDC");
  });

  it("returns multiple holdings from one transaction (receiver + change)", async () => {
    const client = makeGetTxClient([
      {
        ExercisedEvent: {
          contractId: "00factory",
          templateId: "x:y:TF",
          choice: "TransferFactory_Transfer",
        },
      },
      {
        ArchivedEvent: {
          contractId: "00holding-sender-old",
          templateId: "x:y:Holding",
        },
      },
      {
        CreatedEvent: {
          contractId: "00holding-receiver",
          templateId: "x:y:Holding",
          createArgument: {
            owner: "merchant::1220",
            issuer: "issuer::1220",
            amount: "25.00",
          },
          signatories: [],
          observers: [],
          packageName: "x",
        },
      },
      {
        CreatedEvent: {
          contractId: "00holding-change",
          templateId: "x:y:Holding",
          createArgument: {
            owner: "sender::1220",
            issuer: "issuer::1220",
            amount: "75.00",
          },
          signatories: [],
          observers: [],
          packageName: "x",
        },
      },
    ]);

    const result = await findCompleted(client, FAC, "u-multi-holdings");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);

    const rcv = result!.find((h) => h.owner === "merchant::1220");
    const change = result!.find((h) => h.owner === "sender::1220");
    expect(rcv).toBeDefined();
    expect(rcv!.amount).toBe("25.00");
    expect(change).toBeDefined();
    expect(change!.amount).toBe("75.00");
  });
});
