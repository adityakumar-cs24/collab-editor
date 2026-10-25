import { WebSocket as WsWebSocket } from "ws";
import { Connection, type SocketLike } from "./connection";
import { EditorSession } from "./session";
import { openDoc, type DocStore } from "./store";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

export function wrapWs(raw: WsWebSocket): SocketLike {
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (data) => raw.send(data),
    close: () => raw.close(),
  };
  raw.on("open", () => socket.onopen?.());
  raw.on("message", (data, isBinary) => {
    if (!isBinary) socket.onmessage?.(data.toString());
  });
  raw.on("close", () => socket.onclose?.());
  raw.on("error", () => {});
  return socket;
}

export interface Peer {
  readonly siteId: string;
  readonly session: EditorSession;
  readonly connection: Connection;
  readonly sockets: WsWebSocket[];
  readonly errors: string[];
  readonly storageErrors: string[];
}

// Starts a client the way the page does: load or create the saved identity, restore the saved
// document, then connect (unless told not to).
export async function startPeer(
  port: number,
  docId: string,
  store: DocStore,
  options: { connect?: boolean } = {},
): Promise<Peer> {
  const opened = await openDoc(store, docId);
  const sockets: WsWebSocket[] = [];
  const errors: string[] = [];
  const storageErrors: string[] = [];
  const session = new EditorSession({
    docId,
    siteId: opened.siteId,
    send: (msg) => connection.send(msg),
    onError: (message) => errors.push(message),
    persist: (ops) => store.append(docId, ops),
    onStorageError: (message) => storageErrors.push(message),
  });
  if (opened.ops !== null) session.restore(opened.ops);
  const connection = new Connection({
    session,
    createSocket: () => {
      const raw = new WsWebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(raw);
      return wrapWs(raw);
    },
    baseDelayMs: 5,
    maxDelayMs: 20,
  });
  if (options.connect !== false) connection.goOnline();
  return { siteId: opened.siteId, session, connection, sockets, errors, storageErrors };
}
