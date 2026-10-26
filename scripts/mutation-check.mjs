import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Each mutation breaks one rule on purpose. A healthy test suite fails when it is applied.
const mutations = [
  { name: "crdt: ties between ids are not broken by site id", pkg: "packages/crdt", file: "packages/crdt/src/id.ts",
    find: "if (a.counter !== b.counter) return a.counter - b.counter;",
    replace: "if (a.counter !== b.counter) return a.counter - b.counter;\n  return 0;" },
  { name: "crdt: operations waiting for a dependency are never applied", pkg: "packages/crdt", file: "packages/crdt/src/rga.ts",
    find: "this.drainPending();", replace: "" },
  { name: "protocol: counter 0 is accepted", pkg: "packages/protocol", file: "packages/protocol/src/parse.ts",
    find: "Number.isSafeInteger(counter) || counter < 1) return null;",
    replace: "Number.isSafeInteger(counter) || counter < 0) return null;" },
  { name: "server: sender is sent its own operation back", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "if (client !== ws) sendRaw(client, payload);", replace: "sendRaw(client, payload);" },
  { name: "server: operations from another site are accepted", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "if (op.id.siteId !== session.siteId) {", replace: "if (false) {" },
  { name: "server: duplicates and conflicts are not detected", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "if (existing !== undefined) {", replace: "if (false) {" },
  { name: "server: out of order operations from a site are accepted", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "if (op.id.counter <= (room.vector.get(op.id.siteId) ?? 0)) {", replace: "if (false) {" },
  { name: "server: a connection with a failed save is not shut out", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "broken.add(ws);", replace: "" },
  { name: "server: the version vector is not rebuilt after a restart", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "room.vector = index.vector;", replace: "" },
  { name: "server: joins and writes of a document are not serialized", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "const result = room.queue.then(task);", replace: "const result = task();" },
  { name: "server: silent connections are never terminated", pkg: "apps/server", file: "apps/server/src/server.ts",
    find: "if (!alive.has(client)) {", replace: "if (false) {" },
  { name: "server: stored operations are not normalized", pkg: "apps/server", file: "apps/server/src/storage.ts",
    find: "ops.push(parsed.value.op);", replace: "ops.push(candidate as Op);" },
  { name: "server: postgres returns operations in counter order, not arrival order", pkg: "apps/server", file: "apps/server/src/pg-storage.ts",
    find: "ORDER BY seq", replace: "ORDER BY counter", needsDb: true },
  { name: "client: everything in the outbox is resent after a rejoin", pkg: "apps/client", file: "apps/client/src/session.ts",
    find: "entry.op.id.counter > known", replace: "entry.op.id.counter >= 0" },
  { name: "client: reconnect delay does not grow", pkg: "apps/client", file: "apps/client/src/connection.ts",
    find: "this.baseDelayMs * 2 ** this.attempt", replace: "this.baseDelayMs * 1" },
  { name: "client: messages from a replaced socket are not ignored", pkg: "apps/client", file: "apps/client/src/connection.ts",
    find: "socket.onmessage = (data) => {\n      if (this.socket !== socket) return;",
    replace: "socket.onmessage = (data) => {" },
  { name: "client: unsaved operations are sent", pkg: "apps/client", file: "apps/client/src/session.ts",
    find: "if (entry === undefined || !entry.persisted) break;", replace: "if (entry === undefined) break;" },
  { name: "client: restore puts other sites operations in the outbox", pkg: "apps/client", file: "apps/client/src/session.ts",
    find: ".filter((op) => op.id.siteId === this.options.siteId)", replace: ".filter(() => true)" },
  { name: "client: a failed save of an own edit is not fatal", pkg: "apps/client", file: "apps/client/src/session.ts",
    find: "this.storageFailed = true;", replace: "" },
  { name: "client: memory store replaces an existing identity", pkg: "apps/client", file: "apps/client/src/store.ts",
    find: "if (!this.docs.has(docId)) this.docs.set(docId, siteId);", replace: "this.docs.set(docId, siteId);" },
];

let active = null;
function restore() {
  if (active) {
    writeFileSync(active.file, active.original);
    active = null;
  }
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("exit", restore);

function runTests(pkg) {
  const r = spawnSync("pnpm", ["exec", "vitest", "run"], { cwd: pkg, encoding: "utf8", env: process.env });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "");
  const m = out.match(/^\s*Tests\s+(.*)$/m);
  return { passed: r.status === 0, summary: m ? m[1].trim() : "no summary" };
}

const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout
  .split("\n").filter((line) => line && !line.includes("scripts/mutation-check.mjs"));
if (dirty.length > 0) {
  console.error("Commit or stash your changes first:\n" + dirty.join("\n"));
  process.exit(2);
}

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
const packages = [...new Set(mutations.map((m) => m.pkg))];
for (const pkg of packages) {
  const base = runTests(pkg);
  console.log("baseline " + pkg + ": " + base.summary);
  if (!base.passed) {
    console.error("The unmodified tests of " + pkg + " do not pass, so mutation results would mean nothing.");
    process.exit(2);
  }
}

const results = [];
for (const m of mutations) {
  if (m.needsDb && !hasDb) {
    results.push({ name: m.name, verdict: "SKIPPED (set TEST_DATABASE_URL)", detail: "" });
    continue;
  }
  const original = readFileSync(m.file, "utf8");
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    results.push({ name: m.name, verdict: "ANCHOR NOT FOUND (matches: " + count + ")", detail: m.file });
    continue;
  }
  active = { file: m.file, original };
  writeFileSync(m.file, original.replace(m.find, () => m.replace));
  const run = runTests(m.pkg);
  restore();
  results.push({ name: m.name, verdict: run.passed ? "SURVIVED (tests still pass)" : "caught", detail: run.summary });
  console.log((run.passed ? "SURVIVED  " : "caught    ") + m.name + "  [" + run.summary + "]");
}

console.log("\nSummary");
for (const r of results) console.log(r.verdict.padEnd(32) + " " + r.name + (r.detail ? "  [" + r.detail + "]" : ""));
const caught = results.filter((r) => r.verdict === "caught").length;
console.log("\n" + caught + " of " + results.length + " mutations caught");
console.log(spawnSync("git", ["diff", "--stat"], { encoding: "utf8" }).stdout || "working tree is clean again");
process.exit(results.every((r) => r.verdict === "caught" || r.verdict.startsWith("SKIPPED")) ? 0 : 1);
