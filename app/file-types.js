export const AUDIO_FILE_ACCEPT = "audio/*,.aac,.m4a,.mp4,.mp3,.flac,.wav,.wave,.aif,.aiff,.caf";

const KNOWN_AUDIO_EXTENSIONS = new Set([
  "aac", "m4a", "mp4", "mp3", "flac", "wav", "wave", "aif", "aiff", "caf",
]);

/**
 * iOS Files can report valid audio as application/octet-stream or with no MIME
 * type. Accept recognized extensions in those cases and let HTMLAudioElement
 * perform the authoritative decode check.
 */
export function isLikelyAudioFile(file) {
  if (file.type?.toLowerCase().startsWith("audio/")) return true;
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return KNOWN_AUDIO_EXTENSIONS.has(extension);
}
