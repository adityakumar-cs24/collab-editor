import type { Op } from "@collab/crdt";

// Limits for untrusted input. Lengths are in UTF-16 code units.
export const MAX_MESSAGE_LENGTH = 64 * 1024; // client -> server
export const MAX_SERVER_MESSAGE_LENGTH = 16 * 1024 * 1024; // server -> client (history on join)
export const MAX_SITE_ID_LENGTH = 64;
export const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ClientMessage =
  | { type: "join"; docId: string; siteId: string }
  | { type: "op"; op: Op };

export type ServerMessage =
  | { type: "joined"; docId: string; ops: Op[] }
  | { type: "op"; op: Op }
  | { type: "error"; message: string };
