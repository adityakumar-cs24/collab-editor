import { idKey, type Op } from "@collab/crdt";
import { parseClientMessage } from "@collab/protocol";

// Where a document's operations are kept. Operations are appended in arrival order and loaded
// back in the same order. Whatever comes back from load is untrusted until it is validated.
export interface OpStorage {
  load(docId: string): Promise<readonly unknown[]>;
  // Saving an operation that is already stored is not an error and stores nothing new.
  append(docId: string, op: Op): Promise<void>;
  close(): Promise<void>;
}

export class StoredDataError extends Error {}

// Stored operations go through the same parser as network messages. That rejects damaged data and
// also gives every operation the same property order as a freshly received one, which matters
// because the server compares operations by their serialized form (PostgreSQL jsonb does not keep
// the order of keys).
export function validateStoredOps(docId: string, raw: readonly unknown[]): Op[] {
  const ops: Op[] = [];
  for (const candidate of raw) {
    const parsed = parseClientMessage(JSON.stringify({ type: "op", op: candidate }));
    if (!parsed.ok || parsed.value.type !== "op") {
      throw new StoredDataError(`document ${docId} contains an invalid stored operation`);
    }
    ops.push(parsed.value.op);
  }
  return ops;
}

// Version vectors rely on each site's operations being stored in increasing counter order.
// If storage does not satisfy that, the document is refused instead of being served with a gap.
export function indexOps(
  docId: string,
  ops: readonly Op[],
): { seen: Map<string, Op>; vector: Map<string, number> } {
  const seen = new Map<string, Op>();
  const vector = new Map<string, number>();
  for (const op of ops) {
    if (op.id.counter <= (vector.get(op.id.siteId) ?? 0)) {
      throw new StoredDataError(`document ${docId} stores operations of site ${op.id.siteId} out of order or twice`);
    }
    seen.set(idKey(op.id), op);
    vector.set(op.id.siteId, op.id.counter);
  }
  return { seen, vector };
}

export class MemoryStorage implements OpStorage {
  private readonly docs = new Map<string, { log: Op[]; keys: Set<string> }>();

  async load(docId: string): Promise<readonly unknown[]> {
    return [...(this.docs.get(docId)?.log ?? [])];
  }

  async append(docId: string, op: Op): Promise<void> {
    let doc = this.docs.get(docId);
    if (doc === undefined) {
      doc = { log: [], keys: new Set() };
      this.docs.set(docId, doc);
    }
    const key = idKey(op.id);
    if (doc.keys.has(key)) return;
    doc.keys.add(key);
    doc.log.push(op);
  }

  async close(): Promise<void> {}
}
