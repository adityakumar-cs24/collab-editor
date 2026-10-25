import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { makeId, compareIds, idEquals, idKey } from "./id";

describe("compareIds", () => {
  it("orders by counter first", () => {
    expect(compareIds(makeId(1, "z"), makeId(2, "a"))).toBeLessThan(0);
    expect(compareIds(makeId(3, "a"), makeId(2, "z"))).toBeGreaterThan(0);
  });

  it("breaks counter ties by siteId", () => {
    expect(compareIds(makeId(5, "a"), makeId(5, "b"))).toBeLessThan(0);
    expect(compareIds(makeId(5, "b"), makeId(5, "a"))).toBeGreaterThan(0);
  });

  it("returns 0 for equal ids", () => {
    expect(compareIds(makeId(5, "a"), makeId(5, "a"))).toBe(0);
    expect(idEquals(makeId(5, "a"), makeId(5, "a"))).toBe(true);
  });

  // Property tests: the order must be a valid total order, or replicas can disagree.
  const arbId = fc.record({
    counter: fc.integer({ min: 0, max: 20 }),
    siteId: fc.constantFrom("a", "b", "c"),
  });

    it("is antisymmetric", () => {
    fc.assert(
      fc.property(arbId, arbId, (a, b) => {
        // Compare with === so that +0 and -0 count as equal.
        const forward = Math.sign(compareIds(a, b));
        const backward = Math.sign(compareIds(b, a));
        expect(forward === -backward).toBe(true);
      }),
    );
  });

  it("is transitive", () => {
    fc.assert(
      fc.property(arbId, arbId, arbId, (a, b, c) => {
        if (compareIds(a, b) <= 0 && compareIds(b, c) <= 0) {
          expect(compareIds(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it("idKey is unique per distinct id", () => {
    fc.assert(
      fc.property(arbId, arbId, (a, b) => {
        expect(idKey(a) === idKey(b)).toBe(idEquals(a, b));
      }),
    );
  });
});
