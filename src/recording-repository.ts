import type { SavedSession } from "./models.js";

const DATABASE_NAME = "synchronized-audio-recorder";
const DATABASE_VERSION = 2;
const STORE_NAME = "sessions";
const SOURCE_STORE_NAME = "sources";
const LAST_SOURCE_KEY = "last-selected";

export interface StoredAudioSource {
  id: typeof LAST_SOURCE_KEY;
  selectedAt: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  blob: Blob;
}

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
        if (!database.objectStoreNames.contains(SOURCE_STORE_NAME)) {
          database.createObjectStore(SOURCE_STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open on-device storage."));
      request.onblocked = () => reject(new Error("Storage upgrade is blocked by another open Innercast tab."));
    });
    return this.databasePromise;
  }

  async saveSession(session: SavedSession): Promise<void> {
    const database = await this.open();
    await this.request(database, STORE_NAME, "readwrite", (store) => store.put(session));
  }

  async getSession(id: string): Promise<SavedSession | undefined> {
    const database = await this.open();
    return this.request(database, STORE_NAME, "readonly", (store) => store.get(id));
  }

  async listSessions(): Promise<SavedSession[]> {
    const database = await this.open();
    const sessions = await this.request<SavedSession[]>(database, STORE_NAME, "readonly", (store) => store.getAll());
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteSession(id: string): Promise<void> {
    const database = await this.open();
    await this.request(database, STORE_NAME, "readwrite", (store) => store.delete(id));
  }

  async updateSessionTranscription(id: string, transcription: SavedSession["transcription"]): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const readRequest = store.get(id);
      readRequest.onsuccess = () => {
        if (!readRequest.result) {
          transaction.abort();
          reject(new Error("The saved recording no longer exists."));
          return;
        }
        store.put({ ...readRequest.result, transcription });
      };
      readRequest.onerror = () => reject(readRequest.error ?? new Error("The saved recording could not be read."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("The transcript could not be saved."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The transcript update was interrupted."));
    });
  }

  async saveLastSelectedSource(file: File, durationSeconds: number): Promise<void> {
    const database = await this.open();
    const source: StoredAudioSource = {
      id: LAST_SOURCE_KEY,
      selectedAt: new Date().toISOString(),
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      durationSeconds,
      blob: file,
    };
    await this.request(database, SOURCE_STORE_NAME, "readwrite", (store) => store.put(source));
  }

  async getLastSelectedSource(): Promise<StoredAudioSource | undefined> {
    const database = await this.open();
    return this.request(database, SOURCE_STORE_NAME, "readonly", (store) => store.get(LAST_SOURCE_KEY));
  }

  async deleteLastSelectedSource(): Promise<void> {
    const database = await this.open();
    await this.request(database, SOURCE_STORE_NAME, "readwrite", (store) => store.delete(LAST_SOURCE_KEY));
  }

  private request<T>(database: IDBDatabase, storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("On-device storage operation failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Storage transaction was interrupted."));
    });
  }
}
