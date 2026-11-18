const { contextBridge, ipcRenderer } = require("electron");

// Narrow API surface: the renderer cannot reach Node or arbitrary IPC channels.
contextBridge.exposeInMainWorld("sah", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  addAccount: (input) => ipcRenderer.invoke("accounts:add", input),
  importRemembered: () => ipcRenderer.invoke("accounts:importRemembered"),
  removeAccount: (id) => ipcRenderer.invoke("accounts:remove", id),
  setManual: (id, expiresAtIso) => ipcRenderer.invoke("accounts:setManual", id, expiresAtIso),
  clearCooldown: (id) => ipcRenderer.invoke("accounts:clearCooldown", id),
  refreshCooldown: (id) => ipcRenderer.invoke("accounts:refreshOne", id),
  refreshAllCooldowns: () => ipcRenderer.invoke("accounts:refreshAll"),
  signIn: (steamId64) => ipcRenderer.invoke("steam:signIn", steamId64),
  vaultStatus: () => ipcRenderer.invoke("vault:status"),
  vaultSetup: (password) => ipcRenderer.invoke("vault:setup", password),
  vaultUnlock: (password) => ipcRenderer.invoke("vault:unlock", password),
  vaultUnlockRecovery: (code) => ipcRenderer.invoke("vault:unlockRecovery", code),
  vaultLock: () => ipcRenderer.invoke("vault:lock"),
  loginStart: (input) => ipcRenderer.invoke("login:start", input),
  loginCode: (input) => ipcRenderer.invoke("login:code", input),
  loginFinish: (input) => ipcRenderer.invoke("login:finish", input),
  signupOpen: (input) => ipcRenderer.invoke("signup:open", input),
  signupStatus: () => ipcRenderer.invoke("signup:status"),
  signupComplete: (input) => ipcRenderer.invoke("signup:complete", input),
  signupCancel: () => ipcRenderer.invoke("signup:cancel"),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  getLoginDraft: (id) => ipcRenderer.invoke("accounts:loginDraft", id),
  cs2List: (id) => ipcRenderer.invoke("cs2:list", id),
  cs2Import: (id) => ipcRenderer.invoke("cs2:import", id),
  cs2View: (id, snapshotId) => ipcRenderer.invoke("cs2:view", id, snapshotId),
  cs2Settings: (id, snapshotId) => ipcRenderer.invoke("cs2:settings", id, snapshotId),
  cs2SaveSettings: (id, snapshotId, changes) => ipcRenderer.invoke("cs2:saveSettings", id, snapshotId, changes),
  // Opens (or re-targets) the CS2 window across the top of the main window.
  cs2Open: (id) => ipcRenderer.invoke("cs2:open", id),
  cs2Close: () => ipcRenderer.invoke("cs2:close"),
  // Fired in the CS2 window when the main window asks for another account.
  onCs2Select: (callback) => {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on("cs2:select", listener);
    return () => ipcRenderer.removeListener("cs2:select", listener);
  },
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (change) => ipcRenderer.invoke("settings:save", change),
  getMailSettings: () => ipcRenderer.invoke("mail:get"),
  saveMailSettings: (input) => ipcRenderer.invoke("mail:save", input),
  clearMailSettings: () => ipcRenderer.invoke("mail:clear"),
  getGuardCode: () => ipcRenderer.invoke("mail:guardCode"),
  getAccountPassword: (id) => ipcRenderer.invoke("accounts:password", id),
  getUpdateStatus: () => ipcRenderer.invoke("update:status"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  // Fired as the update check and download change. Returns an unsubscribe function.
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
  getCooldownProgress: () => ipcRenderer.invoke("cooldowns:progressState"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  // Shows the window once it has mounted. Resolves when the call is handled.
  revealWindow: () => ipcRenderer.invoke("window:reveal"),
  // Opens (or re-targets) the attached account panel window.
  openPanel: (id) => ipcRenderer.invoke("panel:open", id),
  // Hides the attached account panel with its fade-out.
  closePanel: () => ipcRenderer.invoke("panel:close"),
  // Fired in the panel window when the main window picks another account.
  onPanelSelect: (callback) => {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on("panel:select", listener);
    return () => ipcRenderer.removeListener("panel:select", listener);
  },
  // Fired in the main window when the account panel is closed.
  onPanelClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("panel:closed", listener);
    return () => ipcRenderer.removeListener("panel:closed", listener);
  },
  // Fired as each account read starts and finishes. Returns an unsubscribe function.
  onCooldownProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("cooldowns:progress", listener);
    return () => ipcRenderer.removeListener("cooldowns:progress", listener);
  },
  // Fired after automatic or manual page reads finish. Returns an unsubscribe function.
  onAccountsChanged: (callback) => {
    const listener = (_event, accounts) => callback(accounts);
    ipcRenderer.on("accounts:changed", listener);
    return () => ipcRenderer.removeListener("accounts:changed", listener);
  },
});
