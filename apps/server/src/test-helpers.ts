import { WebSocket } from "ws";
import { encode, parseServerMessage, type ClientMessage, type ServerMessage } from "@collab/protocol";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

export class TestClient {
  private readonly inbox: ServerMessage[] = [];
  private readonly ws: WebSocket;
  closeCode: number | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`invalid server message: ${parsed.error}`);
      this.inbox.push(parsed.value);
    });
    ws.on("close", (code) => {
      this.closeCode = code;
    });
    ws.on("error", () => {});
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("error", reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(encode(msg));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  async next(timeoutMs = 2000): Promise<ServerMessage> {
    await waitFor(() => this.inbox.length > 0, timeoutMs);
    const msg = this.inbox.shift();
    if (msg === undefined) throw new Error("inbox unexpectedly empty");
    return msg;
  }

  async waitForClose(): Promise<number> {
    await waitFor(() => this.closeCode !== null);
    return this.closeCode as number;
  }

  close(): void {
    this.ws.close();
  }
}
