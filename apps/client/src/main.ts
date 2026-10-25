import { DOC_ID_PATTERN } from "@collab/protocol";
import { Connection, wrapBrowserSocket, type ConnectionStatus } from "./connection";
import { codePointToUtf16Index, shiftPosition, utf16ToCodePointIndex, type TextEdit } from "./diff";
import { EditorSession } from "./session";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
}

const editor = byId<HTMLTextAreaElement>("editor");
const statusEl = byId<HTMLDivElement>("status");
const toggle = byId<HTMLButtonElement>("toggle");

const requestedDoc = new URLSearchParams(location.search).get("doc") ?? "demo";
const docId = DOC_ID_PATTERN.test(requestedDoc) ? requestedDoc : "demo";
const wsUrl = (import.meta.env["VITE_WS_URL"] as string | undefined) ?? "ws://127.0.0.1:8080";
// A fresh site id per page load. The document lives only in memory, so a reloaded page must not
// reuse an old id: its counters would restart and the server would reject them as out of order.
const siteId = crypto.randomUUID();

function describeStatus(status: ConnectionStatus): string {
  switch (status) {
    case "connecting":
      return "connecting…";
    case "online":
      return `online · document "${docId}" · you are ${siteId.slice(0, 8)}`;
    case "reconnecting":
      return "connection lost, reconnecting… your changes are kept and will sync";
    case "offline":
      return "offline: your changes are kept and will sync when you go online";
  }
}

function setStatus(status: ConnectionStatus): void {
  statusEl.textContent = describeStatus(status);
  statusEl.classList.remove("error");
  statusEl.classList.toggle("warn", status === "reconnecting" || status === "offline");
  toggle.textContent = status === "offline" ? "Go online" : "Go offline";
  toggle.disabled = !session.isJoined;
  if (session.isJoined && editor.disabled) {
    editor.disabled = false;
    editor.placeholder = "Start typing…";
    editor.focus();
  }
}

// Show the remote change while keeping the user's caret in the same place.
function renderRemoteEdit(edit: TextEdit): void {
  const old = editor.value;
  const start = shiftPosition(utf16ToCodePointIndex(old, editor.selectionStart), edit);
  const end = shiftPosition(utf16ToCodePointIndex(old, editor.selectionEnd), edit);
  const next = session.text;
  editor.value = next;
  editor.setSelectionRange(codePointToUtf16Index(next, start), codePointToUtf16Index(next, end));
}

let connection: Connection;
const session = new EditorSession({
  docId,
  siteId,
  send: (msg) => connection.send(msg),
  onError: (message) => {
    statusEl.textContent = `server error: ${message}`;
    statusEl.classList.add("error");
  },
});
connection = new Connection({
  session,
  createSocket: () => wrapBrowserSocket(new WebSocket(wsUrl)),
  onStatus: setStatus,
  onRemoteEdit: renderRemoteEdit,
  onProtocolError: (message) => {
    statusEl.textContent = `bad message from server: ${message}`;
    statusEl.classList.add("error");
  },
});

editor.addEventListener("input", () => {
  session.applyLocalText(editor.value);
});

toggle.addEventListener("click", () => {
  if (connection.status === "offline") connection.goOnline();
  else connection.goOffline();
});

setStatus("connecting");
connection.goOnline();
