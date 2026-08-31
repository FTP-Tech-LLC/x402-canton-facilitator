/**
 * A created holding must name the sender or the receiver.
 *
 * The party backstop admits the trusted registrar's whole NAMESPACE inside value
 * buckets, and it has to: registrars like onRails put per-user
 * `auth0_*::<their namespace>` parties inside legitimate holdings, and a cETH
 * swap is refused outright without them (measured on MainNet). That admission
 * alone would let a relay re-own the sender's CHANGE — everything the transfer
 * did not send — to a party under that namespace, with sender, receiver, amount
 * and instrument all still matching the caller's intent.
 *
 * So ownership is pinned separately: every `Holding` the tree creates is either
 * the receiver's delivery or the sender's change, and must name one of them.
 *
 * Measured on the real MainNet CBTC swap-to-pool transfer: the change `Holding`
 * names the agent at byte 6867. Re-owning that leaf to `eeeee::<registrar
 * namespace>` (same length, so the protobuf stays valid) must be REFUSED.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  decodePrepared,
  PreparedTransferMismatchError,
  partyNamespace,
  type PreparedTransferExpectation,
} from "./prepared-transfer.js";

const RAW = readFileSync(
  new URL("../../agent-wallet/src/__fixtures__/mainnet-cbtc-registry-offer-to-pool.b64", import.meta.url),
  "utf8"
).trim();

const AGENT = "agent::12200c7b2b064db839c0f0ef6c027759e94f1d3abd0fed431624a6509776a809e03f";
const CBTC_ADMIN = "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262";
const POOL = "tc-swp_CBTC-CC::122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";
const OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const BENEFICIARY =
  "cbtc-beneficiary::1220409a9fcc5ff6422e29ab978c22c004dde33202546b4bcbde24b25b85353366c2";
/** Inside the fixture's ledger-effective window. */
const NOW_MS = 1787828032964;

const base: PreparedTransferExpectation = {
  sender: AGENT,
  receiver: POOL,
  amount: "0.0000200000",
  instrumentId: "CBTC",
  instrumentAdmin: CBTC_ADMIN,
  trustedRegistryParties: new Set([OPERATOR, BENEFICIARY]),
  allowRegistryOffer: true,
  nowMs: NOW_MS,
};

/** Re-own the CHANGE holding (the first `Holding` create) to `to`, which must be
 *  the same byte length as the agent id so every length prefix stays valid. */
function reownChangeHolding(b64: string, to: string): string {
  expect(to.length).toBe(AGENT.length);
  const buf = Buffer.from(b64, "base64");
  const decoded = decodePrepared(b64) as unknown as {
    nodes: Array<{ create?: { argument?: Uint8Array; templateQualifiedName?: string } }>;
  };
  const change = decoded.nodes.find(
    (n) => n.create?.argument && n.create.templateQualifiedName?.endsWith("Holding:Holding")
  );
  if (!change?.create?.argument) throw new Error("fixture has no Holding create");
  const arg = Buffer.from(change.create.argument);
  const off = buf.indexOf(arg);
  expect(off).toBeGreaterThanOrEqual(0);
  const fromB = Buffer.from(AGENT, "utf8");
  let hits = 0;
  for (let i = buf.indexOf(fromB, off); i !== -1 && i < off + arg.length; i = buf.indexOf(fromB, i + 1)) {
    Buffer.from(to, "utf8").copy(buf, i);
    hits++;
  }
  expect(hits).toBeGreaterThan(0);
  return buf.toString("base64");
}

describe("a created holding must name the sender or the receiver", () => {
  it("accepts the honest registry offer to a pool — the swap path still works", () => {
    expect(() => assertPreparedTransferMatches(RAW, base)).not.toThrow();
  });

  it("REFUSES a change holding re-owned to a party under the registrar's own namespace", () => {
    const evil = `eeeee::${partyNamespace(CBTC_ADMIN)}`;
    expect(partyNamespace(evil)).toBe(partyNamespace(CBTC_ADMIN));
    let err: unknown;
    try {
      assertPreparedTransferMatches(reownChangeHolding(RAW, evil), base);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    expect((err as Error).message).toMatch(/naming neither the sender nor the receiver/i);
  });

  it("REFUSES a foreign namespace too — ownership is pinned regardless of who the party is", () => {
    const evil = `eeeee::1220${"ff".repeat(32)}`;
    let err: unknown;
    try {
      assertPreparedTransferMatches(reownChangeHolding(RAW, evil), base);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
  });
});
