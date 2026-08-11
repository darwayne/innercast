export const isNativeRuntime = Boolean(window.__INNERCAST_NATIVE__ && window.webkit?.messageHandlers?.innercast);

export async function nativeCommand(command, payload = {}) {
  if (!isNativeRuntime) throw new Error("The native Innercast bridge is unavailable.");
  return window.webkit.messageHandlers.innercast.postMessage({ command, payload });
}

export class NativeRecordingRepository {
  async saveSession() { throw new Error("Native sessions are saved by the native audio pipeline."); }
  async listSessions() { return nativeCommand("listSessions"); }
  async getSession(id) { return nativeCommand("getSession", { id }); }
  async deleteSession(id) { return nativeCommand("deleteSession", { id }); }
  async updateSessionTranscription() { throw new Error("Native transcription will be added in the next milestone."); }
  async saveLastSelectedSource() { /* The native picker already persisted the source. */ }
  async getLastSelectedSource() { return nativeCommand("restoreSource"); }
  async deleteLastSelectedSource() { /* Replaced when another native source is selected. */ }
  async exportSession(id) { return nativeCommand("exportSession", { id }); }
  async getStorageInfo() { return nativeCommand("storageInfo"); }
}
