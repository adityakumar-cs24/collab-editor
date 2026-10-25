import type { Op } from "./rga";

// For each site, the highest counter received. This summarises "everything I have from this site"
// because each site's operations are created, sent and delivered in increasing counter order.
export type VersionVector = ReadonlyMap<string, number>;

// The operations in `log` that a replica holding `vector` does not have yet.
export function missingOps(log: readonly Op[], vector: VersionVector): Op[] {
  return log.filter((op) => op.id.counter > (vector.get(op.id.siteId) ?? 0));
}

export function vectorsEqual(a: VersionVector, b: VersionVector): boolean {
  if (a.size !== b.size) return false;
  for (const [site, counter] of a) if (b.get(site) !== counter) return false;
  return true;
}
