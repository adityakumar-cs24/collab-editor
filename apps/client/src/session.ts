import { Rga, type Op } from "@collab/crdt";
import {
  MAX_CLIENT_VECTOR_ENTRIES,
  entriesToVector,
  vectorToEntries,
  type ClientMessage,
  type ServerMessage,
  type VectorEntries,
} from "@collab/protocol";
import { diffCodePoints, type TextEdit } from "./diff";

export interface SessionOptions {
  readonly docId: string;
  readonly siteId: string;
  readonly send: (msg: ClientMessage) => void;
  readonly onError?: (message: string) => void;
}

export class EditorSession {
  private readonly rga: Rga;
  private readonly options: SessionOptions;
  // Operations this replica created that the server may not have yet, in counter order.
  // Trimmed on every rejoin using the server's version vector.
  private outbox: Op[] = [];
  private loaded = false; // the document has been received at least once
  private connected = false; // joined on a live connection

  constructor(options: SessionOptions) {
    this.options = options;
    this.rga = new Rga(options.siteId);
  }

  get text(): string {
    return this.rga.toString();
  }

  // The document has been loaded at least once, so local edits are allowed (even while offline).
  get isJoined(): boolean {
    return this.loaded;
  }

  // Joined on a live connection right now.
  get isConnected(): boolean {
    return this.connected;
  }

  get outboxSize(): number {
    return this.outbox.length;
  }

  get pendingCount(): number {
    return this.rga.pendingCount;
  }

  versionVector(): Map<string, number> {
    return this.rga.versionVector();
  }

  join(): void {
    this.connected = false; // nothing is sent until the server answers
    // Tell the server what we already have so it sends only the rest. If the vector would not fit
    // in one message, send an empty one: correct, but the server replays the whole history.
    const entries = vectorToEntries(this.rga.versionVector());
    const vector = entries.length <= MAX_CLIENT_VECTOR_ENTRIES ? entries : [];
    this.options.send({ type: "join", docId: this.options.docId, siteId: this.options.siteId, vector });
  }

  handleDisconnect(): void {
    this.connected = false;
  }

  // The user changed the text: turn the difference into operations. They are applied locally and
  // kept in the outbox; they are sent now if connected, or after the next successful join.
  applyLocalText(newText: string): void {
    if (!this.loaded) throw new Error("cannot edit before joining the document");
    const edit = diffCodePoints(this.rga.toString(), newText);
    if (edit === null) return;

    const ops: Op[] = [];
    // Each delete shifts the text left, so every delete happens at the same index.
    for (let i = 0; i < edit.deleteCount; i++) ops.push(this.rga.deleteAt(edit.index));
    edit.insert.forEach((char, i) => ops.push(this.rga.insertAt(edit.index + i, char)));

    for (const op of ops) {
      this.outbox.push(op);
      if (this.connected) this.options.send({ type: "op", op });
    }
  }

  // Apply a message from the server. Returns how the visible text changed (null if it did not).
  handleServerMessage(msg: ServerMessage): TextEdit | null {
    if (msg.type === "error") {
      this.options.onError?.(msg.message);
      return null;
    }
    const before = this.rga.toString();
    if (msg.type === "joined") {
      for (const op of msg.ops) this.rga.apply(op);
      this.loaded = true;
      this.resend(msg.vector ?? []);
    } else {
      this.rga.apply(msg.op);
    }
    return diffCodePoints(before, this.rga.toString());
  }

  // The server's copy of our operations is a prefix of ours (each site's operations arrive in order),
  // so everything above the server's counter for our site is missing and must be sent again.
  private resend(serverVector: VectorEntries): void {
    const known = entriesToVector(serverVector).get(this.options.siteId) ?? 0;
    this.outbox = this.outbox.filter((op) => op.id.counter > known);
    this.connected = true;
    for (const op of this.outbox) this.options.send({ type: "op", op });
  }
}
