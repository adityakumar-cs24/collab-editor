import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rga, type Op } from "@collab/crdt";
import { vectorToEntries } from "@collab/protocol";
import { startServer, type RunningServer } from "./server";
import { TestClient, waitFor } from "./test-helpers";

let server: RunningServer;

beforeEach(async () => {
  server = await startServer({ port: 0 });
});

afterEach(async () => {
  await server.close();
});

function ins(counter: number, siteId: string, char = "a"): Op {
  return { type: "insert", id: { counter, siteId }, origin: null, char };
}

async function joinWith(docId: string, siteId: string, vector: Array<[string, number]> = []) {
  const client = await TestClient.connect(server.port);
  client.send({ type: "join", docId, siteId, vector });
  const msg = await client.next();
  if (msg.type !== "joined") throw new Error(`expected joined, got ${JSON.stringify(msg)}`);
  return { client, ops: msg.ops, vector: msg.vector ?? [] };
}

// Once the error reply to this garbage arrives, the server has handled everything sent before it.
async function sync(client: TestClient): Promise<void> {
  client.sendRaw("{sync");
  expect(await client.next()).toEqual({ type: "error", message: "invalid JSON" });
}

describe("delta joins", () => {
  it("sends a joiner only the operations after the prefix it already has", async () => {
    const { client: alice } = await joinWith("doc", "alice");
    const ops = [ins(1, "alice", "a"), ins(2, "alice", "b"), ins(3, "alice", "c")];
    for (const op of ops) alice.send({ type: "op", op });
    await sync(alice);

    const joined = await joinWith("doc", "bob", [["alice", 2]]);
    expect(joined.ops).toEqual([ops[2]]);
  });

  it("sends nothing to a joiner that is up to date", async () => {
    const { client: alice } = await joinWith("doc", "alice");
    for (const counter of [1, 2, 3]) alice.send({ type: "op", op: ins(counter, "alice") });
    await sync(alice);

    const joined = await joinWith("doc", "bob", [["alice", 3]]);
    expect(joined.ops).toEqual([]);
  });

  it("tracks each site separately", async () => {
    const { client: alice } = await joinWith("doc", "alice");
    alice.send({ type: "op", op: ins(1, "alice") });
    alice.send({ type: "op", op: ins(2, "alice") });
    await sync(alice);
    const { client: bob } = await joinWith("doc", "bob");
    const b1 = ins(1, "bob");
    const b2 = ins(2, "bob");
    bob.send({ type: "op", op: b1 });
    bob.send({ type: "op", op: b2 });
    await sync(bob);

    const joined = await joinWith("doc", "carol", [["alice", 2], ["bob", 1]]);
    expect(joined.ops).toEqual([b2]);
  });

  it("includes the server vector in the joined message", async () => {
    const { client: alice } = await joinWith("doc", "alice");
    for (const counter of [1, 2, 3]) alice.send({ type: "op", op: ins(counter, "alice") });
    await sync(alice);
    const { client: bob } = await joinWith("doc", "bob");
    bob.send({ type: "op", op: ins(1, "bob") });
    await sync(bob);

    const joined = await joinWith("doc", "carol");
    expect(joined.vector).toEqual([["alice", 3], ["bob", 1]]);
  });

  it("has an empty vector for a new document", async () => {
    const joined = await joinWith("fresh", "alice");
    expect(joined.vector).toEqual([]);
    expect(joined.ops).toEqual([]);
  });

  it("a client that rejoins with its own vector receives only what it missed", async () => {
    const aliceRga = new Rga("alice");
    const { client: alice } = await joinWith("doc", "alice");
    const typeX = (n: number) => {
      for (let i = 0; i < n; i++) alice.send({ type: "op", op: aliceRga.insertAt(aliceRga.length, "x") });
    };
    typeX(5);
    await sync(alice);

    const carolRga = new Rga("carol");
    const first = await joinWith("doc", "carol");
    for (const op of first.ops) carolRga.apply(op);
    expect(carolRga.toString()).toBe("xxxxx");
    first.client.close();
    await waitFor(() => server.stats().connections === 1);

    typeX(6);
    await sync(alice);
    const second = await joinWith("doc", "carol", vectorToEntries(carolRga.versionVector()));
    expect(second.ops).toHaveLength(6);
    for (const op of second.ops) carolRga.apply(op);
    expect(carolRga.toString()).toBe(aliceRga.toString());
    expect(carolRga.toString()).toHaveLength(11);
  });
});

describe("ordering and integrity checks", () => {
  it("rejects an operation older than the latest one from the same site", async () => {
    const { client: alice } = await joinWith("doc", "alice");
    const newer = ins(5, "alice");
    alice.send({ type: "op", op: newer });
    alice.send({ type: "op", op: ins(3, "alice", "b") });
    expect(await alice.next()).toEqual({ type: "error", message: "operation out of order for this site" });

    const joined = await joinWith("doc", "bob");
    expect(joined.ops).toEqual([newer]);
  });

  it("rejects the same operation id carrying different content", async () => {
    const { client: alice } = await joinWith("doc", "alice");
    const original = ins(1, "alice", "a");
    alice.send({ type: "op", op: original });
    alice.send({ type: "op", op: ins(1, "alice", "b") });
    expect(await alice.next()).toEqual({ type: "error", message: "conflicting operation id" });

    const joined = await joinWith("doc", "bob");
    expect(joined.ops).toEqual([original]);
  });

  it("rejects an invalid vector and stays usable", async () => {
    const client = await TestClient.connect(server.port);
    client.sendRaw(JSON.stringify({ type: "join", docId: "doc", siteId: "alice", vector: "x" }));
    expect(await client.next()).toEqual({ type: "error", message: "vector must be an array" });
    client.send({ type: "join", docId: "doc", siteId: "alice", vector: [] });
    expect(await client.next()).toEqual({ type: "joined", docId: "doc", ops: [], vector: [] });
  });
});
