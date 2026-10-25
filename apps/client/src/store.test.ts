import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { Rga, idKey, type Op } from "@collab/crdt";
import { MemoryStore, loadDoc, openDoc, openIdbStore, type DocStore, type RawStoredDoc } from "./store";

let dbCounter = 0;
const factories: Array<[string, () => Promise<DocStore>]> = [
  ["memory", async () => new MemoryStore()],
  ["indexeddb", () => openIdbStore(`test-store-${dbCounter++}`)],
];

function makeOps(siteId: string, text: string): Op[] {
  const rga = new Rga(siteId);
  return [...text].map((ch) => rga.insertAt(rga.length, ch));
}

const keys = (ops: readonly unknown[]) => (ops as Op[]).map((op) => idKey(op.id)).sort();

describe.each(factories)("%s store", (_name, make) => {
  it("returns null for an unknown document", async () => {
    const store = await make();
    expect(await store.load("doc")).toBeNull();
  });

  it("remembers the identity of a created document", async () => {
    const store = await make();
    await store.create("doc", "alice");
    expect(await store.load("doc")).toEqual({ siteId: "alice", ops: [] });
  });

  it("never replaces an existing identity", async () => {
    const store = await make();
    await store.create("doc", "alice");
    await store.create("doc", "mallory");
    expect((await store.load("doc"))?.siteId).toBe("alice");
  });

  it("returns the operations that were appended", async () => {
    const store = await make();
    await store.create("doc", "alice");
    const ops = makeOps("alice", "hello");
    await store.append("doc", ops);
    expect(keys((await store.load("doc"))?.ops ?? [])).toEqual(keys(ops));
  });

  it("saving the same operations twice does not duplicate them", async () => {
    const store = await make();
    await store.create("doc", "alice");
    const ops = makeOps("alice", "abc");
    await store.append("doc", ops);
    await store.append("doc", ops);
    expect((await store.load("doc"))?.ops).toHaveLength(3);
  });

  it("keeps documents separate", async () => {
    const store = await make();
    await store.create("a", "alice");
    await store.create("b", "alice");
    const opsA = makeOps("alice", "aaa");
    const opsB = makeOps("alice", "bb");
    await store.append("a", opsA);
    await store.append("b", opsB);
    expect(keys((await store.load("a"))?.ops ?? [])).toEqual(keys(opsA));
    expect(keys((await store.load("b"))?.ops ?? [])).toEqual(keys(opsB));
  });

  it("saves a large batch in one call", async () => {
    const store = await make();
    await store.create("doc", "alice");
    const ops = makeOps("alice", "x".repeat(2000));
    await store.append("doc", ops);
    expect((await store.load("doc"))?.ops).toHaveLength(2000);
  });
});

describe("indexeddb persistence", () => {
  it("a second connection to the same database sees the saved data", async () => {
    const name = `test-reopen-${dbCounter++}`;
    const first = await openIdbStore(name);
    await first.create("doc", "alice");
    const ops = makeOps("alice", "hello");
    await first.append("doc", ops);

    const second = await openIdbStore(name);
    const loaded = await second.load("doc");
    expect(loaded?.siteId).toBe("alice");
    expect(keys(loaded?.ops ?? [])).toEqual(keys(ops));
  });
});

function stub(raw: RawStoredDoc | null): DocStore {
  return { load: async () => raw, create: async () => {}, append: async () => {} };
}

describe("loadDoc and openDoc", () => {
  it("returns null for a document that was never saved", async () => {
    expect(await loadDoc(stub(null), "doc")).toBeNull();
  });

  it("skips invalid operations and counts them", async () => {
    const [good] = makeOps("alice", "a") as [Op];
    const store = stub({ siteId: "alice", ops: [good, { type: "bogus" }, null, 42] });
    expect(await loadDoc(store, "doc")).toEqual({ siteId: "alice", ops: [good], skipped: 3 });
  });

  it("refuses a stored identity that is invalid", async () => {
    await expect(loadDoc(stub({ siteId: "", ops: [] }), "doc")).rejects.toThrow("identity is invalid");
    await expect(loadDoc(stub({ siteId: 5, ops: [] }), "doc")).rejects.toThrow("identity is invalid");
  });

  it("creates an identity the first time and returns the same one afterwards", async () => {
    const store = new MemoryStore();
    let made = 0;
    const first = await openDoc(store, "doc", () => `site-${++made}`);
    expect(first).toEqual({ siteId: "site-1", ops: null, skipped: 0 });
    const second = await openDoc(store, "doc", () => `site-${++made}`);
    expect(second.siteId).toBe("site-1");
    expect(second.ops).toEqual([]);
    expect(made).toBe(1);
  });
});
