import { describe, it, expect } from "vitest";
import {
  encodeBase64Json,
  decodeBase64Json,
} from "./encoding.js";

describe("encodeBase64Json / decodeBase64Json", () => {
  it("round-trips a plain object", () => {
    const obj = { hello: "world", n: 42 };
    expect(decodeBase64Json(encodeBase64Json(obj))).toEqual(obj);
  });

  it("round-trips nested structures and arrays", () => {
    const obj = {
      x402Version: 2,
      accepts: [{ scheme: "exact", amount: "10" }],
      extra: { memo: "✓ unicode" },
    };
    expect(decodeBase64Json(encodeBase64Json(obj))).toEqual(obj);
  });

  it("encodes to standard base64 (not base64url)", () => {
    // Confirm we emit '+' and '/' (not '-' and '_') so HTTP headers
    // stay compatible with x402-foundation's reference clients.
    const encoded = encodeBase64Json({ a: "aaaaaaa".repeat(20) });
    expect(encoded).not.toMatch(/[-_]/);
  });

  it("handles null and primitive values", () => {
    expect(decodeBase64Json(encodeBase64Json(null))).toBeNull();
    expect(decodeBase64Json(encodeBase64Json(42))).toBe(42);
    expect(decodeBase64Json(encodeBase64Json("hi"))).toBe("hi");
  });

  it("throws on garbage input to decode", () => {
    expect(() => decodeBase64Json("@@@not valid base64@@@")).toThrow();
  });
});


describe("decodeBase64Json — input hardening (audit M4)", () => {
  it("throws on input larger than the size cap (DoS guard)", () => {
    // Header-supplied envelopes arrive OUTSIDE the server body-size limit.
    const huge = "A".repeat(128 * 1024 + 1);
    expect(() => decodeBase64Json(huge)).toThrow(/too large/);
  });

  it("accepts input at exactly the cap boundary (decodes, even if not valid JSON it fails at parse not size)", () => {
    // A string at the cap must pass the size check (it then fails JSON.parse,
    // which is the expected downstream behavior, not a size rejection).
    const atCap = "A".repeat(128 * 1024);
    expect(() => decodeBase64Json(atCap)).not.toThrow(/too large/);
  });

  it("throws a clear error on non-string input", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => decodeBase64Json(42)).toThrow(/not a string/);
  });

  it("still round-trips a normal small envelope", () => {
    const obj = { scheme: "exact", amount: "1000000000" };
    expect(decodeBase64Json(encodeBase64Json(obj))).toEqual(obj);
  });
});
