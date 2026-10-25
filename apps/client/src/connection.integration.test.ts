import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { WebSocket as WsWebSocket } from "ws";
import { startServer, type RunningServer } from "@collab/server";
import { Connection, type SocketLike } from "./connection";
import { EditorSession } from "./session";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

function wrapWs(raw: WsWebSocket): SocketLike {
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (data) => raw.send(data),
    close: () => raw.close(),
  };
  raw.on("open", () => socket.onopen?.());
  raw.on("message", (data, isBinary) => {
    if (!isBinary) socket.onmessage?.(data.toString());
  });
  raw.on("close", () => socket.onclose?.());
  raw.on("error", () => {});
  return socket;
}

interface Peer {
  readonly session: EditorSession;
  readonly connection: Connection;
  readonly sockets: WsWebSocket[];
  readonly errors: string[];
}

function makePeer(port: number, siteId: string): Peer {
  const sockets: WsWebSocket[] = [];
  const errors: string[] = [];
  const session = new EditorSession({
    docId: "doc",
    siteId,
    send: (msg) => connection.send(msg),
    onError: (message) => errors.push(message),
  });
  const connection = new Connection({
    session,
    createSocket: () => {
      const raw = new WsWebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(raw);
      return wrapWs(raw);
    },
    baseDelayMs: 5,
    maxDelayMs: 20,
  });
  connection.goOnline();
  return { session, connection, sockets, errors };
}

const allOnline = (peers: Peer[]) => peers.every((p) => p.connection.status === "online");

let server: RunningServer | undefined;
const peers: Peer[] = [];

function track(peer: Peer): Peer {
  peers.push(peer);
  return peer;
}

async function boot(): Promise<RunningServer> {
  const running = await startServer({ port: 0 });
  server = running;
  return running;
}

afterEach(async () => {
  for (const p of peers.splice(0)) p.connection.goOffline();
  await server?.close();
  server = undefined;
});

describe("offline editing against a real server", () => {
  it("two clients that edit while offline merge when they come back", async () => {
    const running = await boot();
    const alice = track(makePeer(running.port, "alice"));
    const bob = track(makePeer(running.port, "bob"));
    await waitFor(() => allOnline([alice, bob]));

    alice.session.applyLocalText("hello");
    await waitFor(() => bob.session.text === "hello");

    alice.connection.goOffline();
    bob.connection.goOffline();
    alice.session.applyLocalText("hello world");
    bob.session.applyLocalText("oh hello");
    expect(alice.session.text).toBe("hello world");
    expect(bob.session.text).toBe("oh hello");

    alice.connection.goOnline();
    bob.connection.goOnline();
    await waitFor(() => alice.session.text === "oh hello world" && bob.session.text === "oh hello world");
    expect(alice.session.pendingCount).toBe(0);
    expect(bob.session.pendingCount).toBe(0);
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });

  it("reconnects by itself after the connection is cut, without losing an edit made at that moment", async () => {
    const running = await boot();
    const alice = track(makePeer(running.port, "alice"));
    const bob = track(makePeer(running.port, "bob"));
    await waitFor(() => allOnline([alice, bob]));

    alice.session.applyLocalText("abc");
    await waitFor(() => bob.session.text === "abc");

    const first = alice.sockets[0];
    if (first === undefined) throw new Error("no socket");
    first.terminate();
    alice.session.applyLocalText("abcd"); // written to a socket that is already dying

    await waitFor(() => bob.session.text === "abcd");
    expect(alice.sockets.length).toBeGreaterThan(1);
    expect(alice.connection.status).toBe("online");
    expect(alice.errors).toEqual([]);
  });

  it("a client that was offline catches up with what the others wrote", async () => {
    const running = await boot();
    const alice = track(makePeer(running.port, "alice"));
    const bob = track(makePeer(running.port, "bob"));
    await waitFor(() => allOnline([alice, bob]));

    alice.connection.goOffline();
    bob.session.applyLocalText("hi");
    await waitFor(() => running.stats().operations === 2);

    alice.connection.goOnline();
    await waitFor(() => alice.session.text === "hi");
    expect(alice.errors).toEqual([]);
  });

  it(
    "random edits, offline periods and cut connections still converge",
    async () => {
      type Action =
        | { kind: "edit"; client: number; del: boolean; pos: number; char: string }
        | { kind: "toggle"; client: number }
        | { kind: "cut"; client: number }
        | { kind: "wait" };

      const arbAction: fc.Arbitrary<Action> = fc.oneof(
        {
          weight: 6,
          arbitrary: fc.record({
            kind: fc.constant("edit" as const),
            client: fc.nat(2),
            del: fc.boolean(),
            pos: fc.nat(),
            char: fc.constantFrom("a", "b", "c"),
          }),
        },
        { weight: 2, arbitrary: fc.record({ kind: fc.constant("toggle" as const), client: fc.nat(2) }) },
        { weight: 1, arbitrary: fc.record({ kind: fc.constant("cut" as const), client: fc.nat(2) }) },
        { weight: 2, arbitrary: fc.record({ kind: fc.constant("wait" as const) }) },
      );

      const vectorKey = (p: Peer) => JSON.stringify([...p.session.versionVector()].sort());
      const pick = (list: Peer[], i: number): Peer => {
        const p = list[i % list.length];
        if (p === undefined) throw new Error("no peers");
        return p;
      };
      const converged = (list: Peer[]) => {
        const first = pick(list, 0);
        return list.every(
          (p) =>
            p.connection.status === "online" &&
            p.session.text === first.session.text &&
            vectorKey(p) === vectorKey(first),
        );
      };

      await fc.assert(
        fc.asyncProperty(fc.array(arbAction, { maxLength: 25 }), async (actions) => {
          const running = await startServer({ port: 0 });
          const group = ["p0", "p1", "p2"].map((id) => makePeer(running.port, id));
          try {
            await waitFor(() => allOnline(group));
            for (const a of actions) {
              if (a.kind === "wait") {
                await sleep(3);
                continue;
              }
              const peer = pick(group, a.client);
              if (a.kind === "toggle") {
                if (peer.connection.status === "offline") peer.connection.goOnline();
                else peer.connection.goOffline();
              } else if (a.kind === "cut") {
                peer.sockets.at(-1)?.terminate();
              } else {
                const chars = Array.from(peer.session.text);
                if (a.del) {
                  if (chars.length === 0) continue;
                  chars.splice(a.pos % chars.length, 1);
                } else {
                  chars.splice(a.pos % (chars.length + 1), 0, a.char);
                }
                peer.session.applyLocalText(chars.join(""));
              }
            }
            for (const p of group) p.connection.goOnline(); // no effect if already online
            await waitFor(() => converged(group));
            for (const p of group) {
              expect(p.session.pendingCount).toBe(0);
              expect(p.errors).toEqual([]);
            }
          } finally {
            for (const p of group) p.connection.goOffline();
            await running.close();
          }
        }),
        { numRuns: 15 },
      );
    },
    60_000,
  );
});
