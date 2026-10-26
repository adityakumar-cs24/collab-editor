import pg from "pg";
import type { Op } from "@collab/crdt";
import type { OpStorage } from "./storage";

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,40}$/;

export interface PgOptions {
  readonly connectionString: string;
  // Lets tests use a private schema. The name is checked because it is placed inside SQL.
  readonly schema?: string;
  readonly max?: number;
}

export class PgStorage implements OpStorage {
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private closed = false;

  private constructor(pool: pg.Pool, schema: string) {
    this.pool = pool;
    this.schema = schema;
  }

  static async open(options: PgOptions): Promise<PgStorage> {
    const schema = options.schema ?? "public";
    if (!SCHEMA_PATTERN.test(schema)) throw new Error(`invalid schema name: ${schema}`);
    const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
    // An idle connection can fail (for example when the database restarts). Without a listener,
    // that event would crash the whole process.
    pool.on("error", (error: Error) => console.error("postgres pool error:", error.message));
    const storage = new PgStorage(pool, schema);
    try {
      await storage.migrate();
    } catch (error) {
      await pool.end();
      throw error;
    }
    return storage;
  }

  private async migrate(): Promise<void> {
    const s = this.schema;
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS "${s}".ops (
         seq bigint GENERATED ALWAYS AS IDENTITY,
         doc_id text NOT NULL,
         site_id text NOT NULL,
         counter bigint NOT NULL,
         op jsonb NOT NULL,
         PRIMARY KEY (doc_id, site_id, counter)
       )`,
    );
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ops_doc_seq ON "${s}".ops (doc_id, seq)`);
  }

  async load(docId: string): Promise<readonly unknown[]> {
    const result = await this.pool.query<{ op: unknown }>(
      `SELECT op FROM "${this.schema}".ops WHERE doc_id = $1 ORDER BY seq`,
      [docId],
    );
    return result.rows.map((row) => row.op);
  }

  async append(docId: string, op: Op): Promise<void> {
    await this.pool.query(
      `INSERT INTO "${this.schema}".ops (doc_id, site_id, counter, op)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (doc_id, site_id, counter) DO NOTHING`,
      [docId, op.id.siteId, op.id.counter, JSON.stringify(op)],
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
