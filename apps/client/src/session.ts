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
  // Saves operations locally. Operations this replica creates are saved BEFORE they are sent,
  // so a reload can never lead to a counter being used twice.
  readonly persist?: (ops: Op[]) => Promise<void>;
  readonly onStorageError?: (message: string, fatal: boolean) => void;
}

interface OutboxEntry {
  readonly op: Op;
  persisted: boolean;
}

export class EditorSession {
  private readonly rga: Rga;
  private readonly options: SessionOptions;
  // Operations this replica created that the server may not have yet, in counter order.
  private outbox: OutboxEntry[] = [];
  private nextToSend = 0; // outbox[0 .. nextToSend) were sent on the current connection
  private loaded = false; // the document is available (received once, or restored from storage)
  private connected = false; // joined on a live connection
  private storageFailed = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: SessionOptions) {
    this.options = options;
    this.rga = new Rga(options.siteId);
  }

  get text(): string {
    return this.rga.toString();
  }

  // The document is available, so local edits are allowed (even while offline).
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

  // Resolves when everything handed to storage so far has been saved (or has failed).
  flushStorage(): Promise<void> {
    return this.persistChain;
  }

  // Rebuild the document from operations saved earlier. Applying them moves the clock past every
  // counter seen, so new operations never reuse one. Own operations go back into the outbox and
  // are trimmed on the next join using the server vector.
  restore(ops: readonly Op[]): void {
    for (const op of ops) this.rga.apply(op);
    this.outbox = ops
      .filter((op) => op.id.siteId === this.options.siteId)
      .sort((a, b) => a.id.counter - b.id.counter)
      .map((op) => ({ op, persisted: true }));
    this.nextToSend = 0;
    this.loaded = true;
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
  // kept in the outbox; they are sent once saved and connected.
  applyLocalText(newText: string): void {
    if (!this.loaded) throw new Error("cannot edit before the document is loaded");
    if (this.storageFailed) throw new Error("local storage failed: cannot accept more edits");
    const edit = diffCodePoints(this.rga.toString(), newText);
    if (edit === null) return;

    const ops: Op[] = [];
    // Each delete shifts the text left, so every delete happens at the same index.
    for (let i = 0; i < edit.deleteCount; i++) ops.push(this.rga.deleteAt(edit.index));
    edit.insert.forEach((char, i) => ops.push(this.rga.insertAt(edit.index + i, char)));

    const entries: OutboxEntry[] = ops.map((op) => ({ op, persisted: this.options.persist === undefined }));
    for (const entry of entries) this.outbox.push(entry);
    if (this.options.persist === undefined) this.flush();
    else this.enqueuePersist(ops, entries);
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
      this.enqueuePersist(msg.ops, null);
      this.resend(msg.vector ?? []);
    } else {
      this.rga.apply(msg.op);
      this.enqueuePersist([msg.op], null);
    }
    return diffCodePoints(before, this.rga.toString());
  }

  // The server copy of our operations is a prefix of ours (each site operations arrive in order),
  // so everything above the server counter for our site is missing and must be sent again.
  private resend(serverVector: VectorEntries): void {
    const known = entriesToVector(serverVector).get(this.options.siteId) ?? 0;
    this.outbox = this.outbox.filter((entry) => entry.op.id.counter > known);
    this.nextToSend = 0;
    this.connected = true;
    this.flush();
  }

  // Send the saved, not yet sent prefix of the outbox, in order. Stops at the first unsaved entry.
  private flush(): void {
    if (!this.connected) return;
    while (this.nextToSend < this.outbox.length) {
      const entry = this.outbox[this.nextToSend];
      if (entry === undefined || !entry.persisted) break;
      this.options.send({ type: "op", op: entry.op });
      this.nextToSend++;
    }
  }

  // Saves are done one after another, in order. For our own operations a failure is fatal: sending
  // an operation that was not saved could lead to its counter being reused after a reload.
  private enqueuePersist(ops: readonly Op[], own: OutboxEntry[] | null): void {
    const persist = this.options.persist;
    if (persist === undefined || ops.length === 0) return;
    this.persistChain = this.persistChain.then(async () => {
      try {
        await persist([...ops]);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (own !== null) {
          this.storageFailed = true;
          this.options.onStorageError?.(`could not save edits locally: ${reason}`, true);
        } else {
          this.options.onStorageError?.(`could not save received changes locally: ${reason}`, false);
        }
        return;
      }
      if (own !== null) {
        for (const entry of own) entry.persisted = true;
        this.flush();
      }
    });
  }
}
