import type { CharId, Op } from "@collab/crdt";
import {
  DOC_ID_PATTERN,
  MAX_MESSAGE_LENGTH,
  MAX_SERVER_MESSAGE_LENGTH,
  MAX_CLIENT_VECTOR_ENTRIES,
  MAX_SERVER_VECTOR_ENTRIES,
  MAX_SITE_ID_LENGTH,
  type ClientMessage,
  type ServerMessage,
  type VectorEntries,
} from "./messages";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSiteId(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_SITE_ID_LENGTH) return null;
  return v;
}

function parseId(v: unknown): CharId | null {
  if (!isRecord(v)) return null;
  const siteId = parseSiteId(v["siteId"]);
  const counter = v["counter"];
  if (siteId === null) return null;
  // Lamport counters start at 1 (the first tick), so 0 and below are invalid.
  if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 1) return null;
  return { counter, siteId };
}

// A missing vector means "I have nothing", which makes the server send everything.
function parseVector(v: unknown, maxEntries: number): ParseResult<VectorEntries> {
  if (v === undefined) return ok<VectorEntries>([]);
  if (!Array.isArray(v)) return fail("vector must be an array");
  if (v.length > maxEntries) return fail("vector too large");
  const seen = new Set<string>();
  const entries: VectorEntries = [];
  for (const item of v as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) return fail("vector entries must be [siteId, counter]");
    const siteId = parseSiteId(item[0]);
    const counter: unknown = item[1];
    if (siteId === null) return fail("vector entry has an invalid siteId");
    if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 1) {
      return fail("vector entry has an invalid counter");
    }
    if (seen.has(siteId)) return fail("vector has a duplicate siteId");
    seen.add(siteId);
    entries.push([siteId, counter]);
  }
  return ok<VectorEntries>(entries);
}

function parseOp(v: unknown): ParseResult<Op> {
  if (!isRecord(v)) return fail("op must be an object");
  const id = parseId(v["id"]);
  if (id === null) return fail("op.id is invalid");

  if (v["type"] === "insert") {
    const char = v["char"];
    // One code point per operation. A code point is at most 2 UTF-16 units.
    if (typeof char !== "string" || char.length > 2 || Array.from(char).length !== 1) {
      return fail("insert.char must be exactly one character");
    }
    const rawOrigin = v["origin"];
    if (rawOrigin === null) return ok<Op>({ type: "insert", id, origin: null, char });
    const origin = parseId(rawOrigin);
    if (origin === null) return fail("insert.origin must be null or a valid id");
    return ok<Op>({ type: "insert", id, origin, char });
  }

  if (v["type"] === "delete") {
    const target = parseId(v["target"]);
    if (target === null) return fail("delete.target is invalid");
    return ok<Op>({ type: "delete", id, target });
  }

  return fail("unknown op type");
}

function parseJson(raw: string, maxLength: number): ParseResult<unknown> {
  if (raw.length > maxLength) return fail("message too large");
  try {
    return ok<unknown>(JSON.parse(raw));
  } catch {
    return fail("invalid JSON");
  }
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  const json = parseJson(raw, MAX_MESSAGE_LENGTH);
  if (!json.ok) return json;
  const msg = json.value;
  if (!isRecord(msg)) return fail("message must be an object");

  switch (msg["type"]) {
    case "join": {
      const docId = msg["docId"];
      if (typeof docId !== "string" || !DOC_ID_PATTERN.test(docId)) return fail("invalid docId");
      const siteId = parseSiteId(msg["siteId"]);
      if (siteId === null) return fail("invalid siteId");
      const vector = parseVector(msg["vector"], MAX_CLIENT_VECTOR_ENTRIES);
      if (!vector.ok) return vector;
      return ok<ClientMessage>({ type: "join", docId, siteId, vector: vector.value });
    }
    case "op": {
      const op = parseOp(msg["op"]);
      if (!op.ok) return op;
      return ok<ClientMessage>({ type: "op", op: op.value });
    }
    default:
      return fail("unknown message type");
  }
}

// The client validates server messages too: it should not blindly trust the wire either.
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  const json = parseJson(raw, MAX_SERVER_MESSAGE_LENGTH);
  if (!json.ok) return json;
  const msg = json.value;
  if (!isRecord(msg)) return fail("message must be an object");

  switch (msg["type"]) {
    case "joined": {
      const docId = msg["docId"];
      if (typeof docId !== "string" || !DOC_ID_PATTERN.test(docId)) return fail("invalid docId");
      const rawOps: unknown = msg["ops"];
      if (!Array.isArray(rawOps)) return fail("ops must be an array");
      const ops: Op[] = [];
      for (const item of rawOps) {
        const op = parseOp(item);
        if (!op.ok) return op;
        ops.push(op.value);
      }
      const vector = parseVector(msg["vector"], MAX_SERVER_VECTOR_ENTRIES);
      if (!vector.ok) return vector;
      return ok<ServerMessage>({ type: "joined", docId, ops, vector: vector.value });
    }
    case "op": {
      const op = parseOp(msg["op"]);
      if (!op.ok) return op;
      return ok<ServerMessage>({ type: "op", op: op.value });
    }
    case "error": {
      const message = msg["message"];
      if (typeof message !== "string") return fail("error.message must be a string");
      return ok<ServerMessage>({ type: "error", message });
    }
    default:
      return fail("unknown message type");
  }
}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}
