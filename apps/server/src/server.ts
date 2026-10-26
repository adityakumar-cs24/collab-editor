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
import { MemoryStorage, indexOps, validateStoredOps, type OpStorage } from "./storage";

export interface ServerOptions {
  port?: number; // 0 picks a free port
  host?: string;
  maxOpsPerDocument?: number;
  heartbeatIntervalMs?: number; // how often to ping; 0 disables (default 30000)
  // Where operations are kept. The default is memory only. A storage passed in stays open when
  // the server closes: whoever created it closes it.
  storage?: OpStorage;
  onError?: (error: unknown) => void;
}

export interface RunningServer {
  readonly port: number;
  stats(): { connections: number; documents: number; operations: number };
  close(): Promise<void>;
}

interface Room {
  readonly docId: string;
  readonly clients: Map<string, WebSocket>; // siteId -> connection
  log: Op[]; // every operation, in arrival order
  seen: Map<string, Op>; // operations in the log, by id
  vector: Map<string, number>; // highest counter per site in the log
  loaded: boolean;
  // Joins and writes for one document run one at a time, so storage order, memory order and
  // broadcast order are always the same.
  queue: Promise<void>;
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

function runInRoom<T>(room: Room, task: () => Promise<T>): Promise<T> {
  const result = room.queue.then(task);
  room.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const maxOps = options.maxOpsPerDocument ?? DEFAULT_MAX_OPS_PER_DOCUMENT;
  const ownsStorage = options.storage === undefined;
  const storage = options.storage ?? new MemoryStorage();
  const onError = options.onError ?? ((error: unknown) => console.error("server error:", error));
  const rooms = new Map<string, Room>();
  const sessions = new Map<WebSocket, Session>();
  // Connections that had a storage failure. Nothing more is accepted from them: their next
  // operation would otherwise leave a gap in the counters of that site.
  const broken = new WeakSet<WebSocket>();
  // Messages of one connection are handled one at a time, in order.
  const chains = new WeakMap<WebSocket, Promise<void>>();

  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host: options.host ?? "127.0.0.1",
    maxPayload: MAX_MESSAGE_LENGTH, // bytes; ws closes the connection with 1009 beyond this
  });

  function fail(ws: WebSocket): void {
    broken.add(ws);
    ws.close(1011, "internal error"); // the client reconnects and rejoins from the server vector
  }

  function enqueue(ws: WebSocket, task: () => Promise<void>): void {
    const previous = chains.get(ws) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      onError(error);
      fail(ws);
    });
    chains.set(ws, next);
  }

  function getRoom(docId: string): Room {
    let room = rooms.get(docId);
    if (room === undefined) {
      room = {
        docId,
        clients: new Map(),
        log: [],
        seen: new Map(),
        vector: new Map(),
        loaded: false,
        queue: Promise.resolve(),
      };
      rooms.set(docId, room);
    }
    return room;
  }

  async function loadRoom(room: Room): Promise<void> {
    const raw = await storage.load(room.docId);
    const ops = validateStoredOps(room.docId, raw);
    const index = indexOps(room.docId, ops);
    room.log = ops;
    room.seen = index.seen;
    room.vector = index.vector;
    room.loaded = true;
  }

  async function handleJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: "join" }>): Promise<void> {
    if (sessions.has(ws)) return sendError(ws, "already joined");
    const room = getRoom(msg.docId);
    await runInRoom(room, async () => {
      if (broken.has(ws) || ws.readyState !== WebSocket.OPEN) return;
      if (!room.loaded) {
        try {
          await loadRoom(room);
        } catch (error) {
          onError(error);
          sendError(ws, "could not load document");
          fail(ws);
          return;
        }
      }
      // The connection may have closed while the document was loading.
      if (broken.has(ws) || ws.readyState !== WebSocket.OPEN) return;
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
    });
  }

  async function handleOp(ws: WebSocket, op: Op): Promise<void> {
    const session = sessions.get(ws);
    if (session === undefined) return sendError(ws, "join a document first");
    if (op.id.siteId !== session.siteId) {
      return sendError(ws, "operation does not belong to this site");
    }
    const room = rooms.get(session.docId);
    if (room === undefined) return sendError(ws, "document not found");

    await runInRoom(room, async () => {
      if (broken.has(ws) || sessions.get(ws) !== session) return;

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

      // Save first. Only an operation that is stored is added to memory and forwarded.
      try {
        await storage.append(room.docId, op);
      } catch (error) {
        onError(error);
        sendError(ws, "could not save operation");
        fail(ws);
        return;
      }

      room.seen.set(key, op);
      room.vector.set(op.id.siteId, op.id.counter);
      room.log.push(op);

      const payload = encode({ type: "op", op });
      for (const client of room.clients.values()) {
        if (client !== ws) sendRaw(client, payload); // the sender already applied it locally
      }
    });
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

  // Heartbeat: a connection that goes silent (half-open TCP, a laptop lid closed) is terminated,
  // which frees its siteId so the client can reconnect.
  const alive = new WeakSet<WebSocket>();
  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const client of wss.clients) {
            if (!alive.has(client)) {
              client.terminate();
              continue;
            }
            alive.delete(client);
            client.ping();
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();
  wss.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
  });

  wss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    ws.on("message", (data, isBinary) => {
      enqueue(ws, async () => {
        if (broken.has(ws)) return;
        if (isBinary) return sendError(ws, "binary messages are not supported");
        const parsed = parseClientMessage(rawToString(data));
        if (!parsed.ok) return sendError(ws, parsed.error);
        const msg = parsed.value;
        if (msg.type === "join") await handleJoin(ws, msg);
        else await handleOp(ws, msg.op);
      });
    });
    ws.on("close", () => leave(ws));
    // Without an error listener, a protocol error (like an oversized frame) would crash the process.
    ws.on("error", () => ws.terminate());
  });

  return new Promise<RunningServer>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      wss.on("error", (err) => onError(err));
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
        async close() {
          for (const client of wss.clients) client.terminate();
          await new Promise<void>((done) => wss.close(() => done()));
          if (ownsStorage) await storage.close();
        },
      });
    });
  });
}
