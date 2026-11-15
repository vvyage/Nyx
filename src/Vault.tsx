import { useState } from "react";
import type { VaultStatus } from "./types";

const MIN_PASSWORD = 10;

// First run: set the master password and show the recovery code once.
export function VaultSetup({ onDone }: { onDone: (status: VaultStatus) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.sah.vaultSetup(password);
      setPassword("");
      setConfirm("");
      setRecoveryCode(result.recoveryCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Create vault</h1>
        {recoveryCode ? (
          <>
            <p className="muted small">
              Write this recovery code down and keep it somewhere safe. It is shown only once. If you forget
              the master password, this code is the only way to open the vault.
            </p>
            <p className="recovery">{recoveryCode}</p>
            <button onClick={() => onDone({ exists: true, unlocked: true })}>I saved the code</button>
          </>
        ) : (
          <>
            <p className="muted small">
              Saved Steam logins are encrypted with this master password. The app keeps nothing readable on disk.
            </p>
            <input
              type="password"
              placeholder="Master password (10+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input
              type="password"
              placeholder="Repeat master password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
            {error && <p className="error-text">{error}</p>}
            <button onClick={create} disabled={busy || !password || !confirm}>
              {busy ? "Creating..." : "Create vault"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Each launch: unlock with the master password, or with the recovery code.
export function VaultUnlock({ onDone }: { onDone: (status: VaultStatus) => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useCode, setUseCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const status = useCode
        ? await window.sah.vaultUnlockRecovery(code)
        : await window.sah.vaultUnlock(password);
      setPassword("");
      setCode("");
      onDone(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Unlock vault</h1>
        {useCode ? (
          <input
            placeholder="Recovery code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
          />
        ) : (
          <input
            type="password"
            placeholder="Master password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
          />
        )}
        {error && <p className="error-text">{error}</p>}
        <button onClick={unlock} disabled={busy || (useCode ? !code : !password)}>
          {busy ? "Unlocking..." : "Unlock"}
        </button>
        <button className="ghost small" onClick={() => setUseCode(!useCode)}>
          {useCode ? "Use master password" : "Use recovery code instead"}
        </button>
      </div>
    </div>
  );
}
