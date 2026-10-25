import { idKey, type Op } from "@collab/crdt";
import { parseClientMessage } from "@collab/protocol";

// What a store hands back is untrusted: it may be old, damaged or edited by hand.
export interface RawStoredDoc {
  readonly siteId: unknown;
  readonly ops: readonly unknown[];
}

export interface StoredDoc {
  readonly siteId: string;
  readonly ops: Op[];
  readonly skipped: number; // records that failed validation
}

export interface DocStore {
  load(docId: string): Promise<RawStoredDoc | null>;
  // Records the replica identity for a document. Never replaces an existing one.
  create(docId: string, siteId: string): Promise<void>;
  // Saves operations. Saving the same operation twice is harmless. Resolves once they are durable.
  append(docId: string, ops: readonly Op[]): Promise<void>;
}

function safeParseOp(candidate: unknown): Op | null {
  try {
    const parsed = parseClientMessage(JSON.stringify({ type: "op", op: candidate }));
    return parsed.ok && parsed.value.type === "op" ? parsed.value.op : null;
  } catch {
    return null;
  }
}

export async function loadDoc(store: DocStore, docId: string): Promise<StoredDoc | null> {
  const raw = await store.load(docId);
  if (raw === null) return null;
  const identity = parseClientMessage(JSON.stringify({ type: "join", docId, siteId: raw.siteId }));
  if (!identity.ok || identity.value.type !== "join") {
    throw new Error("stored document identity is invalid");
  }
  const ops: Op[] = [];
  let skipped = 0;
  for (const candidate of raw.ops) {
    const op = safeParseOp(candidate);
    if (op === null) skipped++;
    else ops.push(op);
  }
  return { siteId: identity.value.siteId, ops, skipped };
}

// Loads the saved document, or creates a new replica identity for it.
export async function openDoc(
  store: DocStore,
  docId: string,
  newSiteId: () => string = () => crypto.randomUUID(),
): Promise<{ siteId: string; ops: Op[] | null; skipped: number }> {
  const stored = await loadDoc(store, docId);
  if (stored !== null) return { siteId: stored.siteId, ops: stored.ops, skipped: stored.skipped };
  const siteId = newSiteId();
  await store.create(docId, siteId);
  return { siteId, ops: null, skipped: 0 };
}

export class MemoryStore implements DocStore {
  private readonly docs = new Map<string, string>();
  private readonly ops = new Map<string, Map<string, Op>>();

  async load(docId: string): Promise<RawStoredDoc | null> {
    const siteId = this.docs.get(docId);
    if (siteId === undefined) return null;
    return { siteId, ops: [...(this.ops.get(docId)?.values() ?? [])] };
  }

  async create(docId: string, siteId: string): Promise<void> {
    if (!this.docs.has(docId)) this.docs.set(docId, siteId);
  }

  async append(docId: string, ops: readonly Op[]): Promise<void> {
    let saved = this.ops.get(docId);
    if (saved === undefined) {
      saved = new Map();
      this.ops.set(docId, saved);
    }
    for (const op of ops) saved.set(idKey(op.id), op);
  }
}

const DOCS = "docs";
const OPS = "ops";

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // A failed request aborts the transaction, which fires onabort. An onerror handler here would
    // also fire for request errors that bubble up but do not abort, and reject too early.
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

class IdbStore implements DocStore {
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  async load(docId: string): Promise<RawStoredDoc | null> {
    const tx = this.db.transaction([DOCS, OPS], "readonly");
    const doc = tx.objectStore(DOCS).get(docId);
    const records = tx.objectStore(OPS).index("byDoc").getAll(IDBKeyRange.only(docId));
    await transactionDone(tx);
    const row = doc.result as { siteId?: unknown } | undefined;
    if (row === undefined) return null;
    const saved = records.result as Array<{ op?: unknown }>;
    return { siteId: row.siteId, ops: saved.map((record) => record.op) };
  }

  async create(docId: string, siteId: string): Promise<void> {
    const tx = this.db.transaction(DOCS, "readwrite");
    const store = tx.objectStore(DOCS);
    // Check and add inside one read-write transaction, so an existing identity is never replaced.
    const existing = store.get(docId);
    existing.onsuccess = () => {
      if (existing.result === undefined) store.add({ docId, siteId });
    };
    await transactionDone(tx);
  }

  async append(docId: string, ops: readonly Op[]): Promise<void> {
    if (ops.length === 0) return;
    const tx = this.db.transaction(OPS, "readwrite");
    const store = tx.objectStore(OPS);
    for (const op of ops) {
      store.put({ docId, siteId: op.id.siteId, counter: op.id.counter, op });
    }
    await transactionDone(tx);
  }
}

export function openIdbStore(name = "collab-editor"): Promise<DocStore> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(DOCS, { keyPath: "docId" });
      const ops = db.createObjectStore(OPS, { keyPath: ["docId", "siteId", "counter"] });
      ops.createIndex("byDoc", "docId");
    };
    request.onsuccess = () => resolve(new IdbStore(request.result));
    request.onerror = () => reject(request.error ?? new Error("could not open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}
