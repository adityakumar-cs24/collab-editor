import { describe, it, expect } from "vitest";
import { Rga } from "@collab/crdt";
import { encode, type ClientMessage, type ServerMessage } from "@collab/protocol";
import { Connection, SITE_ID_IN_USE, type ConnectionStatus, type SocketLike } from "./connection";
import type { TextEdit } from "./diff";
import { EditorSession } from "./session";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: ClientMessage[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  receive(msg: ServerMessage): void {
    this.onmessage?.(encode(msg));
  }
  drop(): void {
    this.onclose?.();
  }
}

interface Timer {
  fn: () => void;
  ms: number;
  active: boolean;
}

function setup(options: { random?: number; baseDelayMs?: number; maxDelayMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Timer[] = [];
  const statuses: ConnectionStatus[] = [];
  const edits: TextEdit[] = [];
  const errors: string[] = [];
  const protocolErrors: string[] = [];

  const session = new EditorSession({
    docId: "doc",
    siteId: "alice",
    send: (msg) => connection.send(msg),
    onError: (m) => errors.push(m),
  });
  const connection = new Connection({
    session,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onStatus: (s) => statuses.push(s),
    onRemoteEdit: (e) => edits.push(e),
    onProtocolError: (m) => protocolErrors.push(m),
    baseDelayMs: options.baseDelayMs ?? 100,
    maxDelayMs: options.maxDelayMs ?? 1000,
    random: () => options.random ?? 1,
    setTimer: (fn, ms) => {
      const timer: Timer = { fn, ms, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as Timer).active = false;
    },
  });

  return {
    session,
    connection,
    sockets,
    timers,
    statuses,
    edits,
    errors,
    protocolErrors,
    socket(i: number): FakeSocket {
      const s = sockets[i];
      if (s === undefined) throw new Error(`no socket ${i}`);
      return s;
    },
    delays: () => timers.map((t) => t.ms),
    fireTimer(): void {
      const timer = [...timers].reverse().find((t) => t.active);
      if (timer === undefined) throw new Error("no active timer");
      timer.active = false;
      timer.fn();
    },
  };
}

function join(s: FakeSocket, vector: Array<[string, number]> = []): void {
  s.open();
  s.receive({ type: "joined", docId: "doc", ops: [], vector });
}

const counters = (sent: ClientMessage[]) =>
  sent.map((m) => (m.type === "op" ? m.op.id.counter : 0));

describe("connecting", () => {
  it("joins when the socket opens and is online once the server confirms", () => {
    const t = setup();
    t.connection.goOnline();
    expect(t.statuses).toEqual(["connecting"]);
    t.socket(0).open();
    expect(t.socket(0).sent).toEqual([{ type: "join", docId: "doc", siteId: "alice", vector: [] }]);
    t.socket(0).receive({ type: "joined", docId: "doc", ops: [], vector: [] });
    expect(t.statuses).toEqual(["connecting", "online"]);
    expect(t.session.isConnected).toBe(true);
  });
});

describe("reconnecting with an outbox", () => {
  it("keeps editing while disconnected and resends only what the server is missing", () => {
    const t = setup();
    t.connection.goOnline();
    join(t.socket(0));
    t.session.applyLocalText("ab"); // counters 1 and 2, sent live
    expect(t.socket(0).sent).toHaveLength(3); // join + 2 operations

    t.socket(0).drop();
    expect(t.statuses.at(-1)).toBe("reconnecting");
    t.session.applyLocalText("abc"); // counter 3, kept locally only
    expect(t.session.text).toBe("abc");
    expect(t.socket(0).sent).toHaveLength(3);

    t.fireTimer();
    t.socket(1).open();
    expect(t.socket(1).sent).toEqual([
      { type: "join", docId: "doc", siteId: "alice", vector: [["alice", 3]] },
    ]);
    t.socket(1).receive({ type: "joined", docId: "doc", ops: [], vector: [["alice", 2]] });
    expect(counters(t.socket(1).sent)).toEqual([0, 3]);
    expect(t.statuses.at(-1)).toBe("online");
    expect(t.session.outboxSize).toBe(1);
  });

  it("sends nothing again when the server already has everything", () => {
    const t = setup();
    t.connection.goOnline();
    join(t.socket(0));
    t.session.applyLocalText("abc");
    t.socket(0).drop();
    t.fireTimer();
    join(t.socket(1), [["alice", 3]]);
    expect(t.socket(1).sent).toHaveLength(1); // only the join
    expect(t.session.outboxSize).toBe(0);
  });

  it("resends everything when the server has lost its state", () => {
    const t = setup();
    t.connection.goOnline();
    join(t.socket(0));
    t.session.applyLocalText("abc");
    t.socket(0).drop();
    t.fireTimer();
    join(t.socket(1), []);
    expect(counters(t.socket(1).sent)).toEqual([0, 1, 2, 3]);
  });
});

describe("backoff", () => {
  it("grows exponentially up to a cap", () => {
    const t = setup({ random: 1, baseDelayMs: 100, maxDelayMs: 1000 });
    t.connection.goOnline();
    for (let i = 0; i < 6; i++) {
      t.socket(i).drop();
      t.fireTimer();
    }
    expect(t.delays()).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it("waits between half and all of the ceiling", () => {
    const low = setup({ random: 0, baseDelayMs: 100 });
    low.connection.goOnline();
    low.socket(0).drop();
    expect(low.delays()).toEqual([50]);

    const high = setup({ random: 1, baseDelayMs: 100 });
    high.connection.goOnline();
    high.socket(0).drop();
    expect(high.delays()).toEqual([100]);
  });

  it("starts again from the beginning after a successful join", () => {
    const t = setup({ random: 1, baseDelayMs: 100, maxDelayMs: 1000 });
    t.connection.goOnline();
    t.socket(0).drop();
    t.fireTimer();
    t.socket(1).drop();
    t.fireTimer();
    join(t.socket(2));
    t.socket(2).drop();
    expect(t.delays()).toEqual([100, 200, 100]);
  });
});

describe("edge cases", () => {
  it("retries instead of reporting when the server still holds the old connection", () => {
    const t = setup();
    t.connection.goOnline();
    t.socket(0).open();
    t.socket(0).receive({ type: "error", message: SITE_ID_IN_USE });
    expect(t.socket(0).closed).toBe(true);
    expect(t.errors).toEqual([]);
    expect(t.statuses.at(-1)).toBe("reconnecting");
    t.fireTimer();
    join(t.socket(1));
    expect(t.statuses.at(-1)).toBe("online");
  });

  it("goOffline stops reconnecting and goOnline resumes", () => {
    const t = setup();
    t.connection.goOnline();
    join(t.socket(0));
    t.connection.goOffline();
    expect(t.socket(0).closed).toBe(true);
    expect(t.statuses.at(-1)).toBe("offline");
    t.socket(0).drop(); // the late close event of the old socket
    expect(t.timers).toHaveLength(0);
    expect(t.sockets).toHaveLength(1);
    t.connection.goOnline();
    expect(t.sockets).toHaveLength(2);
    expect(t.statuses.at(-1)).toBe("reconnecting");
  });

  it("ignores events from a socket that was replaced", () => {
    const t = setup();
    t.connection.goOnline();
    join(t.socket(0));
    t.socket(0).drop();
    t.fireTimer();
    join(t.socket(1));
    const op = new Rga("bob").insertAt(0, "x");
    t.socket(0).receive({ type: "op", op }); // stale socket
    expect(t.session.text).toBe("");
    t.socket(1).receive({ type: "op", op });
    expect(t.session.text).toBe("x");
  });

  it("forwards remote edits", () => {
    const t = setup();
    t.connection.goOnline();
    join(t.socket(0));
    const op = new Rga("bob").insertAt(0, "x");
    t.socket(0).receive({ type: "op", op });
    expect(t.edits).toEqual([{ index: 0, deleteCount: 0, insert: ["x"] }]);
  });

  it("reports invalid server messages and ignores binary data", () => {
    const t = setup();
    t.connection.goOnline();
    t.socket(0).open();
    t.socket(0).onmessage?.("not json");
    t.socket(0).onmessage?.(new Uint8Array(1));
    expect(t.protocolErrors).toEqual(["invalid JSON"]);
  });
});
