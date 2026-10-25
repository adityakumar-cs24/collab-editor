import { describe, it, expect } from "vitest";
import { Rga, type Op } from "./rga";

// Type a string at the end of a replica, returning the operations produced.
function type(r: Rga, text: string): Op[] {
  return [...text].map((ch) => r.insertAt(r.length, ch));
}

function deliver(to: Rga, ops: Op[]): void {
  for (const op of ops) to.apply(op);
}

describe("local editing", () => {
  it("types text", () => {
    const r = new Rga("alice");
    type(r, "hello");
    expect(r.toString()).toBe("hello");
  });

  it("inserts in the middle and at the start", () => {
    const r = new Rga("alice");
    type(r, "ac");
    r.insertAt(1, "b");
    r.insertAt(0, ">");
    expect(r.toString()).toBe(">abc");
  });

  it("deletes characters but keeps tombstones", () => {
    const r = new Rga("alice");
    type(r, "abc");
    r.deleteAt(1);
    expect(r.toString()).toBe("ac");
    expect(r.length).toBe(2);
    expect(r.nodeCount).toBe(3);
  });

  it("rejects out of range indexes", () => {
    const r = new Rga("alice");
    expect(() => r.insertAt(1, "x")).toThrow(RangeError);
    expect(() => r.deleteAt(0)).toThrow(RangeError);
  });
});

describe("replication", () => {
  it("a second replica reproduces the same text", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    deliver(bob, type(alice, "hello"));
    expect(bob.toString()).toBe("hello");
  });

  it("converges on the scenario that broke the naive version", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    deliver(bob, type(alice, "ABC"));

    // Concurrent: Alice inserts X after A, Bob deletes B.
    const aliceOp = alice.insertAt(1, "X");
    const bobOp = bob.deleteAt(1);

    alice.apply(bobOp);
    bob.apply(aliceOp);

    expect(alice.toString()).toBe("AXC");
    expect(bob.toString()).toBe("AXC");
  });

  it("orders concurrent inserts at the same spot identically everywhere", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    deliver(bob, type(alice, "AC"));

    const aliceOp = alice.insertAt(1, "X");
    const bobOp = bob.insertAt(1, "Y");

    alice.apply(bobOp);
    bob.apply(aliceOp);

    expect(alice.toString()).toBe(bob.toString());
    expect(alice.toString()).toBe("AYXC"); // same counter, "bob" > "alice", so Y goes first
  });

  it("is idempotent: applying the same operation twice changes nothing", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const ops = type(alice, "hey");
    deliver(bob, ops);
    deliver(bob, ops);
    expect(bob.toString()).toBe("hey");
    expect(bob.nodeCount).toBe(3);
  });

  it("two replicas deleting the same character is fine", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    deliver(bob, type(alice, "abc"));
    const a = alice.deleteAt(1);
    const b = bob.deleteAt(1);
    alice.apply(b);
    bob.apply(a);
    expect(alice.toString()).toBe("ac");
    expect(bob.toString()).toBe("ac");
  });

});
