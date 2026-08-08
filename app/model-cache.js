const DATABASE_NAME = "innercast-whisper-model-cache";
const DATABASE_VERSION = 1;
const FILES_STORE = "files";
const CHUNKS_STORE = "chunks";
const CHUNK_SIZE = 4 * 1024 * 1024;

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Model cache operation failed."));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Model cache transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Model cache transaction was interrupted."));
  });
}

function requestUrl(request) {
  if (typeof Request !== "undefined" && request instanceof Request) return request.url;
  return String(request);
}

function filenameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "model file"); }
  catch { return "model file"; }
}

function totalFromResponse(response, resumedBytes) {
  const contentRange = response.headers.get("content-range");
  const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1];
  if (rangeTotal) return Number(rangeTotal);
  const contentLength = Number(response.headers.get("content-length"));
  return Number.isFinite(contentLength) && contentLength > 0 ? resumedBytes + contentLength : null;
}

/**
 * A Cache-like adapter for Transformers.js that writes remote model responses
 * to IndexedDB incrementally. A cache miss is intentionally downloaded here:
 * Transformers.js otherwise materializes the entire response before calling
 * cache.put(), producing an avoidable second large in-memory copy in Safari.
 */
export class ChunkedModelCache {
  constructor(onProgress = () => {}) {
    this.onProgress = onProgress;
    this.databasePromise = null;
  }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FILES_STORE)) {
          database.createObjectStore(FILES_STORE, { keyPath: "url" });
        }
        if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
          database.createObjectStore(CHUNKS_STORE, { keyPath: ["url", "index"] });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the model cache."));
      request.onblocked = () => reject(new Error("The model cache is blocked by another Innercast tab."));
    });
    return this.databasePromise;
  }

  async getFile(url) {
    const database = await this.open();
    const transaction = database.transaction(FILES_STORE, "readonly");
    return requestPromise(transaction.objectStore(FILES_STORE).get(url));
  }

  async countChunks(url) {
    const database = await this.open();
    const transaction = database.transaction(CHUNKS_STORE, "readonly");
    const range = IDBKeyRange.bound([url, 0], [url, Number.MAX_SAFE_INTEGER]);
    return requestPromise(transaction.objectStore(CHUNKS_STORE).count(range));
  }

  async getChunk(url, index) {
    const database = await this.open();
    const transaction = database.transaction(CHUNKS_STORE, "readonly");
    const record = await requestPromise(transaction.objectStore(CHUNKS_STORE).get([url, index]));
    if (!record?.blob) throw new Error("A downloaded model chunk is missing.");
    return record.blob;
  }

  async saveChunk(url, index, blob, file) {
    const database = await this.open();
    const transaction = database.transaction([FILES_STORE, CHUNKS_STORE], "readwrite");
    transaction.objectStore(CHUNKS_STORE).put({ url, index, blob });
    transaction.objectStore(FILES_STORE).put(file);
    await transactionPromise(transaction);
  }

  async clearFile(url) {
    const database = await this.open();
    const transaction = database.transaction([FILES_STORE, CHUNKS_STORE], "readwrite");
    transaction.objectStore(FILES_STORE).delete(url);
    const chunks = transaction.objectStore(CHUNKS_STORE);
    const range = IDBKeyRange.bound([url, 0], [url, Number.MAX_SAFE_INTEGER]);
    chunks.delete(range);
    await transactionPromise(transaction);
  }

  responseFor(file) {
    let index = 0;
    const cache = this;
    const body = new ReadableStream({
      async pull(controller) {
        if (index >= file.chunkCount) {
          controller.close();
          return;
        }
        try {
          const blob = await cache.getChunk(file.url, index);
          index += 1;
          controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-length": String(file.totalBytes || file.receivedBytes),
        "content-type": file.contentType || "application/octet-stream",
        "x-innercast-model-cache": "chunked-indexeddb",
      },
    });
  }

  async existingResponse(url) {
    const file = await this.getFile(url);
    if (!file?.complete || !file.chunkCount) return null;
    if (await this.countChunks(url) !== file.chunkCount) {
      await this.clearFile(url);
      return null;
    }
    return this.responseFor(file);
  }

  async match(request) {
    const url = requestUrl(request);
    if (!/^https?:/i.test(url)) return undefined;

    const stored = await this.existingResponse(url);
    if (stored) return stored;

    // Preserve models downloaded by earlier Innercast versions rather than
    // forcing a second copy into IndexedDB.
    if (typeof caches !== "undefined") {
      try {
        const legacy = await (await caches.open("transformers-cache")).match(url);
        if (legacy) return legacy;
      } catch { /* IndexedDB remains the primary cache. */ }
    }

    return this.download(url);
  }

  async download(url) {
    let file = await this.getFile(url);
    let receivedBytes = file?.receivedBytes || 0;
    if (file && file.totalBytes && receivedBytes === file.totalBytes &&
        await this.countChunks(url) === file.chunkCount) {
      const completeFile = { ...file, complete: true, updatedAt: new Date().toISOString() };
      const database = await this.open();
      const transaction = database.transaction(FILES_STORE, "readwrite");
      transaction.objectStore(FILES_STORE).put(completeFile);
      await transactionPromise(transaction);
      return this.responseFor(completeFile);
    }
    const headers = new Headers();
    if (receivedBytes > 0) headers.set("Range", `bytes=${receivedBytes}-`);

    let response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      // Some CDNs/browser versions reject Range requests even though a normal
      // fetch works. Preserve resumability where supported, but remain usable.
      if (!receivedBytes) throw error;
      await this.clearFile(url);
      file = null;
      receivedBytes = 0;
      response = await fetch(url);
    }
    if (response.status === 416 && receivedBytes > 0) {
      await this.clearFile(url);
      return this.download(url);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Model download failed (${response.status}).`);

    const responseEtag = response.headers.get("etag");
    const cannotResume = receivedBytes > 0 && response.status !== 206;
    const changed = receivedBytes > 0 && file?.etag && responseEtag && file.etag !== responseEtag;
    if (cannotResume || changed) {
      await this.clearFile(url);
      file = null;
      receivedBytes = 0;
      response = await fetch(url);
      if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
    }

    const totalBytes = totalFromResponse(response, receivedBytes);
    let chunkIndex = file?.chunkCount || 0;
    let parts = [];
    let partsSize = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Streaming model downloads are not supported by this Safari version.");

    const saveParts = async () => {
      if (!partsSize) return;
      const blob = new Blob(parts, { type: "application/octet-stream" });
      receivedBytes += blob.size;
      chunkIndex += 1;
      const manifest = {
        url,
        receivedBytes,
        totalBytes,
        chunkCount: chunkIndex,
        contentType: response.headers.get("content-type") || file?.contentType || "application/octet-stream",
        etag: response.headers.get("etag") || file?.etag || null,
        complete: false,
        updatedAt: new Date().toISOString(),
      };
      await this.saveChunk(url, chunkIndex - 1, blob, manifest);
      parts = [];
      partsSize = 0;
      this.onProgress({
        file: filenameFromUrl(url),
        loaded: receivedBytes,
        total: totalBytes,
        progress: totalBytes ? receivedBytes / totalBytes : null,
      });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        partsSize += value.byteLength;
        if (partsSize >= CHUNK_SIZE) await saveParts();
      }
      await saveParts();
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error?.name === "QuotaExceededError" || /quota/i.test(error?.message || "")) {
        throw new Error("Safari ran out of website storage while caching this model. The completed chunks were kept; free some website storage and retry.");
      }
      throw new Error(`Model download paused after ${(receivedBytes / (1024 * 1024)).toFixed(0)} MB. Retry to resume it. ${error?.message || error}`);
    }

    const completeFile = {
      url,
      receivedBytes,
      totalBytes: totalBytes || receivedBytes,
      chunkCount: chunkIndex,
      contentType: response.headers.get("content-type") || file?.contentType || "application/octet-stream",
      etag: response.headers.get("etag") || file?.etag || null,
      complete: true,
      updatedAt: new Date().toISOString(),
    };
    const database = await this.open();
    const transaction = database.transaction(FILES_STORE, "readwrite");
    transaction.objectStore(FILES_STORE).put(completeFile);
    await transactionPromise(transaction);
    return this.responseFor(completeFile);
  }

  async put(request, response) {
    // Normally match() has already downloaded and stored the response. This is
    // a compatibility fallback for a response Transformers.js obtained itself.
    const url = requestUrl(request);
    if (await this.existingResponse(url)) return;
    let index = 0;
    let receivedBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) return;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const blob = new Blob([value]);
      receivedBytes += blob.size;
      index += 1;
      await this.saveChunk(url, index - 1, blob, {
        url, receivedBytes, totalBytes: Number(response.headers.get("content-length")) || null,
        chunkCount: index, contentType: response.headers.get("content-type"), etag: response.headers.get("etag"),
        complete: false, updatedAt: new Date().toISOString(),
      });
    }
    const database = await this.open();
    const transaction = database.transaction(FILES_STORE, "readwrite");
    transaction.objectStore(FILES_STORE).put({
      url, receivedBytes, totalBytes: receivedBytes, chunkCount: index,
      contentType: response.headers.get("content-type"), etag: response.headers.get("etag"),
      complete: true, updatedAt: new Date().toISOString(),
    });
    await transactionPromise(transaction);
  }
}
