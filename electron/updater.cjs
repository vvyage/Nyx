// Auto-update flow for packaged builds, using electron-updater and the GitHub release
// feed configured in package.json (build.publish). Nothing downloads until the user
// clicks the Update button. Dev runs (not packaged) never check.

const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const IDLE = { state: "idle", version: null, percent: 0 };

// autoUpdater is injected so the flow can be tested without Electron.
// States: idle, available, downloading, downloaded.
function createUpdater({ autoUpdater, isPackaged, send, log = console }) {
  let status = { ...IDLE };
  let timers = [];

  function set(change) {
    status = { ...status, ...change };
    send("update:status", status);
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", (info) => {
    set({ state: "available", version: info.version, percent: 0 });
  });
  autoUpdater.on("update-not-available", () => {
    // Keep a pending update visible if one was already found; otherwise stay idle.
    if (status.state === "idle") set({ ...IDLE });
  });
  autoUpdater.on("download-progress", (progress) => {
    set({ state: "downloading", percent: Math.round(progress.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    set({ state: "downloaded", version: info.version, percent: 100 });
  });
  autoUpdater.on("error", (error) => {
    // Missing release files or no network are not shown to the user; the next check retries.
    log.warn(`[update] ${error && error.message ? error.message : error}`);
    if (status.state === "downloading") set({ state: "available", percent: 0 });
  });

  function check() {
    if (!isPackaged) return Promise.resolve(status);
    if (status.state === "downloading" || status.state === "downloaded") return Promise.resolve(status);
    return autoUpdater.checkForUpdates().then(() => status).catch((error) => {
      log.warn(`[update] check failed: ${error.message}`);
      return status;
    });
  }

  // Called by the Update button. Downloads the release found by the last check.
  async function download() {
    if (status.state !== "available") throw new Error("No update is ready to download.");
    set({ state: "downloading", percent: 0 });
    await autoUpdater.downloadUpdate();
    return status;
  }

  // Called by the Restart button. Closes the app and starts the installer.
  function install() {
    if (status.state !== "downloaded") throw new Error("The update is not downloaded yet.");
    autoUpdater.quitAndInstall(false, true);
  }

  function start() {
    if (!isPackaged) return;
    timers.push(setTimeout(() => check(), FIRST_CHECK_MS));
    timers.push(setInterval(() => check(), CHECK_EVERY_MS));
  }

  function stop() {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers = [];
  }

  return { start, stop, check, download, install, getStatus: () => status };
}

module.exports = { createUpdater };
