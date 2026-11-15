const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cs2 = require("./cs2Config.cjs");

const KEYS = `"config"
{
	"bindings"
	{
		"g"		"drop"
		"MOUSE4"		"<unbound>"
		"f"		"slot10"
	}
}
`;

function makeSteam(steamId64, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-steam-"));
  const cfg = path.join(root, "userdata", cs2.accountIdFor(steamId64), "730", "local", "cfg");
  fs.mkdirSync(cfg, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(cfg, name), text);
  return root;
}

function tempStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nyx-store-"));
}

test("account ID is SteamID64 minus the base", () => {
  assert.equal(cs2.accountIdFor("76561198188880847"), "228615119");
});

test("invalid SteamID64 values are rejected", () => {
  assert.throws(() => cs2.accountIdFor("123"), /Invalid SteamID64/);
  assert.throws(() => cs2.accountIdFor("76561197960265728"), /Invalid SteamID64/);
  assert.throws(() => cs2.accountIdFor("../76561198188880847"), /Invalid SteamID64/);
});

test("parseKeyValues reads nested blocks and skips comments", () => {
  const parsed = cs2.parseKeyValues('// note\n"a" { "b" "x\\"y" }');
  assert.deepEqual(parsed, [["a", [["b", 'x"y']]]]);
});

test("parseKeyValues rejects unbalanced braces", () => {
  assert.throws(() => cs2.parseKeyValues('"a" { "b" "c"'), /closing brace/);
  assert.throws(() => cs2.parseKeyValues('"a" "b" }'), /Unexpected closing brace/);
});

test("bindingsFromKeys returns each key and command in order", () => {
  assert.deepEqual(cs2.bindingsFromKeys(KEYS), [
    { key: "g", command: "drop" },
    { key: "MOUSE4", command: "<unbound>" },
    { key: "f", command: "slot10" },
  ]);
});

test("bindingsFromKeys fails without a bindings block", () => {
  assert.throws(() => cs2.bindingsFromKeys('"config" { }'), /No bindings block/);
});

test("createSnapshot copies the files and records keybind count and hashes", () => {
  const steamId = "76561198188880847";
  const steamRoot = makeSteam(steamId, { "cs2_user_keys_0_slot0.vcfg": KEYS, "cs2_video.txt": '"video" { }' });
  const storeRoot = tempStore();
  const meta = cs2.createSnapshot({ steamRoot, storeRoot, steamId64: steamId, now: new Date("2026-11-15T10:00:00.000Z") });

  assert.equal(meta.id, "2026-11-15T10-00-00-000Z");
  assert.equal(meta.bindingCount, 3);
  assert.equal(meta.bindingNote, null);
  assert.deepEqual(meta.files.map((f) => f.name).sort(), ["cs2_user_keys_0_slot0.vcfg", "cs2_video.txt"]);
  assert.match(meta.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(storeRoot, steamId, meta.id, "meta.json")), true);
});

test("createSnapshot fails clearly when Steam has no CS2 folder for the account", () => {
  const steamRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nyx-empty-"));
  assert.throws(
    () => cs2.createSnapshot({ steamRoot, storeRoot: tempStore(), steamId64: "76561198188880847" }),
    /No CS2 settings for this account/,
  );
});

test("a keys file that cannot be parsed still imports, with a note", () => {
  const steamId = "76561198188880847";
  const steamRoot = makeSteam(steamId, { "cs2_user_keys_0_slot0.vcfg": '"config" {' });
  const meta = cs2.createSnapshot({ steamRoot, storeRoot: tempStore(), steamId64: steamId });
  assert.equal(meta.bindingCount, null);
  assert.match(meta.bindingNote, /closing brace/);
});

test("listSnapshots returns newest first and ignores unrelated folders", () => {
  const steamId = "76561198188880847";
  const steamRoot = makeSteam(steamId, { "cs2_user_keys_0_slot0.vcfg": KEYS });
  const storeRoot = tempStore();
  cs2.createSnapshot({ steamRoot, storeRoot, steamId64: steamId, now: new Date("2026-11-14T08:00:00.000Z") });
  cs2.createSnapshot({ steamRoot, storeRoot, steamId64: steamId, now: new Date("2026-11-15T08:00:00.000Z") });
  fs.mkdirSync(path.join(storeRoot, steamId, "junk"));

  const ids = cs2.listSnapshots(storeRoot, steamId).map((s) => s.id);
  assert.deepEqual(ids, ["2026-11-15T08-00-00-000Z", "2026-11-14T08-00-00-000Z"]);
});

test("only the newest MAX_SNAPSHOTS are kept", () => {
  const steamId = "76561198188880847";
  const steamRoot = makeSteam(steamId, { "cs2_user_keys_0_slot0.vcfg": KEYS });
  const storeRoot = tempStore();
  const total = cs2.MAX_SNAPSHOTS + 2;
  for (let i = 0; i < total; i++) {
    cs2.createSnapshot({ steamRoot, storeRoot, steamId64: steamId, now: new Date(Date.UTC(2026, 0, 1 + i)) });
  }
  const kept = cs2.listSnapshots(storeRoot, steamId);
  assert.equal(kept.length, cs2.MAX_SNAPSHOTS);
  assert.equal(kept[0].id, new Date(Date.UTC(2026, 0, total)).toISOString().replace(/[:.]/g, "-"));
});

test("readBindings returns the keybinds of a snapshot and rejects bad IDs", () => {
  const steamId = "76561198188880847";
  const steamRoot = makeSteam(steamId, { "cs2_user_keys_0_slot0.vcfg": KEYS });
  const storeRoot = tempStore();
  const meta = cs2.createSnapshot({ steamRoot, storeRoot, steamId64: steamId });
  assert.equal(cs2.readBindings(storeRoot, steamId, meta.id).length, 3);
  assert.throws(() => cs2.readBindings(storeRoot, steamId, "..\\..\\secret"), /Unknown backup/);
});

test("removeStore deletes all snapshots for the account", () => {
  const steamId = "76561198188880847";
  const steamRoot = makeSteam(steamId, { "cs2_user_keys_0_slot0.vcfg": KEYS });
  const storeRoot = tempStore();
  cs2.createSnapshot({ steamRoot, storeRoot, steamId64: steamId });
  cs2.removeStore(storeRoot, steamId);
  assert.equal(fs.existsSync(path.join(storeRoot, steamId)), false);
});
