import { describe, it, expect } from "vitest";
import { PayerNonceGuard } from "./payer-nonce-guard.js";

describe("PayerNonceGuard", () => {
  const PAYER = "alice::1220abc";
  const OTHER = "bob::1220def";

  describe("reserve — concurrent same-nonce window (a)", () => {
    it("first reservation succeeds; an identical live (payer, nonce) is refused", () => {
      const g = new PayerNonceGuard();
      expect(g.reserve(PAYER, 5n, 1_000)).toBe(true);
      // Same payer + nonce, still within TTL → the concurrent duplicate.
      expect(g.reserve(PAYER, 5n, 1_001)).toBe(false);
    });

    it("a DIFFERENT nonce for the same payer is allowed (legit next payment)", () => {
      const g = new PayerNonceGuard();
      expect(g.reserve(PAYER, 5n, 1_000)).toBe(true);
      expect(g.reserve(PAYER, 6n, 1_000)).toBe(true);
    });

    it("the SAME nonce for a DIFFERENT payer is allowed (per-payer isolation)", () => {
      const g = new PayerNonceGuard();
      expect(g.reserve(PAYER, 5n, 1_000)).toBe(true);
      expect(g.reserve(OTHER, 5n, 1_000)).toBe(true);
    });

    it("a reservation self-expires by TTL so the same nonce can be re-reserved later", () => {
      const g = new PayerNonceGuard(30_000);
      expect(g.reserve(PAYER, 5n, 1_000)).toBe(true);
      // Just before expiry: still blocked.
      expect(g.reserve(PAYER, 5n, 30_999)).toBe(false);
      // At/after expiry (1_000 + 30_000): free again.
      expect(g.reserve(PAYER, 5n, 31_000)).toBe(true);
    });
  });

  describe("high-water — sequential Scan-lag window (b)", () => {
    it("committedHighWater is null until a commit is recorded", () => {
      const g = new PayerNonceGuard();
      expect(g.committedHighWater(PAYER)).toBeNull();
    });

    it("markCommitted advances the high-water monotonically (never regresses)", () => {
      const g = new PayerNonceGuard();
      g.markCommitted(PAYER, 5n);
      expect(g.committedHighWater(PAYER)).toBe(5n);
      g.markCommitted(PAYER, 7n);
      expect(g.committedHighWater(PAYER)).toBe(7n);
      // A lower/equal nonce does not regress the high-water.
      g.markCommitted(PAYER, 3n);
      expect(g.committedHighWater(PAYER)).toBe(7n);
      g.markCommitted(PAYER, 7n);
      expect(g.committedHighWater(PAYER)).toBe(7n);
    });

    it("tracks high-water independently per payer", () => {
      const g = new PayerNonceGuard();
      g.markCommitted(PAYER, 5n);
      expect(g.committedHighWater(OTHER)).toBeNull();
      g.markCommitted(OTHER, 2n);
      expect(g.committedHighWater(PAYER)).toBe(5n);
      expect(g.committedHighWater(OTHER)).toBe(2n);
    });
  });

  describe("bounded memory", () => {
    it("evicts the oldest payer's high-water once maxPayers is exceeded", () => {
      const g = new PayerNonceGuard(30_000, 2);
      g.markCommitted("p1", 1n);
      g.markCommitted("p2", 1n);
      g.markCommitted("p3", 1n); // exceeds cap of 2 → p1 (oldest) evicted
      expect(g.committedHighWater("p1")).toBeNull();
      expect(g.committedHighWater("p2")).toBe(1n);
      expect(g.committedHighWater("p3")).toBe(1n);
    });

    it("re-advancing a payer's high-water refreshes its recency (not evicted next)", () => {
      const g = new PayerNonceGuard(30_000, 2);
      g.markCommitted("p1", 1n);
      g.markCommitted("p2", 1n);
      g.markCommitted("p1", 2n); // p1 re-inserted as newest → p2 now oldest
      g.markCommitted("p3", 1n); // evicts p2, keeps p1
      expect(g.committedHighWater("p1")).toBe(2n);
      expect(g.committedHighWater("p2")).toBeNull();
      expect(g.committedHighWater("p3")).toBe(1n);
    });
  });
});
