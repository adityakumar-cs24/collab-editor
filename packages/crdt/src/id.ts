export type SiteId = string;

export interface CharId {
  readonly counter: number;
  readonly siteId: SiteId;
}

export function makeId(counter: number, siteId: SiteId): CharId {
  return { counter, siteId };
}

// Total order: counter first, siteId breaks ties.
// Returns <0 if a < b, 0 if equal, >0 if a > b.
export function compareIds(a: CharId, b: CharId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.siteId < b.siteId) return -1;
  if (a.siteId > b.siteId) return 1;
  return 0;
}

export function idEquals(a: CharId, b: CharId): boolean {
  return a.counter === b.counter && a.siteId === b.siteId;
}

// Stable string key, useful for Map lookups later.
// JSON.stringify makes it unambiguous even if siteId contains ':'.
export function idKey(id: CharId): string {
  return JSON.stringify([id.counter, id.siteId]);
}
