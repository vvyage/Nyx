import { useEffect, useMemo, useState } from "react";
import type { Account, CooldownProgress, LoginStart, SignupCredentials, SignupMode, UpdateStatus, VaultStatus } from "./types";
import { MAIL_PRESETS, presetForEmail } from "./mailPresets";
import { displayStatus } from "./status";
import { VaultSetup, VaultUnlock } from "./Vault";
import { AccountWindow } from "./AccountPanel";
import { Avatar, Badge, Count, Frame, Pill, errorText, isClear, signInBlock } from "./shared";
import { Icon } from "./Icon";

// The same bundle serves the main window and the attached account panel (?panel=<id>).
const panelId = new URLSearchParams(window.location.search).get("panel");

export function App() {
  if (panelId) {
    return (
      <Frame title="Account" draggable={false} minimizable={false} closable={false}>
        <AccountWindow initialId={panelId} />
      </Frame>
    );
  }
  return <MainApp />;
}

// Shows the vault setup or unlock screen until the vault is open, then the dashboard.
function MainApp() {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  useEffect(() => {
    window.sah.vaultStatus().then(setVault).catch(() => setVault({ exists: true, unlocked: false }));
  }, []);

  if (!vault) return <Frame><div className="gate" /></Frame>;
  if (!vault.exists) return <Frame><VaultSetup onDone={setVault} /></Frame>;
  if (!vault.unlocked) return <Frame><VaultUnlock onDone={setVault} /></Frame>;
  return (
    <Frame>
      <Dashboard
        onLock={async () => {
          setVault(await window.sah.vaultLock());
        }}
      />
    </Frame>
  );
}

function rank(status: ReturnType<typeof displayStatus>): number {
  if (status.kind === "blocked") return 0;
  if (status.kind === "unknown") return 1;
  return 2;
}

function Dashboard({ onLock }: { onLock: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [now, setNow] = useState(() => new Date());
  // The account whose panel is open in the attached window.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Update found by the main process (packaged builds only).
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle", version: null, percent: 0 });
  // Add-account card: closed by default, with a SteamID tab and a sign-in tab.
  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState<"id" | "login" | "create">("id");
  const [steamId64, setSteamId64] = useState("");
  // Add-with-login form state.
  const [newLoginName, setNewLoginName] = useState("");
  const [newLoginPassword, setNewLoginPassword] = useState("");
  const [newLoginGuard, setNewLoginGuard] = useState<LoginStart | null>(null);
  const [newGuardCode, setNewGuardCode] = useState("");
  // Assisted signup form state. The mailbox password is cleared after the signup opens.
  const [signupEmail, setSignupEmail] = useState("");
  const [signupMode, setSignupMode] = useState<SignupMode>("embedded");
  const [signupPreset, setSignupPreset] = useState("custom");
  const [signupMailHost, setSignupMailHost] = useState("");
  const [signupMailPort, setSignupMailPort] = useState("993");
  const [signupMailUser, setSignupMailUser] = useState("");
  const [signupMailPassword, setSignupMailPassword] = useState("");
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
    window.sah.getUpdateStatus().then(setUpdate).catch(() => {});
    const offUpdate = window.sah.onUpdateStatus(setUpdate);
    window.sah.listAccounts().then(setAccounts).catch((e: Error) => setError(e.message));
    // Automatic reads push fresh accounts from the main process.
    const offAccounts = window.sah.onAccountsChanged(setAccounts);
    // Progress for both manual and automatic refreshes. Read the current state too, in
    // case a refresh started before this view mounted.
    window.sah.getCooldownProgress().then(setProgress).catch(() => {});
    const offProgress = window.sah.onCooldownProgress(setProgress);
    // Closing the panel window clears the selection.
    const offPanelClosed = window.sah.onPanelClosed(() => setSelectedId(null));
    return () => {
      offUpdate();
      offAccounts();
      offProgress();
      offPanelClosed();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

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

  async function addAccount() {
    const id = steamId64.trim();
    if (await run(() => window.sah.addAccount({ steamId64: id }))) {
      setSteamId64("");
      setAddOpen(false);
    }
  }

  async function syncFromSteam() {
    if (await run(() => window.sah.importRemembered())) {
      setNotice("Synced accounts from Steam.");
    }
  }

  // Available: download. Downloaded: restart and install. Errors show in the banner.
  async function updateClicked() {
    try {
      setError(null);
      if (update.state === "downloaded") {
        await window.sah.installUpdate();
        return;
      }
      await window.sah.downloadUpdate();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function refreshAll() {
    if (await run(() => window.sah.refreshAllCooldowns())) {
      setNotice("Cooldowns refreshed for accounts with a web session.");
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
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const start = await window.sah.loginStart({
        accountName: newLoginName.trim(),
        password: newLoginPassword,
      });
      setNewLoginPassword("");
      if (start.guards.some((g) => g === "DeviceCode" || g === "EmailCode")) {
        setNewLoginGuard(start);
        setNotice(
          start.guards.includes("EmailCode")
            ? "Enter the Steam Guard code from the email Steam sent."
            : "Enter the code from your Steam mobile app.",
        );
        return;
      }
      if (start.guards.length > 0) setNotice("Approve the sign-in in your Steam mobile app.");
      await finishAddWithLogin(start.pendingId);
    } catch (e) {
      setNewLoginPassword("");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitNewGuardCode() {
    if (!newLoginGuard) return;
    setBusy(true);
    setError(null);
    try {
      await window.sah.loginCode({ pendingId: newLoginGuard.pendingId, code: newGuardCode.trim() });
      await finishAddWithLogin(newLoginGuard.pendingId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Ends the signup view and drops the credentials from renderer state.
  function clearSignupView() {
    setSignup(null);
    setSignupUser("");
    setSignupPass("");
    setSignupMessage(null);
  }

  // Changing the email suggests a mail server when the domain is a known provider.
  function changeSignupEmail(value: string) {
    setSignupEmail(value);
    const preset = presetForEmail(value.trim());
    if (preset) {
      setSignupPreset(preset.id);
      setSignupMailHost(preset.host);
      setSignupMailPort(String(preset.port));
    }
  }

  function choosePreset(id: string) {
    setSignupPreset(id);
    const preset = MAIL_PRESETS.find((p) => p.id === id);
    if (preset) {
      setSignupMailHost(preset.host);
      setSignupMailPort(String(preset.port));
    }
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text).catch(() => setError("Could not copy to the clipboard."));
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
          host: signupMailHost.trim(),
          port: Number(signupMailPort) || 993,
          user: signupMailUser.trim(),
          password: signupMailPassword,
        },
      });
      setSignup(creds);
      setSignupUser(creds.username);
      setSignupPass(creds.password);
      setSignupMessage("Opening Steam's signup page...");
      if (creds.mode === "browser") copyText(signupEmail.trim());
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
    setError(null);
    setNotice(null);
    try {
      const start = await window.sah.signupComplete({ username: signupUser.trim(), password: signupPass });
      clearSignupView();
      if (start.guards.some((g) => g === "DeviceCode" || g === "EmailCode")) {
        setNewLoginGuard(start);
        setNotice(
          start.guards.includes("EmailCode")
            ? "Enter the Steam Guard code from the email Steam sent."
            : "Enter the code from your Steam mobile app.",
        );
        return;
      }
      if (start.guards.length > 0) setNotice("Approve the sign-in in your Steam mobile app.");
      await finishAddWithLogin(start.pendingId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function lockVault() {
    setBusy(true);
    try {
      await window.sah.vaultLock();
      onLock();
    } finally {
      setBusy(false);
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
          {update.state === "available" && (
            <button className="update-btn" onClick={updateClicked} title={`Download Nyx ${update.version}`}>
              Update to {update.version}
            </button>
          )}
          {update.state === "downloading" && (
            <button className="update-btn" disabled title="Downloading the update">
              Downloading {update.percent}%
            </button>
          )}
          {update.state === "downloaded" && (
            <button className="update-btn" onClick={updateClicked} title="Close Nyx and install the update">
              Restart to update
            </button>
          )}
          <button
            className={`icon-btn${refreshing ? " spin" : ""}`}
            title={refreshing ? checkingLabel : "Refresh cooldowns"}
            aria-label="Refresh cooldowns"
            onClick={refreshAll}
            disabled={busy || progress.running}
          >
            <Icon name="refresh" />
          </button>
          <button
            className={`icon-btn${syncing ? " bob" : ""}`}
            title={syncing ? "Syncing from Steam..." : "Sync from Steam"}
            aria-label="Sync from Steam"
            onClick={syncFromSteam}
            disabled={busy || progress.running}
          >
            <Icon name="download" />
          </button>
          <button
            className={`icon-btn${addOpen ? " active" : ""}`}
            title="Add account"
            aria-label="Add account"
            onClick={() => setAddOpen((open) => !open)}
          >
            <Icon name="userPlus" />
          </button>
          <button className="icon-btn" title="Lock vault" aria-label="Lock vault" onClick={lockVault} disabled={busy}>
            <Icon name="lock" />
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

      {addOpen && (
        <section className="add-card">
          <div className="tabs">
            <button className={addTab === "id" ? "tab active" : "tab"} onClick={() => setAddTab("id")}>
              SteamID64
            </button>
            <button className={addTab === "login" ? "tab active" : "tab"} onClick={() => setAddTab("login")}>
              Sign in
            </button>
            <button className={addTab === "create" ? "tab active" : "tab"} onClick={() => setAddTab("create")}>
              Create
            </button>
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
                  <button className="ghost" onClick={() => copyText(signupUser)} disabled={!signupUser}>
                    Copy
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
                  <button className="ghost" onClick={() => copyText(signupPass)} disabled={!signupPass}>
                    Copy
                  </button>
                </div>
                <p className="muted small">{signupMessage ?? "Working..."}</p>
                <div className="row">
                  <button onClick={finishSignup} disabled={busy || !signupUser.trim() || !signupPass}>
                    <Icon name="check" />
                    Account created, sign in
                  </button>
                  <button className="ghost" onClick={() => copyText(signupEmail.trim())} disabled={busy}>
                    Copy email
                  </button>
                  <button className="ghost" onClick={cancelSignup} disabled={busy}>
                    Cancel signup
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="tabs">
                  <button
                    className={signupMode === "browser" ? "tab active" : "tab"}
                    onClick={() => setSignupMode("browser")}
                    disabled={!!signup}
                  >
                    Default browser
                  </button>
                  <button
                    className={signupMode === "embedded" ? "tab active" : "tab"}
                    onClick={() => setSignupMode("embedded")}
                    disabled={!!signup}
                  >
                    App window
                  </button>
                </div>
                <div className="row">
                  <input
                    type="email"
                    placeholder="Email for the new account"
                    value={signupEmail}
                    onChange={(e) => changeSignupEmail(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="row">
                  <select value={signupPreset} onChange={(e) => choosePreset(e.target.value)}>
                    {MAIL_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">Custom server</option>
                  </select>
                  <input
                    placeholder="Mail server (IMAP), e.g. imap.gmail.com"
                    value={signupMailHost}
                    onChange={(e) => {
                      setSignupMailHost(e.target.value);
                      setSignupPreset("custom");
                    }}
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
                <div className="row">
                  <input
                    placeholder="Mailbox login"
                    value={signupMailUser}
                    onChange={(e) => setSignupMailUser(e.target.value)}
                    autoComplete="off"
                  />
                  <input
                    type="password"
                    placeholder="Mailbox password (not stored)"
                    value={signupMailPassword}
                    onChange={(e) => setSignupMailPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  <button
                    disabled={
                      busy ||
                      !signupEmail.trim() ||
                      !signupMailHost.trim() ||
                      !signupMailUser.trim() ||
                      !signupMailPassword
                    }
                    onClick={openSignup}
                  >
                    <Icon name="userPlus" />
                    Open signup
                  </button>
                </div>
                {(signupPreset === "gmail" || signupMailHost.trim().toLowerCase() === "imap.gmail.com") && (
                  <p className="muted small">
                    Gmail requires an app password (16 characters, needs 2-Step Verification on the account), not your normal Google password.
                  </p>
                )}
              </>
            )
          ) : addTab === "id" ? (
            <>
              <div className="row">
                <input
                  placeholder="SteamID64 or steamcommunity.com/profiles/... link"
                  value={steamId64}
                  onChange={(e) => setSteamId64(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && steamId64.trim() && !busy && addAccount()}
                />
                <button onClick={addAccount} disabled={busy || !steamId64.trim()}>
                  <Icon name="plus" />
                  Add
                </button>
              </div>
            </>
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
                placeholder="Password (not stored)"
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
          <p className="muted small">
            {addTab === "id"
              ? "Adds an account by its SteamID64 or profile link."
              : addTab === "create"
                ? "Generates a username and password, opens Steam's signup page, and watches your mailbox for Steam's confirmation email, then opens its link. You fill the form, solve the CAPTCHA, and choose to create a new account. Edit the name and password if Steam changed them. The mailbox password is not stored."
                : "The password is not stored. Only a refresh token is kept in the encrypted vault."}
          </p>
        </section>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          <Icon name="monitor" size={28} />
          <p>No accounts yet. Use Sync from Steam or add one by SteamID64.</p>
        </div>
      ) : (
        <div className="grid">
          {rows.map(({ account, status }) => (
            <article
              key={account.id}
              className={`card ${status.kind} ${account.id === selectedId ? "selected" : ""}`}
              onClick={() => openAccount(account.id)}
            >
              <div className="card-head">
                <Avatar url={account.avatarUrl} name={account.displayName} size="sm" />
                <div className="card-title">
                  <span className="name">{account.displayName}</span>
                  <span className="sid">{account.steamId64}</span>
                </div>
                <Pill status={status} now={now} />
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
                <Badge
                  icon="globe"
                  label="Web"
                  state={account.webSignedIn ? "on" : "off"}
                  title={account.webSignedIn ? "Web session saved" : "No web session"}
                />
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
