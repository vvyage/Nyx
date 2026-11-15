import { useEffect, useState, type ReactNode } from "react";
import type { Account, Cs2Binding, Cs2State, LoginStart } from "./types";
import { displayStatus, localInputToIso } from "./status";
import { Avatar, DetailStatus, errorText, guardNotice, signInBlock } from "./shared";
import { Icon, type IconName } from "./Icon";

// Root of the attached account panel window. Follows the account the main window selects.
export function AccountWindow({ initialId }: { initialId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState(initialId);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    window.sah
      .listAccounts()
      .then(setAccounts)
      .catch(() => {})
      .finally(() => setLoaded(true));
    const offAccounts = window.sah.onAccountsChanged(setAccounts);
    const offSelect = window.sah.onPanelSelect(setSelectedId);
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => {
      offAccounts();
      offSelect();
      clearInterval(timer);
    };
  }, []);

  if (!loaded) return <div className="panel" />;
  const account = accounts.find((item) => item.id === selectedId) ?? null;
  if (!account) {
    return (
      <div className="panel">
        <p className="empty">This account is no longer tracked.</p>
      </div>
    );
  }
  // key resets the form state when another account is selected.
  return <AccountPanel key={account.id} account={account} now={now} onAccounts={setAccounts} />;
}

// A titled group of related controls in the panel.
function Section({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <section className="sec">
      <div className="sec-head">
        <Icon name={icon} size={14} />
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

// CS2 settings for this account: one import from Steam (confirmed), kept as timestamped backups.
function Cs2Section({ accountId }: { accountId: string }) {
  const [state, setState] = useState<Cs2State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; bindings: Cs2Binding[] } | null>(null);

  useEffect(() => {
    window.sah
      .cs2List(accountId)
      .then(setState)
      .catch((e) => setError(errorText(e)));
  }, [accountId]);

  async function importNow() {
    setBusy(true);
    setError(null);
    try {
      setState(await window.sah.cs2Import(accountId));
      setViewing(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }

  async function view(id: string) {
    setBusy(true);
    setError(null);
    try {
      setViewing({ id, bindings: await window.sah.cs2View(accountId, id) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const latest = state?.snapshots[0] ?? null;
  const backups = state?.snapshots ?? [];

  return (
    <Section icon="key" title="CS2 settings">
      <p className="muted small">
        {latest
          ? `Last imported ${new Date(latest.createdAt).toLocaleString()}${
              latest.bindingCount !== null ? `, ${latest.bindingCount} keybinds` : ""
            }.`
          : "Not imported yet."}
        {state && !state.available && " No CS2 settings for this account on this PC right now."}
      </p>

      {error && <p className="cs2-error small">{error}</p>}

      {confirming ? (
        <div className="cs2-confirm">
          <span>
            Replace the Nyx copy with the current CS2 settings from Steam? The current copy is kept in Backups.
          </span>
          <div className="row">
            <button onClick={importNow} disabled={busy}>
              <Icon name="check" />
              Import
            </button>
            <button className="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => setConfirming(true)} disabled={busy || !state?.available}>
            <Icon name="download" />
            Import from Steam
          </button>
          <button className="ghost" onClick={() => setShowBackups((v) => !v)} disabled={backups.length === 0}>
            Backups ({backups.length})
          </button>
        </div>
      )}

      {showBackups && backups.length > 0 && (
        <ul className="cs2-backups">
          {backups.map((snapshot) => (
            <li key={snapshot.id}>
              <span className="small">
                {new Date(snapshot.createdAt).toLocaleString()}
                {snapshot.bindingCount !== null ? ` · ${snapshot.bindingCount} keybinds` : " · keybinds unreadable"}
              </span>
              <button className="ghost small-btn" disabled={busy} onClick={() => view(snapshot.id)}>
                View
              </button>
            </li>
          ))}
        </ul>
      )}

      {viewing && (
        <div className="cs2-view">
          <div className="row">
            <span className="small">{viewing.bindings.length} keybinds</span>
            <button className="ghost small-btn" onClick={() => setViewing(null)}>
              <Icon name="x" size={12} />
              Close
            </button>
          </div>
          <ul className="cs2-binds">
            {viewing.bindings.map((bind, index) => (
              <li key={`${bind.key}-${index}`}>
                <span>{bind.key}</span>
                <span>{bind.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function AccountPanel({
  account,
  now,
  onAccounts,
}: {
  account: Account;
  now: Date;
  onAccounts: (accounts: Account[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Saved-login form state. The password is cleared after use.
  const [loginName, setLoginName] = useState(account.steam?.accountName ?? "");
  const [loginPassword, setLoginPassword] = useState("");
  // True when the fields were filled with the login generated during signup.
  const [fromSignup, setFromSignup] = useState(false);

  // Fills the form with the signup's generated login, if this account was just created.
  useEffect(() => {
    window.sah
      .getLoginDraft(account.id)
      .then((draft) => {
        if (!draft) return;
        setLoginName(draft.accountName);
        setLoginPassword(draft.password);
        setFromSignup(true);
      })
      .catch(() => undefined);
  }, [account.id]);
  const [loginGuard, setLoginGuard] = useState<LoginStart | null>(null);
  const [guardCode, setGuardCode] = useState("");
  const [manualValue, setManualValue] = useState("");

  // Runs an IPC call with busy/error handling. Returns true on success.
  async function run(action: () => Promise<Account[]>): Promise<boolean> {
    setBusy(true);
    try {
      setError(null);
      onAccounts(await action());
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function refreshOne() {
    if (await run(() => window.sah.refreshCooldown(account.id))) setNotice("Cooldown checked.");
  }

  async function webSignIn() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sah.webSignIn(account.id);
      onAccounts(result.accounts);
      setNotice(result.message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveManual() {
    const iso = localInputToIso(manualValue);
    if (!iso) {
      setError("Enter a valid date and time.");
      return;
    }
    if (await run(() => window.sah.setManual(account.id, iso))) setManualValue("");
  }

  // Finishes a sign-in: waits for Steam, then saves the refresh token in the vault.
  async function finishSavedLogin(pendingId: string) {
    const result = await window.sah.loginFinish({ pendingId, accountId: account.id });
    onAccounts(result.accounts);
    setNotice(result.message);
    setLoginGuard(null);
    setGuardCode("");
    setFromSignup(false);
  }

  async function startSavedLogin() {
    setError(null);
    setNotice(null);
    if (/^\d{17}$/.test(loginName.trim())) {
      setError("Enter the Steam account name (login name), not the SteamID64.");
      return;
    }
    setBusy(true);
    try {
      const start = await window.sah.loginStart({
        accountId: account.id,
        accountName: loginName.trim(),
        password: loginPassword,
      });
      setLoginPassword("");
      if (start.codeFromMail) {
        await finishSavedLogin(start.pendingId);
        return;
      }
      if (start.guards.some((g) => g === "DeviceCode" || g === "EmailCode")) {
        setLoginGuard(start);
        setNotice(guardNotice(start));
        return;
      }
      // No code needed, or only approval in the Steam app is required.
      if (start.guards.length > 0) setNotice("Approve the sign-in in your Steam mobile app.");
      await finishSavedLogin(start.pendingId);
    } catch (e) {
      setLoginPassword("");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitGuardCode() {
    if (!loginGuard) return;
    setBusy(true);
    setError(null);
    try {
      await window.sah.loginCode({ pendingId: loginGuard.pendingId, code: guardCode.trim() });
      await finishSavedLogin(loginGuard.pendingId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    // Closing the panel after removal also clears the selection in the main window.
    if (await run(() => window.sah.removeAccount(account.id))) {
      await window.sah.closeWindow();
    }
  }

  const status = displayStatus(account, now);

  return (
    <div className="panel">
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

      <div className="panel-hero">
        <Avatar url={account.avatarUrl} name={account.displayName} size="lg" />
        <div className="hero-text">
          <h2>{account.displayName}</h2>
          <span className="sid">{account.steamId64}</span>
        </div>
      </div>

      <div className={`cooldown-box ${status.kind}`}>
        <span className="cooldown-label">
          <Icon name="clock" size={12} />
          Cooldown
        </span>
        <DetailStatus status={status} now={now} />
      </div>

      <Section icon="monitor" title="Steam">
        <p className="muted small">
          {account.steamSignedIn
            ? "Steam is currently signed in as this account."
            : (signInBlock(account) ?? "Not the active Steam account. Sign in restarts Steam as this account.")}
        </p>
      </Section>

      <Section icon="key" title="Saved login">
        <p className="muted small">
          {fromSignup
            ? "Filled with the login generated during signup. Save login again to keep it current."
            : account.loginSaved
              ? "Refresh token saved in the encrypted vault. Save again if it is rejected."
              : "The password is not stored. Only a refresh token is kept, encrypted in the vault."}
        </p>
        {loginGuard ? (
          <div className="row">
            <input
              placeholder="Steam Guard code"
              value={guardCode}
              onChange={(e) => setGuardCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && guardCode.trim() && submitGuardCode()}
            />
            <button onClick={submitGuardCode} disabled={busy || !guardCode.trim()}>
              <Icon name="check" />
              Submit
            </button>
          </div>
        ) : (
          <div className="stack">
            <input
              placeholder="Steam account name"
              value={loginName}
              onChange={(e) => setLoginName(e.target.value)}
              autoComplete="off"
            />
            <input
              type="password"
              placeholder="Password (not stored)"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loginName.trim() && loginPassword && startSavedLogin()}
              autoComplete="new-password"
            />
            <button
              className="block"
              disabled={busy || !loginName.trim() || !loginPassword}
              onClick={startSavedLogin}
            >
              <Icon name="key" />
              {account.loginSaved ? "Save login again" : "Save login"}
            </button>
          </div>
        )}
      </Section>

      <Section icon="globe" title="Web session">
        <p className="muted small">
          {account.webSignedIn
            ? "Web session saved. Cooldowns are read automatically."
            : "Optional fallback: sign in through Steam's web login in a window."}
        </p>
        <div className="row">
          <button onClick={webSignIn} disabled={busy}>
            <Icon name="globe" />
            {account.webSignedIn ? "Re-sign in" : "Sign in (web)"}
          </button>
          <button className="ghost" disabled={busy || !account.webSignedIn} onClick={refreshOne}>
            <Icon name="refresh" />
            Check now
          </button>
        </div>
      </Section>

      <Cs2Section accountId={account.id} />

      <Section icon="calendar" title="Manual end">
        <div className="row">
          <input type="datetime-local" value={manualValue} onChange={(e) => setManualValue(e.target.value)} />
          <button onClick={saveManual} disabled={busy || !manualValue}>
            Save
          </button>
        </div>
      </Section>

      <div className="panel-footer">
        <button className="ghost" disabled={busy} onClick={() => run(() => window.sah.clearCooldown(account.id))}>
          <Icon name="rotateCcw" />
          Clear cooldown
        </button>
        <button className="danger" disabled={busy} onClick={remove}>
          <Icon name="trash" />
          Remove
        </button>
      </div>
    </div>
  );
}
