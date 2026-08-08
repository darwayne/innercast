const DATABASE_NAME = "synchronized-audio-recorder";
const DATABASE_VERSION = 1;
const STORE_NAME = "sessions";

export class RecordingRepository {
  constructor() { this.databasePromise = null; }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "id" });
        if (!store.indexNames.contains("createdAt")) store.createIndex("createdAt", "createdAt");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open on-device storage."));
      request.onblocked = () => reject(new Error("Storage upgrade is blocked by another open Innercast tab."));
    });
    return this.databasePromise;
  }

  async saveSession(session) {
    const database = await this.open();
    return this.request(database, "readwrite", (store) => store.put(session));
  }

  async getSession(id) {
    const database = await this.open();
    return this.request(database, "readonly", (store) => store.get(id));
  }

  async listSessions() {
    const database = await this.open();
    const sessions = await this.request(database, "readonly", (store) => store.getAll());
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteSession(id) {
    const database = await this.open();
    return this.request(database, "readwrite", (store) => store.delete(id));
  }

  request(database, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("On-device storage operation failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction was interrupted."));
    });
  }
}
