export type CooldownSource = "steam-page" | "manual";


export interface Cooldown {
  source: CooldownSource;
  // Absolute UTC ISO timestamp, or null when the page had no readable value.
  expiresAt: string | null;
  parsedStatus: "cooldown" | "expired" | "clear" | "unknown" | null;
  reason: string;
  checkedAt: string;
}

export interface SteamInfo {
  accountName: string;
  personaName: string;
  rememberPassword: boolean;
}

export interface Account {
  id: string;
  name: string;
  steamId64: string;
  // Steam avatar URL from the public profile; null when unknown.
  avatarUrl: string | null;
  // null = never checked; shown as unknown, never as clear.
  cooldown: Cooldown | null;
  displayName: string;
  // Present when Steam lists this account on this machine.
  steam: SteamInfo | null;
  // True when this account's Steam web session is saved in the app.
  webSignedIn: boolean;
  // True when Steam is running and currently signed in as this account.
  steamSignedIn: boolean;
  // True when a refresh token for this account is stored in the encrypted vault.
  loginSaved: boolean;
}

export interface CooldownProgress {
  // What is running: a cooldown check, a Steam sync, or nothing.
  kind: "idle" | "refresh" | "sync";
  running: boolean;
  // Accounts finished out of the total in the current run. total is 0 until it is known.
  done: number;
  total: number;
  currentName: string | null;
  // The step in progress, e.g. "gingerbottom: applying the saved login".
  phase: string | null;
  // Most recent step results, oldest first.
  log: string[];
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export interface LoginStart {
  pendingId: string;
  // Steam Guard methods Steam needs, e.g. "DeviceCode", "EmailCode",
  // "DeviceConfirmation", "EmailConfirmation". Empty when no code is needed.
  guards: string[];
}

// Mailbox (IMAP) settings used to read the Steam verification code. Not stored.
export interface MailSettings {
  host: string;
  port: number;
  user: string;
  password: string;
}

// Generated for the signup; shown while it is open so the user can review and edit them.
export type SignupMode = "browser" | "embedded";

export interface SignupCredentials {
  username: string;
  password: string;
  mode: SignupMode;
}

export interface SignupStatus {
  open: boolean;
  message: string | null;
}

export type DisplayStatus =
  | { kind: "unknown"; detail: string }
  | { kind: "blocked"; until: Date }
  | { kind: "expired"; until: Date }
  | { kind: "clear"; detail: string };

// idle: nothing to show. available: a newer release exists. downloading: fetching it.
// downloaded: ready to install on restart.
export interface UpdateStatus {
  state: "idle" | "available" | "downloading" | "downloaded";
  version: string | null;
  percent: number;
}

export interface SahApi {
  listAccounts(): Promise<Account[]>;
  addAccount(input: { steamId64: string }): Promise<Account[]>;
  importRemembered(): Promise<Account[]>;
  removeAccount(id: string): Promise<Account[]>;
  setManual(id: string, expiresAtIso: string): Promise<Account[]>;
  clearCooldown(id: string): Promise<Account[]>;
  refreshCooldown(id: string): Promise<Account[]>;
  refreshAllCooldowns(): Promise<Account[]>;
  webSignIn(id: string): Promise<{ message: string; accounts: Account[] }>;
  signIn(steamId64: string): Promise<{ message: string }>;
  vaultStatus(): Promise<VaultStatus>;
  vaultSetup(password: string): Promise<{ recoveryCode: string; status: VaultStatus }>;
  vaultUnlock(password: string): Promise<VaultStatus>;
  vaultUnlockRecovery(code: string): Promise<VaultStatus>;
  vaultLock(): Promise<VaultStatus>;
  // accountId is omitted when the sign-in adds a new account.
  loginStart(input: { accountId?: string; accountName: string; password: string }): Promise<LoginStart>;
  loginCode(input: { pendingId: string; code: string }): Promise<{ ok: true }>;
  loginFinish(input: { pendingId: string; accountId?: string }): Promise<{ message: string; accounts: Account[] }>;
  signupOpen(input: { email: string; mode: SignupMode; mail: MailSettings }): Promise<SignupCredentials>;
  signupStatus(): Promise<SignupStatus>;
  signupComplete(input: { username: string; password: string }): Promise<LoginStart>;
  signupCancel(): Promise<{ ok: true }>;
  getUpdateStatus(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<{ ok: true }>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  onAccountsChanged(callback: (accounts: Account[]) => void): () => void;
  getCooldownProgress(): Promise<CooldownProgress>;
  onCooldownProgress(callback: (progress: CooldownProgress) => void): () => void;
  minimizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  revealWindow(): Promise<void>;
  openPanel(id: string): Promise<void>;
  closePanel(): Promise<void>;
  onPanelSelect(callback: (id: string) => void): () => void;
  onPanelClosed(callback: () => void): () => void;
}

declare global {
  interface Window {
    sah: SahApi;
  }
}
