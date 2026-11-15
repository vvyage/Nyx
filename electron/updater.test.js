const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater } = require("./updater.cjs");

function fakeUpdater() {
  const emitter = new EventEmitter();
  emitter.checkCalls = 0;
  emitter.downloadCalls = 0;
  emitter.installArgs = null;
  emitter.checkForUpdates = async () => {
    emitter.checkCalls += 1;
  };
  emitter.downloadUpdate = async () => {
    emitter.downloadCalls += 1;
  };
  emitter.quitAndInstall = (...args) => {
    emitter.installArgs = args;
  };
  return emitter;
}

const silentLog = { warn() {} };

test("update-available moves the status to available with the version", () => {
  const auto = fakeUpdater();
  const updater = createUpdater({ autoUpdater: auto, isPackaged: true, send: () => {}, log: silentLog });
  auto.emit("update-available", { version: "0.2.0" });
  assert.deepEqual(updater.getStatus(), { state: "available", version: "0.2.0", percent: 0 });
});

test("download progress and downloaded state are reported", () => {
  const auto = fakeUpdater();
  const sent = [];
  const updater = createUpdater({
    autoUpdater: auto,
    isPackaged: true,
    send: (channel, payload) => sent.push([channel, payload]),
    log: silentLog,
  });
  auto.emit("update-available", { version: "0.2.0" });
  auto.emit("download-progress", { percent: 42.6 });
  assert.equal(updater.getStatus().state, "downloading");
  assert.equal(updater.getStatus().percent, 43);
  auto.emit("update-downloaded", { version: "0.2.0" });
  assert.equal(updater.getStatus().state, "downloaded");
  assert.equal(sent.at(-1)[0], "update:status");
  assert.equal(sent.at(-1)[1].state, "downloaded");
});

test("a failed download returns to available so the user can retry", () => {
  const auto = fakeUpdater();
  const updater = createUpdater({ autoUpdater: auto, isPackaged: true, send: () => {}, log: silentLog });
  auto.emit("update-available", { version: "0.2.0" });
  auto.emit("download-progress", { percent: 10 });
  auto.emit("error", new Error("network down"));
  assert.equal(updater.getStatus().state, "available");
});

test("a failed check with no pending update stays idle", () => {
  const auto = fakeUpdater();
  const updater = createUpdater({ autoUpdater: auto, isPackaged: true, send: () => {}, log: silentLog });
  auto.emit("error", new Error("latest.yml not found"));
  assert.equal(updater.getStatus().state, "idle");
});

test("download only runs from the available state", async () => {
  const auto = fakeUpdater();
  const updater = createUpdater({ autoUpdater: auto, isPackaged: true, send: () => {}, log: silentLog });
  await assert.rejects(updater.download(), /No update is ready/);
  assert.equal(auto.downloadCalls, 0);
  auto.emit("update-available", { version: "0.2.0" });
  await updater.download();
  assert.equal(auto.downloadCalls, 1);
});

test("install only runs once the update is downloaded", () => {
  const auto = fakeUpdater();
  const updater = createUpdater({ autoUpdater: auto, isPackaged: true, send: () => {}, log: silentLog });
  assert.throws(() => updater.install(), /not downloaded/);
  auto.emit("update-downloaded", { version: "0.2.0" });
  updater.install();
  assert.deepEqual(auto.installArgs, [false, true]);
});

test("dev runs (not packaged) never check for updates", async () => {
  const auto = fakeUpdater();
  const updater = createUpdater({ autoUpdater: auto, isPackaged: false, send: () => {}, log: silentLog });
  await updater.check();
  updater.start();
  updater.stop();
  assert.equal(auto.checkCalls, 0);
});

test("check does not start a new lookup while an update is already downloading", async () => {
  const auto = fakeUpdater();
  const updater = createUpdater({ autoUpdater: auto, isPackaged: true, send: () => {}, log: silentLog });
  auto.emit("update-available", { version: "0.2.0" });
  await updater.download();
  auto.emit("download-progress", { percent: 50 });
  await updater.check();
  assert.equal(auto.checkCalls, 0);
});
