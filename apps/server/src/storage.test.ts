import { describe, expect, it } from "vitest";
import type { Op } from "@collab/crdt";
import { MemoryStorage, StoredDataError, indexOps, validateStoredOps } from "./storage";
import { insertOp, runStorageContract } from "./storage-contract";

runStorageContract("memory", async () => ({
  storage: new MemoryStorage(),
  cleanup: async () => {},
}));

describe("validateStoredOps", () => {
  it("gives stored operations the same property order as received ones and drops extra fields", () => {
    const stored = { char: "a", origin: null, id: { siteId: "a", counter: 1 }, type: "insert", extra: 1 };
    const [op] = validateStoredOps("doc", [stored]) as [Op];
    const canonical = { type: "insert", id: { counter: 1, siteId: "a" }, origin: null, char: "a" };
    expect(JSON.stringify(op)).toBe(JSON.stringify(canonical));
  });

  it("refuses data that is not a valid operation", () => {
    for (const bad of [{ bogus: true }, null, 5, "x", { type: "insert" }]) {
      expect(() => validateStoredOps("doc", [bad])).toThrow(StoredDataError);
    }
  });
});

describe("indexOps", () => {
  it("builds the lookup table and the version vector", () => {
    const ops = [insertOp(1, "a"), insertOp(2, "a"), insertOp(1, "b")];
    const { seen, vector } = indexOps("doc", ops);
    expect(seen.size).toBe(3);
    expect([...vector].sort()).toEqual([["a", 2], ["b", 1]]);
  });

  it("accepts operations of different sites interleaved", () => {
    expect(() => indexOps("doc", [insertOp(5, "b"), insertOp(1, "a"), insertOp(6, "b")])).not.toThrow();
  });

  it("refuses a site whose counters go backwards", () => {
    expect(() => indexOps("doc", [insertOp(2, "a"), insertOp(1, "a")])).toThrow(StoredDataError);
  });

  it("refuses the same operation stored twice", () => {
    expect(() => indexOps("doc", [insertOp(1, "a"), insertOp(1, "a")])).toThrow(StoredDataError);
  });
});
