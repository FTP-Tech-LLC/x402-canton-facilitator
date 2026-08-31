import { describe, it, expect } from "vitest";
import { createInMemoryRedeemedStore } from "./redeemed-store.js";

describe("createInMemoryRedeemedStore", () => {
  it("the first claim wins and every later one loses", () => {
    const s = createInMemoryRedeemedStore();
    expect(s.claim("1220-a")).toBe(true);
    expect(s.claim("1220-a")).toBe(false);
    expect(s.claim("1220-a")).toBe(false);
  });

  it("distinct ids do not interfere", () => {
    const s = createInMemoryRedeemedStore();
    expect(s.claim("1220-a")).toBe(true);
    expect(s.claim("1220-b")).toBe(true);
    expect(s.claim("1220-a")).toBe(false);
  });

  it("a claim expires after the TTL, because the payment it guards has too", () => {
    // The window only has to outlive the payment's own replay window (the
    // transfer's executeBefore). Once the transfer can no longer be settled it
    // can no longer be replayed either, so holding the id forever would only
    // grow memory.
    let now = 1_000;
    const s = createInMemoryRedeemedStore({ ttlMs: 100, now: () => now });
    expect(s.claim("1220-a")).toBe(true);
    now += 99;
    expect(s.claim("1220-a")).toBe(false);
    now += 2; // past the TTL
    expect(s.claim("1220-a")).toBe(true);
  });

  it("stays bounded under a flood of distinct ids", () => {
    // A merchant serving real traffic must not be turned into a memory leak by
    // its own success, and an attacker must not be able to grow this on demand.
    const s = createInMemoryRedeemedStore({ maxSize: 10 });
    for (let i = 0; i < 1000; i++) expect(s.claim("id-" + i)).toBe(true);
    // The most recent id is still remembered — eviction takes the OLDEST.
    expect(s.claim("id-999")).toBe(false);
    // ...and a long-evicted one is claimable again. That is the deliberate
    // trade: bounded memory over an unbounded guarantee. It matters only for a
    // replay arriving after maxSize distinct payments, by which point the
    // payment's own executeBefore has almost certainly passed anyway.
    expect(s.claim("id-0")).toBe(true);
  });

  it("re-claiming after expiry restores insertion order rather than keeping the old slot", () => {
    // Regression guard for the eviction loop: if an expired entry were
    // overwritten in place it would keep its ORIGINAL position, and the
    // oldest-first sweep would then evict entries that are still live.
    let now = 1_000;
    const s = createInMemoryRedeemedStore({ ttlMs: 50, maxSize: 3, now: () => now });
    s.claim("old");
    now += 60; // "old" expires
    s.claim("b");
    s.claim("c");
    expect(s.claim("old")).toBe(true); // re-inserted as the NEWEST
    s.claim("d"); // pushes the cap; the oldest live entry ("b") goes first
    expect(s.claim("old")).toBe(false); // "old" survived — it is not the oldest
  });
});

describe("the ticket must outlive the window the payment can still settle in", () => {
  // The facilitator answers a replayed inline settle from its recorded success
  // — no submission, no traffic — for 24 h. The merchant's ticket used to
  // expire at 1 h, so the same payment bought the resource again every hour
  // until the record was swept.
  const at = (ms: number) => {
    let t = 0;
    const store = createInMemoryRedeemedStore({ now: () => t });
    return {
      claimAt(when: number) {
        t = when;
        return store.claim("1220-settled");
      },
    };
  };

  it("a replay is still refused across the whole 24 h the facilitator remembers", () => {
    const s = at(0);
    expect(s.claimAt(0)).toBe(true); // first delivery
    expect(s.claimAt(60 * 60_000)).toBe(false); // the old expiry — used to be true
    expect(s.claimAt(23 * 60 * 60_000)).toBe(false);
    expect(s.claimAt(24 * 60 * 60_000)).toBe(false); // facilitator sweeps here
  });

  it("but it still expires — the store stays bounded", () => {
    // The discriminator. "Remember forever" would be a memory leak keyed by an
    // attacker-visible id; the ticket only has to outlive the replay window,
    // not the process.
    const s = at(0);
    expect(s.claimAt(0)).toBe(true);
    expect(s.claimAt(26 * 60 * 60_000)).toBe(true);
  });
});
