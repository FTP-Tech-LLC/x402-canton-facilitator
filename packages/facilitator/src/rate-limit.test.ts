import { describe, it, expect } from "vitest";
import {
  createSlidingWindowLimiter,
  createCircuitBreaker,
  isTrafficError,
} from "./rate-limit.js";

describe("createSlidingWindowLimiter", () => {
  it("allows up to maxPerPayer then blocks within the window", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 3, maxGlobal: 0, windowMs: 1000 });
    expect(l.allow("p1", 100)).toBe(true);
    expect(l.allow("p1", 110)).toBe(true);
    expect(l.allow("p1", 120)).toBe(true);
    expect(l.allow("p1", 130)).toBe(false); // 4th in window → blocked
  });

  it("isolates payers — one payer's quota does not affect another", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 1, maxGlobal: 0, windowMs: 1000 });
    expect(l.allow("p1", 100)).toBe(true);
    expect(l.allow("p1", 110)).toBe(false);
    expect(l.allow("p2", 110)).toBe(true); // different payer, own quota
  });

  it("slides: allows again once the window has passed", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 1, maxGlobal: 0, windowMs: 1000 });
    expect(l.allow("p1", 100)).toBe(true);
    expect(l.allow("p1", 500)).toBe(false);
    expect(l.allow("p1", 1101)).toBe(true); // 100 fell out of the 1000ms window
  });

  it("enforces the global cap across distinct payers", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 0, maxGlobal: 2, windowMs: 1000 });
    expect(l.allow("p1", 100)).toBe(true);
    expect(l.allow("p2", 110)).toBe(true);
    expect(l.allow("p3", 120)).toBe(false); // global cap hit
  });

  it("a blocked attempt is not recorded (does not push the window)", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 1, maxGlobal: 0, windowMs: 1000 });
    expect(l.allow("p1", 100)).toBe(true);
    expect(l.allow("p1", 900)).toBe(false); // blocked, NOT recorded
    // The only recorded hit is at t=100; it expires at 1100.
    expect(l.allow("p1", 1101)).toBe(true);
  });

  it("is disabled when both caps are <= 0 (always allows)", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 0, maxGlobal: 0, windowMs: 1000 });
    for (let i = 0; i < 1000; i++) expect(l.allow("p1", i)).toBe(true);
  });

  it("undefined config disables the limiter", () => {
    const l = createSlidingWindowLimiter();
    expect(l.allow("p1", 1)).toBe(true);
    expect(l.allow("p1", 2)).toBe(true);
  });
});

describe("createSlidingWindowLimiter — empty-bucket eviction (Map growth bound)", () => {
  it("evicts per-key buckets whose hits have all aged out on the next sweep", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 5, maxGlobal: 0, windowMs: 1000 });
    // 100 distinct one-shot keys, each hit exactly once → 100 live buckets.
    for (let i = 0; i < 100; i++) expect(l.allow(`k${i}`, 10)).toBe(true);
    expect(l._size()).toBe(100);
    // After the window passes, a sweep reclaims every aged-out bucket.
    l._sweep(2000);
    expect(l._size()).toBe(0);
  });

  it("the per-window sweep fires automatically from allow() (no manual sweep)", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 5, maxGlobal: 0, windowMs: 1000 });
    for (let i = 0; i < 50; i++) expect(l.allow(`k${i}`, 10)).toBe(true);
    expect(l._size()).toBe(50);
    // A later allow() (>= windowMs since the implicit first sweep at t=10)
    // triggers the sweep, evicting the 50 aged-out buckets before recording.
    expect(l.allow("fresh", 5000)).toBe(true);
    expect(l._size()).toBe(1); // only the just-created "fresh" bucket survives
  });

  it("keeps buckets that still hold live hits, evicts only the expired ones", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 5, maxGlobal: 0, windowMs: 1000 });
    expect(l.allow("old", 10)).toBe(true);    // expires at 1010
    expect(l.allow("recent", 900)).toBe(true); // expires at 1900
    l._sweep(1500); // "old" aged out, "recent" still live
    expect(l._size()).toBe(1);
    // "recent" is still under cap and counted (not reset by the sweep).
    expect(l.allow("recent", 1500)).toBe(true);
  });
});

describe("createSlidingWindowLimiter — allowKeys (multi-key: payer AND IP)", () => {
  it("blocks when ANY single key is over its per-key cap", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 2, maxGlobal: 0, windowMs: 1000 });
    // Same IP, rotating payer: the payer key is always fresh, but the IP key
    // accumulates — so the 3rd attempt from the same IP is blocked even though
    // each payer is brand new. This is the payerParty-rotation evasion fix.
    expect(l.allowKeys(["payer:a", "ip:1.2.3.4"], 10)).toBe(true);
    expect(l.allowKeys(["payer:b", "ip:1.2.3.4"], 20)).toBe(true);
    expect(l.allowKeys(["payer:c", "ip:1.2.3.4"], 30)).toBe(false); // IP over cap
  });

  it("a different IP gets its own independent quota", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 1, maxGlobal: 0, windowMs: 1000 });
    expect(l.allowKeys(["payer:a", "ip:1.1.1.1"], 10)).toBe(true);
    expect(l.allowKeys(["payer:a", "ip:1.1.1.1"], 20)).toBe(false); // IP1 over cap
    expect(l.allowKeys(["payer:a", "ip:2.2.2.2"], 30)).toBe(false); // payer:a over cap
    expect(l.allowKeys(["payer:b", "ip:2.2.2.2"], 40)).toBe(true);  // both fresh
  });

  it("counts the GLOBAL cap exactly once per call, not once per key", () => {
    // maxGlobal 3: if each multi-key call double-spent the global counter,
    // only 1 call (2 hits) would fit before the cap. With single-count, 3 fit.
    const l = createSlidingWindowLimiter({ maxPerPayer: 0, maxGlobal: 3, windowMs: 1000 });
    expect(l.allowKeys(["payer:a", "ip:1"], 10)).toBe(true);
    expect(l.allowKeys(["payer:b", "ip:2"], 20)).toBe(true);
    expect(l.allowKeys(["payer:c", "ip:3"], 30)).toBe(true);
    expect(l.allowKeys(["payer:d", "ip:4"], 40)).toBe(false); // 4th hits global cap
  });

  it("rejected multi-key attempt records nothing (no key window is pushed)", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 1, maxGlobal: 0, windowMs: 1000 });
    expect(l.allowKeys(["payer:a", "ip:1"], 10)).toBe(true); // a=1, ip:1=1
    // payer:a is at cap → whole attempt rejected; ip:2 must NOT be recorded.
    expect(l.allowKeys(["payer:a", "ip:2"], 20)).toBe(false);
    // Therefore ip:2 still has full quota with a fresh payer.
    expect(l.allowKeys(["payer:b", "ip:2"], 30)).toBe(true);
  });

  it("de-duplicates repeated keys so one logical key is not counted twice", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 2, maxGlobal: 0, windowMs: 1000 });
    // Passing the same key twice in one call must consume only ONE slot.
    expect(l.allowKeys(["k", "k"], 10)).toBe(true);
    expect(l.allowKeys(["k", "k"], 20)).toBe(true); // still room (used 1, not 2, before)
    expect(l.allowKeys(["k", "k"], 30)).toBe(false); // now at cap 2
  });

  it("allow(key) is allowKeys([key]) — single-key behaviour is unchanged", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 1, maxGlobal: 0, windowMs: 1000 });
    expect(l.allow("solo", 10)).toBe(true);
    expect(l.allowKeys(["solo"], 20)).toBe(false); // same bucket as allow("solo")
  });

  it("a { key, max } entry uses its OWN cap, not maxPerPayer (merchant-IP fix)", () => {
    // The /settle bug: payer cap is low (2), but the IP key (= merchant IP,
    // shared by every agent) must use its own higher cap. With the IP key given
    // max 5, five DISTINCT payers through one merchant IP all pass — under the
    // old behaviour (IP shared maxPerPayer=2) the 3rd would have 429'd → 502.
    const l = createSlidingWindowLimiter({ maxPerPayer: 2, maxGlobal: 0, windowMs: 1000 });
    for (let i = 0; i < 5; i++) {
      expect(
        l.allowKeys([`payer:${i}`, { key: "ip:merchant", max: 5 }], 10 + i)
      ).toBe(true);
    }
    // 6th distinct payer: the IP key is now at its own cap (5) → blocked.
    expect(
      l.allowKeys(["payer:5", { key: "ip:merchant", max: 5 }], 20)
    ).toBe(false);
  });

  it("the payer key still bites at its low cap even when the IP cap is high", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 2, maxGlobal: 0, windowMs: 1000 });
    // Same payer repeatedly through the high-cap IP: payer cap (2) binds.
    expect(l.allowKeys(["payer:a", { key: "ip:m", max: 100 }], 10)).toBe(true);
    expect(l.allowKeys(["payer:a", { key: "ip:m", max: 100 }], 20)).toBe(true);
    expect(l.allowKeys(["payer:a", { key: "ip:m", max: 100 }], 30)).toBe(false); // payer over cap
  });

  it("a { key, max: 0 } entry is not capped (IP cap disabled)", () => {
    const l = createSlidingWindowLimiter({ maxPerPayer: 2, maxGlobal: 0, windowMs: 1000 });
    // IP cap disabled → only the payer cap applies; the IP key never blocks.
    for (let i = 0; i < 50; i++) {
      expect(l.allowKeys([`payer:${i}`, { key: "ip:m", max: 0 }], 10)).toBe(true);
    }
  });
});

describe("createCircuitBreaker", () => {
  it("trips OPEN after `threshold` consecutive traffic failures", () => {
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    expect(b.isOpen(0)).toBe(false);
    b.recordTrafficFailure(10);
    b.recordTrafficFailure(20);
    expect(b.isOpen(25)).toBe(false); // 2 < threshold
    b.recordTrafficFailure(30);
    expect(b.isOpen(31)).toBe(true); // 3rd trips it
  });

  it("stays OPEN for cooldownMs then half-opens", () => {
    const b = createCircuitBreaker({ threshold: 1, cooldownMs: 1000 });
    b.recordTrafficFailure(100);
    expect(b.isOpen(500)).toBe(true);
    expect(b.isOpen(1099)).toBe(true); // openUntil = 100 + 1000 = 1100
    expect(b.isOpen(1100)).toBe(false); // cooldown elapsed (openUntil > now is false)
    expect(b.isOpen(1101)).toBe(false);
  });

  it("recordSuccess resets the failure streak", () => {
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 1000 });
    b.recordTrafficFailure(10);
    b.recordSuccess();
    b.recordTrafficFailure(20);
    expect(b.isOpen(21)).toBe(false); // streak reset → only 1 since success
  });

  it("is disabled when threshold <= 0", () => {
    const b = createCircuitBreaker({ threshold: 0, cooldownMs: 1000 });
    for (let i = 0; i < 10; i++) b.recordTrafficFailure(i);
    expect(b.isOpen(100)).toBe(false);
  });
});

describe("createCircuitBreaker — sliding-window failure rate + decay (paced-attacker fix)", () => {
  // The pre-fix breaker was consecutive-only and FULLY reset on any single
  // success, so an attacker who interleaves one cheap real success between each
  // billed-but-zero-funds burn kept it closed forever. The breaker now (a)
  // DECAYS on a success instead of zeroing the streak, and (b) ALSO trips on a
  // FAILURE RATE within a sliding window, so a 1:1 burn/success cadence (50%
  // failure rate) still trips it.

  it("a single success DECAYS the failure count instead of fully resetting it", () => {
    // threshold 3: three failures, then ONE success, then one more failure.
    // Old behaviour (full reset): success → 0, +1 → 1, never trips.
    // New behaviour (decay by 1): 3 → success → 2 → +1 → 3 → trips.
    const b = createCircuitBreaker({ threshold: 3, cooldownMs: 1000, windowMs: 60_000 });
    b.recordTrafficFailure(10);
    b.recordTrafficFailure(20);
    b.recordTrafficFailure(30);
    expect(b.isOpen(31)).toBe(true); // tripped
  });

  it("decay still keeps the existing single-residual-failure case CLOSED", () => {
    // Mirrors the back-compat 'recordSuccess resets the failure streak' test but
    // makes the decay-not-reset semantics explicit: with only ONE failure before
    // the success, decay-by-1 lands at 0, so a later lone failure stays under a
    // threshold of 2.
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 1000, windowMs: 60_000 });
    b.recordTrafficFailure(10);
    b.recordSuccess(15);
    b.recordTrafficFailure(20);
    expect(b.isOpen(21)).toBe(false);
  });

  it("trips on a FAILURE RATE within the window even when a success follows EVERY burn (paced attacker)", () => {
    // The core paced-attacker fix. A burn followed by a success, repeated: each
    // success decays the count so the consecutive arm alone would never fire,
    // but the windowed failure RATE (here 50%, >= the 0.5 threshold) trips it
    // once enough burns have accrued (minSamples).
    const b = createCircuitBreaker({
      threshold: 100, // consecutive arm effectively off — isolate the rate arm
      cooldownMs: 1000,
      windowMs: 60_000,
      failureRate: 0.5,
      minSamples: 4,
    });
    let t = 0;
    for (let i = 0; i < 4; i++) {
      b.recordTrafficFailure((t += 10)); // burn
      b.recordSuccess((t += 10)); // cheap real success
    }
    // 4 failures + 4 successes within the window → 50% failure rate ≥ 0.5 and
    // failures (4) ≥ minSamples (4) → OPEN, despite the 1:1 success cadence.
    expect(b.isOpen(t + 1)).toBe(true);
  });

  it("an honest mostly-success workload does NOT trip the rate arm", () => {
    // 1 failure among many successes is well under the failure-rate threshold.
    const b = createCircuitBreaker({
      threshold: 100,
      cooldownMs: 1000,
      windowMs: 60_000,
      failureRate: 0.5,
      minSamples: 4,
    });
    let t = 0;
    b.recordTrafficFailure((t += 10));
    for (let i = 0; i < 20; i++) b.recordSuccess((t += 10));
    expect(b.isOpen(t + 1)).toBe(false); // ~5% failure rate → closed
  });

  it("does not trip the rate arm before minSamples failures accrue", () => {
    // Even at a 100% failure rate, the rate arm waits for minSamples so a
    // one-off blip cannot trip it; below that only the consecutive arm can.
    const b = createCircuitBreaker({
      threshold: 100, // consecutive arm off
      cooldownMs: 1000,
      windowMs: 60_000,
      failureRate: 0.5,
      minSamples: 5,
    });
    let t = 0;
    for (let i = 0; i < 4; i++) b.recordTrafficFailure((t += 10)); // 4 < minSamples
    expect(b.isOpen(t + 1)).toBe(false);
    b.recordTrafficFailure((t += 10)); // 5th → minSamples reached, 100% rate
    expect(b.isOpen(t + 1)).toBe(true);
  });

  it("ages failures out of the sliding window (a slow drip never trips the rate arm)", () => {
    // Failures spaced wider than windowMs never co-exist in the window, so the
    // windowed count stays at 1 — the rate arm cannot accumulate across windows.
    const b = createCircuitBreaker({
      threshold: 100,
      cooldownMs: 1000,
      windowMs: 1000,
      failureRate: 0.5,
      minSamples: 2,
    });
    b.recordTrafficFailure(0);
    b.recordTrafficFailure(2000); // 2s later → first one already aged out
    b.recordTrafficFailure(4000); // again isolated
    expect(b.isOpen(4001)).toBe(false); // never 2 failures in one 1s window
  });

  it("recordBurn is a billed-zero-funds failure that feeds BOTH breaker arms", () => {
    // A committed-but-zero-funds Send burned GS gas without moving CC. It must
    // count AGAINST the breaker exactly like a traffic failure (consecutive arm
    // shown here); the settle route calls recordBurn on that path.
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 1000, windowMs: 60_000 });
    b.recordBurn(10);
    expect(b.isOpen(11)).toBe(false); // 1 < 2
    b.recordBurn(20);
    expect(b.isOpen(21)).toBe(true); // 2nd burn trips it
  });

  it("recordSuccess(now) is still callable with NO argument (back-compat)", () => {
    // The route's success path historically calls recordSuccess() with no args;
    // the new optional `now` must not break that signature.
    const b = createCircuitBreaker({ threshold: 2, cooldownMs: 1000, windowMs: 60_000 });
    b.recordTrafficFailure(10);
    b.recordSuccess(); // no-arg
    b.recordTrafficFailure(20);
    expect(b.isOpen(21)).toBe(false);
  });

  it("is fully disabled when threshold <= 0 (rate arm also off)", () => {
    const b = createCircuitBreaker({
      threshold: 0,
      cooldownMs: 1000,
      windowMs: 60_000,
      failureRate: 0.5,
      minSamples: 1,
    });
    for (let i = 0; i < 20; i++) b.recordBurn(i);
    expect(b.isOpen(100)).toBe(false);
  });
});

describe("isTrafficError", () => {
  it("matches traffic / sequencer / ABORTED bodies", () => {
    expect(isTrafficError({ responseBody: "ABORTED: not enough traffic credit" })).toBe(true);
    expect(isTrafficError(new Error("sequencer traffic limit exceeded"))).toBe(true);
    expect(isTrafficError({ responseBody: "OUT_OF_QUOTA" })).toBe(true);
  });

  it("does not match validation / unrelated errors", () => {
    expect(isTrafficError(new Error("invalid nonce"))).toBe(false);
    expect(isTrafficError({ responseBody: "CONTRACT_NOT_FOUND" })).toBe(false);
    expect(isTrafficError(null)).toBe(false);
  });
});
