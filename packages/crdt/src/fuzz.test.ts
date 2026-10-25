import { describe, it } from "vitest";
import fc from "fast-check";
import { simulate, expectConverged, type Action } from "./testing/simulate";

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant("edit" as const),
    replica: fc.nat(),
    del: fc.boolean(),
    pos: fc.nat(),
    char: fc.constantFrom("a", "b", "c", "x", "y", "z"),
  }),
  fc.record({
    kind: fc.constant("deliver" as const),
    replica: fc.nat(),
    pick: fc.nat(),
    dup: fc.boolean(),
  }),
);

describe("convergence under random concurrent edits", () => {
  it("3 replicas converge with shuffled and duplicated delivery", () => {
    fc.assert(
      fc.property(fc.array(arbAction, { minLength: 1, maxLength: 100 }), (actions) => {
        expectConverged(simulate(3, actions));
      }),
      { numRuns: 500 },
    );
  });

  it("10 replicas converge with shuffled and duplicated delivery", () => {
    fc.assert(
      fc.property(fc.array(arbAction, { minLength: 1, maxLength: 200 }), (actions) => {
        expectConverged(simulate(10, actions));
      }),
      { numRuns: 200 },
    );
  });
});
