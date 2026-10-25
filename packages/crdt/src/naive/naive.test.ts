import { describe, it, expect } from "vitest";
import { NaiveReplica, type NaiveOp } from "./naive";

describe("naive index-based sync", () => {
  it("diverges when two users edit concurrently", () => {
    const alice = new NaiveReplica("ABC");
    const bob = new NaiveReplica("ABC");

    // Both edit at the same moment, before seeing each other's change.
    const aliceOp: NaiveOp = { type: "insert", index: 1, char: "X" }; // A X B C
    const bobOp: NaiveOp = { type: "delete", index: 1 };              // A C (deletes B)

    // Each applies their own edit locally.
    alice.apply(aliceOp);
    bob.apply(bobOp);

    // Then they exchange operations.
    alice.apply(bobOp);
    bob.apply(aliceOp);

    // Alice deleted X (wrong character), Bob kept X and lost B.
    expect(alice.text).toBe("ABC");
    expect(bob.text).toBe("AXC");
    expect(alice.text).not.toBe(bob.text); // the replicas have diverged
  });
});
