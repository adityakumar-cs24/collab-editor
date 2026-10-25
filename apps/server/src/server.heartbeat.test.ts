import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./server";
import { TestClient, waitFor } from "./test-helpers";

let server: RunningServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("heartbeat", () => {
  it("terminates a connection that stops answering pings and frees its siteId", async () => {
    const running = await startServer({ port: 0, heartbeatIntervalMs: 40 });
    server = running;

    // autoPong: false makes this client ignore pings, like a half-open connection would.
    const silent = new WebSocket(`ws://127.0.0.1:${running.port}`, { autoPong: false });
    let closed = false;
    silent.on("close", () => {
      closed = true;
    });
    silent.on("error", () => {});
    await new Promise<void>((resolve) => silent.once("open", () => resolve()));
    silent.send(JSON.stringify({ type: "join", docId: "doc", siteId: "alice", vector: [] }));
    await waitFor(() => running.stats().connections === 1);

    await waitFor(() => closed, 2000);
    await waitFor(() => running.stats().connections === 0);

    const again = await TestClient.connect(running.port);
    again.send({ type: "join", docId: "doc", siteId: "alice", vector: [] });
    expect(await again.next()).toMatchObject({ type: "joined" });
  });

  it("keeps connections that answer pings", async () => {
    const running = await startServer({ port: 0, heartbeatIntervalMs: 40 });
    server = running;

    const client = await TestClient.connect(running.port);
    client.send({ type: "join", docId: "doc", siteId: "alice", vector: [] });
    await client.next();

    await sleep(250); // several heartbeat intervals
    expect(running.stats().connections).toBe(1);
    expect(client.closeCode).toBeNull();
  });
});
