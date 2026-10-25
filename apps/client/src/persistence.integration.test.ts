import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@collab/server";
import { MemoryStore, loadDoc, openIdbStore } from "./store";
import { startPeer, waitFor, type Peer } from "./test-support";

const servers: RunningServer[] = [];
const peers: Peer[] = [];
let dbCounter = 0;

async function boot(): Promise<RunningServer> {
  const server = await startServer({ port: 0 });
  servers.push(server);
  return server;
}

function track(peer: Peer): Peer {
  peers.push(peer);
  return peer;
}

const freshStore = () => openIdbStore(`test-persist-${dbCounter++}`);
const allOnline = (list: Peer[]) => list.every((p) => p.connection.status === "online");

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.connection.goOffline();
  for (const server of servers.splice(0)) await server.close();
});

describe("a reloaded page", () => {
  it("keeps its identity and its offline edits, then syncs them and keeps editing", async () => {
    const server = await boot();
    const store = await freshStore();
    const a1 = track(await startPeer(server.port, "doc", store));
    const b = track(await startPeer(server.port, "doc", new MemoryStore()));
    await waitFor(() => allOnline([a1, b]));

    a1.session.applyLocalText("hello");
    await waitFor(() => b.session.text === "hello");

    a1.connection.goOffline();
    a1.session.applyLocalText("hello world"); // typed while offline
    await a1.session.flushStorage();

    // The page is reloaded: everything in memory is gone, only the store remains.
    const a2 = track(await startPeer(server.port, "doc", store, { connect: false }));
    expect(a2.siteId).toBe(a1.siteId);
    expect(a2.session.text).toBe("hello world");
    expect(a2.session.isJoined).toBe(true);
    expect(a2.session.outboxSize).toBe(11); // all of its own operations

    a2.connection.goOnline();
    await waitFor(() => b.session.text === "hello world");
    a2.session.applyLocalText("hello world!");
    await waitFor(() => b.session.text === "hello world!");
    expect(a2.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(a2.storageErrors).toEqual([]);
  });

  it("can rebuild a server that lost its state", async () => {
    const first = await boot();
    const store = await freshStore();
    const a1 = track(await startPeer(first.port, "doc", store));
    await waitFor(() => allOnline([a1]));
    a1.session.applyLocalText("abc");
    await waitFor(() => first.stats().operations === 3);
    await a1.session.flushStorage();
    a1.connection.goOffline();
    servers.splice(servers.indexOf(first), 1);
    await first.close();

    const second = await boot(); // a new server with no memory of the document
    const a2 = track(await startPeer(second.port, "doc", store));
    await waitFor(() => second.stats().operations === 3);

    const late = track(await startPeer(second.port, "doc", new MemoryStore()));
    await waitFor(() => late.session.text === "abc");
    expect(a2.errors).toEqual([]);
  });

  it("has already saved everything it sent or received", async () => {
    const server = await boot();
    const store = await freshStore();
    const a = track(await startPeer(server.port, "doc", store));
    const b = track(await startPeer(server.port, "doc", new MemoryStore()));
    await waitFor(() => allOnline([a, b]));

    a.session.applyLocalText("abc");
    await waitFor(() => b.session.text === "abc");
    b.session.applyLocalText("abcx");
    await waitFor(() => a.session.text === "abcx");
    await a.session.flushStorage();

    const stored = await loadDoc(store, "doc");
    expect(stored?.siteId).toBe(a.siteId);
    expect(stored?.ops).toHaveLength(4);
    expect(stored?.skipped).toBe(0);
    expect(server.stats().operations).toBe(4);
    expect(a.storageErrors).toEqual([]);
  });
});
