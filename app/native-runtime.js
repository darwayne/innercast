export const isNativeRuntime = Boolean(window.__INNERCAST_NATIVE__ && window.webkit?.messageHandlers?.innercast);

export async function nativeCommand(command, payload = {}) {
  if (!isNativeRuntime) throw new Error("The native Innercast bridge is unavailable.");
  return window.webkit.messageHandlers.innercast.postMessage({ command, payload });
}

export class NativeOnDeviceTranscriber {
  constructor() {
    this.sessionId = null;
    this.activeReject = null;
    this.eventHandler = null;
  }

  transcribe(sessionId, onProgress = () => {}) {
    if (this.activeReject) return Promise.reject(new Error("A native transcription is already running."));
    this.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.activeReject = reject;
      const finish = () => {
        if (this.eventHandler) window.removeEventListener("innercast-native-event", this.eventHandler);
        this.eventHandler = null;
        this.activeReject = null;
        this.sessionId = null;
      };
      this.eventHandler = (event) => {
        const { type, payload = {} } = event.detail || {};
        if (payload.sessionId !== sessionId) return;
        if (type === "transcriptionProgress") {
          onProgress(payload);
          return;
        }
        if (type === "transcriptionCompleted") {
          finish();
          resolve(payload.transcription);
        } else if (type === "transcriptionCancelled") {
          finish();
          reject(new Error("Transcription cancelled."));
        } else if (type === "transcriptionFailed") {
          finish();
          reject(new Error(payload.message || "Native transcription failed."));
        }
      };
      window.addEventListener("innercast-native-event", this.eventHandler);
      nativeCommand("startTranscription", { id: sessionId }).catch((error) => {
        finish();
        reject(error);
      });
    });
  }

  cancel() {
    if (!this.sessionId) return;
    nativeCommand("cancelTranscription", { id: this.sessionId }).catch(() => {});
  }
}

export class NativeRecordingRepository {
  async saveSession() { throw new Error("Native sessions are saved by the native audio pipeline."); }
  async listSessions() { return nativeCommand("listSessions"); }
  async getSession(id) { return nativeCommand("getSession", { id }); }
  async deleteSession(id) { return nativeCommand("deleteSession", { id }); }
  async updateSessionTranscription() { /* Native transcription is persisted by the native service. */ }
  async saveLastSelectedSource() { /* The native picker already persisted the source. */ }
  async getLastSelectedSource() { return nativeCommand("restoreSource"); }
  async deleteLastSelectedSource() { /* Replaced when another native source is selected. */ }
  async exportSession(id) { return nativeCommand("exportSession", { id }); }
  async getStorageInfo() { return nativeCommand("storageInfo"); }
}
