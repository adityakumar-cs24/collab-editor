import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Rga, type Op } from "./rga";
import { missingOps, vectorsEqual } from "./vector";

function type(r: Rga, text: string): Op[] {
  return [...text].map((ch) => r.insertAt(r.length, ch));
}

describe("Rga.versionVector", () => {
  it("counts local inserts and deletes", () => {
    const alice = new Rga("alice");
    type(alice, "ab");
    alice.deleteAt(0);
    expect([...alice.versionVector()]).toEqual([["alice", 3]]);
  });

  it("counts remote operations once applied", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    for (const op of type(alice, "abc")) bob.apply(op);
    expect(bob.versionVector().get("alice")).toBe(3);
    expect(bob.versionVector().has("bob")).toBe(false);
  });

  it("counts operations that are still waiting for a dependency", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const [a, b] = type(alice, "ab") as [Op, Op];
    bob.apply(b); // parked: its origin has not arrived
    expect(bob.pendingCount).toBe(1);
    expect(bob.versionVector().get("alice")).toBe(2);
    bob.apply(a);
    expect(bob.versionVector().get("alice")).toBe(2);
  });

  it("is unchanged by duplicate operations", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const ops = type(alice, "abc");
    for (const op of ops) bob.apply(op);
    const before = bob.versionVector();
    for (const op of ops) bob.apply(op);
    expect(vectorsEqual(before, bob.versionVector())).toBe(true);
  });

  it("returns a copy, not a live view", () => {
    const alice = new Rga("alice");
    type(alice, "a");
    const copy = alice.versionVector();
    copy.set("alice", 99);
    expect(alice.versionVector().get("alice")).toBe(1);
  });
});

describe("missingOps", () => {
  const alice = new Rga("alice");
  const bob = new Rga("bob");
  const log: Op[] = [...type(alice, "abc"), ...type(bob, "xy")];

  it("returns everything for an empty vector", () => {
    expect(missingOps(log, new Map())).toEqual(log);
  });

  it("returns only operations above the counter known for each site", () => {
    const vector = new Map([
      ["alice", 2],
      ["bob", 1],
    ]);
    expect(missingOps(log, vector)).toEqual([log[2], log[4]]);
  });

  it("a replica holding any prefix of a log is brought up to date by the missing operations alone", () => {
    type Step =
      | { kind: "edit"; replica: number; del: boolean; pos: number; char: string }
      | { kind: "pull"; replica: number };

    const arbStep: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        kind: fc.constant("edit" as const),
        replica: fc.nat(2),
        del: fc.boolean(),
        pos: fc.nat(),
        char: fc.constantFrom("a", "b", "c"),
      }),
      fc.record({ kind: fc.constant("pull" as const), replica: fc.nat(2) }),
    );

    // The log is in creation order, which is a valid server arrival order:
    // each site's operations appear in increasing counter order.
    function buildLog(steps: readonly Step[]): Op[] {
      const replicas = [new Rga("site0"), new Rga("site1"), new Rga("site2")];
      const out: Op[] = [];
      for (const step of steps) {
        const replica = replicas[step.replica];
        if (replica === undefined) continue;
        if (step.kind === "pull") {
          for (const op of out) replica.apply(op);
        } else if (step.del) {
          if (replica.length > 0) out.push(replica.deleteAt(step.pos % replica.length));
        } else {
          out.push(replica.insertAt(step.pos % (replica.length + 1), step.char));
        }
      }
      return out;
    }

    fc.assert(
      fc.property(fc.array(arbStep, { maxLength: 80 }), fc.nat(), (steps, rawCut) => {
        const fullLog = buildLog(steps);
        const cut = rawCut % (fullLog.length + 1);

        const partial = new Rga("late");
        for (const op of fullLog.slice(0, cut)) partial.apply(op);

        const delta = missingOps(fullLog, partial.versionVector());
        expect(delta).toEqual(fullLog.slice(cut));

        for (const op of delta) partial.apply(op);
        const full = new Rga("late2");
        for (const op of fullLog) full.apply(op);

        expect(partial.toString()).toBe(full.toString());
        expect(partial.pendingCount).toBe(0);
        expect(vectorsEqual(partial.versionVector(), full.versionVector())).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
