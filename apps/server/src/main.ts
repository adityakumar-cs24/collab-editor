import { PgStorage } from "./pg-storage";
import { startServer } from "./server";

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["HOST"] ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid PORT: ${process.env["PORT"]}`);
  process.exit(1);
}

const databaseUrl = process.env["DATABASE_URL"];
const storage = databaseUrl ? await PgStorage.open({ connectionString: databaseUrl }) : undefined;
console.log(
  storage
    ? "documents are stored in PostgreSQL"
    : "no DATABASE_URL: documents are kept in memory and lost when the server stops",
);

const server = await startServer({ port, host, storage });
console.log(`collab server listening on ws://${host}:${server.port}`);

process.on("SIGINT", () => {
  void server
    .close()
    .then(() => storage?.close())
    .then(() => process.exit(0));
});
