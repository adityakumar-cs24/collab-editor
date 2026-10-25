import { DOC_ID_PATTERN, encode, parseServerMessage } from "@collab/protocol";
import { codePointToUtf16Index, shiftPosition, utf16ToCodePointIndex, type TextEdit } from "./diff";
import { EditorSession } from "./session";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
}

const editor = byId<HTMLTextAreaElement>("editor");
const statusEl = byId<HTMLDivElement>("status");

const requestedDoc = new URLSearchParams(location.search).get("doc") ?? "demo";
const docId = DOC_ID_PATTERN.test(requestedDoc) ? requestedDoc : "demo";
const wsUrl = (import.meta.env["VITE_WS_URL"] as string | undefined) ?? "ws://127.0.0.1:8080";
// A fresh site id per page load: ids stay unique and a reload never collides with the old socket.
const siteId = crypto.randomUUID();

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

const ws = new WebSocket(wsUrl);
const session = new EditorSession({
  docId,
  siteId,
  send: (msg) => ws.send(encode(msg)),
  onError: (message) => setStatus(`server error: ${message}`, true),
});

// Show the remote change while keeping the user's caret in the same place.
function renderRemoteEdit(edit: TextEdit): void {
  const old = editor.value;
  const start = shiftPosition(utf16ToCodePointIndex(old, editor.selectionStart), edit);
  const end = shiftPosition(utf16ToCodePointIndex(old, editor.selectionEnd), edit);
  const next = session.text;
  editor.value = next;
  editor.setSelectionRange(codePointToUtf16Index(next, start), codePointToUtf16Index(next, end));
}

ws.addEventListener("open", () => {
  setStatus("joining document…");
  session.join();
});

ws.addEventListener("message", (event: MessageEvent) => {
  if (typeof event.data !== "string") return;
  const parsed = parseServerMessage(event.data);
  if (!parsed.ok) {
    setStatus(`bad message from server: ${parsed.error}`, true);
    return;
  }
  const edit = session.handleServerMessage(parsed.value);
  if (edit !== null) renderRemoteEdit(edit);
  if (parsed.value.type === "joined") {
    editor.disabled = false;
    editor.placeholder = "Start typing…";
    editor.focus();
    setStatus(`document "${docId}" · you are ${siteId.slice(0, 8)}`);
  }
});

ws.addEventListener("close", () => {
  editor.disabled = true;
  setStatus("disconnected: reload the page to reconnect", true);
});

editor.addEventListener("input", () => {
  session.applyLocalText(editor.value);
});
