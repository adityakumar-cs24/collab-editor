export const PACKAGE_NAME = "@collab/crdt";

export type { SiteId, CharId } from "./id";
export { makeId, compareIds, idEquals, idKey } from "./id";
export { LamportClock } from "./clock";
