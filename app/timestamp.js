/** Parse seconds, MM:SS, or HH:MM:SS into seconds. */
export function parseTimestamp(value) {
  const text = String(value).trim();
  if (!text) throw new Error("Enter a time.");
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(text)) throw new Error("Use seconds, MM:SS, or HH:MM:SS.");
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) throw new Error("Time cannot be negative.");
  if (parts.length > 1 && parts.slice(1).some((part) => part >= 60)) throw new Error("Minutes and seconds must be below 60.");
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function formatTimestamp(seconds, includeHours = false) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return (includeHours || hours > 0)
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function validateOffset(offset, duration) {
  if (!Number.isFinite(offset) || offset < 0) throw new Error("Recording start must be a valid, non-negative time.");
  if (Number.isFinite(duration) && offset >= duration) throw new Error("Recording start must be before the end of the source audio.");
  return offset;
}

export function sourceTimeForMicTime(offset, micTime) { return offset + micTime; }
