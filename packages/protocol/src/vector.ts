import type { VersionVector } from "@collab/crdt";
import type { VectorEntries } from "./messages";

// Sorted, so the same vector always encodes to the same message.
export function vectorToEntries(vector: VersionVector): VectorEntries {
  return [...vector].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function entriesToVector(entries: VectorEntries): Map<string, number> {
  return new Map(entries);
}
