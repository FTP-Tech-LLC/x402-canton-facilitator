import net from "node:net";
import { describe, it, expect } from "vitest";
import { connectionNeverEstablished } from "./network-failure.js";

/**
 * The claim this function makes is one-sided on purpose: true means "the
 * request PROVABLY never left". Everything it cannot prove must answer false,
 * because on the money path the unproven direction is the one that invites a
 * second payment.
 */
describe("connectionNeverEstablished", () => {
  const fetchFailed = (code: string) =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(code), { code }),
    });

  it("proves a no-op for codes that cannot have carried bytes", () => {
    for (const code of [
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
    ]) {
      expect(connectionNeverEstablished(fetchFailed(code)), code).toBe(true);
    }
  });

  it("refuses to claim it for anything that had a socket", () => {
    // These happened with a connection open — the request may have been
    // delivered and the facilitator may already have relayed the submission.
    for (const code of [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ]) {
      expect(connectionNeverEstablished(fetchFailed(code)), code).toBe(false);
    }
  });

  it("an abort is never proof of a no-op, even nested under fetch failed", () => {
    // The deadline can fire at any moment, including long after the request was
    // delivered. Reading it as "never sent" is exactly the unsafe direction.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(connectionNeverEstablished(abort)).toBe(false);
    expect(
      connectionNeverEstablished(
        Object.assign(new TypeError("fetch failed"), { cause: abort })
      )
    ).toBe(false);
    // And an abort must win even if a connect-class code sits deeper.
    expect(
      connectionNeverEstablished(
        Object.assign(new Error("aborted"), {
          name: "AbortError",
          cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        })
      )
    ).toBe(false);
  });

  it("an unrecognised failure answers false — the safe direction", () => {
    expect(connectionNeverEstablished(new TypeError("fetch failed"))).toBe(false);
    expect(connectionNeverEstablished(new Error("something else"))).toBe(false);
    expect(connectionNeverEstablished(undefined)).toBe(false);
    expect(connectionNeverEstablished({ code: 42 })).toBe(false);
  });

  it("does not walk a cause chain forever", () => {
    const loop: Record<string, unknown> = { message: "x" };
    loop["cause"] = loop;
    expect(connectionNeverEstablished(loop)).toBe(false);
  });
});

/**
 * The tests above hand-build the error objects, so they only prove the function
 * reads the shape we BELIEVE node produces. They cannot catch the failure that
 * actually threatens this classifier: undici moving the code somewhere else in
 * the cause chain. That degrades silently — every connect failure would start
 * answering "false", the safe direction, so nothing breaks loudly while the
 * distinction the money path depends on quietly stops existing.
 *
 * These two drive real sockets on loopback. No DNS, no unroutable addresses,
 * nothing that depends on the machine's network — they run offline and in CI.
 */
describe("connectionNeverEstablished against real node failures", () => {
  /** Bind a port, then release it: nothing is listening, and nothing else grabbed it. */
  const closedPort = async (): Promise<number> => {
    const srv = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const { port } = srv.address() as net.AddressInfo;
    await new Promise((r) => srv.close(r));
    return port;
  };

  it("proves the no-op for a genuinely refused connection", async () => {
    const port = await closedPort();
    await expect(
      fetch(`http://127.0.0.1:${port}/settle`, { method: "POST" })
    ).rejects.toSatisfy((err: unknown) => connectionNeverEstablished(err) === true);
  });

  it("refuses to prove it once a socket was established and then died", async () => {
    // The discriminator: a server that accepts and immediately destroys. Bytes
    // may have gone out, so this must stay ambiguous — if this one also answered
    // true the classifier would be worthless, not merely stale.
    const srv = net.createServer((s) => s.destroy()).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const { port } = srv.address() as net.AddressInfo;
    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/settle`, { method: "POST" })
      ).rejects.toSatisfy((err: unknown) => connectionNeverEstablished(err) === false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
