import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Rga, type Op } from "@collab/crdt";
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

async function join(
  docId: string,
  siteId: string,
  port = server.port,
): Promise<{ client: TestClient; ops: Op[] }> {
  const client = await TestClient.connect(port);
  client.send({ type: "join", docId, siteId });
  const msg = await client.next();
  if (msg.type !== "joined") throw new Error(`expected joined, got ${JSON.stringify(msg)}`);
  return { client, ops: msg.ops };
}

// Messages on one connection are handled in order, so once the error reply to this garbage
// arrives, everything sent to this client before it has already arrived. If an unwanted
// message was delivered, it shows up here instead of the error and the test fails.
async function sync(client: TestClient): Promise<void> {
  client.sendRaw("{sync");
  expect(await client.next()).toEqual({ type: "error", message: "invalid JSON" });
}

async function applyIncoming(client: TestClient, replica: Rga, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const msg = await client.next();
    if (msg.type !== "op") throw new Error(`expected op, got ${JSON.stringify(msg)}`);
    replica.apply(msg.op);
  }
}

describe("joining", () => {
  it("returns an empty history for a new document", async () => {
    const { ops } = await join("doc", "alice");
    expect(ops).toEqual([]);
  });

  it("sends the full history to a late joiner", async () => {
    const { client: alice } = await join("doc", "alice");
    const sent = [ins(1, "alice", "a"), ins(2, "alice", "b"), ins(3, "alice", "c")];
    for (const op of sent) alice.send({ type: "op", op });
    await sync(alice);

    const { ops } = await join("doc", "bob");
    expect(ops).toEqual(sent);
  });

  it("rejects a second join on the same connection", async () => {
    const { client } = await join("doc", "alice");
    client.send({ type: "join", docId: "doc", siteId: "alice" });
    expect(await client.next()).toEqual({ type: "error", message: "already joined" });
  });

  it("rejects a siteId already connected to the same document, but allows it in another", async () => {
    await join("doc", "alice");
    const second = await TestClient.connect(server.port);
    second.send({ type: "join", docId: "doc", siteId: "alice" });
    expect(await second.next()).toEqual({
      type: "error",
      message: "siteId already in use in this document",
    });
    await join("other-doc", "alice"); // different document: fine
  });

  it("frees the siteId when a client disconnects", async () => {
    const { client } = await join("doc", "alice");
    client.close();
    await waitFor(() => server.stats().connections === 0);
    await join("doc", "alice");
  });
});

describe("forwarding operations", () => {
  it("forwards to other clients but never echoes back to the sender", async () => {
    const { client: alice } = await join("doc", "alice");
    const { client: bob } = await join("doc", "bob");
    const op = ins(1, "alice");
    alice.send({ type: "op", op });
    expect(await bob.next()).toEqual({ type: "op", op });
    await sync(alice); // fails if the server echoed the op back to alice
  });

  it("keeps documents isolated", async () => {
    const { client: alice } = await join("doc-1", "alice");
    const { client: bob } = await join("doc-2", "bob");
    alice.send({ type: "op", op: ins(1, "alice") });
    await sync(alice); // the server has processed alice's op
    await sync(bob); // fails if it was delivered to the other document
  });

  it("drops duplicate operations: not re-broadcast and not stored twice", async () => {
    const { client: alice } = await join("doc", "alice");
    const { client: bob } = await join("doc", "bob");
    const op1 = ins(1, "alice", "a");
    const op2 = ins(2, "alice", "b");
    alice.send({ type: "op", op: op1 });
    alice.send({ type: "op", op: op1 });
    alice.send({ type: "op", op: op2 });
    expect(await bob.next()).toEqual({ type: "op", op: op1 });
    expect(await bob.next()).toEqual({ type: "op", op: op2 });

    const { ops } = await join("doc", "carol");
    expect(ops).toEqual([op1, op2]);
  });

  it("rejects an operation that claims another site's id", async () => {
    const { client: alice } = await join("doc", "alice");
    const { client: bob } = await join("doc", "bob");
    alice.send({ type: "op", op: ins(1, "bob") });
    expect(await alice.next()).toEqual({
      type: "error",
      message: "operation does not belong to this site",
    });
    await sync(bob); // fails if the forged operation was forwarded
  });

  it("rejects an operation sent before joining", async () => {
    const client = await TestClient.connect(server.port);
    client.send({ type: "op", op: ins(1, "alice") });
    expect(await client.next()).toEqual({ type: "error", message: "join a document first" });
  });

  it("enforces the per-document operation cap", async () => {
    const small = await startServer({ port: 0, maxOpsPerDocument: 2 });
    try {
      const { client } = await join("doc", "alice", small.port);
      for (let i = 1; i <= 3; i++) client.send({ type: "op", op: ins(i, "alice") });
      expect(await client.next()).toEqual({ type: "error", message: "document is full" });
      expect(small.stats().operations).toBe(2);
    } finally {
      await small.close();
    }
  });
});

describe("hostile input", () => {
  it("replies with an error to invalid JSON and stays usable", async () => {
    const client = await TestClient.connect(server.port);
    client.sendRaw("{nope");
    expect(await client.next()).toEqual({ type: "error", message: "invalid JSON" });
    client.send({ type: "join", docId: "doc", siteId: "alice" });
    expect(await client.next()).toEqual({ type: "joined", docId: "doc", ops: [] });
  });

  it("rejects binary messages", async () => {
    const client = await TestClient.connect(server.port);
    client.sendRaw(Buffer.from([1, 2, 3]));
    expect(await client.next()).toEqual({
      type: "error",
      message: "binary messages are not supported",
    });
  });

  it("closes connections that exceed the payload limit", async () => {
    const client = await TestClient.connect(server.port);
    client.sendRaw("x".repeat(70 * 1024));
    expect(await client.waitForClose()).toBe(1009);
  });
});

describe("end to end", () => {
  it("two replicas editing concurrently converge through the server, and a late joiner rebuilds the document", async () => {
    const aliceRga = new Rga("alice");
    const bobRga = new Rga("bob");
    const { client: alice } = await join("doc", "alice");
    const { client: bob } = await join("doc", "bob");

    // Both type before seeing anything from the other.
    const aliceOps = [..."hello"].map((ch) => aliceRga.insertAt(aliceRga.length, ch));
    const bobOps = [..."world"].map((ch) => bobRga.insertAt(bobRga.length, ch));
    for (const op of aliceOps) alice.send({ type: "op", op });
    for (const op of bobOps) bob.send({ type: "op", op });

    await applyIncoming(alice, aliceRga, bobOps.length);
    await applyIncoming(bob, bobRga, aliceOps.length);

    expect(aliceRga.toString()).toBe(bobRga.toString());
    expect(aliceRga.toString()).toHaveLength(10);

    const { ops } = await join("doc", "carol");
    const carolRga = new Rga("carol");
    for (const op of ops) carolRga.apply(op);
    expect(carolRga.toString()).toBe(aliceRga.toString());
    expect(carolRga.pendingCount).toBe(0);
  });
});
