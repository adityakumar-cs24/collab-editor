import { startServer } from "./server";

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["HOST"] ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid PORT: ${process.env["PORT"]}`);
  process.exit(1);
}

const server = await startServer({ port, host });
console.log(`collab server listening on ws://${host}:${server.port}`);

process.on("SIGINT", () => {
  void server.close().then(() => process.exit(0));
});
