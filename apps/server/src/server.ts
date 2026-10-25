import { WebSocketServer, WebSocket, type RawData } from "ws";
import { idKey, missingOps, type Op } from "@collab/crdt";
import {
  MAX_MESSAGE_LENGTH,
  encode,
  entriesToVector,
  parseClientMessage,
  vectorToEntries,
  type ClientMessage,
  type ServerMessage,
} from "@collab/protocol";

export interface ServerOptions {
  port?: number; // 0 picks a free port
  host?: string;
  maxOpsPerDocument?: number;
}

export interface RunningServer {
  readonly port: number;
  stats(): { connections: number; documents: number; operations: number };
  close(): Promise<void>;
}

interface Room {
  readonly log: Op[]; // every operation, in arrival order
  readonly seen: Map<string, Op>; // operations already in the log, by id
  readonly vector: Map<string, number>; // highest counter per site in the log
  readonly clients: Map<string, WebSocket>; // siteId -> connection
}

interface Session {
  readonly docId: string;
  readonly siteId: string;
}

// ~150 bytes of JSON per operation, so a full history stays under the client's 16M character limit.
const DEFAULT_MAX_OPS_PER_DOCUMENT = 50_000;

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function sendRaw(ws: WebSocket, payload: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

function sendMessage(ws: WebSocket, msg: ServerMessage): void {
  sendRaw(ws, encode(msg));
}

function sendError(ws: WebSocket, message: string): void {
  sendMessage(ws, { type: "error", message });
}

export function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const maxOps = options.maxOpsPerDocument ?? DEFAULT_MAX_OPS_PER_DOCUMENT;
  const rooms = new Map<string, Room>();
  const sessions = new Map<WebSocket, Session>();

  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
    maxPayload: MAX_MESSAGE_LENGTH, // bytes; ws closes the connection with 1009 beyond this
  });

  function handleJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: "join" }>): void {
    if (sessions.has(ws)) return sendError(ws, "already joined");

    let room = rooms.get(msg.docId);
    if (room === undefined) {
      room = { log: [], seen: new Map(), vector: new Map(), clients: new Map() };
      rooms.set(msg.docId, room);
    }
    if (room.clients.has(msg.siteId)) {
      return sendError(ws, "siteId already in use in this document");
    }

    room.clients.set(msg.siteId, ws);
    sessions.set(ws, { docId: msg.docId, siteId: msg.siteId });
    // Send only what the client does not have yet.
    const known = entriesToVector(msg.vector ?? []);
    sendMessage(ws, {
      type: "joined",
      docId: msg.docId,
      ops: missingOps(room.log, known),
      vector: vectorToEntries(room.vector),
    });
  }

  function handleOp(ws: WebSocket, op: Op): void {
    const session = sessions.get(ws);
    if (session === undefined) return sendError(ws, "join a document first");
    if (op.id.siteId !== session.siteId) {
      return sendError(ws, "operation does not belong to this site");
    }
    const room = rooms.get(session.docId);
    if (room === undefined) return sendError(ws, "document not found");

    const key = idKey(op.id);
    const existing = room.seen.get(key);
    if (existing !== undefined) {
      // A retry is harmless. The same id with different content would make replicas diverge.
      if (JSON.stringify(existing) !== JSON.stringify(op)) {
        return sendError(ws, "conflicting operation id");
      }
      return; // duplicate: already stored and broadcast
    }
    // Each site's operations must arrive in increasing counter order: version vectors rely on it.
    if (op.id.counter <= (room.vector.get(op.id.siteId) ?? 0)) {
      return sendError(ws, "operation out of order for this site");
    }
    if (room.log.length >= maxOps) return sendError(ws, "document is full");

    room.seen.set(key, op);
    room.vector.set(op.id.siteId, op.id.counter);
    room.log.push(op);

    const payload = encode({ type: "op", op });
    for (const client of room.clients.values()) {
      if (client !== ws) sendRaw(client, payload); // the sender already applied it locally
    }
  }

  function leave(ws: WebSocket): void {
    const session = sessions.get(ws);
    if (session === undefined) return;
    sessions.delete(ws);
    const room = rooms.get(session.docId);
    if (room !== undefined && room.clients.get(session.siteId) === ws) {
      room.clients.delete(session.siteId);
    }
    // The room and its log stay, so the document survives everyone leaving.
  }

  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendError(ws, "binary messages are not supported");
      const parsed = parseClientMessage(rawToString(data));
      if (!parsed.ok) return sendError(ws, parsed.error);
      const msg = parsed.value;
      if (msg.type === "join") handleJoin(ws, msg);
      else handleOp(ws, msg.op);
    });
    ws.on("close", () => leave(ws));
    // Without an error listener, a protocol error (like an oversized frame) would crash the process.
    ws.on("error", () => ws.terminate());
  });

  return new Promise<RunningServer>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      wss.on("error", (err) => console.error("server error:", err));
      const address = wss.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine server port"));
        return;
      }
      resolve({
        port: address.port,
        stats() {
          let operations = 0;
          for (const room of rooms.values()) operations += room.log.length;
          return { connections: sessions.size, documents: rooms.size, operations };
        },
        close() {
          for (const client of wss.clients) client.terminate();
          return new Promise<void>((done) => wss.close(() => done()));
        },
      });
    });
  });
}
