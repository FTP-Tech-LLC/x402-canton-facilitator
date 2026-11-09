import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decodePrepared,
  deliversViaAmuletPreapproval,
  extractTransfer,
  type DecodedPrepared,
} from "./prepared-transfer.js";

/* Real MainNet one-step CC payments: each delivers through the receiver's
 * TransferPreapproval via TransferPreapproval_SendV2. */
const FIXTURES = [
  "mainnet-transfer-preapproval-0.1.21.b64",
  "mainnet-preapproval-distinct-provider.b64",
  "mainnet-preapproval-self-provider.b64",
];

function load(name: string) {
  const b64 = readFileSync(
    new URL(`../../agent-wallet/src/__fixtures__/${name}`, import.meta.url),
    "utf8"
  ).trim();
  const decoded = decodePrepared(b64);
  const root = decoded.exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
  return { decoded, t: extractTransfer(root.chosenValue) };
}

function check(decoded: DecodedPrepared, t: ReturnType<typeof extractTransfer>) {
  return deliversViaAmuletPreapproval(decoded, t.receiver, t.instrumentAdmin, t.amount);
}

/** The same tree with its nodes edited, as a payer building its own bytes would. */
function withNodes(
  decoded: DecodedPrepared,
  edit: (nodes: DecodedPrepared["nodes"]) => DecodedPrepared["nodes"]
): DecodedPrepared {
  return { ...decoded, nodes: edit(decoded.nodes.map((n) => ({ ...n }))) };
}

const isSend = (n: DecodedPrepared["nodes"][number]) =>
  n.exercise?.choiceId === "TransferPreapproval_SendV2";

describe("deliversViaAmuletPreapproval", () => {
  it.each(FIXTURES)("accepts the real one-step payment %s", (name) => {
    const { decoded, t } = load(name);
    expect(check(decoded, t)).toBe(true);
  });

  it("refuses a different amount or receiver", () => {
    const { decoded, t } = load(FIXTURES[0]!);
    expect(deliversViaAmuletPreapproval(decoded, t.receiver, t.instrumentAdmin, "0.02")).toBe(false);
    expect(
      deliversViaAmuletPreapproval(decoded, "someone::1220" + "ee".repeat(32), t.instrumentAdmin, t.amount)
    ).toBe(false);
  });

  it("refuses the two-step shape: no SendV2 node", () => {
    const { decoded, t } = load(FIXTURES[0]!);
    expect(check(withNodes(decoded, (ns) => ns.filter((n) => !isSend(n))), t)).toBe(false);
  });

  it("refuses a SendV2 on another contract, a legacy _Send, or two sends", () => {
    const { decoded, t } = load(FIXTURES[0]!);
    const retarget = withNodes(decoded, (ns) =>
      ns.map((n) => (isSend(n) ? { ...n, exercise: { ...n.exercise!, contractId: "00ff" } } : n))
    );
    const legacy = withNodes(decoded, (ns) =>
      ns.map((n) =>
        isSend(n) ? { ...n, exercise: { ...n.exercise!, choiceId: "TransferPreapproval_Send" } } : n
      )
    );
    const twice = withNodes(decoded, (ns) => [...ns, ...ns.filter(isSend)]);
    expect(check(retarget, t)).toBe(false);
    expect(check(legacy, t)).toBe(false);
    expect(check(twice, t)).toBe(false);
  });

  it("refuses when the preapproval is not an input contract", () => {
    const { decoded, t } = load(FIXTURES[0]!);
    const noPre: DecodedPrepared = {
      ...decoded,
      inputContracts: decoded.inputContracts.filter(
        (ic) => ic.templateQualifiedName !== "Splice.AmuletRules:TransferPreapproval"
      ),
    };
    expect(check(noPre, t)).toBe(false);
  });

  it("refuses a preapproval with an extra signatory", () => {
    const { decoded, t } = load(FIXTURES[0]!);
    const extra: DecodedPrepared = {
      ...decoded,
      inputContracts: decoded.inputContracts.map((ic) =>
        ic.templateQualifiedName === "Splice.AmuletRules:TransferPreapproval"
          ? { ...ic, signatories: [...ic.signatories, "x::1220" + "ee".repeat(32)] }
          : ic
      ),
    };
    expect(check(extra, t)).toBe(false);
  });
});
