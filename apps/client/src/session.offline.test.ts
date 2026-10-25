import { describe, it, expect } from "vitest";
import type { ClientMessage } from "@collab/protocol";
import { EditorSession } from "./session";

function joinedSession(): { session: EditorSession; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const session = new EditorSession({ docId: "doc", siteId: "alice", send: (m) => sent.push(m) });
  session.join();
  session.handleServerMessage({ type: "joined", docId: "doc", ops: [], vector: [] });
  sent.length = 0;
  return { session, sent };
}

const counters = (sent: ClientMessage[]) => sent.map((m) => (m.type === "op" ? m.op.id.counter : 0));

describe("outbox", () => {
  it("sends edits immediately while connected", () => {
    const { session, sent } = joinedSession();
    session.applyLocalText("ab");
    expect(counters(sent)).toEqual([1, 2]);
  });

  it("keeps applying edits after a disconnect without sending them", () => {
    const { session, sent } = joinedSession();
    session.handleDisconnect();
    session.applyLocalText("ab");
    expect(session.text).toBe("ab");
    expect(sent).toEqual([]);
    expect(session.isConnected).toBe(false);
    expect(session.outboxSize).toBe(2);
  });

  it("holds edits made between sending the join and receiving the answer", () => {
    const { session, sent } = joinedSession();
    session.handleDisconnect();
    session.join();
    session.applyLocalText("a");
    expect(sent).toEqual([{ type: "join", docId: "doc", siteId: "alice", vector: [] }]);
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [], vector: [] });
    expect(counters(sent)).toEqual([0, 1]); // the join, then the held operation
  });

  it("after rejoining, drops what the server already has and resends the rest", () => {
    const { session, sent } = joinedSession();
    session.applyLocalText("abc");
    expect(counters(sent)).toEqual([1, 2, 3]);
    session.handleDisconnect();
    session.join();
    sent.length = 0;
    session.handleServerMessage({ type: "joined", docId: "doc", ops: [], vector: [["alice", 2]] });
    expect(counters(sent)).toEqual([3]);
    expect(session.outboxSize).toBe(1);
  });
});
