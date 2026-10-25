import { Rga } from "@collab/crdt";
import type { ClientMessage, ServerMessage } from "@collab/protocol";
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
  private joined = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.rga = new Rga(options.siteId);
  }

  get text(): string {
    return this.rga.toString();
  }

  get isJoined(): boolean {
    return this.joined;
  }

  join(): void {
    this.options.send({ type: "join", docId: this.options.docId, siteId: this.options.siteId });
  }

  // The user changed the text: turn the difference into operations and send them.
  applyLocalText(newText: string): void {
    if (!this.joined) throw new Error("cannot edit before joining the document");
    const edit = diffCodePoints(this.rga.toString(), newText);
    if (edit === null) return;

    // Each delete shifts the text left, so every delete happens at the same index.
    for (let i = 0; i < edit.deleteCount; i++) {
      this.options.send({ type: "op", op: this.rga.deleteAt(edit.index) });
    }
    edit.insert.forEach((char, i) => {
      this.options.send({ type: "op", op: this.rga.insertAt(edit.index + i, char) });
    });
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
      this.joined = true;
    } else {
      this.rga.apply(msg.op);
    }
    return diffCodePoints(before, this.rga.toString());
  }
}
