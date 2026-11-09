/**
 * The hashing budget (MAX_HASHED_STEPS). The hasher awaits once per string,
 * list or record element and part of a dotted name, so a transaction past the
 * budget is refused before it runs, wherever those steps sit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  recomputeHash,
  MAX_HASHED_STEPS,
  MAX_HASHED_VALUE_DEPTH,
  PreparedTransactionBudgetError,
  PreparedTransactionGraphError,
} from "./canton-hash.js";
import { REAL_PREPARED_B64, mutated, nodeBody } from "./_graph-fixture.js";

const FIXTURES = fileURLToPath(new URL("../../agent-wallet/src/__fixtures__/", import.meta.url));
/** The real transaction takes 1,418 steps. */
const BUDGET = 5_000;

async function refusedOver(b64: string, maxSteps?: number): Promise<void> {
  const outcome = await recomputeHash(b64, maxSteps === undefined ? {} : { maxSteps }).then(
    () => new Error("hashed, expected a refusal"),
    (err: unknown) => err
  );
  expect(outcome).toBeInstanceOf(PreparedTransactionBudgetError);
  // A graph error too: callers that refuse those refuse this.
  expect(outcome).toBeInstanceOf(PreparedTransactionGraphError);
}

describe("recomputeHash keeps to a hashing budget", () => {
  it("hashes every real transaction in the fixtures within the default and the facilitator's 10,000", async () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".b64"));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const b64 = readFileSync(FIXTURES + f, "utf8").trim();
      const unbounded = await recomputeHash(b64, { maxSteps: Number.POSITIVE_INFINITY });
      expect(await recomputeHash(b64), f).toBe(unbounded);
      expect(await recomputeHash(b64, { maxSteps: 10_000 }), f).toBe(unbounded);
    }
  });

  it("refuses dots in one name past the default budget", async () => {
    await refusedOver(mutated((p) => (nodeBody(p, "3").templateId!.moduleName = ".".repeat(MAX_HASHED_STEPS))));
  });

  it("counts the whole transaction: dots spread over names that each fit are refused together", async () => {
    const one = mutated((p) => (nodeBody(p, "3").templateId!.moduleName = "A" + ".A".repeat(1_000)));
    expect(Buffer.from(await recomputeHash(one, { maxSteps: BUDGET }), "base64")).toHaveLength(32);
    const spread = mutated((p) => {
      for (const id of ["0", "1", "2", "3", "4"]) nodeBody(p, id).templateId!.moduleName = "A" + ".A".repeat(1_000);
    });
    await refusedOver(spread, BUDGET);
  });

  // Each case below is sized so that it stays under the budget without the
  // rule it names, and goes over with it.
  it("counts strings: a party list of empty names", async () => {
    await refusedOver(mutated((p) => (nodeBody(p, "3").signatories = Array(2_500).fill(""))), BUDGET);
  });

  it("counts elements: a long list in a choice argument", async () => {
    const units = mutated((p) => {
      const exercise = nodeBody(p, "0");
      if (!("chosenValue" in exercise)) throw new Error("node 0 is not an exercise");
      exercise.chosenValue = {
        sum: {
          oneofKind: "list",
          list: { elements: Array.from({ length: 2_500 }, () => ({ sum: { oneofKind: "unit" as const, unit: {} } })) },
        },
      };
    });
    await refusedOver(units, BUDGET);
  });

  it("counts identifiers: records that carry a record id", async () => {
    const records = mutated((p) => {
      const exercise = nodeBody(p, "0");
      if (!("chosenValue" in exercise)) throw new Error("node 0 is not an exercise");
      exercise.chosenValue = {
        sum: {
          oneofKind: "list",
          list: {
            elements: Array.from({ length: 600 }, () => ({
              sum: {
                oneofKind: "record" as const,
                record: { recordId: { packageId: "p", moduleName: "M", entityName: "E" }, fields: [] },
              },
            })),
          },
        },
      };
    });
    await refusedOver(records, BUDGET);
  });

  it(`refuses a value nested deeper than ${MAX_HASHED_VALUE_DEPTH} levels, whatever the budget`, async () => {
    const chain = (levels: number) =>
      mutated((p) => {
        const exercise = nodeBody(p, "0");
        if (!("chosenValue" in exercise)) throw new Error("node 0 is not an exercise");
        let value: NonNullable<typeof exercise.chosenValue> = { sum: { oneofKind: "text", text: "x" } };
        for (let i = 0; i < levels; i++) value = { sum: { oneofKind: "optional", optional: { value } } };
        exercise.chosenValue = value;
      });
    // Three object levels per optional, under the exercise at level 8.
    expect(Buffer.from(await recomputeHash(chain(330)), "base64")).toHaveLength(32);
    await refusedOver(chain(345), Number.POSITIVE_INFINITY);
  });

  it("refuses more node seeds than nodes", async () => {
    const seeded = mutated((p) => {
      const t = p.transaction!;
      const seed = t.nodeSeeds[0]!;
      while (t.nodeSeeds.length <= t.nodes.length) t.nodeSeeds.push({ ...seed, nodeId: 900 + t.nodeSeeds.length });
    });
    const outcome = await recomputeHash(seeded).then(
      () => new Error("hashed, expected a refusal"),
      (err: unknown) => err
    );
    expect(outcome).toBeInstanceOf(PreparedTransactionGraphError);
    expect((outcome as Error).message).toMatch(/node seeds for 12 nodes/);
  });

  it("takes no options as the default budget, null included", async () => {
    expect(await recomputeHash(REAL_PREPARED_B64, null)).toBe(await recomputeHash(REAL_PREPARED_B64));
  });

  it("refuses everything when the budget is not a number", async () => {
    await refusedOver(REAL_PREPARED_B64, Number.NaN);
  });

  it("leaves the real transaction alone at a budget it fits", async () => {
    const unbounded = await recomputeHash(REAL_PREPARED_B64, { maxSteps: Number.POSITIVE_INFINITY });
    expect(await recomputeHash(REAL_PREPARED_B64, { maxSteps: 1_500 })).toBe(unbounded);
    await refusedOver(REAL_PREPARED_B64, 1_000);
  });
});
