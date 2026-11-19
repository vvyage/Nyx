// Reads Steam's local account list and switches the Steam client's auto-login user.
// Only reads account names/flags from config\loginusers.vdf. No passwords, tokens,
// or Steam Guard data are read or written. Sign-in works only for accounts that
// Steam already remembers on this machine (RememberPassword = 1).

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REG_KEY = "HKCU\\Software\\Valve\\Steam";

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || "") });
    });
  });
}

async function regValue(name) {
  const { ok, stdout } = await run("reg", ["query", REG_KEY, "/v", name]);
  if (!ok) return null;
  const match = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`));
  return match ? match[1].trim() : null;
}

async function steamDir() {
  const raw = (await regValue("SteamPath")) || "";
  if (!raw) {
    throw new Error("Steam is not installed (no SteamPath in the registry).");
  }
  return path.normalize(raw);
}

// Parses the VDF "users" section: "<steamid64>" { "AccountName" "x" ... }.
function parseLoginUsers(text) {
  const users = [];
  const blockPattern = /"(\d{17})"\s*\{([^}]*)\}/g;
  let block;
  while ((block = blockPattern.exec(text))) {
    const fields = {};
    for (const field of block[2].matchAll(/"([^"]+)"\s+"([^"]*)"/g)) {
      fields[field[1].toLowerCase()] = field[2];
    }
    users.push({
      steamId64: block[1],
      accountName: fields.accountname || "",
      personaName: fields.personaname || "",
      rememberPassword: fields.rememberpassword === "1",
    });
  }
  return users;
}

async function listRememberedAccounts() {
  const dir = await steamDir();
  const file = path.join(dir, "config", "loginusers.vdf");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseLoginUsers(text).filter((user) => user.accountName);
}

async function isSteamRunning() {
  const { stdout } = await run("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"]);
  return /steam\.exe/i.test(stdout);
}

async function waitForSteamExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isSteamRunning())) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

// The account Steam is currently signed in as, or null when signed out or Steam is closed.
// Steam stores the 32-bit account ID in HKCU\...\ActiveProcess\ActiveUser (0 when signed out).
const STEAMID64_BASE = 76561197960265728n;

// Parses `reg query ...\ActiveProcess` output. ActiveUser can keep the last account after Steam
// shows its account picker, so a signed-in account also needs a running Steam process (pid).
// Returns the SteamID64 or null.
function parseActiveUser(stdout) {
  const pid = stdout.match(/\bpid\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
  if (!pid || BigInt(`0x${pid[1]}`) === 0n) return null;
  const match = stdout.match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
  if (!match) return null;
  const accountId = BigInt(`0x${match[1]}`);
  if (accountId === 0n) return null;
  return (accountId + STEAMID64_BASE).toString();
}

async function activeSteamId64() {
  if (!(await isSteamRunning())) return null;
  const { ok, stdout } = await run("reg", ["query", `${REG_KEY}\\ActiveProcess`]);
  if (!ok) return null;
  return parseActiveUser(stdout);
}

// Makes the account Steam's auto-login user, then restarts Steam.
// Steam must be closed while its config is written, so it is shut down first.
async function signInAccount(steamId64) {
  const users = await listRememberedAccounts();
  const user = users.find((item) => item.steamId64 === steamId64);
  if (!user) {
    throw new Error("Steam does not list this account on this machine. Sign in once manually.");
  }
  if (!user.rememberPassword) {
    throw new Error(
      "Steam does not remember this account's password here. Sign in once manually with 'Remember my password'.",
    );
  }

  const exe = path.join(await steamDir(), "steam.exe");
  if (!fs.existsSync(exe)) {
    throw new Error("steam.exe was not found.");
  }

  if (await isSteamRunning()) {
    await run(exe, ["-shutdown"]);
    if (!(await waitForSteamExit(30000))) {
      throw new Error("Steam did not close within 30 seconds. Close it manually and retry.");
    }
  }

  const set = await run("reg", [
    "add",
    REG_KEY,
    "/v",
    "AutoLoginUser",
    "/t",
    "REG_SZ",
    "/d",
    user.accountName,
    "/f",
  ]);
  if (!set.ok) {
    throw new Error("Could not set Steam's auto-login user in the registry.");
  }

  spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  return `Starting Steam as ${user.personaName || user.accountName}.`;
}

module.exports = {
  parseLoginUsers,
  parseActiveUser,
  listRememberedAccounts,
  activeSteamId64,
  signInAccount,
  steamDir,
  isSteamRunning,
};
