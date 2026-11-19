const fs = require("node:fs");
const path = require("node:path");

// User preferences. Every notification is off until the user turns it on.
const DEFAULTS = Object.freeze({
  notifyCooldownEnd: false,
  notifyCheckFailed: false,
});

// Keeps only known keys with boolean values; anything else falls back to the default.
function normalizeSettings(input) {
  const settings = { ...DEFAULTS };
  if (input && typeof input === "object") {
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof input[key] === "boolean") settings[key] = input[key];
    }
  }
  return settings;
}

function loadSettings(filePath) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return normalizeSettings(null);
  }
}

// Applies a partial change and writes the full settings. Returns the saved settings.
function saveSettings(filePath, change) {
  const next = normalizeSettings({ ...loadSettings(filePath), ...(change || {}) });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

module.exports = { DEFAULTS, normalizeSettings, loadSettings, saveSettings };
