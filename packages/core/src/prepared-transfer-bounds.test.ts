import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodePrepared, PreparedDecodeError } from "./prepared-transfer.js";

/* Minimal protobuf writer — just enough to build a transaction with an
 * arbitrary number of nodes or roots. Hand-rolled on purpose: the point is to
 * feed the decoder shapes no honest producer would emit. */
const key = (field: number, wire: number) => Buffer.from([(field << 3) | wire]);
const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const lenField = (field: number, body: Buffer) =>
  Buffer.concat([key(field, 2), varint(body.length), body]);

/** PreparedTransaction{ transaction: DamlTransaction{ roots, nodes } } */
function prepared(nodeCount: number, rootCount = 1): string {
  const node = lenField(1, Buffer.from("n")); // Node{node_id} — no v1 member
  return lenField(
    1,
    Buffer.concat([
      ...Array.from({ length: rootCount }, (_, i) =>
        lenField(2, Buffer.from(`r${i}`))
      ),
      ...Array.from({ length: nodeCount }, () => lenField(3, node)),
    ])
  ).toString("base64");
}

const REAL = readFileSync(
  fileURLToPath(
    new URL(
      "../../agent-wallet/src/__fixtures__/mainnet-transfer-preapproval-0.1.21.b64",
      import.meta.url
    )
  ),
  "utf8"
).trim();

describe("prepared-transaction decode bounds", () => {
  it("does not reject the real MainNet payment", () => {
    // The caps are worthless if they cost a real payment. Measured shape: 12
    // nodes, 1 root — the bounds sit ~20x above it.
    const d = decodePrepared(REAL);
    expect(d.nodes.length).toBe(12);
    expect(d.roots.length).toBe(1);
  });

  it("accepts a transaction sitting exactly on the node cap", () => {
    expect(decodePrepared(prepared(256)).nodes.length).toBe(256);
  });

  it("refuses one node past the cap", () => {
    expect(() => decodePrepared(prepared(257))).toThrow(PreparedDecodeError);
    expect(() => decodePrepared(prepared(257))).toThrow(/257 nodes, over the 256/);
  });

  it("refuses a transaction with an absurd node count", () => {
    expect(() => decodePrepared(prepared(5000))).toThrow(/5000 nodes/);
  });

  it("refuses too many declared roots", () => {
    expect(() => decodePrepared(prepared(1, 17))).toThrow(/17 roots, over the 16/);
    expect(() => decodePrepared(prepared(1, 16))).not.toThrow();
  });

  /* No timing assertion here on purpose. The bound's value IS a cost
   * argument, but a wall-clock assertion in CI compares different-sized inputs
   * and goes flaky on a loaded box. The measurement that matters was taken
   * directly, same input with and without the cap: 5000 nodes cost 14.6 ms to
   * decode and 2.8 ms to refuse. It is recorded next to MAX_NODES, where the
   * number can be re-taken, rather than asserted here where it would only
   * produce noise. */
});
