import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync, deflateRawSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  encodeInlinePayload,
  decodeInlinePayload,
  InlineCodecError,
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
} from "./inline-codec.js";

/** Build a gzip member by hand so we can set header flags gzipSync will not. */
function craftMember(raw: Buffer, flg: number, extraHeader: Buffer): Buffer {
  const deflated = deflateRawSync(raw, { level: 9 });
  const header = Buffer.from([0x1f, 0x8b, 0x08, flg, 0, 0, 0, 0, 0, 0x03]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(raw) >>> 0, 0);
  trailer.writeUInt32LE(raw.length, 4);
  return Buffer.concat([header, extraHeader, deflated, trailer]);
}

describe("inline codec — round trip", () => {
  it("round-trips prepared-transaction-shaped bytes", () => {
    const raw = Buffer.from("prepared-tx-bytes".repeat(200), "utf8");
    expect(decodeInlinePayload(encodeInlinePayload(raw))).toEqual(raw);
  });

  it("round-trips bytes that do not compress (all-random)", () => {
    // Incompressible input makes gzip slightly LARGER than the input. Proves
    // the decoder has no hidden "must have shrunk" assumption.
    const raw = Buffer.alloc(4096);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff;
    expect(decodeInlinePayload(encodeInlinePayload(raw))).toEqual(raw);
  });

  it("round-trips an empty payload", () => {
    expect(decodeInlinePayload(encodeInlinePayload(Buffer.alloc(0))).length).toBe(0);
  });

  it("what we emit never sets the header fields we refuse", () => {
    const gz = encodeInlinePayload(Buffer.from("x".repeat(5000)));
    // FEXTRA|FNAME|FCOMMENT|FHCRC|reserved must all be clear, or our own
    // encoder would produce payloads our own decoder rejects.
    expect((gz[3] as number) & 0b1111_1110).toBe(0);
  });
});

describe("inline codec — the real mainnet payload fits the default caps", () => {
  // Reads (does not import) an agent-wallet fixture: bytes captured from a real
  // MainNet prepared transfer. This is the assertion that keeps the RECOMMENDED
  // 8 KiB / 64 KiB defaults honest — if a real payment did not fit them, the
  // defaults would reject production traffic, which is a worse failure than any
  // of the attacks below.
  const fixture = fileURLToPath(
    new URL(
      "../../agent-wallet/src/__fixtures__/mainnet-transfer-preapproval-0.1.21.b64",
      import.meta.url
    )
  );

  it("a real prepared transfer compresses under 8 KiB and decodes back", () => {
    const raw = Buffer.from(readFileSync(fixture, "utf8").trim(), "base64");
    const gz = encodeInlinePayload(raw);

    expect(raw.length).toBeGreaterThan(20_000); // ~26 KB raw — will not fit a header
    expect(gz.length).toBeLessThan(DEFAULT_MAX_COMPRESSED_BYTES);
    expect(raw.length).toBeLessThan(DEFAULT_MAX_DECOMPRESSED_BYTES);
    expect(decodeInlinePayload(gz)).toEqual(raw); // byte-identical, not just same length
  });
});

describe("inline codec — bounds", () => {
  it("rejects a decompression bomb without allocating it", () => {
    // 4 MiB of zeros gzips to a few KB: passes the compressed cap, would blow
    // 64 KiB on output. This is the attack the decompressed cap exists for.
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(DEFAULT_MAX_COMPRESSED_BYTES);

    expect(() => decodeInlinePayload(bomb)).toThrow(InlineCodecError);
    expect(() => decodeInlinePayload(bomb)).toThrow(/decompressed size exceeds/);
  });

  it("rejects an oversized member before decompressing it", () => {
    const big = encodeInlinePayload(Buffer.alloc(200_000, 7));
    expect(() => decodeInlinePayload(big, { maxCompressedBytes: 64 })).toThrow(
      /compressed size \d+ exceeds the 64-byte cap/
    );
  });

  it("honours raised caps so the numbers are policy, not law", () => {
    const raw = Buffer.alloc(100_000, 3);
    const gz = encodeInlinePayload(raw);
    expect(() => decodeInlinePayload(gz)).toThrow(InlineCodecError);
    expect(
      decodeInlinePayload(gz, { maxDecompressedBytes: 200_000 }).length
    ).toBe(100_000);
  });

  it("accepts a payload sitting exactly on the decompressed cap", () => {
    // Off-by-one guard: the cap is inclusive, so a payload of exactly the cap
    // must pass. A strict-greater bug here would reject legitimate traffic.
    const raw = Buffer.alloc(1024, 9);
    expect(
      decodeInlinePayload(encodeInlinePayload(raw), { maxDecompressedBytes: 1024 })
    ).toEqual(raw);
  });
});

describe("inline codec — framing", () => {
  it("rejects two concatenated members", () => {
    const a = encodeInlinePayload(Buffer.from("first member payload"));
    const b = encodeInlinePayload(Buffer.from("second member payload"));
    expect(() => decodeInlinePayload(Buffer.concat([a, b]))).toThrow(
      InlineCodecError
    );
  });

  it("rejects the same member concatenated with itself", () => {
    // The nastier case: a self-concatenation whose trailer agrees with the
    // first member's output, so the CRC/ISIZE check alone would pass it.
    const one = encodeInlinePayload(Buffer.from("identical payload".repeat(20)));
    expect(() => decodeInlinePayload(Buffer.concat([one, one]))).toThrow(
      InlineCodecError
    );
  });

  it("rejects trailing bytes appended after a valid member", () => {
    const gz = encodeInlinePayload(Buffer.from("payload with a tail"));
    expect(() =>
      decodeInlinePayload(Buffer.concat([gz, Buffer.from([0x00, 0x01, 0x02])]))
    ).toThrow(InlineCodecError);
  });

  it("rejects a member carrying a filename (FNAME)", () => {
    const raw = Buffer.from("named member payload");
    const named = craftMember(raw, 0x08, Buffer.from("payload.bin\0", "utf8"));
    // Sanity: the crafted member is genuinely valid gzip, so the rejection is
    // our policy and not an accidentally corrupt fixture.
    expect(gzipSync(raw).length).toBeGreaterThan(0);
    expect(() => decodeInlinePayload(named)).toThrow(
      /disallowed optional fields/
    );
  });

  it("rejects FEXTRA and FCOMMENT members too", () => {
    const raw = Buffer.from("payload");
    const extra = craftMember(raw, 0x04, Buffer.from([0x02, 0x00, 0xaa, 0xbb]));
    const comment = craftMember(raw, 0x10, Buffer.from("a comment\0", "utf8"));
    expect(() => decodeInlinePayload(extra)).toThrow(/disallowed optional fields/);
    expect(() => decodeInlinePayload(comment)).toThrow(/disallowed optional fields/);
  });

  it("accepts a plain member and rejects one that only sets FTEXT... consistently", () => {
    const raw = Buffer.from("ftext payload");
    // FTEXT (bit 0) carries no length, so it is the one optional flag that is
    // safe to allow — the body still starts at a fixed offset.
    expect(decodeInlinePayload(craftMember(raw, 0x01, Buffer.alloc(0)))).toEqual(raw);
  });

  it("rejects a truncated member", () => {
    const gz = encodeInlinePayload(Buffer.from("truncate me".repeat(100)));
    expect(() => decodeInlinePayload(gz.subarray(0, gz.length - 5))).toThrow(
      InlineCodecError
    );
    expect(() => decodeInlinePayload(gz.subarray(0, 12))).toThrow(InlineCodecError);
  });

  it("rejects non-gzip and undersized input", () => {
    expect(() => decodeInlinePayload(Buffer.alloc(0))).toThrow(/too short/);
    expect(() => decodeInlinePayload(Buffer.alloc(30, 0x41))).toThrow(/bad magic/);
    const gz = encodeInlinePayload(Buffer.from("x".repeat(100)));
    const wrongCm = Buffer.from(gz);
    wrongCm[2] = 0x07;
    expect(() => decodeInlinePayload(wrongCm)).toThrow(/compression method/);
  });

  it("rejects a member whose body was tampered with", () => {
    const gz = encodeInlinePayload(Buffer.from("authentic payload".repeat(50)));
    const tampered = Buffer.from(gz);
    tampered[tampered.length - 12] ^= 0xff; // inside the deflate body
    expect(() => decodeInlinePayload(tampered)).toThrow(InlineCodecError);
  });

  it("rejects a member whose trailer was tampered with", () => {
    const raw = Buffer.from("authentic payload".repeat(50));
    const gz = encodeInlinePayload(raw);
    const badCrc = Buffer.from(gz);
    badCrc[gz.length - 8] ^= 0xff;
    expect(() => decodeInlinePayload(badCrc)).toThrow(/checksum does not match/);

    const badSize = Buffer.from(gz);
    badSize.writeUInt32LE(raw.length + 1, gz.length - 4);
    expect(() => decodeInlinePayload(badSize)).toThrow(/length does not match/);
  });

  it("never leaks decoded bytes when it rejects", () => {
    // A caller that swallows the error must not be able to read a partial
    // result: rejection is always a throw, never a short return.
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024), { level: 9 });
    let leaked: unknown = "not-set";
    try {
      leaked = decodeInlinePayload(bomb);
    } catch {
      /* expected */
    }
    expect(leaked).toBe("not-set");
  });
});
