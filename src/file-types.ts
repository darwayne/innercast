export const AUDIO_FILE_ACCEPT = "audio/*,.aac,.m4a,.mp4,.mp3,.flac,.wav,.wave,.aif,.aiff,.caf";

const KNOWN_AUDIO_EXTENSIONS = new Set([
  "aac", "m4a", "mp4", "mp3", "flac", "wav", "wave", "aif", "aiff", "caf",
]);

/**
 * iOS Files sometimes supplies a generic or empty MIME type for valid local
 * audio. Recognized extensions are therefore accepted as a fallback; the
 * media element remains the authoritative decoder compatibility check.
 */
export function isLikelyAudioFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type?.toLowerCase().startsWith("audio/")) return true;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return KNOWN_AUDIO_EXTENSIONS.has(extension);
}
