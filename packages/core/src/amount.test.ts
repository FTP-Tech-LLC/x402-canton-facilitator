import { describe, it, expect } from "vitest";
import {
  CC_ATOMIC_SCALE,
  decimalToAtomicCC,
  atomicToDecimalCC,
  schemeIsAtomic,
  wireAmountToLedgerDecimal,
  ledgerDecimalToWireAmount,
  ledgerDecimalEquals,
  ledgerDecimalsMatch,
} from "./amount.js";

describe("CC amount-unit conversion (atomic <-> Decimal, 1 CC = 10^10)", () => {
  it("scale is 10 (Daml Decimal for Amulet)", () => {
    expect(CC_ATOMIC_SCALE).toBe(10);
  });

  describe("decimalToAtomicCC — representative amounts, EXACT (no off-by-10^10)", () => {
    it("1 atomic unit (smallest CC)", () => {
      expect(decimalToAtomicCC("0.0000000001")).toBe("1");
    });
    it("a non-round decimal", () => {
      expect(decimalToAtomicCC("0.0123456789")).toBe("123456789");
    });
    it("0.1 CC", () => {
      expect(decimalToAtomicCC("0.1")).toBe("1000000000");
    });
    it("0.1 CC with explicit 10dp form", () => {
      expect(decimalToAtomicCC("0.1000000000")).toBe("1000000000");
    });
    it("1 CC", () => {
      expect(decimalToAtomicCC("1.0000000000")).toBe("10000000000");
    });
    it("1 CC written as integer", () => {
      expect(decimalToAtomicCC("1")).toBe("10000000000");
    });
    it("the live MainNet v1 e2e amount 0.0100000000", () => {
      expect(decimalToAtomicCC("0.0100000000")).toBe("100000000");
    });
    it("a large value (no precision loss past 2^53)", () => {
      // 12,345,678.9 CC -> 123456789000000000 atomic. Number() would lose this.
      expect(decimalToAtomicCC("12345678.9")).toBe("123456789000000000");
    });
    it("zero", () => {
      expect(decimalToAtomicCC("0")).toBe("0");
      expect(decimalToAtomicCC("0.0000000000")).toBe("0");
    });
  });

  describe("atomicToDecimalCC — canonical fixed-scale output", () => {
    it("1 atomic -> 0.0000000001", () => {
      expect(atomicToDecimalCC("1")).toBe("0.0000000001");
    });
    it("123456789 -> 0.0123456789", () => {
      expect(atomicToDecimalCC("123456789")).toBe("0.0123456789");
    });
    it("10000000000 -> 1.0000000000", () => {
      expect(atomicToDecimalCC("10000000000")).toBe("1.0000000000");
    });
    it("large 123456789000000000 -> 12345678.9000000000", () => {
      expect(atomicToDecimalCC("123456789000000000")).toBe(
        "12345678.9000000000"
      );
    });
    it("zero", () => {
      expect(atomicToDecimalCC("0")).toBe("0.0000000000");
    });
  });

  describe("round-trip identity (the off-by-10^10 regression guard)", () => {
    for (const atomic of [
      "1",
      "100000000",
      "123456789",
      "1000000000",
      "10000000000",
      "123456789000000000",
      "0",
    ]) {
      it(`atomic ${atomic} survives atomic->dec->atomic`, () => {
        expect(decimalToAtomicCC(atomicToDecimalCC(atomic))).toBe(atomic);
      });
    }
    for (const dec of ["0.0000000001", "0.0100000000", "0.1", "1", "999.5"]) {
      it(`decimal ${dec} survives dec->atomic->dec (10dp normalized)`, () => {
        const back = atomicToDecimalCC(decimalToAtomicCC(dec));
        // back is the 10dp-normalized form; re-converting must be stable.
        expect(decimalToAtomicCC(back)).toBe(decimalToAtomicCC(dec));
      });
    }
  });

  describe("fail-closed on lossy / malformed input", () => {
    it("rejects a decimal with > 10 significant fractional digits", () => {
      expect(() => decimalToAtomicCC("0.00000000001")).toThrow(/precision/);
    });
    it("tolerates trailing zeros past the scale (not significant)", () => {
      expect(decimalToAtomicCC("0.10000000000000")).toBe("1000000000");
    });
    it("rejects non-numeric decimal", () => {
      expect(() => decimalToAtomicCC("abc")).toThrow(/invalid CC decimal/);
      expect(() => decimalToAtomicCC("-1")).toThrow(/invalid CC decimal/);
      expect(() => decimalToAtomicCC("1e10")).toThrow(/invalid CC decimal/);
    });
    it("rejects non-integer / non-numeric atomic", () => {
      expect(() => atomicToDecimalCC("1.5")).toThrow(/invalid CC atomic/);
      expect(() => atomicToDecimalCC("abc")).toThrow(/invalid CC atomic/);
      expect(() => atomicToDecimalCC("-1")).toThrow(/invalid CC atomic/);
    });
  });
});

describe("unit-by-scheme boundary (atomic-by-scheme, BACK-COMPAT)", () => {
  describe("schemeIsAtomic", () => {
    it('"exact" is atomic', () => {
      expect(schemeIsAtomic("exact")).toBe(true);
    });
    it('a non-exact scheme (e.g. "exact-evm") is NOT atomic (defensive passthrough)', () => {
      expect(schemeIsAtomic("exact-evm")).toBe(false);
    });
    it("any other scheme is treated as non-atomic (Decimal)", () => {
      expect(schemeIsAtomic("something-else")).toBe(false);
      expect(schemeIsAtomic("")).toBe(false);
    });
  });

  describe("wireAmountToLedgerDecimal — EXACT conversion at the boundary", () => {
    it('atomic scheme "exact": 1 atomic -> 0.0000000001', () => {
      expect(wireAmountToLedgerDecimal("exact", "1")).toBe("0.0000000001");
    });
    it('atomic scheme "exact": non-round decimal round-trips', () => {
      // 123456789 atomic == 0.0123456789 CC
      expect(wireAmountToLedgerDecimal("exact", "123456789")).toBe(
        "0.0123456789"
      );
    });
    it('atomic scheme "exact": value > 2^53 keeps full precision (BigInt)', () => {
      // 123456789000000000 atomic == 12345678.9 CC; Number() would lose this.
      expect(wireAmountToLedgerDecimal("exact", "123456789000000000")).toBe(
        "12345678.9000000000"
      );
    });
    it('non-exact scheme (e.g. "exact-evm"): Decimal passthrough (defensive — the validated path never reaches here with a non-exact scheme)', () => {
      expect(wireAmountToLedgerDecimal("exact-evm", "0.0100000000")).toBe(
        "0.0100000000"
      );
      expect(wireAmountToLedgerDecimal("exact-evm", "0.1")).toBe("0.1");
    });
    it("atomic scheme fail-closed on a non-integer wire value", () => {
      expect(() => wireAmountToLedgerDecimal("exact", "0.5")).toThrow(
        /invalid CC atomic/
      );
    });
  });

  describe("ledgerDecimalToWireAmount — inverse for the emit/builder seam", () => {
    it('atomic scheme "exact": 0.0000000001 -> "1"', () => {
      expect(ledgerDecimalToWireAmount("exact", "0.0000000001")).toBe("1");
    });
    it('atomic scheme "exact": 1 CC -> "10000000000"', () => {
      expect(ledgerDecimalToWireAmount("exact", "1")).toBe("10000000000");
    });
    it('non-exact scheme (e.g. "exact-evm"): passthrough (defensive)', () => {
      expect(ledgerDecimalToWireAmount("exact-evm", "0.0100000000")).toBe(
        "0.0100000000"
      );
    });
    it("round-trip wire->ledger->wire under atomic scheme is identity", () => {
      for (const a of ["1", "100000000", "123456789000000000"]) {
        const dec = wireAmountToLedgerDecimal("exact", a);
        expect(ledgerDecimalToWireAmount("exact", dec)).toBe(a);
      }
    });
  });

  describe("ledgerDecimalEquals — canonical Decimal value-equality", () => {
    it('folds "0.1" with "0.1000000000"', () => {
      expect(ledgerDecimalEquals("0.1", "0.1000000000")).toBe(true);
    });
    it("rejects a 10x difference", () => {
      expect(ledgerDecimalEquals("0.1", "1")).toBe(false);
    });
    it("rejects a 0.1x difference", () => {
      expect(ledgerDecimalEquals("1", "0.1")).toBe(false);
    });
    it("matches at 1-atomic granularity", () => {
      expect(ledgerDecimalEquals("0.0000000001", "0.0000000001")).toBe(true);
      expect(ledgerDecimalEquals("0.0000000001", "0.0000000002")).toBe(false);
    });
    it("throws on malformed input (strict variant)", () => {
      expect(() => ledgerDecimalEquals("abc", "0.1")).toThrow();
    });
  });

  describe("ledgerDecimalsMatch — non-throwing fail-closed validator variant", () => {
    it('folds "0.1" ≡ "0.1000000000"', () => {
      expect(ledgerDecimalsMatch("0.1", "0.1000000000")).toBe(true);
    });
    it("10x / 0.1x provably do not match", () => {
      expect(ledgerDecimalsMatch("0.1", "1")).toBe(false);
      expect(ledgerDecimalsMatch("1", "0.1")).toBe(false);
    });
    it("malformed input returns false (never throws)", () => {
      expect(ledgerDecimalsMatch("abc", "0.1")).toBe(false);
      expect(ledgerDecimalsMatch("0.1", "")).toBe(false);
      expect(
        ledgerDecimalsMatch(undefined as unknown as string, "0.1")
      ).toBe(false);
    });
  });
});
