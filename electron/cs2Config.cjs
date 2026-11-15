// Copies one account's CS2 settings from Steam's userdata folder into Nyx, keeping timestamped
// snapshots so earlier imports can be viewed. Reads only: nothing is written back to Steam.
// Steam keeps per-account CS2 files in userdata\<accountID>\730\local\cfg, where
// accountID = SteamID64 - 76561197960265728.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CS2_APP_ID = "730";
const STEAMID_BASE = 76561197960265728n;
const KEYS_FILE = "cs2_user_keys_0_slot0.vcfg";
// Per-account files copied on import. Machine-wide files (cs2_machine_convars.vcfg) are skipped.
const FILES = [KEYS_FILE, "cs2_user_convars_0_slot0.vcfg", "cs2_video.txt"];
const MAX_SNAPSHOTS = 10;
const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function accountIdFor(steamId64) {
  if (!/^\d{17}$/.test(String(steamId64))) throw new Error("Invalid SteamID64.");
  const id = BigInt(steamId64) - STEAMID_BASE;
  if (id <= 0n) throw new Error("Invalid SteamID64.");
  return id.toString();
}

function sourceDirFor(steamRoot, steamId64) {
  return path.join(steamRoot, "userdata", accountIdFor(steamId64), CS2_APP_ID, "local", "cfg");
}

function storeDirFor(storeRoot, steamId64) {
  // Validates the ID before it becomes a folder name.
  accountIdFor(steamId64);
  return path.join(storeRoot, steamId64);
}

function snapshotIdFor(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

// Parses Valve KeyValues text into entries: [[key, value], ...] where value is a string or
// a nested entry list. Order and duplicate keys are kept. Throws on malformed input.
function parseKeyValues(text) {
  let pos = 0;

  function skipSpace() {
    for (;;) {
      while (pos < text.length && /\s/.test(text[pos])) pos++;
      if (text.startsWith("//", pos)) {
        while (pos < text.length && text[pos] !== "\n") pos++;
      } else {
        return;
      }
    }
  }

  function readString() {
    if (text[pos] !== '"') throw new Error(`Expected a quoted string at ${pos}.`);
    pos++;
    let out = "";
    while (pos < text.length && text[pos] !== '"') {
      if (text[pos] === "\\" && pos + 1 < text.length) {
        const next = text[pos + 1];
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        pos += 2;
      } else {
        out += text[pos++];
      }
    }
    if (pos >= text.length) throw new Error("Unterminated string.");
    pos++;
    return out;
  }

  function readBlock(nested) {
    const entries = [];
    for (;;) {
      skipSpace();
      if (pos >= text.length) {
        if (nested) throw new Error("Missing closing brace.");
        return entries;
      }
      if (text[pos] === "}") {
        if (!nested) throw new Error("Unexpected closing brace.");
        pos++;
        return entries;
      }
      const key = readString();
      skipSpace();
      if (text[pos] === "{") {
        pos++;
        entries.push([key, readBlock(true)]);
      } else {
        entries.push([key, readString()]);
      }
    }
  }

  return readBlock(false);
}

// Returns the keybinds as [{ key, command }] from the "config" > "bindings" block.
function bindingsFromKeys(text) {
  const root = parseKeyValues(text);
  const config = root.find(([key]) => key === "config");
  const bindings = config && Array.isArray(config[1]) ? config[1].find(([key]) => key === "bindings") : null;
  if (!bindings || !Array.isArray(bindings[1])) throw new Error("No bindings block in the keys file.");
  return bindings[1]
    .filter(([, value]) => typeof value === "string")
    .map(([key, command]) => ({ key, command }));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Copies the account's CS2 files into a new snapshot. Returns the snapshot's metadata.
// Throws when Steam has no CS2 settings for the account on this PC.
function createSnapshot({ steamRoot, storeRoot, steamId64, now = new Date() }) {
  if (!steamRoot) throw new Error("Steam is not installed on this PC.");
  const source = sourceDirFor(steamRoot, steamId64);
  if (!fs.existsSync(source)) {
    throw new Error(
      "No CS2 settings for this account on this PC. Start CS2 once while signed in as this account, then try again.",
    );
  }

  const storeDir = storeDirFor(storeRoot, steamId64);
  const id = snapshotIdFor(now);
  const target = path.join(storeDir, id);
  const staging = `${target}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const files = [];
  try {
    for (const name of FILES) {
      const from = path.join(source, name);
      if (!fs.existsSync(from)) continue;
      const data = fs.readFileSync(from);
      fs.writeFileSync(path.join(staging, name), data);
      files.push({ name, size: data.length, sha256: sha256(data) });
    }
    if (files.length === 0) throw new Error("CS2 settings folder is empty for this account.");

    let bindingCount = null;
    let bindingNote = null;
    if (files.some((file) => file.name === KEYS_FILE)) {
      try {
        bindingCount = bindingsFromKeys(fs.readFileSync(path.join(staging, KEYS_FILE), "utf8")).length;
      } catch (error) {
        bindingNote = error instanceof Error ? error.message : String(error);
      }
    }

    const meta = { id, createdAt: now.toISOString(), bindingCount, bindingNote, files };
    fs.writeFileSync(path.join(staging, "meta.json"), JSON.stringify(meta, null, 2));
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  pruneSnapshots(storeDir);
  return readMeta(storeDir, id);
}

function readMeta(storeDir, id) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(storeDir, id, "meta.json"), "utf8"));
    return meta && meta.id === id ? meta : null;
  } catch {
    return null;
  }
}

// Snapshot metadata for the account, newest first. Damaged snapshots are skipped.
function listSnapshots(storeRoot, steamId64) {
  const storeDir = storeDirFor(storeRoot, steamId64);
  if (!fs.existsSync(storeDir)) return [];
  return fs
    .readdirSync(storeDir)
    .filter((name) => SNAPSHOT_ID.test(name))
    .sort()
    .reverse()
    .map((id) => readMeta(storeDir, id))
    .filter(Boolean);
}

function pruneSnapshots(storeDir) {
  const ids = fs
    .readdirSync(storeDir)
    .filter((name) => SNAPSHOT_ID.test(name))
    .sort()
    .reverse();
  for (const id of ids.slice(MAX_SNAPSHOTS)) {
    fs.rmSync(path.join(storeDir, id), { recursive: true, force: true });
  }
}

// Keybinds stored in one snapshot. The ID must be a snapshot ID, so it cannot point outside the store.
function readBindings(storeRoot, steamId64, snapshotId) {
  if (!SNAPSHOT_ID.test(String(snapshotId))) throw new Error("Unknown backup.");
  const file = path.join(storeDirFor(storeRoot, steamId64), snapshotId, KEYS_FILE);
  if (!fs.existsSync(file)) throw new Error("This backup has no keybinds file.");
  return bindingsFromKeys(fs.readFileSync(file, "utf8"));
}

function removeStore(storeRoot, steamId64) {
  fs.rmSync(storeDirFor(storeRoot, steamId64), { recursive: true, force: true });
}

module.exports = {
  accountIdFor,
  sourceDirFor,
  parseKeyValues,
  bindingsFromKeys,
  createSnapshot,
  listSnapshots,
  readBindings,
  removeStore,
  MAX_SNAPSHOTS,
};
