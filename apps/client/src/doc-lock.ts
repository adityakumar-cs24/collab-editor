const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tryLock(docId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void navigator.locks.request(`collab-editor:${docId}`, { ifAvailable: true }, async (lock) => {
      if (lock === null) {
        resolve(false);
        return;
      }
      resolve(true);
      await new Promise<void>(() => {}); // hold the lock until this page goes away
    });
  });
}

// Only one tab may own the saved identity of a document, otherwise two tabs would use the same
// siteId and reuse each other's counters. Returns false when another tab already owns it.
// The old page can still be shutting down during a reload, so a few retries are made.
export async function acquireDocLock(docId: string, attempts = 4, delayMs = 250): Promise<boolean> {
  if (!("locks" in navigator)) return true; // cannot coordinate tabs here: assume this one is alone
  for (let i = 0; i < attempts; i++) {
    if (await tryLock(docId)) return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}
