import { useEffect, useMemo, useState } from "react";
import type { Account, AppSettings, Cs2TabId, CooldownProgress, LoginStart, SavedMail, SignupCredentials, SignupMode, VaultStatus } from "./types";
import { presetForEmail } from "./mailPresets";
import { displayStatus } from "./status";
import { VaultSetup, VaultUnlock } from "./Vault";
import { AccountWindow } from "./AccountPanel";
import { Cs2Window, cs2TabFrom } from "./Cs2Window";
import { Avatar, Badge, Count, Frame, Pill, UpdateButton, errorText, guardNotice, isClear, signInBlock, signInHint, useCooldownClock } from "./shared";
import { Icon } from "./Icon";

// The same bundle serves the main window, the attached account panel (?panel=<id>), and the
// attached CS2 settings window (?cs2=<id>).
const params = new URLSearchParams(window.location.search);
const panelId = params.get("panel");
const cs2Id = params.get("cs2");

// Shown over the add card while a Steam sign-in runs. A Steam Guard email can add a wait of up to a minute.
const SIGNING_IN_MESSAGE = "Signing in to Steam. This can take up to a minute.";

export function App() {
  if (panelId) {
    return (
      <Frame title="Account" groupDrag minimizable={false}>
        <AccountWindow initialId={panelId} />
      </Frame>
    );
  }
  if (cs2Id) {
    return (
      <Frame title="CS2 settings">
        <Cs2Window initialId={cs2Id} initialTab={cs2TabFrom(params.get("tab"))} />
      </Frame>
    );
  }
  return <MainApp />;
}

// Time for the frame to grow from the vault box to the full window. Matches the .window transition.
const GROW_MS = 320;

// Shows the vault setup or unlock screen until the vault is open, then the dashboard.
// The vault screens are a centred box. Unlocking grows the box to the full window (CSS transition),
// then the dashboard replaces the vault screen.
function MainApp() {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  // False while the vault screens are shown as a box. Set on unlock to start the grow.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    window.sah.vaultStatus().then(setVault).catch(() => setVault({ exists: true, unlocked: false }));
  }, []);

  function onVaultOpened(status: VaultStatus) {
    if (!status.unlocked) return setVault(status);
    // The window grows to dashboard size at once; the box stays centred and CSS grows it to fill.
    window.sah.setMainBoxed(false).catch(() => undefined);
    setExpanded(true);
    window.setTimeout(() => setVault(status), GROW_MS);
  }

  if (!vault) return <Frame showVersion boxed><div className="gate" /></Frame>;
  if (!vault.exists) {
    return (
      <Frame showVersion boxed={!expanded}>
        <VaultSetup onDone={onVaultOpened} />
      </Frame>
    );
  }
  if (!vault.unlocked) {
    return (
      <Frame showVersion boxed={!expanded}>
        <VaultUnlock onDone={onVaultOpened} />
      </Frame>
    );
  }
  return (
    <Frame showVersion>
      <Dashboard />
    </Frame>
  );
}

function rank(status: ReturnType<typeof displayStatus>): number {
  if (status.kind === "blocked") return 0;
  if (status.kind === "unknown") return 1;
  return 2;
}

function Dashboard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const now = useCooldownClock(accounts);
  // The account whose panel is open in the attached window.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The card whose CS2 options menu is open, or null.
  const [cs2MenuId, setCs2MenuId] = useState<string | null>(null);
  // Add-account card: closed by default, with a sign-in tab and a create tab.
  const [addOpen, setAddOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  // Notification preferences, loaded once. Null until the saved values arrive.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [addTab, setAddTab] = useState<"login" | "create">("create");
  // Set while a sign-in runs: shown on the add card in place of the form. Null when idle.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  // Add-with-login form state.
  const [newLoginName, setNewLoginName] = useState("");
  const [newLoginPassword, setNewLoginPassword] = useState("");
  const [newLoginGuard, setNewLoginGuard] = useState<LoginStart | null>(null);
  const [newGuardCode, setNewGuardCode] = useState("");
  // Assisted signup form state. The mailbox password is cleared after the signup opens.
  const [signupEmail, setSignupEmail] = useState("");
  const [signupMode, setSignupMode] = useState<SignupMode>("embedded");
  // The mail server fields appear only after the email field loses focus, and only for
  // a valid address whose domain is not a known provider.
  const [signupEmailDone, setSignupEmailDone] = useState(false);
  const [signupMailHost, setSignupMailHost] = useState("");
  const [signupMailPort, setSignupMailPort] = useState("993");
  const [signupMailUser, setSignupMailUser] = useState("");
  const [signupMailPassword, setSignupMailPassword] = useState("");
  // Mailbox settings saved in the vault (without the password), and whether to save the next ones.
  const [savedMail, setSavedMail] = useState<SavedMail | null>(null);
  const [saveMailChoice, setSaveMailChoice] = useState(false);
  // The open signup. Username and password are editable, so they are kept apart from it.
  const [signup, setSignup] = useState<SignupCredentials | null>(null);
  const [signupUser, setSignupUser] = useState("");
  const [signupPass, setSignupPass] = useState("");
  const [signupMessage, setSignupMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<CooldownProgress>({
    kind: "idle",
    running: false,
    done: 0,
    total: 0,
    currentName: null,
    phase: null,
    log: [],
  });

  useEffect(() => {
    window.sah.listAccounts().then(setAccounts).catch((e: Error) => setError(e.message));
    // Fill the signup mailbox from the vault. The saved password is used when the field is blank.
    window.sah
      .getMailSettings()
      .then((saved) => {
        if (!saved) return;
        setSavedMail(saved);
        setSignupEmail(saved.email);
        setSignupEmailDone(true);
        setSignupMailHost(saved.host);
        setSignupMailPort(String(saved.port));
        setSignupMailUser(saved.user);
      })
      .catch(() => {});
    // Automatic reads push fresh accounts from the main process.
    const offAccounts = window.sah.onAccountsChanged(setAccounts);
    // Progress for both manual and automatic refreshes. Read the current state too, in
    // case a refresh started before this view mounted.
    window.sah.getCooldownProgress().then(setProgress).catch(() => {});
    const offProgress = window.sah.onCooldownProgress(setProgress);
    // Closing the panel window clears the selection.
    const offPanelClosed = window.sah.onPanelClosed(() => setSelectedId(null));
    // Results of background tasks, such as the CS2 license request after a signup.
    const offNotice = window.sah.onNotice((text) => setNotice(text));
    return () => {
      offAccounts();
      offProgress();
      offPanelClosed();
      offNotice();
    };
  }, []);

  // Closes the CS2 options menu on a click outside it.
  useEffect(() => {
    if (!cs2MenuId) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest(".cs2-menu-wrap")) setCs2MenuId(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [cs2MenuId]);

  const rows = useMemo(
    () =>
      accounts
        .map((account) => ({ account, status: displayStatus(account, now) }))
        .sort((a, b) => rank(a.status) - rank(b.status)),
    [accounts, now],
  );

  const counts = useMemo(() => {
    const result = { blocked: 0, clear: 0, unknown: 0 };
    for (const account of accounts) {
      const status = displayStatus(account, now);
      if (status.kind === "blocked") result.blocked += 1;
      else if (isClear(status)) result.clear += 1;
      else result.unknown += 1;
    }
    return result;
  }, [accounts, now]);

  // Runs an IPC call with busy/error handling. Returns true on success.
  async function run(action: () => Promise<Account[]>): Promise<boolean> {
    setBusy(true);
    try {
      setError(null);
      setAccounts(await action());
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function syncFromSteam() {
    if (await run(() => window.sah.importRemembered())) {
      setNotice("Synced accounts from Steam.");
    }
  }

  async function refreshAll() {
    if (await run(() => window.sah.refreshAllCooldowns())) {
      setNotice("Cooldowns refreshed for accounts with a saved login.");
    }
  }

  // Clicking the open account's card hides the panel; any other card opens its panel.
  function openAccount(id: string) {
    if (id === selectedId) {
      setSelectedId(null);
      window.sah.closePanel().catch((e) => setError(errorText(e)));
      return;
    }
    setSelectedId(id);
    window.sah.openPanel(id).catch((e) => setError(errorText(e)));
  }

  // Runs one entry of the CS2 options menu. Import reads Steam's files directly; the others open the window.
  async function cs2Action(id: string, action: Cs2TabId | "import") {
    setCs2MenuId(null);
    setError(null);
    setNotice(null);
    if (action !== "import") {
      window.sah.cs2Open(id, action).catch((e) => setError(errorText(e)));
      return;
    }
    setBusy(true);
    try {
      await window.sah.cs2Import(id);
      setNotice("Imported the current CS2 settings from Steam.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(account: Account) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sah.signIn(account.steamId64);
      setNotice(result.message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Finishes a sign-in for a new account, then saves its refresh token.
  async function finishAddWithLogin(pendingId: string) {
    const result = await window.sah.loginFinish({ pendingId });
    setAccounts(result.accounts);
    setNotice(result.message);
    setNewLoginName("");
    setNewLoginGuard(null);
    setNewGuardCode("");
    setAddOpen(false);
  }

  async function addWithLogin() {
    setError(null);
    setNotice(null);
    if (/^\d{17}$/.test(newLoginName.trim())) {
      setError("Enter the Steam account name (login name), not the SteamID64.");
      return;
    }
    setBusy(true);
    setSigningIn(SIGNING_IN_MESSAGE);
    try {
      const start = await window.sah.loginStart({
        accountName: newLoginName.trim(),
        password: newLoginPassword,
      });
      setNewLoginPassword("");
      if (start.codeFromMail) {
        await finishAddWithLogin(start.pendingId);
        return;
      }
      if (start.guards.some((g) => g === "DeviceCode" || g === "EmailCode")) {
        setNewLoginGuard(start);
        setNotice(guardNotice(start));
        return;
      }
      if (start.guards.length > 0) setNotice("Approve the sign-in in your Steam mobile app.");
      await finishAddWithLogin(start.pendingId);
    } catch (e) {
      setNewLoginPassword("");
      setError(errorText(e));
    } finally {
      setBusy(false);
      setSigningIn(null);
    }
  }

  async function submitNewGuardCode() {
    if (!newLoginGuard) return;
    setBusy(true);
    setSigningIn("Checking the Steam Guard code...");
    setError(null);
    try {
      await window.sah.loginCode({ pendingId: newLoginGuard.pendingId, code: newGuardCode.trim() });
      await finishAddWithLogin(newLoginGuard.pendingId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setSigningIn(null);
    }
  }

  // Ends the signup view and drops the credentials from renderer state.
  function clearSignupView() {
    setSignup(null);
    setSignupUser("");
    setSignupPass("");
    setSignupMessage(null);
  }

  async function copySignupValue(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${what} copied.`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // Editing the email hides the mail server fields until the field loses focus again.
  function changeSignupEmail(value: string) {
    setSignupEmail(value);
    setSignupEmailDone(false);
  }

  // Mail server settings: a known provider is looked up from the email domain; any other
  // valid address uses the server fields the user fills in.
  const signupEmailValid = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(signupEmail.trim());
  const signupKnownPreset = signupEmailDone && signupEmailValid ? presetForEmail(signupEmail.trim()) : null;
  const signupShowCustomMail = signupEmailDone && signupEmailValid && !signupKnownPreset;
  const signupHost = signupKnownPreset ? signupKnownPreset.host : signupMailHost.trim();
  const signupPort = signupKnownPreset ? signupKnownPreset.port : Number(signupMailPort) || 993;

  async function forgetMail() {
    try {
      await window.sah.clearMailSettings();
      setSavedMail(null);
      setNotice("Saved mailbox login removed.");
    } catch (e) {
      setError(errorText(e));
    }
  }

  // Opens Steam's signup page in the chosen mode. The generated credentials are shown,
  // editable, until the signup ends.
  async function openSignup() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const creds = await window.sah.signupOpen({
        email: signupEmail.trim(),
        mode: signupMode,
        mail: {
          host: signupHost,
          port: signupPort,
          user: signupMailUser.trim(),
          password: signupMailPassword,
        },
      });
      setSignup(creds);
      setSignupUser(creds.username);
      setSignupPass(creds.password);
      if (saveMailChoice && signupMailPassword) {
        const mail = {
          host: signupHost,
          port: signupPort,
          user: signupMailUser.trim(),
        };
        await window.sah.saveMailSettings({ email: signupEmail.trim(), mail: { ...mail, password: signupMailPassword } });
        setSavedMail({ email: signupEmail.trim(), ...mail });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSignupMailPassword("");
      setBusy(false);
    }
  }

  // Keeps the on-screen status in step with the main process. Ends the view when the signup
  // is cancelled, completed, or times out.
  useEffect(() => {
    if (!signup) return;
    let active = true;
    const timer = setInterval(() => {
      window.sah
        .signupStatus()
        .then((status) => {
          if (!active) return;
          if (!status.open) {
            clearSignupView();
            return;
          }
          setSignupMessage(status.message);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // clearSignupView only sets state, so it does not need to re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signup]);

  async function cancelSignup() {
    setBusy(true);
    try {
      await window.sah.signupCancel();
    } catch (e) {
      setError(errorText(e));
    } finally {
      clearSignupView();
      setBusy(false);
    }
  }

  // Called after the user has created the account on Steam's page. Starts the sign-in with the
  // username and password in the card (which the user may have edited), then continues with
  // the usual Steam Guard step.
  async function finishSignup() {
    setBusy(true);
    setSigningIn(SIGNING_IN_MESSAGE);
    setError(null);
    setNotice(null);
    try {
      const start = await window.sah.signupComplete({ username: signupUser.trim(), password: signupPass });
      clearSignupView();
      if (start.codeFromMail) {
        await finishAddWithLogin(start.pendingId);
        return;
      }
      if (start.guards.some((g) => g === "DeviceCode" || g === "EmailCode")) {
        setNewLoginGuard(start);
        setNotice(guardNotice(start));
        return;
      }
      if (start.guards.length > 0) setNotice("Approve the sign-in in your Steam mobile app.");
      await finishAddWithLogin(start.pendingId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setSigningIn(null);
    }
  }

  // Saves one notification preference. The switch changes at once and is reverted if saving fails.
  async function changeSetting(key: keyof AppSettings, value: boolean) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, [key]: value });
    try {
      setSettings(await window.sah.saveSettings({ [key]: value }));
    } catch (err) {
      setSettings(previous);
      setError(errorText(err));
    }
  }

  const refreshing = progress.running && progress.kind === "refresh";
  const syncing = progress.running && progress.kind === "sync";
  const checkingLabel = `Checking ${progress.done} of ${progress.total}`;

  // The window tints by activity: orange while checking cooldowns, deep blue while syncing.
  useEffect(() => {
    const activity = progress.running ? progress.kind : "idle";
    document.documentElement.dataset.activity = activity;
    return () => {
      delete document.documentElement.dataset.activity;
    };
  }, [progress.running, progress.kind]);

  return (
    <div className="shell">
      <div className="toolbar">
        <div className="counts">
          <Count icon="clock" value={counts.blocked} label="cooldown" tone="warn" />
          <Count icon="check" value={counts.clear} label="clear" tone="ok" />
          <Count icon="help" value={counts.unknown} label="unknown" tone="muted" />
        </div>
        <div className="actions">
          <UpdateButton onError={setError} />
          <button
            className={`icon-btn labelled${notifyOpen ? " active" : ""}`}
            title="Notifications"
            aria-label="Notifications"
            onClick={() => {
              setNotifyOpen((open) => !open);
              if (!settings) window.sah.getSettings().then(setSettings).catch(() => undefined);
            }}
          >
            <Icon name="bell" />
            <span>Notifications</span>
          </button>
          <button
            className={`icon-btn labelled${refreshing ? " spin" : ""}`}
            title={refreshing ? checkingLabel : "Refresh cooldowns"}
            aria-label="Refresh cooldowns"
            onClick={refreshAll}
            disabled={busy || progress.running}
          >
            <Icon name="refresh" />
            <span>Refresh cooldowns</span>
          </button>
          <button
            className={`icon-btn labelled${syncing ? " bob" : ""}`}
            title={syncing ? "Syncing from Steam..." : "Sync from Steam"}
            aria-label="Sync from Steam"
            onClick={syncFromSteam}
            disabled={busy || progress.running}
          >
            <Icon name="download" />
            <span>Sync from Steam</span>
          </button>
          <button
            className={`icon-btn labelled${addOpen ? " active" : ""}`}
            title="Add account"
            aria-label="Add account"
            onClick={() => setAddOpen((open) => !open)}
          >
            <Icon name="userPlus" />
            <span>Add account</span>
          </button>
        </div>
      </div>

      {progress.running && (
        <div className={`banner progress ${progress.kind}`} role="status" aria-live="polite">
          <div className="progress-head">
            <span className="progress-title">{syncing ? "Syncing from Steam" : "Checking cooldowns"}</span>
            {progress.total > 0 && (
              <span className="progress-count">
                {progress.done} of {progress.total}
              </span>
            )}
          </div>
          <span className="progress-phase">{progress.phase ?? "Working..."}</span>
          <div className={`progress-track${progress.total ? "" : " indeterminate"}`} aria-hidden="true">
            <div
              className="progress-fill"
              style={progress.total ? { width: `${(progress.done / progress.total) * 100}%` } : undefined}
            />
          </div>
          {progress.log.length > 0 && (
            <ol className="progress-log">
              {progress.log.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ol>
          )}
        </div>
      )}

      {(error || notice) && (
        <div className={error ? "banner error" : "banner"}>
          <span>{error ?? notice}</span>
          <button
            className="icon-btn small"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {notifyOpen && (
        <section className="add-card" aria-label="Notifications">
          <p className="muted small">Windows notifications. Both are off until you turn them on.</p>
          <label className="check">
            <input
              type="checkbox"
              checked={settings?.notifyCooldownEnd ?? false}
              disabled={!settings}
              onChange={(e) => changeSetting("notifyCooldownEnd", e.target.checked)}
            />
            Notify when a cooldown ends
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings?.notifyCheckFailed ?? false}
              disabled={!settings}
              onChange={(e) => changeSetting("notifyCheckFailed", e.target.checked)}
            />
            Notify when a cooldown check fails
          </label>
        </section>
      )}

      {addOpen && (
        <section className={`add-card${signingIn ? " busy" : ""}`} aria-busy={signingIn ? true : undefined}>
          {signingIn && (
            <div className="busy-overlay" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span>{signingIn}</span>
            </div>
          )}
          <div className="add-head">
            <div className="tabs">
              <button className={addTab === "login" ? "tab active" : "tab"} onClick={() => setAddTab("login")}>
                Sign in
              </button>
              <button className={addTab === "create" ? "tab active" : "tab"} onClick={() => setAddTab("create")}>
                Create
              </button>
            </div>
            {addTab === "create" && !newLoginGuard && !signup && (
              <div className="seg" role="group" aria-label="Signup window">
                <button
                  className={signupMode === "browser" ? "on" : ""}
                  aria-pressed={signupMode === "browser"}
                  onClick={() => setSignupMode("browser")}
                >
                  In-Browser
                </button>
                <button
                  className={signupMode === "embedded" ? "on" : ""}
                  aria-pressed={signupMode === "embedded"}
                  onClick={() => setSignupMode("embedded")}
                >
                  Pop-Up Window
                </button>
              </div>
            )}
          </div>

          {newLoginGuard ? (
            <div className="row">
              <input
                placeholder="Steam Guard code"
                value={newGuardCode}
                onChange={(e) => setNewGuardCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && newGuardCode.trim() && submitNewGuardCode()}
              />
              <button onClick={submitNewGuardCode} disabled={busy || !newGuardCode.trim()}>
                <Icon name="check" />
                Submit code
              </button>
            </div>
          ) : addTab === "create" ? (
            signup ? (
              <>
                <div className="row">
                  <input
                    placeholder="Account name"
                    value={signupUser}
                    onChange={(e) => setSignupUser(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    className="ghost icon-only"
                    title="Copy account name"
                    aria-label="Copy account name"
                    disabled={!signupUser}
                    onClick={() => copySignupValue(signupUser, "Account name")}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </div>
                <div className="row">
                  <input
                    placeholder="Password"
                    value={signupPass}
                    onChange={(e) => setSignupPass(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    className="ghost icon-only"
                    title="Copy password"
                    aria-label="Copy password"
                    disabled={!signupPass}
                    onClick={() => copySignupValue(signupPass, "Password")}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </div>
                {signupMessage && <p className="warn-text small">{signupMessage}</p>}
                <div className="row">
                  <button onClick={finishSignup} disabled={busy || !signupUser.trim() || !signupPass}>
                    <Icon name="logIn" />
                    Sign in now
                  </button>
                  <button className="ghost" onClick={cancelSignup} disabled={busy}>
                    Cancel signup
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="row">
                  <input
                    type="email"
                    placeholder="Email for the new account"
                    value={signupEmail}
                    onChange={(e) => changeSignupEmail(e.target.value)}
                    onBlur={() => setSignupEmailDone(true)}
                    autoComplete="off"
                  />
                </div>
                {signupShowCustomMail && (
                  <div className="row">
                    <input
                      placeholder="Mail server (IMAP), e.g. imap.example.com"
                      value={signupMailHost}
                      onChange={(e) => setSignupMailHost(e.target.value)}
                      autoComplete="off"
                    />
                    <input
                      className="narrow"
                      placeholder="Port"
                      value={signupMailPort}
                      onChange={(e) => setSignupMailPort(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                )}
                <div className="row">
                  <input
                    placeholder="Mailbox login"
                    value={signupMailUser}
                    onChange={(e) => setSignupMailUser(e.target.value)}
                    autoComplete="off"
                  />
                  <input
                    type="password"
                    placeholder={savedMail ? "Saved in vault (leave blank to use it)" : "Mailbox or app password"}
                    value={signupMailPassword}
                    onChange={(e) => setSignupMailPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  <button
                    disabled={
                      busy ||
                      !signupEmailValid ||
                      !signupHost ||
                      !signupMailUser.trim() ||
                      (!signupMailPassword && !savedMail)
                    }
                    title="Makes a login, opens Steam's signup, and reads the confirmation email from your mailbox"
                    onClick={openSignup}
                  >
                    <Icon name="userPlus" />
                    Open signup
                  </button>
                </div>
                <div className="add-foot">
                  {savedMail ? (
                    <span className="chip" title={`Mailbox ${savedMail.email}. The password comes from the vault.`}>
                      <Icon name="key" size={12} />
                      Saved mailbox
                    </span>
                  ) : (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={saveMailChoice}
                        onChange={(e) => setSaveMailChoice(e.target.checked)}
                      />
                      Save mailbox in vault
                    </label>
                  )}
                  {signupEmailDone && signupKnownPreset?.id === "gmail" && (
                    <span
                      className="muted"
                      title="Gmail needs a 16-character app password (2-Step Verification must be on), not your Google password"
                    >
                      Gmail: app password
                    </span>
                  )}
                  {savedMail && (
                    <button className="ghost small" onClick={forgetMail} disabled={busy}>
                      Forget
                    </button>
                  )}
                </div>
              </>
            )
          ) : (
            <div className="row">
              <input
                placeholder="Steam account name"
                value={newLoginName}
                onChange={(e) => setNewLoginName(e.target.value)}
                autoComplete="off"
              />
              <input
                type="password"
                placeholder="Password"
                title="Not stored. Only a refresh token is kept in the encrypted vault."
                value={newLoginPassword}
                onChange={(e) => setNewLoginPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && newLoginName.trim() && newLoginPassword && addWithLogin()}
                autoComplete="new-password"
              />
              <button disabled={busy || !newLoginName.trim() || !newLoginPassword} onClick={addWithLogin}>
                <Icon name="logIn" />
                Sign in
              </button>
            </div>
          )}
        </section>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          <p>No accounts yet. Sync from Steam or add an account.</p>
        </div>
      ) : (
        <div className="grid">
          {rows.map(({ account, status }) => (
            <article
              key={account.id}
              className={`card ${status.kind}${account.id === selectedId ? " selected" : ""}${cs2MenuId === account.id ? " menu-open" : ""}`}
              onClick={() => openAccount(account.id)}
            >
              <div className="card-head">
                <Avatar url={account.avatarUrl} name={account.displayName} size="sm" />
                <div className="card-title">
                  <span className="name">{account.displayName}</span>
                  <span className="sid">{account.steamId64}</span>
                </div>
                <Pill status={status} />
              </div>
              <div className="card-foot">
                <Badge
                  icon="monitor"
                  label={account.steamSignedIn ? "Active" : "Steam"}
                  state={account.steamSignedIn ? "active" : account.steam ? "on" : "off"}
                  title={
                    account.steamSignedIn
                      ? "Steam is signed in as this account"
                      : account.steam
                        ? "Listed in Steam on this machine"
                        : "Not listed in Steam on this machine"
                  }
                />
                <Badge
                  icon="key"
                  label="Login"
                  state={account.loginSaved ? "on" : "off"}
                  title={account.loginSaved ? "Saved login in the vault" : "No saved login"}
                />
                <div className="cs2-menu-wrap" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`icon-btn small${cs2MenuId === account.id ? " active" : ""}`}
                    title="CS2 options"
                    aria-label="CS2 options"
                    aria-haspopup="menu"
                    aria-expanded={cs2MenuId === account.id}
                    onClick={() => setCs2MenuId(cs2MenuId === account.id ? null : account.id)}
                  >
                    <Icon name="settings" size={15} />
                  </button>
                  {cs2MenuId === account.id && (
                    <div className="cs2-menu" role="menu">
                      <button role="menuitem" onClick={() => cs2Action(account.id, "video")}>
                        <Icon name="settings" size={13} />
                        CS2 settings
                      </button>
                      <button role="menuitem" onClick={() => cs2Action(account.id, "import")} disabled={busy}>
                        <Icon name="download" size={13} />
                        Import from Steam
                      </button>
                    </div>
                  )}
                </div>
                {signInHint(account) && (
                  <span className="sign-in-hint" title={signInBlock(account) ?? undefined}>
                    {signInHint(account)}
                  </span>
                )}
                <button
                  className="ghost small sign-in"
                  disabled={busy || !!signInBlock(account)}
                  title={signInBlock(account) ?? "Restart Steam signed in as this account"}
                  onClick={(e) => {
                    e.stopPropagation();
                    signIn(account);
                  }}
                >
                  <Icon name="logIn" size={13} />
                  Sign in
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
