import { describe, it, expect } from "vitest";
import { hashPreparedTransaction } from "@canton-network/core-tx-visualizer";
import {
  recomputeHash,
  PreparedTransactionGraphError,
  MAX_HASHED_NODES,
  MAX_HASHED_NODE_DEPTH,
} from "./canton-hash.js";
import {
  REAL_PREPARED_B64,
  addSpareNodes,
  chain,
  exerciseChildren,
  manyNodes,
  mutated,
  renameNode,
} from "./_graph-fixture.js";

async function refusal(b64: string): Promise<Error> {
  const outcome = await recomputeHash(b64).then(
    () => new Error("hashed, expected a refusal"),
    (err: unknown) => err
  );
  expect(outcome).toBeInstanceOf(PreparedTransactionGraphError);
  return outcome as Error;
}

describe("recomputeHash checks the node graph before hashing", () => {
  it("hashes the real MainNet transaction exactly as the library does", async () => {
    const ours = await recomputeHash(REAL_PREPARED_B64);
    expect(ours).toBe(await hashPreparedTransaction(REAL_PREPARED_B64, "base64"));
    expect(Buffer.from(ours, "base64")).toHaveLength(32);
  });

  it("refuses a node that is its own child", async () => {
    const err = await refusal(mutated((p) => exerciseChildren(p, "0").push("0")));
    expect(err.message).toBe("node 0 is reached twice (a cycle or a shared child)");
  });

  it("refuses a two-node cycle", async () => {
    const b64 = mutated((p) => {
      exerciseChildren(p, "4").push("0");
      addSpareNodes(p, 2);
    });
    expect((await refusal(b64)).message).toBe("node 0 is reached twice (a cycle or a shared child)");
  });

  it("refuses a child shared by two parents", async () => {
    const b64 = mutated((p) => {
      exerciseChildren(p, "4").push("1");
      addSpareNodes(p, 1);
    });
    expect((await refusal(b64)).message).toBe("node 1 is reached twice (a cycle or a shared child)");
  });

  it("refuses more references than nodes before walking them", async () => {
    // The real transaction references each of its 12 nodes once.
    const err = await refusal(mutated((p) => exerciseChildren(p, "4").push("1")));
    expect(err.message).toBe("the transaction references more nodes than it has");
  });

  it("refuses a chain where each node lists the next twice", async () => {
    // Without the check this is 2^depth node encodings.
    await refusal(chain(60, 2));
  });

  it("refuses a root listed twice", async () => {
    const b64 = mutated((p) => {
      p.transaction?.roots.push("0");
      addSpareNodes(p, 1);
    });
    expect((await refusal(b64)).message).toBe("node 0 is reached twice (a cycle or a shared child)");
  });

  it("refuses more roots than nodes", async () => {
    const b64 = mutated((p) => {
      if (p.transaction) p.transaction.roots = Array.from({ length: 13 }, (_, i) => String(i));
    });
    expect((await refusal(b64)).message).toBe("more roots than nodes");
  });

  it("refuses a reference to a missing node", async () => {
    const b64 = mutated((p) => {
      const children = exerciseChildren(p, "4");
      children[children.indexOf("11")] = "99";
    });
    expect((await refusal(b64)).message).toBe("node 99 is referenced but missing");
  });

  it("refuses a node id that appears twice", async () => {
    const b64 = mutated((p) => {
      const t = p.transaction;
      const dup = t?.nodes.find((n) => n.nodeId === "3");
      if (t && dup) t.nodes.push(structuredClone(dup));
    });
    expect((await refusal(b64)).message).toBe("node id 3 appears twice");
  });

  it("does not echo a node id that is not a small integer", async () => {
    // Callers match error text: an id like this must not reach it.
    const b64 = mutated((p) => {
      renameNode(p, "0", "fetch failed");
      exerciseChildren(p, "fetch failed").push("fetch failed");
    });
    const err = await refusal(b64);
    expect(err.message).toBe("node (a 12-character id) is reached twice (a cycle or a shared child)");
    expect(err.message).not.toContain("fetch failed");
  });

  it("hashes a chain at the depth limit and refuses one level deeper", async () => {
    const atLimit = await recomputeHash(chain(MAX_HASHED_NODE_DEPTH));
    expect(Buffer.from(atLimit, "base64")).toHaveLength(32);
    const err = await refusal(chain(MAX_HASHED_NODE_DEPTH + 1));
    expect(err.message).toBe("node 200 is at depth 101, the limit is 100");
  });

  it("hashes a transaction at the node limit and refuses one more node", async () => {
    const atLimit = await recomputeHash(manyNodes(MAX_HASHED_NODES));
    expect(Buffer.from(atLimit, "base64")).toHaveLength(32);
    const err = await refusal(manyNodes(MAX_HASHED_NODES + 1));
    expect(err.message).toBe("transaction has 10001 nodes, the limit is 10000");
  });
});
