import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import pg from "pg";
import type { Op } from "@collab/crdt";
import { PgStorage } from "./pg-storage";
import { startServer, type RunningServer } from "./server";
import { insertOp, runStorageContract } from "./storage-contract";
import { TestClient } from "./test-helpers";

const url = process.env["TEST_DATABASE_URL"];
const noop = () => {};

// Each test gets its own schema, so tests never see each other's data and can run in parallel.
async function openTemp(): Promise<{ storage: PgStorage; schema: string; cleanup: () => Promise<void> }> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const storage = await PgStorage.open({ connectionString: url ?? "", schema });
  const cleanup = async () => {
    await storage.close();
    const pool = new pg.Pool({ connectionString: url });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  };
  return { storage, schema, cleanup };
}

async function joinWith(port: number, docId: string, siteId: string, vector: Array<[string, number]> = []) {
  const client = await TestClient.connect(port);
  client.send({ type: "join", docId, siteId, vector });
  const msg = await client.next();
  if (msg.type !== "joined") throw new Error(`expected joined, got ${JSON.stringify(msg)}`);
  return { client, ops: msg.ops, vector: msg.vector ?? [] };
}

async function sync(client: TestClient): Promise<void> {
  client.sendRaw("{sync");
  expect(await client.next()).toEqual({ type: "error", message: "invalid JSON" });
}

describe.skipIf(!url)("postgres", () => {
  runStorageContract("postgres", async () => {
    const temp = await openTemp();
    return { storage: temp.storage, cleanup: temp.cleanup };
  });

  describe("server on postgres", () => {
    it("a document survives a server restart, and a retry of a stored operation is still a quiet no-op", async () => {
      const temp = await openTemp();
      let reopened: PgStorage | undefined;
      const running: RunningServer[] = [];
      try {
        const first = await startServer({ port: 0, storage: temp.storage, onError: noop });
        running.push(first);
        const alice = await joinWith(first.port, "doc", "alice");
        const ops: Op[] = [1, 2, 3, 4, 5].map((counter) => insertOp(counter, "alice", "x"));
        for (const op of ops) alice.client.send({ type: "op", op });
        await sync(alice.client);
        await first.close();
        await temp.storage.close();

        reopened = await PgStorage.open({ connectionString: url ?? "", schema: temp.schema });
        const second = await startServer({ port: 0, storage: reopened, onError: noop });
        running.push(second);

        const bob = await joinWith(second.port, "doc", "bob");
        expect(bob.ops).toEqual(ops);
        expect(bob.vector).toEqual([["alice", 5]]);

        // jsonb does not keep the order of keys. A retry of a stored operation must still be
        // recognised as the same operation, not reported as a conflict.
        const alice2 = await joinWith(second.port, "doc", "alice", [["alice", 5]]);
        alice2.client.send({ type: "op", op: ops[4] as Op });
        await sync(alice2.client); // fails if the retry produced a conflict error instead
      } finally {
        for (const server of running) await server.close();
        await reopened?.close();
        await temp.cleanup();
      }
    });

    it("refuses to serve a document with a damaged stored row", async () => {
      const temp = await openTemp();
      const pool = new pg.Pool({ connectionString: url });
      let server: RunningServer | undefined;
      try {
        await pool.query(
          `INSERT INTO "${temp.schema}".ops (doc_id, site_id, counter, op) VALUES ($1, $2, $3, $4::jsonb)`,
          ["doc", "x", 1, JSON.stringify({ bogus: true })],
        );
        server = await startServer({ port: 0, storage: temp.storage, onError: noop });
        const client = await TestClient.connect(server.port);
        client.send({ type: "join", docId: "doc", siteId: "alice", vector: [] });
        expect(await client.next()).toEqual({ type: "error", message: "could not load document" });
        expect(await client.waitForClose()).toBe(1011);
      } finally {
        await server?.close();
        await pool.end();
        await temp.cleanup();
      }
    });
  });
});
