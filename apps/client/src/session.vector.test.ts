import { describe, it, expect } from "vitest";
import { Rga, type Op } from "@collab/crdt";
import { MAX_CLIENT_VECTOR_ENTRIES, type ClientMessage } from "@collab/protocol";
import { EditorSession } from "./session";

function makeSession(): { session: EditorSession; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const session = new EditorSession({ docId: "doc", siteId: "bob", send: (m) => sent.push(m) });
  return { session, sent };
}

describe("join and version vectors", () => {
  it("sends an empty vector when nothing has been received", () => {
    const { session, sent } = makeSession();
    session.join();
    expect(sent).toEqual([{ type: "join", docId: "doc", siteId: "bob", vector: [] }]);
  });

  it("sends what it has already received when joining again", () => {
    const { session, sent } = makeSession();
    const alice = new Rga("alice");
    const ops = [..."abc"].map((ch) => alice.insertAt(alice.length, ch));
    session.handleServerMessage({ type: "joined", docId: "doc", ops, vector: [["alice", 3]] });
    sent.length = 0;
    session.join();
    expect(sent).toEqual([{ type: "join", docId: "doc", siteId: "bob", vector: [["alice", 3]] }]);
  });

  it("falls back to an empty vector when it knows too many sites", () => {
    const { session, sent } = makeSession();
    const ops: Op[] = Array.from({ length: MAX_CLIENT_VECTOR_ENTRIES + 1 }, (_, i) => ({
      type: "insert" as const,
      id: { counter: 1, siteId: `s${i}` },
      origin: null,
      char: "a",
    }));
    session.handleServerMessage({ type: "joined", docId: "doc", ops });
    sent.length = 0;
    session.join();
    expect(sent).toEqual([{ type: "join", docId: "doc", siteId: "bob", vector: [] }]);
  });
});
