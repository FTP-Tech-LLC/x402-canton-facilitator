import { describe, it, expect } from "vitest";
import {
  buildNetworkId,
  isCantonNetwork,
  parseNetworkReference,
  CANTON_DEVNET,
  CANTON_MAINNET,
  CANTON_NAMESPACE,
} from "./caip2.js";

describe("CAIP-2 Canton network helpers", () => {
  it("exposes the canonical namespace + well-known IDs", () => {
    expect(CANTON_NAMESPACE).toBe("canton");
    expect(CANTON_DEVNET).toBe("canton:devnet");
    expect(CANTON_MAINNET).toBe("canton:mainnet");
  });

  it("buildNetworkId composes `canton:<sync-id>`", () => {
    const sid = "global-domain::1220abcdef";
    expect(buildNetworkId(sid)).toBe(`canton:${sid}`);
  });

  it("isCantonNetwork accepts our IDs", () => {
    expect(isCantonNetwork("canton:devnet")).toBe(true);
    expect(isCantonNetwork("canton:mainnet")).toBe(true);
    expect(isCantonNetwork("canton:global-domain::1220abc")).toBe(true);
  });

  it("isCantonNetwork rejects non-Canton IDs", () => {
    expect(isCantonNetwork("eip155:1")).toBe(false);
    expect(isCantonNetwork("solana:mainnet")).toBe(false);
    expect(isCantonNetwork("canton")).toBe(false);
    expect(isCantonNetwork("")).toBe(false);
  });

  it("parseNetworkReference extracts the reference half", () => {
    expect(parseNetworkReference("canton:devnet")).toBe("devnet");
    expect(parseNetworkReference("canton:mainnet")).toBe("mainnet");
  });

  it("preserves Global Synchronizer IDs that contain '::'", () => {
    // The naive split(":", 2) cuts at the first colon and discards
    // the rest, mangling Splice's <name>::<fingerprint> form. The
    // implementation uses indexOf+slice so the full reference
    // survives, which is what callers (PaymentRequirements
    // extra.synchronizerId, MerchantContract resolution) need.
    expect(
      parseNetworkReference("canton:global-domain::1220abcdef")
    ).toBe("global-domain::1220abcdef");
  });

  it("parseNetworkReference throws on malformed input", () => {
    expect(() => parseNetworkReference("canton:" as never)).toThrow(
      /malformed/
    );
  });

  it("parseNetworkReference throws when the canton: prefix is missing (defense-in-depth)", () => {
    // The type says CantonNetwork, but a raw runtime string must still be
    // rejected rather than silently parsed by slicing the first colon.
    expect(() => parseNetworkReference("eip155:1" as never)).toThrow(/prefix/);
    expect(() => parseNetworkReference("devnet" as never)).toThrow(/prefix/);
  });
});
