import type { SavedSession } from "./models.js";

const DATABASE_NAME = "synchronized-audio-recorder";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";

/** The only module that knows the IndexedDB schema. Blobs are stored directly. */
export class RecordingRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;

  open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction!.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "id" });
        if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open on-device storage."));
      request.onblocked = () => reject(new Error("Storage upgrade is blocked by another open Innercast tab."));
    });
    return this.databasePromise;
  }

  async saveSession(session: SavedSession): Promise<void> {
    const database = await this.open();
    await this.request(database, "readwrite", (store) => store.put(session));
  }

  async getSession(id: string): Promise<SavedSession | undefined> {
    const database = await this.open();
    return this.request(database, "readonly", (store) => store.get(id));
  }

  async listSessions(): Promise<SavedSession[]> {
    const database = await this.open();
    const sessions = await this.request<SavedSession[]>(database, "readonly", (store) => store.getAll());
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteSession(id: string): Promise<void> {
    const database = await this.open();
    await this.request(database, "readwrite", (store) => store.delete(id));
  }

  private request<T>(database: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("On-device storage operation failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Storage transaction was interrupted."));
    });
  }
}
