import { describe, it, expect } from "vitest";
import { LamportClock } from "./clock";

describe("LamportClock", () => {
  it("starts at 0 and increases on tick", () => {
    const c = new LamportClock();
    expect(c.current).toBe(0);
    expect(c.tick()).toBe(1);
    expect(c.tick()).toBe(2);
  });

  it("jumps forward when it observes a larger remote counter", () => {
    const c = new LamportClock();
    c.tick();
    c.observe(10);
    expect(c.current).toBe(10);
    expect(c.tick()).toBe(11);
  });

  it("never goes backward when it observes a smaller counter", () => {
    const c = new LamportClock();
    c.observe(10);
    c.observe(3);
    expect(c.current).toBe(10);
  });

  it("an operation made after observing another gets a larger counter", () => {
    const alice = new LamportClock();
    const bob = new LamportClock();
    const aliceOp = alice.tick();
    bob.observe(aliceOp);
    const bobOp = bob.tick();
    expect(bobOp).toBeGreaterThan(aliceOp);
  });
});
