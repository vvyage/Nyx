import type { Account, DisplayStatus } from "./types";

// Pure: turns a stored cooldown into what the UI shows. Missing data is "unknown",
// never "clear".
export function displayStatus(account: Account, now: Date): DisplayStatus {
  const cooldown = account.cooldown;
  if (!cooldown) {
    return { kind: "unknown", detail: "Not checked yet." };
  }
  if (cooldown.parsedStatus === "clear") {
    return { kind: "clear", detail: cooldown.reason };
  }
  if (!cooldown.expiresAt) {
    return { kind: "unknown", detail: cooldown.reason };
  }
  const until = new Date(cooldown.expiresAt);
  if (Number.isNaN(until.getTime())) {
    return { kind: "unknown", detail: "Stored date is invalid." };
  }
  return until.getTime() > now.getTime()
    ? { kind: "blocked", until }
    : { kind: "expired", until };
}

// Live countdown in one fixed shape, HH:MM:SS. Hours are not split into days and every
// field is always two digits, so the text does not change length as it ticks.
// Example: "11:12:09". Only past 99 hours does the hour field grow by a digit.
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

// Converts a value from <input type="datetime-local"> (local time) to a UTC ISO string.
export function localInputToIso(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
