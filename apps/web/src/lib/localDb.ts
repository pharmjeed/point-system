/**
 * The driver's local store for unfinished intakes (02 §1.8 item 1, D-05, D-06; 03 §4.3; 05 §14 storage
 * rules; PNT-071): one IndexedDB database with two object stores —
 * - `drafts`: one row per user and ticket (`${userId}:${ticketId}`): the D-05/D-06 inputs and the unfinished
 *   command intents (Idempotency-Key + body fingerprint);
 * - `photos`: one row per user, ticket and tile (`${userId}:${ticketId}:${slot}`) holding the compressed
 *   photo until the server confirmed it, indexed by its draft.
 * Every call is best effort inside try/catch: in a private window, with blocked site data or without
 * IndexedDB the app keeps working with the in-memory drafts only.
 */
const DB_NAME = 'point-field';
const DB_VERSION = 1;
export type LocalStore = 'drafts' | 'photos';

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos'))
          db.createObjectStore('photos', { keyPath: 'id' }).createIndex('draft', 'draftId');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(
  store: LocalStore,
  mode: IDBTransactionMode,
  work: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) {
          resolve(undefined);
          return;
        }
        try {
          const tx = db.transaction(store, mode);
          const request = work(tx.objectStore(store));
          tx.oncomplete = () => resolve(request ? request.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export const localDb = {
  get: <T>(store: LocalStore, id: string) => run<T>(store, 'readonly', (s) => s.get(id) as IDBRequest<T>),
  put: <T extends { id: string }>(store: LocalStore, value: T) =>
    run(store, 'readwrite', (s) => s.put(value)).then(() => {}),
  delete: (store: LocalStore, id: string) => run(store, 'readwrite', (s) => s.delete(id)).then(() => {}),
  /** The photo rows of one draft. */
  photosOf: async <T>(draftId: string): Promise<T[]> =>
    (await run<T[]>('photos', 'readonly', (s) => s.index('draft').getAll(draftId) as IDBRequest<T[]>)) ?? [],
  /** Every row of a store (sign-out: the rows of one user are deleted). */
  all: async <T>(store: LocalStore): Promise<T[]> =>
    (await run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)) ?? [],
  /** Deletes the rows whose id starts with `prefix` (`${userId}:` or `${userId}:${ticketId}`). */
  deletePrefix: (store: LocalStore, prefix: string) =>
    run(store, 'readwrite', (s) => {
      s.delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    }).then(() => {}),
};
