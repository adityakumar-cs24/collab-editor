import { expect } from "vitest";
import { Rga, type Op } from "../rga";

export type Action =
  | { kind: "edit"; replica: number; del: boolean; pos: number; char: string }
  | { kind: "deliver"; replica: number; pick: number; dup: boolean };

export interface SimulationResult {
  replicas: Rga[];
  insertCount: number;
}

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`index ${i} out of bounds`);
  return v;
}

// Run a random history across n replicas with out-of-order and duplicated delivery,
// then deliver everything still outstanding.
export function simulate(n: number, actions: readonly Action[]): SimulationResult {
  const replicas = Array.from({ length: n }, (_, i) => new Rga(`site${i}`));
  const inboxes: Op[][] = Array.from({ length: n }, () => []);
  let insertCount = 0;

  for (const a of actions) {
    const r = a.replica % n;

    if (a.kind === "edit") {
      const replica = at(replicas, r);
      let op: Op;
      if (a.del) {
        if (replica.length === 0) continue; // nothing to delete
        op = replica.deleteAt(a.pos % replica.length);
      } else {
        op = replica.insertAt(a.pos % (replica.length + 1), a.char);
        insertCount++;
      }
      for (let j = 0; j < n; j++) if (j !== r) at(inboxes, j).push(op);
    } else {
      const inbox = at(inboxes, r);
      if (inbox.length === 0) continue;
      const index = a.pick % inbox.length;
      at(replicas, r).apply(at(inbox, index));
      if (!a.dup) inbox.splice(index, 1); // dup: message stays and will be delivered again
    }
  }

  // Final drain, in reverse order for extra stress.
  for (let r = 0; r < n; r++) {
    for (const op of [...at(inboxes, r)].reverse()) at(replicas, r).apply(op);
  }

  return { replicas, insertCount };
}

export function expectConverged({ replicas, insertCount }: SimulationResult): void {
  const expected = at(replicas, 0).toString();
  for (const r of replicas) {
    expect(r.toString()).toBe(expected);
    expect(r.pendingCount).toBe(0);
    expect(r.nodeCount).toBe(insertCount);
  }
}
