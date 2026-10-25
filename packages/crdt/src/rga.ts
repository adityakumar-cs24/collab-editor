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
  // Operations received before their dependency, keyed by operation id.
  private readonly pending = new Map<string, Op>();

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

  // Operations waiting for a dependency. Should return to 0 once everything has arrived.
  get pendingCount(): number {
    return this.pending.size;
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
    this.integrate(op);
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
    this.integrate(op);
    return op;
  }

  // ---------- remote operations ----------

  // Apply an operation created elsewhere. Safe to call any number of times with the same op,
  // and in any order relative to other operations.
  apply(op: Op): void {
    this.clock.observe(op.id.counter);

    if (op.type === "insert" && this.byId.has(idKey(op.id))) return; // already applied
    if (this.pending.has(idKey(op.id))) return; // already waiting

    if (!this.isReady(op)) {
      this.pending.set(idKey(op.id), op);
      return;
    }
    this.integrate(op);
    this.drainPending();
  }

  // ---------- internals ----------

  private visibleNodes(): Node[] {
    return this.nodes.filter((n) => !n.deleted);
  }

  private isReady(op: Op): boolean {
    if (op.type === "insert") {
      return op.origin === null || this.byId.has(idKey(op.origin));
    }
    return this.byId.has(idKey(op.target));
  }

  // Repeatedly apply any pending operation whose dependency has arrived.
  private drainPending(): void {
    let progressed = true;
    while (progressed && this.pending.size > 0) {
      progressed = false;
      for (const [key, op] of this.pending) {
        if (this.isReady(op)) {
          this.pending.delete(key);
          this.integrate(op);
          progressed = true;
        }
      }
    }
  }

  // Precondition: isReady(op) is true.
  private integrate(op: Op): void {
    if (op.type === "insert") this.integrateInsert(op);
    else this.integrateDelete(op);
  }

  private integrateDelete(op: DeleteOp): void {
    const target = this.byId.get(idKey(op.target));
    if (target === undefined) {
      throw new Error(`invariant violated: delete target ${idKey(op.target)} missing`);
    }
    target.deleted = true; // deleting twice is harmless
  }

  private integrateInsert(op: InsertOp): void {
    let i = 0;
    if (op.origin !== null) {
      const originIndex = this.nodes.findIndex((n) => idEquals(n.id, op.origin as CharId));
      if (originIndex === -1) {
        throw new Error(`invariant violated: insert origin ${idKey(op.origin)} missing`);
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
