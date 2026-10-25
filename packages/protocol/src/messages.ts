import type { Op } from "@collab/crdt";

// Limits for untrusted input. Lengths are in UTF-16 code units.
export const MAX_MESSAGE_LENGTH = 64 * 1024; // client -> server
export const MAX_SERVER_MESSAGE_LENGTH = 16 * 1024 * 1024; // server -> client (history on join)
export const MAX_SITE_ID_LENGTH = 64;
// Version vector sizes. A client vector must fit in one 64 KB frame (500 entries of up to 64 characters).
export const MAX_CLIENT_VECTOR_ENTRIES = 500;
export const MAX_SERVER_VECTOR_ENTRIES = 50_000;

// A version vector on the wire: pairs, not an object, because site ids are untrusted keys.
export type VectorEntries = Array<[string, number]>;
export const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ClientMessage =
  | { type: "join"; docId: string; siteId: string; vector?: VectorEntries }
  | { type: "op"; op: Op };

export type ServerMessage =
  | { type: "joined"; docId: string; ops: Op[]; vector?: VectorEntries }
  | { type: "op"; op: Op }
  | { type: "error"; message: string };
