// Where the hosted page keeps the accepted save in the browser: the raw bytes with their name, modified time,
// size and source, and the connected file's handle. Two object stores, `save` and `handle`, in the IndexedDB database
// `pkp`, each holding one record under the key `current`. The bytes are written only after the server has accepted them
// (the caller's rule, not this file's). `memorySaveStore` is the fallback for a browser with no IndexedDB, and what the
// tests use; `openSaveStore` picks between them. A store that throws is the caller's to carry on without.

/** The last save the server accepted. `source` says whether it came from an upload or the connected file. */
export interface StoredSave {
  bytes: ArrayBuffer;
  name: string;
  modified: number;
  size: number;
  source: 'upload' | 'connected';
}

/** `readHandle` resolves `null` when no handle is kept. Every method rejects on a storage error. */
export interface SaveStore {
  readSave(): Promise<StoredSave | null>;
  writeSave(s: StoredSave): Promise<void>;
  readHandle(): Promise<unknown>;
  writeHandle(h: unknown): Promise<void>;
  clearHandle(): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = 'pkp';
const DB_VERSION = 1;
const SAVE_STORE = 'save';
const HANDLE_STORE = 'handle';
const KEY = 'current';

/** A store that lives in this page's memory only. */
export function memorySaveStore(): SaveStore {
  let save: StoredSave | null = null;
  let handle: unknown = null;
  return {
    async readSave() { return save; },
    async writeSave(s) { save = s; },
    async readHandle() { return handle; },
    async writeHandle(h) { handle = h; },
    async clearHandle() { handle = null; },
    async clearAll() { save = null; handle = null; },
  };
}

/** Wraps an IndexedDB request as a promise of its result. */
function requestResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when a transaction commits; rejects when it fails or aborts. */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** The store over IndexedDB: the database is opened once, and every operation runs in its own transaction. */
export function idbSaveStore(factory: IDBFactory = indexedDB): SaveStore {
  let opened: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (opened) return opened;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SAVE_STORE)) db.createObjectStore(SAVE_STORE);
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading or the browser closing the connection: open again on the next call.
        db.onclose = () => { opened = null; };
        db.onversionchange = () => { db.close(); opened = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    opened = attempt;
    // A failed open is not kept, so the next call tries again.
    attempt.catch(() => { if (opened === attempt) opened = null; });
    return attempt;
  }

  /** Runs `work` on the named stores in one transaction, and resolves with its value once the transaction commits. */
  async function run<T>(names: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T> | null): Promise<T | undefined> {
    const db = await open();
    const tx = db.transaction(names, mode);
    const done = transactionDone(tx);
    let result: Promise<T | undefined> = Promise.resolve(undefined);
    try {
      const req = work(tx);
      if (req) result = requestResult(req);
    } catch (err) {
      try { tx.abort(); } catch { /* already finished */ }
      done.catch(() => {});
      throw err;
    }
    const [value] = await Promise.all([result, done]);
    return value;
  }

  return {
    async readSave() {
      const v = await run<StoredSave | undefined>([SAVE_STORE], 'readonly', (tx) => tx.objectStore(SAVE_STORE).get(KEY));
      return v ?? null;
    },
    async writeSave(s) {
      await run([SAVE_STORE], 'readwrite', (tx) => tx.objectStore(SAVE_STORE).put(s, KEY));
    },
    async readHandle() {
      const v = await run<unknown>([HANDLE_STORE], 'readonly', (tx) => tx.objectStore(HANDLE_STORE).get(KEY));
      return v ?? null;
    },
    async writeHandle(h) {
      await run([HANDLE_STORE], 'readwrite', (tx) => tx.objectStore(HANDLE_STORE).put(h, KEY));
    },
    async clearHandle() {
      await run([HANDLE_STORE], 'readwrite', (tx) => tx.objectStore(HANDLE_STORE).delete(KEY));
    },
    async clearAll() {
      await run([SAVE_STORE, HANDLE_STORE], 'readwrite', (tx) => {
        tx.objectStore(SAVE_STORE).delete(KEY);
        return tx.objectStore(HANDLE_STORE).delete(KEY);
      });
    },
  };
}

/** IndexedDB where the browser has it, memory where it does not. */
export function openSaveStore(): SaveStore {
  return (globalThis as { indexedDB?: IDBFactory }).indexedDB ? idbSaveStore() : memorySaveStore();
}
