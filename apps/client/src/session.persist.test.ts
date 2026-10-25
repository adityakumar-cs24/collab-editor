import { describe, it, expect } from "vitest";
import { Rga, type Op } from "@collab/crdt";
import type { ClientMessage } from "@collab/protocol";
import { EditorSession } from "./session";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const counters = (sent: ClientMessage[]) =>
  sent.flatMap((m) => (m.type === "op" ? [m.op.id.counter] : []));

function setup(persist: (ops: Op[]) => Promise<void>) {
  const sent: ClientMessage[] = [];
  const storageErrors: Array<[string, boolean]> = [];
  const session = new EditorSession({
    docId: "doc",
    siteId: "alice",
    send: (m) => sent.push(m),
    persist,
    onStorageError: (message, fatal) => storageErrors.push([message, fatal]),
  });
  return { session, sent, storageErrors };
}

function connect(session: EditorSession, sent: ClientMessage[]): void {
  session.join();
  session.handleServerMessage({ type: "joined", docId: "doc", ops: [], vector: [] });
  sent.length = 0;
}

describe("write-ahead saving", () => {
  it("does not send an operation until it has been saved", async () => {
    const gate = deferred();
    const { session, sent } = setup(() => gate.promise);
    connect(session, sent);
    session.applyLocalText("a");
    await tick();
    expect(session.text).toBe("a");
    expect(counters(sent)).toEqual([]);
    gate.resolve();
    await session.flushStorage();
    expect(counters(sent)).toEqual([1]);
  });

  it("saves and sends in order, one save at a time", async () => {
    const gates = [deferred(), deferred()];
    const calls: Op[][] = [];
    const { session, sent } = setup((ops) => {
      const gate = gates[calls.length];
      calls.push(ops);
      return gate === undefined ? Promise.resolve() : gate.promise;
    });
    connect(session, sent);
    session.applyLocalText("a");
    session.applyLocalText("ab");
    await tick();
    expect(calls).toHaveLength(1); // the second save waits for the first
    gates[0]?.resolve();
    await tick();
    expect(calls).toHaveLength(2);
    expect(counters(sent)).toEqual([1]);
    gates[1]?.resolve();
    await session.flushStorage();
    expect(counters(sent)).toEqual([1, 2]);
  });

  it("does not resend an unsaved operation after a rejoin, and sends it once it is saved", async () => {
    const gate = deferred();
    const { session, sent } = setup(() => gate.promise);
    connect(session, sent);
    session.applyLocalText("a");
    session.handleDisconnect();
    session.join();
    sent.length = 0;
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [], vector: [] });
    expect(counters(sent)).toEqual([]);
    gate.resolve();
    await session.flushStorage();
    expect(counters(sent)).toEqual([1]);
  });
});

describe("storage failures", () => {
  it("a failed save of our own edit sends nothing, reports it as fatal and refuses more edits", async () => {
    const { session, sent, storageErrors } = setup(() => Promise.reject(new Error("disk full")));
    connect(session, sent);
    session.applyLocalText("a");
    await session.flushStorage();
    expect(counters(sent)).toEqual([]);
    expect(storageErrors).toEqual([["could not save edits locally: disk full", true]]);
    expect(() => session.applyLocalText("ab")).toThrow("local storage failed");
    expect(session.text).toBe("a");
  });

  it("saves received operations, in order", async () => {
    const saved: Op[][] = [];
    const { session } = setup(async (ops) => {
      saved.push(ops);
    });
    const bob = new Rga("bob");
    const first = bob.insertAt(0, "x");
    const second = bob.insertAt(1, "y");
    session.join();
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [first], vector: [["bob", 1]] });
    session.handleServerMessage({ type: "op", op: second });
    await session.flushStorage();
    expect(saved).toEqual([[first], [second]]);
    expect(session.text).toBe("xy");
  });

  it("a failed save of received operations is reported but not fatal", async () => {
    let calls = 0;
    const { session, sent, storageErrors } = setup(async () => {
      calls++;
      if (calls === 1) throw new Error("quota");
    });
    const first = new Rga("bob").insertAt(0, "x");
    session.join();
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [first], vector: [["bob", 1]] });
    await session.flushStorage();
    expect(storageErrors).toEqual([["could not save received changes locally: quota", false]]);
    sent.length = 0;
    session.applyLocalText("xz");
    await session.flushStorage();
    expect(counters(sent)).toEqual([2]);
  });
});

describe("restoring a saved document", () => {
  it("rebuilds the text, keeps only own operations to resend and continues the clock past everything seen", async () => {
    const mine = new Rga("alice");
    const theirs = new Rga("bob");
    const own = [mine.insertAt(0, "a"), mine.insertAt(1, "b")];
    const others = [..."123456789"].map((ch) => theirs.insertAt(theirs.length, ch));
    const { session, sent } = setup(async () => {});

    session.restore([...own, ...others]);
    expect(session.isJoined).toBe(true);
    expect(session.isConnected).toBe(false);
    expect(session.outboxSize).toBe(2);
    expect(session.text).toHaveLength(11);

    session.join();
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [], vector: [] });
    sent.length = 0;
    session.applyLocalText(session.text + "!");
    await session.flushStorage(); // the operation is saved first, then sent
    expect(counters(sent)).toEqual([10]); // above the highest counter seen (bob's 9)
  });

  it("after restoring, joins with its vector and resends only what the server lacks", () => {
    const mine = new Rga("alice");
    const own = [..."abc"].map((ch) => mine.insertAt(mine.length, ch));
    const { session, sent } = setup(async () => {});
    session.restore(own);
    session.join();
    expect(sent).toEqual([{ type: "join", docId: "doc", siteId: "alice", vector: [["alice", 3]] }]);
    sent.length = 0;
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [], vector: [["alice", 1]] });
    expect(counters(sent)).toEqual([2, 3]);
    expect(session.outboxSize).toBe(2);
  });
});
