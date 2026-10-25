import { DOC_ID_PATTERN } from "@collab/protocol";
import { Connection, wrapBrowserSocket, type ConnectionStatus } from "./connection";
import { codePointToUtf16Index, shiftPosition, utf16ToCodePointIndex, type TextEdit } from "./diff";
import { acquireDocLock } from "./doc-lock";
import { EditorSession } from "./session";
import { MemoryStore, openDoc, openIdbStore, type DocStore } from "./store";

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

// The tab that owns the document saves it on this device. Any other tab, or a browser without
// IndexedDB, works with a temporary identity and keeps nothing across reloads.
async function chooseStore(): Promise<{ store: DocStore; notice: string }> {
  if (!(await acquireDocLock(docId))) {
    return {
      store: new MemoryStore(),
      notice: "this document is open in another tab, so changes made here are not saved for offline use",
    };
  }
  try {
    return { store: await openIdbStore(), notice: "" };
  } catch {
    return {
      store: new MemoryStore(),
      notice: "offline storage is unavailable, so changes are not kept across reloads",
    };
  }
}

async function start(): Promise<void> {
  let { store, notice } = await chooseStore();
  let opened: Awaited<ReturnType<typeof openDoc>>;
  try {
    opened = await openDoc(store, docId);
  } catch {
    store = new MemoryStore();
    notice = "saved data for this document could not be read, so this tab starts without it";
    opened = await openDoc(store, docId);
  }
  const siteId = opened.siteId;
  let storageBroken = false;
  let connection: Connection;

  const session = new EditorSession({
    docId,
    siteId,
    send: (msg) => connection.send(msg),
    persist: (ops) => store.append(docId, ops),
    onError: (message) => {
      statusEl.textContent = `server error: ${message}`;
      statusEl.classList.add("error");
    },
    onStorageError: (message, fatal) => {
      statusEl.textContent = fatal ? `${message}. Editing is disabled: reload the page.` : message;
      statusEl.classList.add("error");
      if (fatal) {
        storageBroken = true;
        editor.disabled = true;
      }
    },
  });
  if (opened.ops !== null) {
    session.restore(opened.ops);
    editor.value = session.text;
  }

  function describeStatus(status: ConnectionStatus): string {
    const suffix = notice === "" ? "" : ` · ${notice}`;
    switch (status) {
      case "connecting":
        return `connecting…${suffix}`;
      case "online":
        return `online · document "${docId}" · you are ${siteId.slice(0, 8)}${suffix}`;
      case "reconnecting":
        return `not connected, retrying… your changes are kept and will sync${suffix}`;
      case "offline":
        return `offline: your changes are kept and will sync when you go online${suffix}`;
    }
  }

  function setStatus(status: ConnectionStatus): void {
    statusEl.textContent = describeStatus(status);
    statusEl.classList.remove("error");
    statusEl.classList.toggle("warn", status === "reconnecting" || status === "offline" || notice !== "");
    toggle.textContent = status === "offline" ? "Go online" : "Go offline";
    toggle.disabled = !session.isJoined;
    if (session.isJoined && editor.disabled && !storageBroken) {
      editor.disabled = false;
      editor.placeholder = "Start typing…";
      editor.focus();
    }
  }

  // Show the remote change while keeping the user caret in the same place.
  function renderRemoteEdit(edit: TextEdit): void {
    const old = editor.value;
    const start = shiftPosition(utf16ToCodePointIndex(old, editor.selectionStart), edit);
    const end = shiftPosition(utf16ToCodePointIndex(old, editor.selectionEnd), edit);
    const next = session.text;
    editor.value = next;
    editor.setSelectionRange(codePointToUtf16Index(next, start), codePointToUtf16Index(next, end));
  }

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
    if (storageBroken) return;
    session.applyLocalText(editor.value);
  });

  toggle.addEventListener("click", () => {
    if (connection.status === "offline") connection.goOnline();
    else connection.goOffline();
  });

  setStatus("connecting");
  connection.goOnline();
}

start().catch((error: unknown) => {
  statusEl.textContent = `could not start: ${error instanceof Error ? error.message : String(error)}`;
  statusEl.classList.add("error");
});
