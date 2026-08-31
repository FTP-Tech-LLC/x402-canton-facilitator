/**
 * The mainnet compose lists every environment variable by hand — it has no
 * `env_file:` — so a variable config.ts reads but the compose omits can never
 * reach the container, and setting it in .env is a silent no-op.
 *
 * That is not a hypothetical: it is how the API key for the ENTIRE agent-wallet
 * relay surface came to be unreachable, leaving pay/prepare, pay/commit, the
 * faucet and submit/execute unauthenticated in production — and how two of the
 * five circuit-breaker arms sat on code defaults however the .env was tuned.
 * Nothing failed; the knobs simply did nothing.
 *
 * This test is the guard: add a `process.env` read to config.ts and you must
 * wire it, or this fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "config.ts");
const MAINNET = join(here, "../../../ops/mainnet-standalone/docker-compose.yml");

/**
 * EVERY committed compose, not just the one that was on fire.
 *
 * This guard was written for ops/mainnet-standalone and hardcoded to it, so its
 * three siblings kept the exact defect its own docstring describes: measured
 * before this widening, ops/testnet omitted 58 of the vars config.ts reads,
 * ops/devnet 59, and packages/facilitator/docker-compose.production.yml 61 —
 * including CANTON_X402_AGENT_WALLET_KEY, which is the relay's ONLY auth gate
 * and whose absence fails OPEN, and CANTON_X402_TF_ENABLED, whose absence makes
 * the only settlement method refuse every payment.
 *
 * A file that declares `env_file:` forwards the whole .env and needs no hand
 * list, so it is exempt — that is the other honest way to close the class, and
 * it is what production and testnet now use.
 */
const COMPOSES = [
  MAINNET,
  join(here, "../docker-compose.production.yml"),
  join(here, "../../../ops/testnet/docker-compose.yml"),
  join(here, "../../../ops/devnet/docker-compose.yml"),
];

const readsOfConfig = (): Set<string> =>
  new Set(
    [...readFileSync(CONFIG, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(
      (m) => m[1]!
    )
  );

describe("every env var config.ts reads must be reachable in every committed compose", () => {
  const read = readsOfConfig();

  it("found the variables at all", () => {
    expect(read.size).toBeGreaterThan(50);
  });

  for (const compose of COMPOSES) {
    const name = compose.split("/").slice(-2).join("/");
    it(`${name} has no unwired variables`, () => {
      const text = readFileSync(compose, "utf8");
      // `env_file:` forwards the whole .env — nothing to hand-wire.
      if (/^\s*env_file:/m.test(text)) return;
      const unwired = [...read].filter((v) => !text.includes(v)).sort();
      expect(unwired).toEqual([]);
    });
  }

  it("the mainnet compose sets NO variable the facilitator stopped reading", () => {
    // The other direction, and the one that just bit us. This suite guarded
    // "config reads it, compose must wire it" and said nothing about "compose
    // wires it, but nothing reads it any more". When the stash carriage was
    // deleted, CANTON_X402_TF_STASH_CAP_PER_PAYER and
    // CANTON_X402_PAY_COMMIT_VERIFY stayed in the shipped compose and in the
    // deployment docs — knobs an operator can set, believe in, and get nothing
    // from. Silent no-ops are worse than missing options: they read as tuned.
    const text = readFileSync(MAINNET, "utf8");
    const setInCompose = [
      ...text.matchAll(/^\s*(CANTON_X402_[A-Z0-9_]+)\s*:/gm),
    ].map((m) => m[1]!);
    const dead = [...new Set(setInCompose)].filter((v) => !read.has(v)).sort();
    expect(dead).toEqual([]);
  });

  it("the mainnet compose still has no env_file, which is what makes ITS hand list load-bearing", () => {
    // The others may take either route; this one deliberately enumerates, so
    // its hand list must stay complete.
    expect(readFileSync(MAINNET, "utf8")).not.toMatch(/^\s*env_file:/m);
  });
});
