import { describe, it, expect } from "vitest";
import {
  MAX_CLIENT_VECTOR_ENTRIES,
  entriesToVector,
  parseClientMessage,
  parseServerMessage,
  vectorToEntries,
} from "./index";

const join = (vector: unknown) =>
  parseClientMessage(JSON.stringify({ type: "join", docId: "doc", siteId: "alice", vector }));

describe("vectors in join messages", () => {
  it("accepts a vector", () => {
    expect(join([["alice", 3], ["bob", 1]])).toEqual({
      ok: true,
      value: { type: "join", docId: "doc", siteId: "alice", vector: [["alice", 3], ["bob", 1]] },
    });
  });

  it("rejects a vector that is not an array", () => {
    for (const bad of ["x", 5, {}, null]) expect(join(bad).ok).toBe(false);
  });

  it("rejects malformed entries", () => {
    const bad: unknown[] = [
      ["alice"],
      [["alice"]],
      [["alice", 1, 2]],
      [[5, 1]],
      [["alice", 0]],
      [["alice", 1.5]],
      [["alice", "1"]],
      [["", 1]],
      [["x".repeat(65), 1]],
    ];
    for (const vector of bad) expect(join(vector).ok).toBe(false);
  });

  it("rejects duplicate site ids", () => {
    expect(join([["alice", 1], ["alice", 2]]).ok).toBe(false);
  });

  it("accepts exactly the maximum number of entries and rejects one more", () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => [`s${i}`, 1]);
    expect(join(make(MAX_CLIENT_VECTOR_ENTRIES)).ok).toBe(true);
    expect(join(make(MAX_CLIENT_VECTOR_ENTRIES + 1))).toEqual({ ok: false, error: "vector too large" });
  });
});

describe("vectors in joined messages", () => {
  it("parses the server vector", () => {
    const raw = JSON.stringify({ type: "joined", docId: "doc", ops: [], vector: [["alice", 2]] });
    expect(parseServerMessage(raw)).toEqual({
      ok: true,
      value: { type: "joined", docId: "doc", ops: [], vector: [["alice", 2]] },
    });
  });

  it("rejects an invalid server vector", () => {
    const raw = JSON.stringify({ type: "joined", docId: "doc", ops: [], vector: [["alice", 0]] });
    expect(parseServerMessage(raw).ok).toBe(false);
  });
});

describe("vector helpers", () => {
  it("sorts entries and round trips", () => {
    const vector = new Map([
      ["bob", 2],
      ["alice", 5],
    ]);
    const entries = vectorToEntries(vector);
    expect(entries).toEqual([["alice", 5], ["bob", 2]]);
    expect(entriesToVector(entries)).toEqual(vector);
  });
});
