import { LamportClock } from "./clock";
import { compareIds, idEquals, idKey, makeId, type CharId, type SiteId } from "./id";

export interface InsertOp {
  readonly type: "insert";
  readonly id: CharId; // identity of the new character
  readonly origin: CharId | null; // inserted right after this character (null = document start)
  readonly char: string;
}

export interface DeleteOp {
  readonly type: "delete";
  readonly id: CharId; // identity of this delete operation itself
  readonly target: CharId; // the character being deleted
}

export type Op = InsertOp | DeleteOp;

interface Node {
  readonly id: CharId;
  readonly char: string;
  readonly origin: CharId | null;
  deleted: boolean;
}

export class Rga {
  readonly siteId: SiteId;
  private readonly clock = new LamportClock();
  // All nodes in document order, including tombstones.
  private readonly nodes: Node[] = [];
  private readonly byId = new Map<string, Node>();

  constructor(siteId: SiteId) {
    this.siteId = siteId;
  }

  // ---------- reading ----------

  toString(): string {
    let out = "";
    for (const n of this.nodes) if (!n.deleted) out += n.char;
    return out;
  }

  // Number of visible characters.
  get length(): number {
    let count = 0;
    for (const n of this.nodes) if (!n.deleted) count++;
    return count;
  }

  // Total nodes including tombstones (useful for measuring memory growth later).
  get nodeCount(): number {
    return this.nodes.length;
  }

  // ---------- local edits: return the operation to send to others ----------

  insertAt(index: number, char: string): InsertOp {
    const visible = this.visibleNodes();
    if (index < 0 || index > visible.length) {
      throw new RangeError(`insert index ${index} out of range 0..${visible.length}`);
    }
    const left = index === 0 ? undefined : visible[index - 1];
    const op: InsertOp = {
      type: "insert",
      id: makeId(this.clock.tick(), this.siteId),
      origin: left ? left.id : null,
      char,
    };
    this.integrateInsert(op);
    return op;
  }

  deleteAt(index: number): DeleteOp {
    const visible = this.visibleNodes();
    const target = visible[index];
    if (index < 0 || target === undefined) {
      throw new RangeError(`delete index ${index} out of range 0..${visible.length - 1}`);
    }
    const op: DeleteOp = {
      type: "delete",
      id: makeId(this.clock.tick(), this.siteId),
      target: target.id,
    };
    target.deleted = true;
    return op;
  }

  // ---------- remote operations ----------

  // Apply an operation created elsewhere. Safe to call twice with the same op.
  apply(op: Op): void {
    this.clock.observe(op.id.counter);
    if (op.type === "insert") {
      if (this.byId.has(idKey(op.id))) return; // already applied (idempotent)
      this.integrateInsert(op);
    } else {
      const target = this.byId.get(idKey(op.target));
      if (target === undefined) {
        throw new Error(`delete target ${idKey(op.target)} not found (causal buffering comes in step 6)`);
      }
      target.deleted = true; // deleting twice is harmless
    }
  }

  // ---------- internals ----------

  private visibleNodes(): Node[] {
    return this.nodes.filter((n) => !n.deleted);
  }

  private integrateInsert(op: InsertOp): void {
    let i = 0;
    if (op.origin !== null) {
      const originIndex = this.nodes.findIndex((n) => idEquals(n.id, op.origin as CharId));
      if (originIndex === -1) {
        throw new Error(`insert origin ${idKey(op.origin)} not found (causal buffering comes in step 6)`);
      }
      i = originIndex + 1;
    }
    // Skip over nodes with a greater id: they belong closer to the origin.
    while (true) {
      const next = this.nodes[i];
      if (next === undefined || compareIds(next.id, op.id) <= 0) break;
      i++;
    }
    const node: Node = { id: op.id, char: op.char, origin: op.origin, deleted: false };
    this.nodes.splice(i, 0, node);
    this.byId.set(idKey(op.id), node);
  }
}
