const { app, BrowserWindow, ipcMain, Menu, Notification, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const steamClient = require("./steamClient.cjs");
const cooldownFetcher = require("./cooldownFetcher.cjs");
const steamAuth = require("./steamAuth.cjs");
const signupHelper = require("./signupHelper.cjs");
const signupUtils = require("./signupUtils.cjs");
const cs2Config = require("./cs2Config.cjs");
const settingsStore = require("./settings.cjs");
const SteamUser = require("steam-user");
const { createFreeLicenseRequester } = require("./freeLicense.cjs");
const { findEndedCooldowns } = require("./notifyRules.cjs");
const { createTokenVault } = require("./tokenVault.cjs");
const { parseSteamIdInput, fetchProfileSummary } = require("./steamProfile.cjs");
const { autoUpdater } = require("electron-updater");
const { createUpdater } = require("./updater.cjs");

// Keep the data folder the same in dev and packaged builds. Packaged builds would
// otherwise use productName ("Nyx") and miss existing accounts and vault.
app.setPath("userData", path.join(app.getPath("appData"), "steam-account-helper"));

// The vault path depends on userData, which is only known once Electron is ready.
let tokenVaultInstance = null;
function tokenVault() {
  if (!tokenVaultInstance) {
    tokenVaultInstance = createTokenVault(path.join(app.getPath("userData"), "vault.json"));
  }
  return tokenVaultInstance;
}

const iconPath = path.join(__dirname, "..", "src", "assets", "logo.png");
const AUTO_REFRESH_MS = 30 * 60 * 1000;
const AUTO_REFRESH_FIRST_MS = 5 * 1000;
const ACTIVE_POLL_MS = 10 * 1000;
const COOLDOWN_CHECK_MS = 60 * 1000;

// Only parsed results are stored: no HTML, passwords, cookies, or tokens.
const storePath = () => path.join(app.getPath("userData"), "accounts.json");
const cs2StorePath = () => path.join(app.getPath("userData"), "cs2-configs");
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

// Cooldown endings are announced only if they happen after this moment.
const sessionStartMs = Date.now();
// Keys ("accountId|expiresAt") of cooldown endings already handled this session.
const announcedEndings = new Set();

// Shows a Windows notification. Clicking it brings the main window forward.
function notify(title, body) {
  if (!Notification.isSupported()) return;
  // Without an explicit icon, Windows shows Electron's default logo in dev builds.
  const note = new Notification({ title, body, icon: iconPath });
  note.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  note.show();
}

// Finds cooldowns that ended since the last check. The endings are tracked even when the
// setting is off, so enabling it later does not announce old endings.
function checkCooldownEndings() {
  const ended = findEndedCooldowns(loadAccounts(), {
    sessionStartMs,
    nowMs: Date.now(),
    announced: announcedEndings,
  });
  if (!settingsStore.loadSettings(settingsPath()).notifyCooldownEnd) return;
  for (const account of ended) {
    notify("Cooldown ended", `${account.name || account.steamId64} can queue for matchmaking again.`);
  }
}

// Reason last announced per account id. A failure is announced once; it is announced again
// only after a successful read or when the reason changes.
const announcedFailures = new Map();

// Announces a failed read, when the user has asked for that. The reason never contains secrets.
function reportCheckFailure(accountId, label, reason) {
  const text = String(reason).slice(0, 160);
  if (announcedFailures.get(accountId) === text) return;
  announcedFailures.set(accountId, text);
  if (!settingsStore.loadSettings(settingsPath()).notifyCheckFailed) return;
  notify("Cooldown check failed", `${label}: ${text}`);
}

// Whether Steam has CS2 settings for the account on this PC, plus the stored backups.
async function cs2Summary(account) {
  const steamRoot = await steamClient.steamDir().catch(() => null);
  const available = Boolean(steamRoot) && fs.existsSync(cs2Config.sourceDirFor(steamRoot, account.steamId64));
  return { available, snapshots: cs2Config.listSnapshots(cs2StorePath(), account.steamId64) };
}

function loadAccounts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAccounts(accounts) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(accounts, null, 2), "utf8");
}

// Adds Steam's local view (persona name, login name, remembered flag) to each account.
// Steam data is read fresh each time; it is not stored.
async function viewAccounts(accounts) {
  let remembered = [];
  let activeId = null;
  try {
    remembered = await steamClient.listRememberedAccounts();
  } catch {
    remembered = [];
  }
  try {
    activeId = await steamClient.activeSteamId64();
  } catch {
    activeId = null;
  }
  return Promise.all(
    accounts.map(async (account) => {
      const steam = remembered.find((user) => user.steamId64 === account.steamId64) || null;
      return {
        ...account,
        // True when Steam is running and currently signed in as this account.
        steamSignedIn: activeId === account.steamId64,
        displayName: (steam && steam.personaName) || account.name || account.steamId64,
        steam: steam
          ? {
              accountName: steam.accountName,
              personaName: steam.personaName,
              rememberPassword: steam.rememberPassword,
            }
          : null,
        webSignedIn: await cooldownFetcher.isWebSignedIn(account.steamId64),
        // True when a refresh token for this account is stored in the vault.
        loginSaved: account.tokenSaved === true,
        // True when a password is stored in the vault. Accounts saved before passwords were
        // kept have none until Save login runs again.
        passwordSaved: tokenVault().isUnlocked() && tokenVault().getPassword(account.steamId64) !== null,
      };
    }),
  );
}

async function respond(accounts) {
  return viewAccounts(accounts);
}

function requireString(value, name, max = 200) {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error(`${name} is required (max ${max} characters).`);
  }
  return value.trim();
}

function requireAccount(accounts, id) {
  const account = accounts.find((item) => item.id === id);
  if (!account) {
    throw new Error("Account not found.");
  }
  return account;
}

function validSteamId(steamId64) {
  if (!/^\d{17}$/.test(steamId64)) {
    throw new Error("SteamID64 must be 17 digits.");
  }
  return steamId64;
}

function newAccount(steamId64, profile) {
  return {
    id: crypto.randomUUID(),
    name: (profile && profile.profileName) || steamId64,
    steamId64,
    avatarUrl: (profile && profile.avatarUrl) || null,
    // null means never checked: rendered as unknown, never as clear.
    cooldown: null,
  };
}

const PROFILE_ATTEMPTS = 3;
const PROFILE_RETRY_MS = 1500;
// HTTP 429 means Steam wants a longer pause before the next request.
const PROFILE_RATE_LIMIT_RETRY_MS = 3000;

// Reads the public profile, retrying on transient failures. Each failed attempt is
// logged with its reason (SteamID only). A failed lookup keeps the previous name and avatar.
// report(text) receives a short note for the progress panel before each retry.
// status.reason is set to the last failure, so the caller can log why a lookup failed.
async function lookupProfile(steamId64, report = () => {}, status = {}) {
  for (let attempt = 1; attempt <= PROFILE_ATTEMPTS; attempt += 1) {
    let delayMs = PROFILE_RETRY_MS;
    let reason = "";
    try {
      const profile = await fetchProfileSummary(steamId64);
      if (profile) return profile;
      reason = "no profile data";
      console.warn(`[profile] ${steamId64}: attempt ${attempt} returned no profile data`);
    } catch (error) {
      console.warn(`[profile] ${steamId64}: attempt ${attempt} failed: ${error.message}`);
      const rateLimited = error.message.includes("HTTP 429");
      reason = rateLimited ? "Steam rate limit" : "request failed";
      status.reason = error.message;
      if (rateLimited) delayMs = PROFILE_RATE_LIMIT_RETRY_MS;
    }
    if (attempt < PROFILE_ATTEMPTS) {
      report(`${reason}, retrying in ${delayMs / 1000} s (attempt ${attempt + 1} of ${PROFILE_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

// Fetches the public profile of each account, one at a time, reporting each step to the
// progress panel. Returns how many accounts had their name or avatar updated.
async function refreshProfiles(accounts) {
  let updated = 0;
  for (const [index, account] of accounts.entries()) {
    const label = account.name || account.steamId64;
    setRefreshProgress({ done: index, currentName: label, phase: `Fetching profile ${index + 1} of ${accounts.length}` });
    const status = {};
    const profile = await lookupProfile(account.steamId64, (note) => setProgressPhase(`${label}: ${note}`), status);
    // Count only profiles that supplied data; an empty profile does not update the account.
    if (profile && (profile.profileName || profile.avatarUrl)) {
      if (profile.profileName) account.name = profile.profileName;
      if (profile.avatarUrl) account.avatarUrl = profile.avatarUrl;
      updated += 1;
      addProgressLog(`${label}: profile updated`);
    } else {
      const why = status.reason ? ` (${status.reason})` : "";
      addProgressLog(`${label}: no profile data${why}, kept previous name and avatar`);
    }
    setRefreshProgress({ done: index + 1 });
  }
  console.info(`[profile] refreshed ${updated} of ${accounts.length} accounts`);
  return updated;
}

// Loads, changes, and saves one account, so long fetches do not overwrite other edits.
function updateAccount(id, change) {
  const accounts = loadAccounts();
  change(requireAccount(accounts, id));
  saveAccounts(accounts);
}

// Records the parser result for an account. Missing data is stored as unknown.
function storePageResult(id, result) {
  updateAccount(id, (account) => {
    account.cooldown = {
      source: "steam-page",
      expiresAt: result.expiresAt,
      parsedStatus: result.status,
      reason: result.reason,
      checkedAt: new Date().toISOString(),
    };
  });
}

// Puts a saved-login session into the account's partition. Returns null on success, or
// the reason it could not be used. Accounts without a saved login are left alone.
async function prepareSavedLogin(account) {
  if (!account.tokenSaved) return null;
  if (!tokenVault().isUnlocked()) return "Vault is locked. Unlock it to read this account.";
  const token = tokenVault().getToken(account.steamId64);
  if (!token) return "No saved login for this account. Save the login again.";
  try {
    const cookies = await steamAuth.webCookiesFor(token);
    await cooldownFetcher.applySteamCookies(account.steamId64, cookies);
    return null;
  } catch (error) {
    return `Saved login was rejected (${error instanceof Error ? error.message : String(error)}). Save the login again.`;
  }
}

// Results that mean the persisted web session was not accepted. Only these trigger a
// saved-login sign-in, so a working session is not replaced on every refresh.
function needsSavedLogin(result) {
  return (
    result.status === "unknown" &&
    /^(Steam showed the profile page|Steam web session expired)/.test(result.reason)
  );
}

// Reads one account. First tries the persisted web session as-is. Only when that is
// missing or rejected does it apply the saved login. Returns null when an automatic run
// should skip the account quietly (vault locked); a manual run gets the reason.
// step(text) reports each stage to the progress panel.
async function readAccountCooldown(account, manual, step = () => {}) {
  if (await cooldownFetcher.isWebSignedIn(account.steamId64)) {
    step("reading the matchmaking page with the saved web session");
    const current = await cooldownFetcher.readCooldownPage(account.steamId64);
    if (!account.tokenSaved || !needsSavedLogin(current)) return current;
    step("the web session was not accepted");
  }
  if (account.tokenSaved) {
    step("applying the saved login");
    const failure = await prepareSavedLogin(account);
    if (failure) {
      return manual ? { status: "unknown", expiresAt: null, reason: failure } : null;
    }
  }
  step("reading the matchmaking page");
  return cooldownFetcher.readCooldownPage(account.steamId64);
}

// One-line summary of a read for the progress log.
function describeResult(result) {
  if (result.status === "unknown") return `unknown: ${result.reason}`.slice(0, 160);
  if (result.expiresAt) return `${result.status} until ${new Date(result.expiresAt).toLocaleString()}`;
  return result.status;
}

let refreshRunning = null;
// True while a Steam sync runs. Refreshes wait for it and syncs wait for refreshes.
let syncRunning = false;
const PROGRESS_LOG_LIMIT = 8;
// Progress of the running refresh or sync, shown in the dashboard. running=false when idle.
// phase is the current step; log holds the most recent step results.
let refreshProgress = { kind: "idle", running: false, done: 0, total: 0, currentName: null, phase: null, log: [] };

function setRefreshProgress(change) {
  refreshProgress = { ...refreshProgress, ...change };
  sendToWindows("cooldowns:progress", refreshProgress);
}

function setProgressPhase(phase) {
  setRefreshProgress({ phase });
}

function addProgressLog(text) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  setRefreshProgress({ log: [...refreshProgress.log, `${time}  ${text}`].slice(-PROGRESS_LOG_LIMIT) });
}

// Reads the matchmaking page for every account with a saved login or web session, one
// at a time. Runs are serialized so the auto timer and a manual click never overlap.
function refreshCooldowns(onlyId = null) {
  if (syncRunning) return Promise.reject(new Error("Wait for the Steam sync to finish."));
  if (refreshRunning) return refreshRunning;
  refreshRunning = (async () => {
    // Decide the work list first so the progress total is known up front.
    const targets = [];
    for (const account of loadAccounts()) {
      if (onlyId && account.id !== onlyId) continue;
      const signedIn = await cooldownFetcher.isWebSignedIn(account.steamId64);
      // Automatic runs skip accounts with neither a saved login nor a web session;
      // a manual check reports why.
      if (!signedIn && !account.tokenSaved && !onlyId) continue;
      targets.push(account);
    }
    setRefreshProgress({
      kind: "refresh",
      running: true,
      done: 0,
      total: targets.length,
      currentName: null,
      phase: targets.length ? "Starting" : "No accounts have a saved login or web session",
      log: [],
    });

    for (const target of targets) {
      const account = loadAccounts().find((item) => item.id === target.id);
      if (!account) continue;
      const label = account.name || account.steamId64;
      setRefreshProgress({ currentName: label, phase: `Starting ${label}` });
      try {
        const result = await readAccountCooldown(account, Boolean(onlyId), (step) =>
          setProgressPhase(`${label}: ${step}`),
        );
        if (result) {
          storePageResult(account.id, result);
          addProgressLog(`${label}: ${describeResult(result)}`);
          if (result.status === "unknown") reportCheckFailure(account.id, label, result.reason);
          else announcedFailures.delete(account.id);
        } else {
          addProgressLog(`${label}: skipped, vault is locked`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        storePageResult(account.id, {
          status: "unknown",
          expiresAt: null,
          reason: `Page read failed: ${reason}`,
        });
        addProgressLog(`${label}: read failed`);
        reportCheckFailure(account.id, label, `Page read failed: ${reason}`);
      }
      setRefreshProgress({ done: refreshProgress.done + 1 });
      notifyRenderer();
    }
  })().finally(() => {
    refreshRunning = null;
    setRefreshProgress({ kind: "idle", running: false, currentName: null, phase: null });
    notifyRenderer();
  });
  return refreshRunning;
}

function notifyRenderer() {
  respond(loadAccounts())
    .then((accounts) => sendToWindows("accounts:changed", accounts))
    .catch((error) => console.warn(`[notify] ${error.message}`));
}

// Sends a message to every open window (main and account panel). A window that is closing
// can still be listed while its web contents are already destroyed, so those are skipped.
function sendToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      console.warn(`[window] send ${channel} failed: ${error.message}`);
    }
  }
}

function registerIpc() {
  ipcMain.handle("accounts:list", async () => respond(loadAccounts()));
  // Lets a dashboard that mounts mid-refresh show the current progress.
  ipcMain.handle("cooldowns:progressState", async () => refreshProgress);

  // Accepts a SteamID64 or a steamcommunity.com/profiles/ link.
  ipcMain.handle("accounts:add", async (_event, input) => {
    const text = requireString(input && input.steamId64, "SteamID64 or profile link", 300);
    const steamId64 = parseSteamIdInput(text);
    if (!steamId64) {
      throw new Error(
        "Enter a 17-digit SteamID64 or a steamcommunity.com/profiles/ link. Vanity /id/ links are not supported.",
      );
    }
    const accounts = loadAccounts();
    if (accounts.some((item) => item.steamId64 === steamId64)) {
      throw new Error("That account is already added.");
    }
    const profile = await lookupProfile(steamId64);
    accounts.push(newAccount(steamId64, profile));
    saveAccounts(accounts);
    return respond(accounts);
  });

  // Adds every account Steam remembers on this machine that is not tracked yet,
  // then refreshes names and avatars for all accounts.
  ipcMain.handle("accounts:importRemembered", async () => {
    if (refreshRunning) throw new Error("Wait for the cooldown check to finish.");
    if (syncRunning) throw new Error("A Steam sync is already running.");
    syncRunning = true;
    setRefreshProgress({
      kind: "sync",
      running: true,
      done: 0,
      total: 0,
      currentName: null,
      phase: "Reading the accounts Steam remembers on this machine",
      log: [],
    });
    try {
      const accounts = loadAccounts();
      const remembered = await steamClient.listRememberedAccounts();
      addProgressLog(`Steam remembers ${remembered.length} account${remembered.length === 1 ? "" : "s"} on this machine`);
      for (const user of remembered) {
        if (!accounts.some((item) => item.steamId64 === user.steamId64)) {
          const added = newAccount(user.steamId64, { profileName: user.personaName || user.accountName });
          accounts.push(added);
          addProgressLog(`Added ${added.name}`);
        }
      }
      setRefreshProgress({ total: accounts.length });
      const updated = await refreshProfiles(accounts);
      setProgressPhase("Saving accounts");
      saveAccounts(accounts);
      addProgressLog(`Sync complete: ${updated} of ${accounts.length} profiles updated`);
      return respond(accounts);
    } finally {
      syncRunning = false;
      setRefreshProgress({ kind: "idle", running: false, done: 0, total: 0, currentName: null, phase: null });
      notifyRenderer();
    }
  });

  ipcMain.handle("accounts:remove", async (_event, id) => {
    const accounts = loadAccounts();
    const removed = accounts.find((item) => item.id === id);
    // An account with a saved token can only be removed while the vault is open, so its
    // encrypted refresh token is dropped with it and never left orphaned in the vault.
    if (removed && removed.tokenSaved) {
      if (!tokenVault().isUnlocked()) {
        throw new Error("Unlock the vault before removing an account with a saved login.");
      }
      tokenVault().removeToken(removed.steamId64);
    }
    if (removed) cs2Config.removeStore(cs2StorePath(), removed.steamId64);
    const remaining = accounts.filter((item) => item.id !== id);
    saveAccounts(remaining);
    return respond(remaining);
  });

  // CS2 settings backups. Import copies from Steam's userdata folder into Nyx's own store.
  ipcMain.handle("cs2:list", async (_event, id) => {
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    return cs2Summary(account);
  });

  ipcMain.handle("cs2:import", async (_event, id) => {
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    const steamRoot = await steamClient.steamDir().catch(() => null);
    cs2Config.createSnapshot({ steamRoot, storeRoot: cs2StorePath(), steamId64: account.steamId64 });
    return cs2Summary(account);
  });

  ipcMain.handle("cs2:view", (_event, id, snapshotId) => {
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    return cs2Config.readBindings(cs2StorePath(), account.steamId64, requireString(snapshotId, "Backup", 40));
  });

  // Editable settings (video and convars) of one backup.
  ipcMain.handle("cs2:settings", (_event, id, snapshotId) => {
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    return cs2Config.readSettings(cs2StorePath(), account.steamId64, requireString(snapshotId, "Backup", 40));
  });

  // Saves edits as a new backup. Steam's files are not changed. Returns the new backup's ID.
  ipcMain.handle("cs2:saveSettings", async (_event, id, snapshotId, changes) => {
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    const meta = cs2Config.saveSettings({
      storeRoot: cs2StorePath(),
      steamId64: account.steamId64,
      snapshotId: requireString(snapshotId, "Backup", 40),
      changes,
    });
    return { state: await cs2Summary(account), snapshotId: meta.id };
  });

  ipcMain.handle("vault:status", async () => tokenVault().status());

  // Creates the vault. Returns the recovery code once; the renderer must show it and
  // must not keep it.
  ipcMain.handle("vault:setup", async (_event, password) => {
    const result = await tokenVault().setup(requireString(password, "Master password", 200));
    return { recoveryCode: result.recoveryCode, status: tokenVault().status() };
  });

  ipcMain.handle("vault:unlock", async (_event, password) => {
    await tokenVault().unlock(requireString(password, "Master password", 200));
    return tokenVault().status();
  });

  ipcMain.handle("vault:unlockRecovery", async (_event, code) => {
    await tokenVault().unlockWithRecovery(requireString(code, "Recovery code", 80));
    return tokenVault().status();
  });

  ipcMain.handle("vault:lock", async () => {
    steamAuth.cancelAllPending();
    signupHelper.cancel();
    closePanel();
    closeCs2();
    tokenVault().lock();
    loginDrafts.clear();
    pendingSignupLogin = null;
    pendingPasswords.clear();
    return tokenVault().status();
  });

  // Starts a Steam sign-in for one account. The password is used once and dropped.
  // accountId is optional: without it, the sign-in adds the account it belongs to.
  ipcMain.handle("login:start", async (_event, input) => {
    if (!tokenVault().isUnlocked()) throw new Error("Unlock the vault before saving a login.");
    if (input && input.accountId) requireAccount(loadAccounts(), requireString(input.accountId, "Account"));
    const accountName = requireString(input && input.accountName, "Steam account name", 100);
    const password = requireString(input && input.password, "Password", 200);
    const since = Date.now() - signupHelper.STEAM_CODE_LOOKBACK_MS;
    const start = await steamAuth.startLogin(accountName, password);
    // Kept in memory until login:finish saves it to the vault with the token.
    pendingPasswords.set(start.pendingId, password);
    // When Steam emails a code and a mailbox is saved, the code is read from it here.
    const fromMail = await signupHelper.submitEmailCodeIfNeeded(start, tokenVault().getMailSettings(), since);
    return { ...start, ...fromMail };
  });

  ipcMain.handle("login:code", async (_event, input) => {
    const code = requireString(input && input.code, "Steam Guard code", 20);
    await steamAuth.submitCode(requireString(input && input.pendingId, "Sign-in"), code);
    return { ok: true };
  });

  // Waits for the sign-in to finish, then saves the refresh token in the vault.
  // With an accountId, the login must belong to that account. Without one, the login's
  // account is added (or, if already tracked, updated) using the SteamID64 Steam returned.
  ipcMain.handle("login:finish", async (_event, input) => {
    const accountId = input && input.accountId ? requireString(input.accountId, "Account") : null;
    if (accountId) requireAccount(loadAccounts(), accountId);
    const pendingId = requireString(input && input.pendingId, "Sign-in");
    const result = await steamAuth.finishLogin(pendingId);
    // The password typed for this sign-in, or the one generated by signup for its sign-in.
    const password = takePendingPassword(pendingId);
    if (!tokenVault().isUnlocked()) {
      throw new Error("Vault was locked during sign-in. Unlock it and try again.");
    }
    // Reload after the wait: the store may have changed while Steam Guard was pending.
    const accounts = loadAccounts();
    let message = "Login saved for this account.";
    let targetId = accountId;
    if (accountId) {
      const account = requireAccount(accounts, accountId);
      if (result.steamId64 !== account.steamId64) {
        throw new Error("That login belongs to a different Steam account. Nothing was saved.");
      }
    } else {
      const existing = accounts.find((item) => item.steamId64 === result.steamId64);
      if (existing) {
        targetId = existing.id;
      } else {
        const created = newAccount(result.steamId64, await lookupProfile(result.steamId64));
        accounts.push(created);
        saveAccounts(accounts);
        targetId = created.id;
        message = "Account added and login saved.";
      }
    }
    tokenVault().saveToken(result.steamId64, result.refreshToken, password);
    // Credentials of the signup this sign-in completes, if it is one.
    const signupLogin =
      !accountId && pendingSignupLogin && pendingSignupLogin.pendingId === input.pendingId ? pendingSignupLogin : null;
    // A manual save from the panel replaces the draft. A sign-in from the signup flow fills
    // the new account's panel with the generated login.
    if (accountId) {
      loginDrafts.delete(accountId);
    } else if (pendingSignupLogin && pendingSignupLogin.pendingId === input.pendingId) {
      loginDrafts.set(targetId, pendingSignupLogin);
      pendingSignupLogin = null;
    }
    updateAccount(targetId, (item) => {
      item.tokenSaved = true;
    });
    // A new signup account gets the free CS2 license now, so it can play. A failure is
    // reported in the message and does not undo the saved login.
    if (signupLogin) {
      message += ` ${await requestSignupLicense(signupLogin, result.steamId64)}`;
    }
    // Read the new account's cooldown right away, as "Check now" does. A read failure is
    // stored on the account by refreshCooldowns and must not fail the saved login.
    await refreshCooldowns(targetId).catch(() => {});
    return { message, accounts: await respond(loadAccounts()) };
  });

  // Reads the Personal Game Data page for one account (manual check).
  ipcMain.handle("accounts:refreshOne", async (_event, id) => {
    requireAccount(loadAccounts(), id);
    await refreshCooldowns(id);
    return respond(loadAccounts());
  });

  // Reads the page for every account that has a web session.
  ipcMain.handle("accounts:refreshAll", async () => {
    await refreshCooldowns();
    return respond(loadAccounts());
  });

  // Opens Steam's web login for one account, then reports whether it was saved.
  ipcMain.handle("accounts:webSignIn", async (_event, id) => {
    const account = requireAccount(loadAccounts(), id);
    const result = await cooldownFetcher.signInWeb(account.steamId64);
    return { message: result.message, accounts: await respond(loadAccounts()) };
  });

  // Manual fallback: the renderer sends an absolute UTC ISO string.
  ipcMain.handle("accounts:setManual", async (_event, id, expiresAtIso) => {
    const accounts = loadAccounts();
    const account = requireAccount(accounts, id);
    const ms = Date.parse(requireString(expiresAtIso, "Expiry", 40));
    if (!Number.isFinite(ms)) {
      throw new Error("Expiry is not a valid date/time.");
    }
    account.cooldown = {
      source: "manual",
      expiresAt: new Date(ms).toISOString(),
      parsedStatus: null,
      reason: "Entered manually.",
      checkedAt: new Date().toISOString(),
    };
    saveAccounts(accounts);
    return respond(accounts);
  });

  ipcMain.handle("accounts:clearCooldown", async (_event, id) => {
    const accounts = loadAccounts();
    requireAccount(accounts, id).cooldown = null;
    saveAccounts(accounts);
    return respond(accounts);
  });

  ipcMain.handle("steam:signIn", async (_event, steamId64) => {
    const message = await steamClient.signInAccount(validSteamId(steamId64));
    return { message };
  });

  // Assisted signup: opens Steam's join page with the user's email and mailbox settings.
  // Returns the generated username and password once, for the user to record.
  ipcMain.handle("signup:open", async (_event, input) => {
    if (!tokenVault().isUnlocked()) throw new Error("Unlock the vault before creating an account.");
    // With no password typed, use the saved mailbox password, but only for the same mailbox.
    const mail = { ...((input && input.mail) || {}) };
    if (!mail.password) {
      const saved = tokenVault().getMailSettings();
      if (saved && saved.host === mail.host && saved.user === mail.user) mail.password = saved.password;
    }
    return signupHelper.open({ ...input, mail });
  });

  // Saved mailbox settings for the signup watcher. The password is never sent to the renderer.
  ipcMain.handle("mail:get", async () => {
    if (!tokenVault().isUnlocked()) return null;
    const saved = tokenVault().getMailSettings();
    return saved ? { email: saved.email, host: saved.host, port: saved.port, user: saved.user } : null;
  });

  ipcMain.handle("mail:save", async (_event, input) => {
    if (!tokenVault().isUnlocked()) throw new Error("Unlock the vault before saving mail settings.");
    const email = signupUtils.validEmail(input && input.email);
    const mail = signupUtils.normalizeMailConfig(input && input.mail);
    tokenVault().saveMailSettings({ email, ...mail });
    return { ok: true };
  });

  ipcMain.handle("mail:clear", async () => {
    if (tokenVault().isUnlocked()) tokenVault().removeMailSettings();
    return { ok: true };
  });

  // Newest Steam Guard code in the saved mailbox, from the last 15 minutes. Read on demand only.
  ipcMain.handle("mail:guardCode", async () => {
    if (!tokenVault().isUnlocked()) throw new Error("Unlock the vault first.");
    const mail = tokenVault().getMailSettings();
    if (!mail) throw new Error("No mailbox saved. Save it in the Add card's Create tab first.");
    const code = await signupHelper.latestGuardCode(mail, 15 * 60 * 1000);
    return code
      ? { code, note: "Newest Steam Guard code from the last 15 minutes. Check it is for the right sign-in." }
      : { code: null, note: "No Steam Guard email from the last 15 minutes." };
  });

  // The stored password for an account, sent only when the user asks to see it.
  ipcMain.handle("accounts:password", async (_event, id) => {
    if (!tokenVault().isUnlocked()) throw new Error("Unlock the vault first.");
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    const password = tokenVault().getPassword(account.steamId64);
    if (password === null) throw new Error("No password is stored for this account. Save login with its password.");
    return { password };
  });

  // Login details to fill into an account's Saved login section, or null.
  ipcMain.handle("accounts:loginDraft", async (_event, id) => {
    if (!tokenVault().isUnlocked()) return null;
    const draft = loginDrafts.get(id);
    return draft ? { accountName: draft.accountName, password: draft.password } : null;
  });

  ipcMain.handle("signup:status", async () => signupHelper.status());

  // Starts the sign-in for the account the user created. The generated password is used
  // here in the main process and never sent back to the renderer.
  // The username and password come from the signup card, where the user may have edited them.
  ipcMain.handle("signup:complete", async (_event, input) => {
    if (!tokenVault().isUnlocked()) throw new Error("Unlock the vault before saving a login.");
    const result = await signupHelper.complete(input);
    pendingSignupLogin = {
      pendingId: result.pendingId,
      accountName: String(input.username).trim(),
      password: String(input.password),
    };
    return result;
  });

  ipcMain.handle("signup:cancel", async () => {
    signupHelper.cancel();
    return { ok: true };
  });

  // User preferences (notifications). Only known boolean keys are accepted.
  ipcMain.handle("settings:get", () => settingsStore.loadSettings(settingsPath()));
  ipcMain.handle("settings:save", (_event, change) => {
    const safe = {};
    for (const key of Object.keys(settingsStore.DEFAULTS)) {
      if (change && typeof change[key] === "boolean") safe[key] = change[key];
    }
    return settingsStore.saveSettings(settingsPath(), safe);
  });

  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("update:status", async () => updater.getStatus());
  ipcMain.handle("update:download", async () => updater.download());
  ipcMain.handle("update:install", async () => {
    updater.install();
    return { ok: true };
  });
}

// Requests the free CS2 license for an account created by the signup flow. The Steam Guard
// code is read from the saved mailbox, so without one the request is skipped. Returns a short
// note for the sign-in message. Skipped if Steam's client is signed in as this account, since a
// second login could disconnect it.
async function requestSignupLicense(login, steamId64) {
  const activeId = await steamClient.activeSteamId64().catch(() => null);
  if (activeId === steamId64) {
    return "CS2 license not requested: this account is signed in to the Steam client. Sign it out there and try again.";
  }
  const mail = tokenVault().getMailSettings();
  if (!mail) {
    return "CS2 license not requested: save the mailbox login so the Steam Guard code can be read.";
  }
  const since = Date.now() - signupHelper.STEAM_CODE_LOOKBACK_MS;
  const requestCs2License = createFreeLicenseRequester({ SteamUser });
  try {
    const outcome = await requestCs2License({
      accountName: login.accountName,
      password: login.password,
      getGuardCode: () => signupHelper.waitForMailCode(mail, since),
    });
    return outcome.granted
      ? "CS2 license granted."
      : "Steam returned no new CS2 license (the account may already have one).";
  } catch (error) {
    return `CS2 license not granted: ${error.message}`;
  }
}

// Checks GitHub Releases for a newer build (packaged builds only). See updater.cjs.
const updater = createUpdater({
  autoUpdater,
  isPackaged: app.isPackaged,
  send: sendToWindows,
  log: console,
});

// Login details for each account's next Saved login, filled into its panel after a signup.
// Held in memory only: cleared on vault lock and never written to disk.
const loginDrafts = new Map();
// Credentials from the last completed signup, kept until its sign-in finishes (matched by
// pendingId), so the new account's panel can be filled in.
let pendingSignupLogin = null;
// Passwords of sign-ins still waiting for Steam Guard, keyed by pendingId. Cleared on lock.
const pendingPasswords = new Map();

// Returns and forgets the password for a sign-in. Signup sign-ins use the generated password.
function takePendingPassword(pendingId) {
  const typed = pendingPasswords.get(pendingId);
  pendingPasswords.delete(pendingId);
  if (typed !== undefined) return typed;
  if (pendingSignupLogin && pendingSignupLogin.pendingId === pendingId) return pendingSignupLogin.password;
  return null;
}

const indexPath = path.join(__dirname, "..", "dist", "renderer", "index.html");
const MAIN_WIDTH = 1100;
const MAIN_HEIGHT = 880;
const PANEL_WIDTH = 380;
// The panel sits flush against the main window; its left border is the divider.
const PANEL_GAP = 0;
// Length of the fade-out when a window closes.
const EXIT_FADE_MS = 150;

// Fixed-size, frameless, transparent windows. The renderer draws its own title bar and
// background, and wipes itself in and out (see Frame in shared.tsx). The window stays
// hidden until the renderer asks for it with window:reveal.
const LOCKED_WINDOW = {
  resizable: false,
  maximizable: false,
  fullscreenable: false,
  frame: false,
  // Transparent so the clipped wipe shows the desktop outside the window box, not an empty box.
  transparent: true,
  show: false,
  icon: iconPath,
};

function webPreferences() {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // Keeps the wipe animations running when the window loses focus. Throttled animations
    // paused partway, and the exit fallback then closed the window early.
    backgroundThrottling: false,
  };
}

let mainWindow = null;
let panelWindow = null;
// True while the panel is fading out, so it is not closed twice.
let panelClosing = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    ...LOCKED_WINDOW,
    width: MAIN_WIDTH,
    height: MAIN_HEIGHT,
    webPreferences: webPreferences(),
  });
  mainWindow.center();
  // The attached windows follow the main window while it is dragged.
  mainWindow.on("move", placeAttached);
  // Closing fades the window out in the main process; the real close follows it.
  let closing = false;
  mainWindow.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    closePanel();
    closeCs2();
    const win = mainWindow;
    fadeOut(win).then(() => {
      if (!win.isDestroyed()) win.close();
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadFile(indexPath);
}

// Fades a window out over EXIT_FADE_MS, driven by the main process so it does not depend on
// the renderer presenting frames. Resolves when the fade is complete.
function fadeOut(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve();
    const started = Date.now();
    const timer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(timer);
        return resolve();
      }
      const progress = Math.min(1, (Date.now() - started) / EXIT_FADE_MS);
      win.setOpacity(1 - progress);
      if (progress >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 16);
  });
}

// Opens the account panel as a second window attached to the right of the main window,
// or updates it when it is already open.
function openPanel(accountId) {
  if (!mainWindow) return;
  if (panelWindow) {
    panelWindow.webContents.send("panel:select", accountId);
    if (panelWindow.isMinimized()) panelWindow.restore();
    panelWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    ...LOCKED_WINDOW,
    parent: mainWindow,
    width: PANEL_WIDTH,
    height: mainWindow.getBounds().height,
    webPreferences: webPreferences(),
  });
  panelWindow = win;
  // Placed before it is shown; the renderer reveals it once mounted.
  placePanel();
  win.on("closed", () => {
    panelWindow = null;
    panelClosing = false;
    sendToWindows("panel:closed");
  });
  win.loadFile(indexPath, { query: { panel: accountId } });
}

// Wipes the panel out, then closes it. Used by its own close button, by the main window's
// close, by removing an account, and by locking the vault.
function closePanel() {
  const win = panelWindow;
  if (!win || win.isDestroyed() || panelClosing) return;
  panelClosing = true;
  fadeOut(win).then(() => {
    if (!win.isDestroyed()) win.close();
  });
}

// Puts the panel beside the main window, same top and height. Opens on the left when
// there is no room on the right of the screen.
function placePanel() {
  if (!mainWindow || !panelWindow || mainWindow.isDestroyed() || panelWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  let x = bounds.x + bounds.width + PANEL_GAP;
  if (x + PANEL_WIDTH > area.x + area.width) x = bounds.x - PANEL_GAP - PANEL_WIDTH;
  panelWindow.setBounds({ x, y: bounds.y, width: PANEL_WIDTH, height: bounds.height });
}

// The CS2 window sits across the top of the main window, the same width. It is a separate
// window above the main one, so the main title bar stays free to drag. When there is no room
// above on screen, it goes below the main window instead.
const CS2_HEIGHT = 470;
let cs2Window = null;
// True while the CS2 window is fading out, so it is not closed twice.
let cs2Closing = false;

function openCs2(accountId) {
  if (!mainWindow) return;
  if (cs2Window) {
    cs2Window.webContents.send("cs2:select", accountId);
    if (cs2Window.isMinimized()) cs2Window.restore();
    cs2Window.focus();
    return;
  }
  const win = new BrowserWindow({
    ...LOCKED_WINDOW,
    parent: mainWindow,
    width: mainWindow.getBounds().width,
    height: CS2_HEIGHT,
    webPreferences: webPreferences(),
  });
  cs2Window = win;
  placeCs2();
  win.on("closed", () => {
    cs2Window = null;
    cs2Closing = false;
  });
  win.loadFile(indexPath, { query: { cs2: accountId } });
}

function closeCs2() {
  const win = cs2Window;
  if (!win || win.isDestroyed() || cs2Closing) return;
  cs2Closing = true;
  fadeOut(win).then(() => {
    if (!win.isDestroyed()) win.close();
  });
}

function placeCs2() {
  if (!mainWindow || !cs2Window || mainWindow.isDestroyed() || cs2Window.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  let y = bounds.y - CS2_HEIGHT;
  if (y < area.y) y = bounds.y + bounds.height;
  cs2Window.setBounds({ x: bounds.x, y, width: bounds.width, height: CS2_HEIGHT });
}

// Keeps every attached window beside the main window.
function placeAttached() {
  placePanel();
  placeCs2();
}

// Title bar controls. The sender's window is the one that was clicked.
function registerWindowControls() {
  // Shows the window once its renderer has mounted, so the wipe-in starts on screen.
  ipcMain.handle("window:reveal", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.show();
  });
  ipcMain.handle("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
  });
  // Opens the panel for one account. The account must exist.
  ipcMain.handle("panel:open", (_event, id) => {
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    openPanel(account.id);
  });
  // Fades the panel out. The main window calls this when its selected account is clicked again.
  ipcMain.handle("panel:close", () => {
    closePanel();
  });
  // Opens the CS2 window across the top for one account, or retargets it when already open.
  ipcMain.handle("cs2:open", (_event, id) => {
    const account = requireAccount(loadAccounts(), requireString(id, "Account"));
    openCs2(account.id);
  });
  ipcMain.handle("cs2:close", () => {
    closeCs2();
  });
  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    // The attached windows fade out themselves; the main window plays its close animation in its close handler.
    if (win === panelWindow) closePanel();
    else if (win === cs2Window) closeCs2();
    else win.close();
  });
}

// Windows groups notifications under this id. It matches the installer's appId so
// notifications from the installed app and from `npm start` are attributed the same way.
app.setAppUserModelId("local.steamaccounthelper");

app.whenReady().then(() => {
  // Removes the File / Edit / View / Window menu bar.
  Menu.setApplicationMenu(null);
  registerIpc();
  registerWindowControls();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  // Automatic reads: shortly after launch, then every 30 minutes.
  setTimeout(() => refreshCooldowns().catch(() => {}), AUTO_REFRESH_FIRST_MS);
  // Pushes an update when Steam's active account changes (e.g. after Sign in or a manual login).
  let lastActiveId = undefined;
  setInterval(async () => {
    const activeId = await steamClient.activeSteamId64().catch(() => null);
    if (activeId !== lastActiveId) {
      lastActiveId = activeId;
      notifyRenderer();
    }
  }, ACTIVE_POLL_MS);
  setInterval(() => refreshCooldowns().catch(() => {}), AUTO_REFRESH_MS);
  setInterval(checkCooldownEndings, COOLDOWN_CHECK_MS);
  updater.start();
});

app.on("window-all-closed", () => {
  app.quit();
});

// Wipes the vault key and any unfinished sign-in when the app exits.
app.on("before-quit", () => {
  steamAuth.cancelAllPending();
  if (tokenVaultInstance) tokenVaultInstance.lock();
});
