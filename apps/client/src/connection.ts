import { encode, parseServerMessage, type ClientMessage } from "@collab/protocol";
import type { TextEdit } from "./diff";
import type { EditorSession } from "./session";

// The part of a WebSocket the connection needs, so tests can use a fake one.
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((data: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline";

// The server refuses a join while it still believes the previous connection of this site is alive.
// That is temporary, so it is retried instead of reported.
export const SITE_ID_IN_USE = "siteId already in use in this document";

export interface ConnectionOptions {
  readonly session: EditorSession;
  readonly createSocket: () => SocketLike;
  readonly onStatus?: (status: ConnectionStatus) => void;
  readonly onRemoteEdit?: (edit: TextEdit) => void;
  readonly onProtocolError?: (message: string) => void;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly random?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class Connection {
  private readonly session: EditorSession;
  private readonly createSocket: () => SocketLike;
  private readonly onStatus: ((status: ConnectionStatus) => void) | undefined;
  private readonly onRemoteEdit: ((edit: TextEdit) => void) | undefined;
  private readonly onProtocolError: ((message: string) => void) | undefined;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private socket: SocketLike | null = null;
  private open = false;
  private attempt = 0;
  private timer: unknown = null;
  private wantOnline = false;
  private current: ConnectionStatus = "offline";

  constructor(options: ConnectionOptions) {
    this.session = options.session;
    this.createSocket = options.createSocket;
    this.onStatus = options.onStatus;
    this.onRemoteEdit = options.onRemoteEdit;
    this.onProtocolError = options.onProtocolError;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get status(): ConnectionStatus {
    return this.current;
  }

  // Start connecting (and keep reconnecting until goOffline is called).
  goOnline(): void {
    if (this.wantOnline) return;
    this.wantOnline = true;
    this.attempt = 0;
    this.connect();
  }

  // Disconnect on purpose and stop reconnecting. Local edits keep working and are kept for later.
  goOffline(): void {
    this.wantOnline = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.dropSocket();
    this.setStatus("offline");
  }

  send(msg: ClientMessage): void {
    if (this.socket !== null && this.open) this.socket.send(encode(msg));
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.current) return;
    this.current = status;
    this.onStatus?.(status);
  }

  private connect(): void {
    this.setStatus(this.session.isJoined ? "reconnecting" : "connecting");
    const socket = this.createSocket();
    this.socket = socket;
    this.open = false;
    // Events from a socket we already replaced or closed are ignored.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.session.join();
    };
    socket.onmessage = (data) => {
      if (this.socket !== socket) return;
      this.handleData(data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.open = false;
      this.session.handleDisconnect();
      if (this.wantOnline) this.scheduleReconnect();
    };
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.session.handleDisconnect();
    socket?.close();
  }

  private handleData(data: unknown): void {
    if (typeof data !== "string") return;
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      this.onProtocolError?.(parsed.error);
      return;
    }
    const msg = parsed.value;
    if (msg.type === "error" && msg.message === SITE_ID_IN_USE && !this.session.isConnected) {
      this.dropSocket();
      if (this.wantOnline) this.scheduleReconnect();
      return;
    }
    const edit = this.session.handleServerMessage(msg);
    if (edit !== null) this.onRemoteEdit?.(edit);
    if (msg.type === "joined") {
      this.attempt = 0;
      this.setStatus("online");
    }
  }

  // Exponential backoff with jitter: wait between half and all of the ceiling, which doubles each
  // attempt up to a cap. The randomness keeps many clients from reconnecting in lockstep.
  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempt);
    const delay = Math.floor(ceiling / 2 + (this.random() * ceiling) / 2);
    this.attempt += 1;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.wantOnline) this.connect();
    }, delay);
  }
}

// Adapts a browser WebSocket to SocketLike.
export function wrapBrowserSocket(ws: WebSocket): SocketLike {
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
  ws.addEventListener("open", () => socket.onopen?.());
  ws.addEventListener("message", (event: MessageEvent) => socket.onmessage?.(event.data));
  ws.addEventListener("close", () => socket.onclose?.());
  return socket;
}
