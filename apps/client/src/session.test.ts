import { describe, it, expect } from "vitest";
import { Rga, type Op } from "@collab/crdt";
import type { ClientMessage, ServerMessage } from "@collab/protocol";
import { EditorSession } from "./session";

// A tiny in-memory stand-in for the server: keeps the log and queues messages per client,
// so tests control exactly when each client receives what.
class Hub {
  private readonly log: Op[] = [];
  private readonly sessions = new Map<string, EditorSession>();
  private readonly queues = new Map<string, ServerMessage[]>();
  readonly errors: string[] = [];

  connect(siteId: string): EditorSession {
    this.queues.set(siteId, []);
    const session = new EditorSession({
      docId: "doc",
      siteId,
      send: (msg) => this.fromClient(siteId, msg),
      onError: (message) => this.errors.push(message),
    });
    this.sessions.set(siteId, session);
    session.join();
    return session;
  }

  private fromClient(siteId: string, msg: ClientMessage): void {
    if (msg.type === "join") {
      this.queues.get(siteId)?.push({ type: "joined", docId: msg.docId, ops: [...this.log] });
      return;
    }
    this.log.push(msg.op);
    for (const [other, queue] of this.queues) {
      if (other !== siteId) queue.push({ type: "op", op: msg.op });
    }
  }

  flushAll(): void {
    for (const [siteId, session] of this.sessions) {
      const queue = this.queues.get(siteId) ?? [];
      for (const msg of queue.splice(0)) session.handleServerMessage(msg);
    }
  }
}

function twoJoined(): { hub: Hub; alice: EditorSession; bob: EditorSession } {
  const hub = new Hub();
  const alice = hub.connect("alice");
  const bob = hub.connect("bob");
  hub.flushAll();
  return { hub, alice, bob };
}

describe("EditorSession", () => {
  it("joins an empty document", () => {
    const { alice } = twoJoined();
    expect(alice.isJoined).toBe(true);
    expect(alice.text).toBe("");
  });

  it("typing in one session shows up in the other", () => {
    const { hub, alice, bob } = twoJoined();
    alice.applyLocalText("hello");
    hub.flushAll();
    expect(bob.text).toBe("hello");
  });

  it("replacing a selection syncs as deletes plus inserts", () => {
    const { hub, alice, bob } = twoJoined();
    alice.applyLocalText("hello world");
    hub.flushAll();
    alice.applyLocalText("hello there");
    hub.flushAll();
    expect(bob.text).toBe("hello there");
  });

  it("concurrent typing converges", () => {
    const { hub, alice, bob } = twoJoined();
    alice.applyLocalText("hello"); // neither has seen the other's edit yet
    bob.applyLocalText("world");
    hub.flushAll();
    expect(alice.text).toBe(bob.text);
    expect(alice.text).toHaveLength(10);
  });

  it("syncs emoji insertion and deletion", () => {
    const { hub, alice, bob } = twoJoined();
    alice.applyLocalText("a😀b");
    hub.flushAll();
    expect(bob.text).toBe("a😀b");
    alice.applyLocalText("ab");
    hub.flushAll();
    expect(bob.text).toBe("ab");
  });

  it("a late joiner rebuilds the document from history", () => {
    const { hub, alice } = twoJoined();
    alice.applyLocalText("history");
    hub.flushAll();
    const carol = hub.connect("carol");
    hub.flushAll();
    expect(carol.isJoined).toBe(true);
    expect(carol.text).toBe("history");
  });

  it("reports how a remote operation changed the visible text", () => {
    const session = new EditorSession({ docId: "doc", siteId: "bob", send: () => {} });
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [] });
    const remote = new Rga("alice");
    const insert = remote.insertAt(0, "x");
    const remove = remote.deleteAt(0);
    expect(session.handleServerMessage({ type: "op", op: insert })).toEqual({
      index: 0,
      deleteCount: 0,
      insert: ["x"],
    });
    expect(session.handleServerMessage({ type: "op", op: remove })).toEqual({
      index: 0,
      deleteCount: 1,
      insert: [],
    });
  });

  it("refuses local edits before joining", () => {
    const session = new EditorSession({ docId: "doc", siteId: "bob", send: () => {} });
    expect(() => session.applyLocalText("x")).toThrow("before the document is loaded");
  });

  it("forwards server errors to onError", () => {
    const hub = new Hub();
    const session = hub.connect("alice");
    session.handleServerMessage({ type: "error", message: "boom" });
    expect(hub.errors).toEqual(["boom"]);
  });
});
