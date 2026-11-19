import { useEffect, useState, type ReactNode } from "react";
import type { Account, LoginStart } from "./types";
import { displayStatus, localInputToIso } from "./status";
import { Avatar, DetailStatus, errorText, guardNotice, signInBlock, useCooldownClock } from "./shared";
import { Icon, type IconName } from "./Icon";

// Root of the attached account panel window. Follows the account the main window selects.
export function AccountWindow({ initialId }: { initialId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState(initialId);
  const [loaded, setLoaded] = useState(false);
  const now = useCooldownClock(accounts);

  useEffect(() => {
    window.sah
      .listAccounts()
      .then(setAccounts)
      .catch(() => {})
      .finally(() => setLoaded(true));
    const offAccounts = window.sah.onAccountsChanged(setAccounts);
    const offSelect = window.sah.onPanelSelect(setSelectedId);
    return () => {
      offAccounts();
      offSelect();
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
  const [loginName, setLoginName] = useState(account.steam?.accountName || account.loginName || "");
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
  const [mailCodeBusy, setMailCodeBusy] = useState(false);

  // Password shown in the panel. Loaded from the vault only when the user asks for it.
  const [shownPassword, setShownPassword] = useState<string | null>(null);

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${what} copied.`);
    } catch {
      setError(`Could not copy the ${what.toLowerCase()}.`);
    }
  }

  // Loads the stored password. With copy=true it goes to the clipboard, otherwise it is shown.
  async function revealPassword(copy: boolean) {
    try {
      setError(null);
      const { password } = await window.sah.getAccountPassword(account.id);
      if (copy) await copyText(password, "Password");
      else setShownPassword(password);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // Fills the Steam Guard field with the newest Steam code from the saved mailbox.
  async function fillGuardFromMail() {
    setMailCodeBusy(true);
    setError(null);
    try {
      const result = await window.sah.getGuardCode();
      if (result.code) {
        setGuardCode(result.code);
        setNotice("Steam Guard code filled from the mailbox.");
      } else {
        setError(result.note);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setMailCodeBusy(false);
    }
  }

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
  // The Steam login name: from Steam's list when it has the account, else the name saved in the vault.
  const steamName = account.steam?.accountName || account.loginName || null;

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
          <span className="sid sid-copy">
            <button
              type="button"
              className="sid-value"
              title="Copy SteamID64"
              onClick={() => copyText(account.steamId64, "SteamID64")}
            >
              {account.steamId64}
            </button>
            <button
              type="button"
              className="icon-btn small"
              title="Copy SteamID64"
              aria-label="Copy SteamID64"
              onClick={() => copyText(account.steamId64, "SteamID64")}
            >
              <Icon name="copy" size={12} />
            </button>
          </span>
        </div>
      </div>

      <div className={`cooldown-box ${status.kind}`}>
        <span className="cooldown-label">
          <Icon name="clock" size={12} />
          Cooldown
        </span>
        <DetailStatus status={status} />
      </div>

      <Section icon="key" title="Login details">
        <div className="row">
          <span className="muted small">Name</span>
          <code>{steamName ?? "Unknown"}</code>
          <button disabled={!steamName} onClick={() => copyText(steamName ?? "", "Name")}>
            Copy
          </button>
        </div>
        <div className="row">
          <span className="muted small">Password</span>
          <code>{account.passwordSaved ? (shownPassword ?? "••••••••") : "Not saved"}</code>
          <button
            disabled={!account.passwordSaved}
            onClick={() => (shownPassword !== null ? setShownPassword(null) : revealPassword(false))}
          >
            {shownPassword !== null ? "Hide" : "Show"}
          </button>
          <button disabled={!account.passwordSaved} onClick={() => revealPassword(true)}>
            Copy
          </button>
          {!account.passwordSaved && (
            <span className="muted small">Save login below once to store the password.</span>
          )}
        </div>
      </Section>

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
              : "Password and refresh token are kept encrypted in the vault."}
        </p>
        {loginGuard ? (
          <div className="row">
            <input
              placeholder="Steam Guard code"
              value={guardCode}
              onChange={(e) => setGuardCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && guardCode.trim() && submitGuardCode()}
            />
            <button
              className="ghost"
              title="Read the newest Steam code from the saved mailbox (last 15 min)"
              onClick={fillGuardFromMail}
              disabled={mailCodeBusy || busy}
            >
              <Icon name="key" />
              {mailCodeBusy ? "Reading..." : "From mailbox"}
            </button>
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
              placeholder="Password"
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

      <Section icon="calendar" title="Manual end">
        <div className="row">
          <input type="datetime-local" value={manualValue} onChange={(e) => setManualValue(e.target.value)} />
          <button onClick={saveManual} disabled={busy || !manualValue}>
            Save
          </button>
        </div>
      </Section>

      <div className="panel-footer">
        <button className="ghost" disabled={busy || !account.loginSaved} onClick={refreshOne} title={account.loginSaved ? undefined : "Save a login first"}>
          <Icon name="refresh" />
          Check now
        </button>
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
