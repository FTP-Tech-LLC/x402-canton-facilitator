import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "./prepared-transfer.js";

// A REAL MainNet CBTC transfer to the Tradecraft CC/CBTC pool (a non-preapproved
// receiver), captured 2026-08-27. It takes the registry TWO-STEP OFFER shape:
// root TransferFactory_Transfer → AllocationFactory_TransferInternal + Archive,
// creating the sender's change Holdings + one TransferOffer to the pool. It also
// references CBTC's `cbtc-beneficiary` party, declared in the registrar's
// InstrumentConfiguration input contract (never a value owner / recipient).
const BYTES = readFileSync(
  new URL("../../agent-wallet/src/__fixtures__/mainnet-cbtc-registry-offer-to-pool.b64", import.meta.url),
  "utf8"
).trim();

const AGENT = "agent::12200c7b2b064db839c0f0ef6c027759e94f1d3abd0fed431624a6509776a809e03f";
const POOL = "tc-swp_CBTC-CC::122096fe076cc065af0cb38f94caa60e8ddfecbe8f0cfe10655ae7aa06fab99c66b7";
const CBTC_ADMIN = "cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262";
const DA_OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const CBTC_BENEFICIARY =
  "cbtc-beneficiary::1220409a9fcc5ff6422e29ab978c22c004dde33202546b4bcbde24b25b85353366c2";
/** preparationTime 1787828002964994µs → a nowMs inside the fixture's window. */
const NOW_MS = 1787828100000;

const base: PreparedTransferExpectation = {
  sender: AGENT,
  receiver: POOL,
  amount: "0.00002",
  instrumentId: "CBTC",
  instrumentAdmin: CBTC_ADMIN,
  trustedRegistryParties: new Set([DA_OPERATOR, CBTC_BENEFICIARY]),
  allowRegistryOffer: true,
  nowMs: NOW_MS,
};

describe("registry two-step offer to a Tradecraft pool (CBTC sell) — verify-before-sign", () => {
  it("accepts the honest offer shape when the caller opts in and trusts the registrar's parties", () => {
    expect(() => assertPreparedTransferMatches(BYTES, base)).not.toThrow();
  });

  it("REFUSES the same bytes without allowRegistryOffer — the offer shape is not admitted by default", () => {
    let err: unknown;
    try {
      assertPreparedTransferMatches(BYTES, { ...base, allowRegistryOffer: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    expect((err as Error).message).toMatch(
      /unexpected exercise\(s\) "AllocationFactory_TransferInternal"/
    );
  });

  it("REFUSES when cbtc-beneficiary is not a trusted registry party — the foreign-party backstop holds", () => {
    let err: unknown;
    try {
      assertPreparedTransferMatches(BYTES, {
        ...base,
        trustedRegistryParties: new Set([DA_OPERATOR]), // beneficiary NOT trusted
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreparedTransferMismatchError);
    expect((err as Error).message).toMatch(/references unexpected part/);
    expect((err as Error).message).toContain("cbtc-beneficiary");
  });

  it("REFUSES when the receiver is not the intended pool — the money barrier stays pinned", () => {
    expect(() =>
      assertPreparedTransferMatches(BYTES, {
        ...base,
        receiver: "attacker::1220deadbeef",
      })
    ).toThrow(PreparedTransferMismatchError);
  });
});
