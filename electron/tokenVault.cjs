// Encrypted store for Steam refresh tokens, built on vault.cjs. Pure Node, no Electron
// imports, so it can be tested directly. The data key exists in memory only while
// unlocked. Refresh tokens are never written to accounts.json or logged.

const fs = require("node:fs");
const path = require("node:path");
const vault = require("./vault.cjs");

function createTokenVault(filePath) {
  let session = null;

  const exists = () => fs.existsSync(filePath);

  function readFile() {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  // Write to a temp file, then rename, so a crash never leaves a half-written vault.
  function writeFile(file) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  }

  function requireUnlocked() {
    if (!session) throw new Error("Vault is locked.");
  }

  function records() {
    requireUnlocked();
    return session.readRecords();
  }

  function storeRecords(list) {
    requireUnlocked();
    writeFile(session.writeRecords(list));
  }

  return {
    status() {
      return { exists: exists(), unlocked: session !== null };
    },

    isUnlocked() {
      return session !== null;
    },

    // Creates the vault and unlocks it. Returns the recovery code, which the caller
    // must show once and never store in plaintext.
    async setup(masterPassword) {
      if (exists()) throw new Error("A vault already exists.");
      const { file, recoveryCode } = await vault.createVault(masterPassword, "[]");
      writeFile(file);
      session = await vault.unlockWithPassword(file, masterPassword);
      return { recoveryCode };
    },

    async unlock(masterPassword) {
      if (!exists()) throw new Error("No vault yet. Set one up first.");
      session = await vault.unlockWithPassword(readFile(), masterPassword);
    },

    async unlockWithRecovery(recoveryCode) {
      if (!exists()) throw new Error("No vault yet. Set one up first.");
      session = await vault.unlockWithRecoveryCode(readFile(), recoveryCode);
    },

    lock() {
      if (session) session.lock();
      session = null;
    },

    getToken(steamId64) {
      const record = records().find((item) => item.steamId64 === steamId64);
      return record ? record.refreshToken : null;
    },

    // Saves the refresh token. A password and the Steam login name, when given, are saved with it.
    // Without them, the values already stored for the account are kept.
    saveToken(steamId64, refreshToken, password, accountName) {
      const all = records();
      const previous = all.find((item) => item.steamId64 === steamId64);
      const list = all.filter((item) => item.steamId64 !== steamId64);
      const kept = typeof password === "string" ? password : previous ? previous.password : undefined;
      const keptName =
        typeof accountName === "string" && accountName ? accountName : previous ? previous.accountName : undefined;
      list.push({
        steamId64,
        refreshToken,
        ...(kept !== undefined ? { password: kept } : {}),
        ...(keptName !== undefined ? { accountName: keptName } : {}),
        savedAt: new Date().toISOString(),
      });
      storeRecords(list);
    },

    getPassword(steamId64) {
      const record = records().find((item) => item.steamId64 === steamId64);
      return record && typeof record.password === "string" ? record.password : null;
    },

    // The Steam login name saved with the account's login, or null.
    getAccountName(steamId64) {
      const record = records().find((item) => item.steamId64 === steamId64);
      return record && typeof record.accountName === "string" && record.accountName ? record.accountName : null;
    },

    removeToken(steamId64) {
      storeRecords(records().filter((item) => item.steamId64 !== steamId64));
    },

    // Mailbox settings for the signup watcher (email, IMAP host, port, login, and password).
    // Stored encrypted with the tokens, as a record without a steamId64.
    getMailSettings() {
      const record = records().find((item) => item.kind === "mail");
      if (!record) return null;
      return { email: record.email, host: record.host, port: record.port, user: record.user, password: record.password };
    },

    saveMailSettings({ email, host, port, user, password }) {
      const list = records().filter((item) => item.kind !== "mail");
      list.push({ kind: "mail", email, host, port, user, password, savedAt: new Date().toISOString() });
      storeRecords(list);
    },

    removeMailSettings() {
      storeRecords(records().filter((item) => item.kind !== "mail"));
    },
  };
}

module.exports = { createTokenVault };
