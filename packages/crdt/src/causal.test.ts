import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Rga, type Op } from "./rga";

function type(r: Rga, text: string): Op[] {
  return [...text].map((ch) => r.insertAt(r.length, ch));
}

describe("causal buffering", () => {
  it("parks an operation until its dependency arrives", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const [a, b] = type(alice, "ab") as [Op, Op];

    bob.apply(b); // 'b' depends on 'a', which has not arrived yet
    expect(bob.toString()).toBe("");
    expect(bob.pendingCount).toBe(1);

    bob.apply(a); // arrival of 'a' unblocks 'b'
    expect(bob.toString()).toBe("ab");
    expect(bob.pendingCount).toBe(0);
  });

  it("applies a whole chain delivered in reverse order", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const ops = type(alice, "hello world");
    for (const op of [...ops].reverse()) bob.apply(op);
    expect(bob.toString()).toBe("hello world");
    expect(bob.pendingCount).toBe(0);
  });

  it("handles a delete that arrives before the insert it targets", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const [a, b, c] = type(alice, "abc") as [Op, Op, Op];
    const del = alice.deleteAt(1);

    bob.apply(del); // target 'b' unknown yet
    expect(bob.pendingCount).toBe(1);
    bob.apply(a);
    bob.apply(b); // delete is applied right after 'b' lands
    bob.apply(c);
    expect(bob.toString()).toBe("ac");
    expect(bob.pendingCount).toBe(0);
  });

  it("does not queue the same pending operation twice", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const [, b] = type(alice, "ab") as [Op, Op];
    bob.apply(b);
    bob.apply(b);
    bob.apply(b);
    expect(bob.pendingCount).toBe(1);
  });

  it("converges for any delivery order of inserts and deletes", () => {
    // Build one history: type, then delete some characters.
    const alice = new Rga("alice");
    const ops: Op[] = type(alice, "collaborate");
    ops.push(alice.deleteAt(2), alice.deleteAt(5), alice.deleteAt(0));
    const expected = alice.toString();

    fc.assert(
      fc.property(fc.shuffledSubarray(ops, { minLength: ops.length }), (shuffled) => {
        const bob = new Rga("bob");
        for (const op of shuffled) bob.apply(op);
        expect(bob.toString()).toBe(expected);
        expect(bob.pendingCount).toBe(0);
      }),
    );
  });
});
