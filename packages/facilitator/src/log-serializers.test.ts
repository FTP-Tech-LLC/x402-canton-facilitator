import { describe, it, expect } from "vitest";
import { CantonError } from "@ftptech/x402-canton-ledger";
import { cantonErrSerializer } from "./log-serializers.js";

describe("cantonErrSerializer", () => {
  it("threads CantonError code/status/responseBody into the serialized object", () => {
    const err = new CantonError(
      "TransferCommand_Send failed",
      "HTTP_ERROR",
      503,
      "ABORTED: sender does not have enough traffic"
    );
    const out = cantonErrSerializer(err);
    // stdSerializers.err base fields preserved.
    expect(out.type).toBe("CantonError");
    expect(out.message).toBe("TransferCommand_Send failed");
    expect(typeof out.stack).toBe("string");
    // The CantonError-specific fields are now present (the whole point).
    expect(out.code).toBe("HTTP_ERROR");
    expect(out.status).toBe(503);
    expect(out.responseBody).toBe(
      "ABORTED: sender does not have enough traffic"
    );
  });

  it("omits the extra fields for a plain Error (serializes as before)", () => {
    const err = new Error("boom");
    const out = cantonErrSerializer(err);
    expect(out.message).toBe("boom");
    expect("code" in out).toBe(false);
    expect("status" in out).toBe(false);
    expect("responseBody" in out).toBe(false);
  });

  it("surfaces code; status/responseBody are undefined when the error did not set a value", () => {
    // A CantonError with no status/responseBody (e.g. a TIMEOUT) carries the
    // `code`. pino's base err serializer copies the class's own enumerable
    // fields (which include status/responseBody assigned as undefined by the
    // constructor), so the keys may be present but their VALUES are undefined —
    // i.e. nothing misleading is logged.
    const err = new CantonError("aborted after 10000ms", "TIMEOUT");
    const out = cantonErrSerializer(err);
    expect(out.code).toBe("TIMEOUT");
    expect(out.status).toBeUndefined();
    expect(out.responseBody).toBeUndefined();
  });

  it("is wired so a Fastify logger emits the fields end-to-end", async () => {
    // Drive a real pino logger with the serializer to prove the extra fields
    // survive into the emitted log line (not just the unit return value).
    const { pino } = await import("pino");
    const lines: string[] = [];
    const stream = {
      write: (s: string) => {
        lines.push(s);
      },
    };
    const log = pino(
      { serializers: { err: cantonErrSerializer } },
      stream as unknown as NodeJS.WritableStream
    );
    log.error(
      { err: new CantonError("nonce mismatch", "HTTP_ERROR", 400, "bad nonce") },
      "settle failed"
    );
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.err.code).toBe("HTTP_ERROR");
    expect(parsed.err.status).toBe(400);
    expect(parsed.err.responseBody).toBe("bad nonce");
  });
});
