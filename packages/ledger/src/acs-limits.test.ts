import { describe, it, expect, vi } from "vitest";
import {
  ACS_DEFAULT_LIST_LIMIT,
  MAX_TRANSFER_INPUTS_AMULET,
  MAX_TRANSFER_INPUTS_REGISTRY,
  isAcsLimitExceeded,
  queryActiveContractsBounded,
} from "./acs-limits.js";
import { CantonError } from "./client.js";

const filter = { filtersByParty: { "p::1": { cumulative: [] } } };
const ev = (cid: string) => ({ contractId: cid, templateId: "#p:M:T", createArgument: {}, signatories: [], observers: [], packageName: "p" });

describe("queryActiveContractsBounded", () => {
  it("is ONE bounded read when the client can slice — the plain read is never tried first", async () => {
    const plain = vi.fn(async () => {
      throw new CantonError("too many", "ACS_LIMIT_EXCEEDED", 413);
    });
    const slice = vi.fn(async (_f: unknown, limit: number) => ({ events: [ev("a")], complete: false, limit }));
    const r = await queryActiveContractsBounded({ queryActiveContracts: plain, queryActiveContractsSlice: slice }, filter);
    expect(plain).not.toHaveBeenCalled();
    expect(slice).toHaveBeenCalledTimes(1);
    expect(slice.mock.calls[0]![1]).toBe(ACS_DEFAULT_LIST_LIMIT);
    expect(r).toEqual({ events: [ev("a")], complete: false });
  });

  it("passes an explicit limit through", async () => {
    const slice = vi.fn(async (_f: unknown, limit: number) => ({ events: [], complete: true, limit }));
    await queryActiveContractsBounded({ queryActiveContracts: vi.fn(), queryActiveContractsSlice: slice }, filter, 7);
    expect(slice.mock.calls[0]![1]).toBe(7);
  });

  it("without the slice capability it is the plain read: complete, or the 413 as before", async () => {
    const ok = await queryActiveContractsBounded({ queryActiveContracts: async () => [ev("a"), ev("b")] }, filter);
    expect(ok).toEqual({ events: [ev("a"), ev("b")], complete: true });
    const err = await queryActiveContractsBounded(
      {
        queryActiveContracts: async () => {
          throw new CantonError("too many", "ACS_LIMIT_EXCEEDED", 413);
        },
      },
      filter
    ).catch((e: unknown) => e);
    expect(isAcsLimitExceeded(err)).toBe(true);
  });
});

describe("limits", () => {
  it("isAcsLimitExceeded matches the ledger's code only", () => {
    expect(isAcsLimitExceeded(new CantonError("x", "ACS_LIMIT_EXCEEDED", 413))).toBe(true);
    expect(isAcsLimitExceeded({ code: "ACS_LIMIT_EXCEEDED" })).toBe(true);
    expect(isAcsLimitExceeded(new CantonError("x", "HTTP_ERROR", 413))).toBe(false);
    expect(isAcsLimitExceeded(null)).toBe(false);
    expect(isAcsLimitExceeded(undefined)).toBe(false);
  });

  it("input caps stay under the 256-node transaction cap (~3 nodes per Amulet, ~1 per registry input)", () => {
    expect(MAX_TRANSFER_INPUTS_AMULET * 3).toBeLessThan(256);
    expect(MAX_TRANSFER_INPUTS_REGISTRY).toBeLessThan(256);
    expect([MAX_TRANSFER_INPUTS_AMULET, MAX_TRANSFER_INPUTS_REGISTRY, ACS_DEFAULT_LIST_LIMIT]).toEqual([70, 90, 200]);
  });
});
