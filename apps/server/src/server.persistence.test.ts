import { afterEach, describe, expect, it } from "vitest";
import type { Op } from "@collab/crdt";
import { startServer, type RunningServer, type ServerOptions } from "./server";
import { MemoryStorage, type OpStorage } from "./storage";
import { TestClient, waitFor } from "./test-helpers";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noop = () => {};

// A storage that can fail, stall and be slow on demand, and counts what is asked of it.
class TestStorage implements OpStorage {
  readonly inner = new MemoryStorage();
  loads = 0;
  appends = 0;
  failNextLoad = false;
  failNextAppend = false;
  loadGate: Promise<void> | null = null;
  appendDelay: (call: number) => number = () => 0;

  async load(docId: string): Promise<readonly unknown[]> {
    this.loads++;
    if (this.loadGate !== null) await this.loadGate;
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error("load failed");
    }
    return this.inner.load(docId);
  }

  async append(docId: string, op: Op): Promise<void> {
    this.appends++;
    const delay = this.appendDelay(this.appends);
    if (delay > 0) await sleep(delay);
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("append failed");
    }
    return this.inner.append(docId, op);
  }

  async close(): Promise<void> {}
}

const servers: RunningServer[] = [];

async function boot(options: ServerOptions = {}): Promise<RunningServer> {
  const server = await startServer({ port: 0, onError: noop, ...options });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function ins(counter: number, siteId: string, char = "a"): Op {
  return { type: "insert", id: { counter, siteId }, origin: null, char };
}

async function joinWith(port: number, docId: string, siteId: string, vector: Array<[string, number]> = []) {
  const client = await TestClient.connect(port);
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

describe("surviving a restart", () => {
  it("a document is served again by a new server using the same storage", async () => {
    const storage = new MemoryStorage();
    const first = await boot({ storage });
    const alice = await joinWith(first.port, "doc", "alice");
    const ops = [ins(1, "alice", "a"), ins(2, "alice", "b"), ins(3, "alice", "c")];
    for (const op of ops) alice.client.send({ type: "op", op });
    await sync(alice.client);
    servers.splice(servers.indexOf(first), 1);
    await first.close();

    const second = await boot({ storage });
    const bob = await joinWith(second.port, "doc", "bob");
    expect(bob.ops).toEqual(ops);
    expect(bob.vector).toEqual([["alice", 3]]);
    const delta = await joinWith(second.port, "doc", "carol", [["alice", 2]]);
    expect(delta.ops).toEqual([ops[2]]);
  });

  it("the ordering, duplicate and conflict rules still hold after a restart", async () => {
    const storage = new MemoryStorage();
    const first = await boot({ storage });
    const writer = await joinWith(first.port, "doc", "alice");
    for (const op of [ins(1, "alice", "a"), ins(2, "alice", "b"), ins(5, "alice", "c")]) {
      writer.client.send({ type: "op", op });
    }
    await sync(writer.client);
    servers.splice(servers.indexOf(first), 1);
    await first.close();

    const second = await boot({ storage });
    const alice = await joinWith(second.port, "doc", "alice", [["alice", 5]]);
    const bob = await joinWith(second.port, "doc", "bob");

    alice.client.send({ type: "op", op: ins(4, "alice", "z") }); // a gap: below the highest stored counter, never seen
    expect(await alice.client.next()).toEqual({ type: "error", message: "operation out of order for this site" });

    alice.client.send({ type: "op", op: ins(5, "alice", "c") }); // exact retry of a stored operation
    alice.client.send({ type: "op", op: ins(5, "alice", "X") }); // same id, different content
    expect(await alice.client.next()).toEqual({ type: "error", message: "conflicting operation id" });

    const fresh = ins(6, "alice", "d");
    alice.client.send({ type: "op", op: fresh });
    // If the retry had been broadcast again, bob would receive it before the fresh operation.
    expect(await bob.client.next()).toEqual({ type: "op", op: fresh });
    expect(await storage.load("doc")).toHaveLength(4);
  });
});

describe("storage failures", () => {
  it("a failed save closes the sender, stores and forwards nothing, and a retry after reconnecting works", async () => {
    const storage = new TestStorage();
    const server = await boot({ storage });
    const alice = await joinWith(server.port, "doc", "alice");
    const bob = await joinWith(server.port, "doc", "bob");

    storage.failNextAppend = true;
    const op1 = ins(1, "alice", "a");
    const op2 = ins(2, "alice", "b");
    alice.client.send({ type: "op", op: op1 });
    alice.client.send({ type: "op", op: op2 });
    expect(await alice.client.next()).toEqual({ type: "error", message: "could not save operation" });
    expect(await alice.client.waitForClose()).toBe(1011);
    await waitFor(() => server.stats().connections === 1);

    const again = await joinWith(server.port, "doc", "alice");
    expect(again.ops).toEqual([]);
    expect(again.vector).toEqual([]);
    expect(storage.appends).toBe(1); // the second operation was never even attempted

    again.client.send({ type: "op", op: op1 });
    again.client.send({ type: "op", op: op2 });
    expect(await bob.client.next()).toEqual({ type: "op", op: op1 });
    expect(await bob.client.next()).toEqual({ type: "op", op: op2 });
    expect(await storage.inner.load("doc")).toEqual([op1, op2]);
  });

  it("a failed load closes the connection, and the next join loads again", async () => {
    const storage = new TestStorage();
    const server = await boot({ storage });
    storage.failNextLoad = true;
    const client = await TestClient.connect(server.port);
    client.send({ type: "join", docId: "doc", siteId: "alice", vector: [] });
    expect(await client.next()).toEqual({ type: "error", message: "could not load document" });
    expect(await client.waitForClose()).toBe(1011);

    const ok = await joinWith(server.port, "doc", "alice");
    expect(ok.ops).toEqual([]);
    expect(storage.loads).toBe(2);
  });

  it("refuses to serve a document whose stored data is damaged", async () => {
    const damaged: OpStorage = { load: async () => [{ bogus: true }], append: async () => {}, close: async () => {} };
    const server = await boot({ storage: damaged });
    const client = await TestClient.connect(server.port);
    client.send({ type: "join", docId: "doc", siteId: "alice", vector: [] });
    expect(await client.next()).toEqual({ type: "error", message: "could not load document" });
    expect(await client.waitForClose()).toBe(1011);
  });

  it("refuses to serve a document whose stored operations are out of order", async () => {
    const unordered: OpStorage = {
      load: async () => [ins(2, "alice"), ins(1, "alice")],
      append: async () => {},
      close: async () => {},
    };
    const server = await boot({ storage: unordered });
    const client = await TestClient.connect(server.port);
    client.send({ type: "join", docId: "doc", siteId: "bob", vector: [] });
    expect(await client.next()).toEqual({ type: "error", message: "could not load document" });
    expect(await client.waitForClose()).toBe(1011);
  });
});

describe("concurrency", () => {
  it("two clients joining while the document is loading cause a single load", async () => {
    const storage = new TestStorage();
    let release!: () => void;
    storage.loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await boot({ storage });
    const a = await TestClient.connect(server.port);
    const b = await TestClient.connect(server.port);
    a.send({ type: "join", docId: "doc", siteId: "alice", vector: [] });
    b.send({ type: "join", docId: "doc", siteId: "bob", vector: [] });

    await waitFor(() => storage.loads === 1);
    await sleep(30); // time for the second join to wrongly start another load
    expect(storage.loads).toBe(1);

    release();
    expect(await a.next()).toMatchObject({ type: "joined" });
    expect(await b.next()).toMatchObject({ type: "joined" });
    expect(storage.loads).toBe(1);
  });

  it("concurrent writers with a slow, uneven storage keep the log, the storage and the broadcasts in the same order", async () => {
    const storage = new TestStorage();
    storage.appendDelay = (call) => (call * 7) % 5;
    const server = await boot({ storage });
    const peers = [];
    for (const id of ["p0", "p1", "p2"]) peers.push({ id, ...(await joinWith(server.port, "doc", id)) });

    for (const peer of peers) {
      for (let counter = 1; counter <= 40; counter++) {
        peer.client.send({ type: "op", op: ins(counter, peer.id, "x") });
      }
    }

    const received = await Promise.all(
      peers.map(async (peer) => {
        const got: Op[] = [];
        for (let i = 0; i < 80; i++) {
          const msg = await peer.client.next();
          if (msg.type !== "op") throw new Error(`unexpected message ${JSON.stringify(msg)}`);
          got.push(msg.op);
        }
        return got;
      }),
    );

    const stored = (await storage.inner.load("doc")) as Op[];
    expect(stored).toHaveLength(120);
    for (const peer of peers) {
      const counters = stored.filter((op) => op.id.siteId === peer.id).map((op) => op.id.counter);
      expect(counters).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    }
    peers.forEach((peer, i) => {
      expect(received[i]).toEqual(stored.filter((op) => op.id.siteId !== peer.id));
    });
  });
});
