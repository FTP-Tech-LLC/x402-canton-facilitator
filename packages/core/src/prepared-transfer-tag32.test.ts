/**
 * The two parsers must agree on WHERE the fields are, not merely on what they
 * say. This suite pins the one place they did not.
 *
 * Our reader accumulated tags and length prefixes over the full 64 bits a
 * varint can carry. Every reader on the other side — protobuf-java's
 * `readRawVarint32()` in the Canton participant, protobufjs's `Reader.uint32()`
 * inside the visualizer that `recomputeHash` uses — reads both as 32-bit and
 * silently drops bits >= 32 of an over-long encoding. That gap is not a
 * mis-parse we would notice; it is a field that exists for them and not for us.
 */
import { describe, it, expect } from "vitest";
import { decodePrepared, PreparedDecodeError } from "./prepared-transfer.js";

/** Minimal-form protobuf varint. */
function varint(n: number): number[] {
  const out: number[] = [];
  let x = n;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    out.push(b);
  } while (x > 0);
  return out;
}

/**
 * A varint padded to `bytes` length: same NUMERIC value, longer encoding. Legal
 * for every parser and used here to show that mere non-minimality is fine — it
 * is only the bits ABOVE 32 that split the two readers apart.
 */
function varintPadded(n: number, bytes: number): number[] {
  const out = varint(n);
  while (out.length < bytes) {
    out[out.length - 1]! |= 0x80;
    out.push(0x00);
  }
  return out;
}

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString("base64");

describe("protobuf tags and lengths are uint32, as every other reader treats them", () => {
  it("a tag carrying bits above 32 is REFUSED, not silently re-numbered", () => {
    // 0x0A + 2^32 encodes as 8A 80 80 80 10. The participant and the hasher
    // truncate to 0x0A and parse field 1 (wire 2). We used to compute field
    // 536870913 and skip it as unknown — the field was effective on execute and
    // invisible to verify-before-sign, which is the whole bypass.
    const tag = [0x8a, 0x80, 0x80, 0x80, 0x10];
    const payload = [0x01, 0x02, 0x03];
    const bytes = [...tag, ...varint(payload.length), ...payload];

    expect(() => decodePrepared(b64(bytes))).toThrow(PreparedDecodeError);
    expect(() => decodePrepared(b64(bytes))).toThrow(/exceeds 32 bits/);
  });

  it("a LENGTH prefix carrying bits above 32 is REFUSED", () => {
    // Same trick one level down. If we and the participant disagree on where a
    // length-delimited field ENDS, every byte after it is a different message
    // to each side — a strictly worse desync than a single hidden field.
    const tag = varint(1 * 8 + 2); // field 1, wire 2 — honest
    const len = [0x83, 0x80, 0x80, 0x80, 0x10]; // 3 + 2^32
    const bytes = [...tag, ...len, 0x01, 0x02, 0x03];

    expect(() => decodePrepared(b64(bytes))).toThrow(/exceeds 32 bits/);
  });

  it("a merely NON-MINIMAL tag still parses — the rule is the 32-bit bound, not minimality", () => {
    // The discriminator. A blanket "reject anything non-minimal" would also
    // pass the two tests above while being a different, stricter rule than the
    // one that actually makes the two readers agree. Here both readers compute
    // the SAME value from a padded encoding, so there is nothing to refuse.
    const tag = varintPadded(1 * 8 + 2, 4); // field 1, wire 2, padded to 4 bytes
    const payload = [0x01];
    const bytes = [...tag, ...varint(payload.length), ...payload];

    // Reaches the real decoder and fails on CONTENT (no transaction/metadata),
    // never on the encoding — which is the point.
    let err: unknown;
    try {
      decodePrepared(b64(bytes));
    } catch (e) {
      err = e;
    }
    expect(String(err)).not.toMatch(/exceeds 32 bits/);
  });

  it("the largest LEGAL tag (field 2^29-1) is accepted", () => {
    // field 536870911, wire 2 -> tag 4294967294, one below the bound. Refusing
    // this would break a legitimately field-numbered encoding, so the boundary
    // has to sit above it, not on it.
    const maxField = 2 ** 29 - 1;
    const tag = varint(maxField * 8 + 2);
    const bytes = [...tag, ...varint(1), 0x00];

    let err: unknown;
    try {
      decodePrepared(b64(bytes));
    } catch (e) {
      err = e;
    }
    expect(String(err)).not.toMatch(/exceeds 32 bits/);
  });
});
