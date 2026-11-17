import { describe, it, expect } from "vitest";
import { checkTopologyReader } from "./reader-readiness.js";
import { createLastKnownKeys } from "./last-known-keys.js";
import { TopologyLookupError } from "./topology-reader-client.js";

const OWN = "ftp-x402-infrastructure::1220ff";
const PAYER = "agent::1220aa";
const KEY = Buffer.alloc(44, 1);

const answering = (byParty: Record<string, Buffer[] | "no_key" | "unavailable">) => {
  const asked: string[] = [];
  const lookup = async (party: string): Promise<Buffer[]> => {
    asked.push(party);
    const a = byParty[party];
    if (a === undefined || a === "no_key") throw new TopologyLookupError("none", "no_key");
    if (a === "unavailable") throw new TopologyLookupError("down", "unavailable");
    return a;
  };
  return { lookup, asked };
};

describe("topology reader readiness", () => {
  it("before any verified payment: our own party's no_key is healthy", async () => {
    const { lookup, asked } = answering({});
    expect(await checkTopologyReader(lookup, OWN, createLastKnownKeys({ maxStaleMs: 1000 }))).toEqual({ ok: true });
    expect(asked).toEqual([OWN]);
  });

  it("asks about the last verified payer, and is healthy when the reader has its key", async () => {
    const known = createLastKnownKeys({ maxStaleMs: 60_000 });
    known.remember(PAYER, [KEY]);
    const { lookup, asked } = answering({ [PAYER]: [KEY] });
    expect(await checkTopologyReader(lookup, OWN, known)).toEqual({ ok: true });
    expect(asked).toEqual([PAYER]);
  });

  it("is not ready when the reader says that payer has no key, and moves on to another payer", async () => {
    const known = createLastKnownKeys({ maxStaleMs: 60_000 });
    known.remember(PAYER, [KEY]);
    const { lookup } = answering({});
    expect((await checkTopologyReader(lookup, OWN, known)).ok).toBe(false);
    expect(known.recentParty()).toBeUndefined();
  });

  it("lets an outage throw, which the probe reports as not ready", async () => {
    const { lookup } = answering({ [OWN]: "unavailable" });
    await expect(checkTopologyReader(lookup, OWN, undefined)).rejects.toMatchObject({ reason: "unavailable" });
  });
});
