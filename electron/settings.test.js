const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const settings = require("./settings.cjs");
const { findEndedCooldowns } = require("./notifyRules.cjs");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-settings-"));
  return { dir, file: path.join(dir, "settings.json") };
}

test("defaults are off", () => {
  assert.deepEqual(settings.normalizeSettings(null), { notifyCooldownEnd: false, notifyCheckFailed: false });
});

test("normalize drops unknown keys and non-boolean values", () => {
  const result = settings.normalizeSettings({ notifyCooldownEnd: "yes", notifyCheckFailed: true, other: 1 });
  assert.deepEqual(result, { notifyCooldownEnd: false, notifyCheckFailed: true });
});

test("missing file loads defaults", () => {
  const { dir, file } = tempFile();
  try {
    assert.deepEqual(settings.loadSettings(file), settings.DEFAULTS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save merges a partial change and persists it", () => {
  const { dir, file } = tempFile();
  try {
    settings.saveSettings(file, { notifyCooldownEnd: true });
    const saved = settings.saveSettings(file, { notifyCheckFailed: true });
    assert.deepEqual(saved, { notifyCooldownEnd: true, notifyCheckFailed: true });
    assert.deepEqual(settings.loadSettings(file), saved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt file loads defaults", () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, "{not json", "utf8");
    assert.deepEqual(settings.loadSettings(file), settings.DEFAULTS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SESSION_START = Date.parse("2026-11-15T10:00:00Z");
const NOW = Date.parse("2026-11-15T11:00:00Z");

function account(id, cooldown) {
  return { id, name: id, steamId64: "76561198000000000", cooldown };
}

test("reports a steam-page cooldown that ended during this session, once", () => {
  const announced = new Set();
  const accounts = [
    account("a", { source: "steam-page", expiresAt: "2026-11-15T10:30:00Z" }),
  ];
  const first = findEndedCooldowns(accounts, { sessionStartMs: SESSION_START, nowMs: NOW, announced });
  assert.deepEqual(first.map((item) => item.id), ["a"]);
  const second = findEndedCooldowns(accounts, { sessionStartMs: SESSION_START, nowMs: NOW + 60000, announced });
  assert.deepEqual(second, []);
});

test("ignores expiries from before the session, future expiries, manual entries, and empty cooldowns", () => {
  const announced = new Set();
  const accounts = [
    account("old", { source: "steam-page", expiresAt: "2026-11-15T09:00:00Z" }),
    account("future", { source: "steam-page", expiresAt: "2026-11-15T12:00:00Z" }),
    account("manual", { source: "manual", expiresAt: "2026-11-15T10:30:00Z" }),
    account("none", null),
    account("bad", { source: "steam-page", expiresAt: "not a date" }),
  ];
  assert.deepEqual(
    findEndedCooldowns(accounts, { sessionStartMs: SESSION_START, nowMs: NOW, announced }),
    [],
  );
});

test("a new expiry for the same account is reported again", () => {
  const announced = new Set();
  const first = [account("a", { source: "steam-page", expiresAt: "2026-11-15T10:30:00Z" })];
  findEndedCooldowns(first, { sessionStartMs: SESSION_START, nowMs: NOW, announced });
  const later = [account("a", { source: "steam-page", expiresAt: "2026-11-15T10:45:00Z" })];
  const result = findEndedCooldowns(later, { sessionStartMs: SESSION_START, nowMs: NOW, announced });
  assert.deepEqual(result.map((item) => item.id), ["a"]);
});
