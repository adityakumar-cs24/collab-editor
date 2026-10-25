import { describe, it, expect } from "vitest";
import { Rga, type Op } from "@collab/crdt";
import { encode, parseClientMessage, parseServerMessage, MAX_MESSAGE_LENGTH } from "./index";

const id = (counter: number, siteId = "alice") => ({ counter, siteId });
const insertOp = { type: "insert", id: id(1), origin: null, char: "a" };
const deleteOp = { type: "delete", id: id(2), target: id(1) };
const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));
const isRejected = (value: unknown) => parse(value).ok === false;

describe("parseClientMessage: valid messages", () => {
  it("accepts join", () => {
    expect(parse({ type: "join", docId: "notes-1", siteId: "alice" })).toEqual({
      ok: true,
      value: { type: "join", docId: "notes-1", siteId: "alice", vector: [] },
    });
  });

  it("accepts an insert at the start of the document", () => {
    expect(parse({ type: "op", op: insertOp })).toEqual({ ok: true, value: { type: "op", op: insertOp } });
  });

  it("accepts an insert after another character", () => {
    const op = { ...insertOp, id: id(2), origin: id(1) };
    expect(parse({ type: "op", op })).toEqual({ ok: true, value: { type: "op", op } });
  });

  it("accepts a delete", () => {
    expect(parse({ type: "op", op: deleteOp })).toEqual({ ok: true, value: { type: "op", op: deleteOp } });
  });

  it("accepts a single emoji as one character", () => {
    const op = { ...insertOp, char: "😀" };
    expect(parse({ type: "op", op }).ok).toBe(true);
  });

  it("drops unknown extra fields", () => {
    const result = parse({ type: "op", op: { ...insertOp, evil: "x" }, extra: 1 });
    expect(result).toEqual({ ok: true, value: { type: "op", op: insertOp } });
  });
});

describe("parseClientMessage: rejected input", () => {
  it("rejects text that is not JSON", () => {
    expect(parseClientMessage("{nope").ok).toBe(false);
  });

  it("rejects JSON that is not an object", () => {
    for (const raw of ["[]", "1", "null", '"join"']) {
      expect(parseClientMessage(raw).ok).toBe(false);
    }
  });

  it("rejects an unknown message type", () => {
    expect(isRejected({ type: "hack" })).toBe(true);
  });

  it("rejects bad document ids", () => {
    for (const docId of ["", "../etc/passwd", "a b", "x".repeat(65), 5, null]) {
      expect(isRejected({ type: "join", docId, siteId: "alice" })).toBe(true);
    }
  });

  it("rejects bad site ids", () => {
    for (const siteId of ["", "x".repeat(65), 7, null]) {
      expect(isRejected({ type: "join", docId: "doc", siteId })).toBe(true);
    }
  });

  it("rejects invalid counters", () => {
    for (const counter of [0, -1, 1.5, "1", null]) {
      const op = { ...insertOp, id: { counter, siteId: "alice" } };
      expect(isRejected({ type: "op", op })).toBe(true);
    }
  });

  it("rejects characters that are not exactly one code point", () => {
    for (const char of ["", "ab", 5, null]) {
      expect(isRejected({ type: "op", op: { ...insertOp, char } })).toBe(true);
    }
  });

  it("rejects an insert with a missing origin", () => {
    const op = { type: "insert", id: id(1), char: "a" };
    expect(isRejected({ type: "op", op })).toBe(true);
  });

  it("rejects oversized messages", () => {
    const result = parseClientMessage("x".repeat(MAX_MESSAGE_LENGTH + 1));
    expect(result).toEqual({ ok: false, error: "message too large" });
  });

  it("rejects an unknown op type", () => {
    expect(isRejected({ type: "op", op: { type: "replace", id: id(1) } })).toBe(true);
  });

  it("rejects an op that is not an object", () => {
    expect(isRejected({ type: "op", op: "insert" })).toBe(true);
  });
});

describe("round trip with a real replica", () => {
  it("operations survive encode and parse and rebuild the same text", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const ops: Op[] = [..."hello"].map((ch) => alice.insertAt(alice.length, ch));
    ops.push(alice.deleteAt(1));

    for (const op of ops) {
      const parsed = parseClientMessage(encode({ type: "op", op }));
      if (!parsed.ok || parsed.value.type !== "op") throw new Error("round trip failed");
      bob.apply(parsed.value.op);
    }
    expect(bob.toString()).toBe(alice.toString());
    expect(bob.toString()).toBe("hllo");
  });
});

describe("parseServerMessage", () => {
  it("parses a joined message with history", () => {
    const raw = JSON.stringify({ type: "joined", docId: "doc", ops: [insertOp, deleteOp] });
    expect(parseServerMessage(raw)).toEqual({
      ok: true,
      value: { type: "joined", docId: "doc", ops: [insertOp, deleteOp], vector: [] },
    });
  });

  it("rejects a joined message containing an invalid op", () => {
    const bad = { ...insertOp, id: id(0) };
    const raw = JSON.stringify({ type: "joined", docId: "doc", ops: [insertOp, bad] });
    expect(parseServerMessage(raw).ok).toBe(false);
  });

  it("parses op and error messages", () => {
    expect(parseServerMessage(JSON.stringify({ type: "op", op: insertOp })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ type: "error", message: "nope" }))).toEqual({
      ok: true,
      value: { type: "error", message: "nope" },
    });
  });

  it("rejects an unknown server message type", () => {
    expect(parseServerMessage(JSON.stringify({ type: "hack" })).ok).toBe(false);
  });
});
