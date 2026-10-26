import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CharId, Op } from "@collab/crdt";
import type { OpStorage } from "./storage";

export interface StorageHarness {
  storage: OpStorage;
  cleanup: () => Promise<void>;
}

export function insertOp(counter: number, siteId: string, char = "a", origin: CharId | null = null): Op {
  return { type: "insert", id: { counter, siteId }, origin, char };
}

export function deleteOp(counter: number, siteId: string, target: CharId): Op {
  return { type: "delete", id: { counter, siteId }, target };
}

// Every storage implementation must pass these.
export function runStorageContract(name: string, open: () => Promise<StorageHarness>): void {
  describe(`${name} storage contract`, () => {
    let harness!: StorageHarness;

    beforeEach(async () => {
      harness = await open();
    });

    afterEach(async () => {
      await harness?.cleanup(); // harness is missing when opening failed
    });

    it("loads nothing for an unknown document", async () => {
      expect(await harness.storage.load("nothing")).toEqual([]);
    });

    it("returns appended operations in the order they were appended", async () => {
      const ops = [insertOp(1, "a", "x"), insertOp(2, "a", "y"), insertOp(3, "a", "z")];
      for (const op of ops) await harness.storage.append("doc", op);
      expect(await harness.storage.load("doc")).toEqual(ops);
    });

    it("keeps documents separate", async () => {
      await harness.storage.append("one", insertOp(1, "a"));
      await harness.storage.append("two", insertOp(1, "a", "b"));
      expect(await harness.storage.load("one")).toEqual([insertOp(1, "a")]);
      expect(await harness.storage.load("two")).toEqual([insertOp(1, "a", "b")]);
    });

    it("stores an operation once when it is appended twice", async () => {
      const op = insertOp(1, "a");
      await harness.storage.append("doc", op);
      await harness.storage.append("doc", op);
      expect(await harness.storage.load("doc")).toEqual([op]);
    });

    it("keeps arrival order, not counter order, across sites", async () => {
      const arrival = [
        insertOp(5, "b"),
        insertOp(1, "a"),
        insertOp(6, "b"),
        insertOp(2, "a"),
        insertOp(3, "a"),
      ];
      for (const op of arrival) await harness.storage.append("doc", op);
      expect(await harness.storage.load("doc")).toEqual(arrival);
    });

    it("returns inserts (with and without an origin) and deletes unchanged", async () => {
      const first: CharId = { counter: 1, siteId: "a" };
      const ops = [insertOp(1, "a", "x", null), insertOp(2, "a", "y", first), deleteOp(3, "a", first)];
      for (const op of ops) await harness.storage.append("doc", op);
      expect(await harness.storage.load("doc")).toEqual(ops);
    });

    it("handles a few hundred appends in order", async () => {
      for (let i = 1; i <= 300; i++) await harness.storage.append("doc", insertOp(i, "a"));
      const loaded = (await harness.storage.load("doc")) as Op[];
      expect(loaded).toHaveLength(300);
      expect(loaded.map((op) => op.id.counter)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    });
  });
}
