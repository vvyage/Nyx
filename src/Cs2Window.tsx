import { useEffect, useState } from "react";
import type { Account, Cs2Binding, Cs2Setting, Cs2Settings, Cs2State } from "./types";
import { Avatar, errorText } from "./shared";
import { Icon } from "./Icon";

// Settings groups that can be edited. Values are keyed by setting name within each group.
type Group = "video" | "convars";
type Edits = Record<Group, Record<string, string>>;

const NO_EDITS: Edits = { video: {}, convars: {} };

// Root of the attached CS2 window. It sits across the top of the main window and follows the
// account the main window selects. Saving edits makes a new backup; Steam's files are not changed.
export function Cs2Window({ initialId }: { initialId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(initialId);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.sah
      .listAccounts()
      .then(setAccounts)
      .catch(() => {})
      .finally(() => setLoaded(true));
    const offAccounts = window.sah.onAccountsChanged(setAccounts);
    const offSelect = window.sah.onCs2Select(setAccountId);
    return () => {
      offAccounts();
      offSelect();
    };
  }, []);

  if (!loaded) return <div className="cs2-window" />;
  const account = accounts.find((item) => item.id === accountId) ?? null;
  if (!account) {
    return (
      <div className="cs2-window">
        <p className="muted">This account is no longer tracked.</p>
      </div>
    );
  }
  // key resets the form state when another account is selected.
  return <Cs2Body key={account.id} account={account} />;
}

function editedValue(edits: Edits, group: Group, key: string, original: string): string {
  return Object.prototype.hasOwnProperty.call(edits[group], key) ? edits[group][key] : original;
}

function Cs2Body({ account }: { account: Account }) {
  const [state, setState] = useState<Cs2State | null>(null);
  // The backup being viewed. Edits start from it and are saved as a new backup.
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<Cs2Settings | null>(null);
  const [bindings, setBindings] = useState<Cs2Binding[] | null>(null);
  const [tab, setTab] = useState<"settings" | "keybinds">("settings");
  const [filter, setFilter] = useState("");
  // Only values that differ from the backup are kept here.
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const changedCount = Object.keys(edits.video).length + Object.keys(edits.convars).length;

  useEffect(() => {
    window.sah
      .cs2List(account.id)
      .then((next) => {
        setState(next);
        setSelectedId(next.snapshots[0]?.id ?? "");
      })
      .catch((e) => setError(errorText(e)));
  }, [account.id]);

  // Loads the editable settings of the selected backup.
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setEdits(NO_EDITS);
    window.sah
      .cs2Settings(account.id, selectedId)
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [account.id, selectedId]);

  // Loads the keybinds of the selected backup when that tab is open.
  useEffect(() => {
    if (tab !== "keybinds" || !selectedId) return;
    let active = true;
    setBindings(null);
    window.sah
      .cs2View(account.id, selectedId)
      .then((next) => {
        if (active) setBindings(next);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [account.id, selectedId, tab]);

  async function importNow() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await window.sah.cs2Import(account.id);
      setState(next);
      setSelectedId(next.snapshots[0]?.id ?? "");
      setNotice("Imported the current CS2 settings from Steam.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setConfirming(false);
      setBusy(false);
    }
  }

  // Keeps the edit only when it differs from the value in the backup.
  function changeValue(group: Group, key: string, original: string, value: string) {
    setEdits((prev) => {
      const next = { ...prev, [group]: { ...prev[group] } };
      if (value === original) delete next[group][key];
      else next[group][key] = value;
      return next;
    });
  }

  async function saveEdits() {
    if (!selectedId || changedCount === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sah.cs2SaveSettings(account.id, selectedId, edits);
      setState(result.state);
      setSelectedId(result.snapshotId);
      setNotice("Saved as a new backup. Steam's CS2 files were not changed.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const latest = state?.snapshots[0] ?? null;

  return (
    <div className="cs2-window">
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

      <div className="cs2-head">
        <Avatar url={account.avatarUrl} name={account.displayName} size="sm" />
        <div className="cs2-title">
          <b>{account.displayName}</b>
          <span className="small muted">
            {latest
              ? `Last imported ${new Date(latest.createdAt).toLocaleString()}`
              : "Not imported yet."}
            {state && !state.available && " No CS2 settings for this account on this PC right now."}
          </span>
        </div>

        {state && state.snapshots.length > 0 && (
          <select
            className="cs2-select"
            aria-label="Backup"
            title={changedCount > 0 ? "Save or discard your edits first" : "Backup to view"}
            value={selectedId}
            disabled={busy || changedCount > 0}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {state.snapshots.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {new Date(snapshot.createdAt).toLocaleString()}
                {snapshot.changedSettings ? " (edited)" : ""}
              </option>
            ))}
          </select>
        )}

        {confirming ? (
          <div className="cs2-inline-confirm">
            <span className="small">Replace Nyx's copy with Steam's current settings? The current copy is kept in backups.</span>
            <button onClick={importNow} disabled={busy}>
              <Icon name="check" />
              Import
            </button>
            <button className="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="ghost"
            onClick={() => setConfirming(true)}
            disabled={busy || !state?.available || changedCount > 0}
          >
            <Icon name="download" />
            Import from Steam
          </button>
        )}
      </div>

      <div className="cs2-bar">
        <div className="tabs">
          <button className={tab === "settings" ? "tab active" : "tab"} onClick={() => setTab("settings")}>
            Settings
          </button>
          <button className={tab === "keybinds" ? "tab active" : "tab"} onClick={() => setTab("keybinds")}>
            Keybinds
          </button>
        </div>
        {tab === "settings" && (
          <input
            className="cs2-filter"
            placeholder="Filter by name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>

      <div className="cs2-body">
        {!selectedId ? (
          <p className="muted small">No backup yet. Import from Steam first.</p>
        ) : tab === "keybinds" ? (
          bindings ? (
            <ul className="cs2-binds">
              {bindings.map((bind, index) => (
                <li key={`${bind.key}-${index}`}>
                  <span>{bind.key}</span>
                  <span>{bind.command}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Loading keybinds...</p>
          )
        ) : settings ? (
          <SettingsList settings={settings} filter={filter} edits={edits} onChange={changeValue} />
        ) : (
          <p className="muted small">Loading settings...</p>
        )}
      </div>

      {tab === "settings" && selectedId && (
        <div className="cs2-footer">
          <span className="small muted">
            {changedCount > 0
              ? `${changedCount} changed. Saving makes a new backup.`
              : "Change a value, then save it as a new backup. Steam's files are not changed."}
          </span>
          <div className="row">
            <button className="ghost" onClick={() => setEdits(NO_EDITS)} disabled={busy || changedCount === 0}>
              Discard
            </button>
            <button onClick={saveEdits} disabled={busy || changedCount === 0}>
              <Icon name="check" />
              Save as new backup
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Editable video options and convars of one backup, filtered by name.
function SettingsList({
  settings,
  filter,
  edits,
  onChange,
}: {
  settings: Cs2Settings;
  filter: string;
  edits: Edits;
  onChange: (group: Group, key: string, original: string, value: string) => void;
}) {
  const needle = filter.trim().toLowerCase();
  const groups: { group: Group; title: string; items: Cs2Setting[] | null }[] = [
    { group: "video", title: "Video", items: settings.video },
    { group: "convars", title: "Convars", items: settings.convars },
  ];
  const sections = groups
    .map(({ group, title, items }) => ({
      group,
      title,
      items: (items ?? []).filter((setting) => !needle || setting.key.toLowerCase().includes(needle)),
    }))
    .filter((section) => section.items.length > 0);

  if (sections.length === 0) return <p className="muted small">No settings match.</p>;

  return (
    <>
      {sections.map(({ group, title, items }) => (
        <section key={group} className="cs2-group">
          <div className="cs2-group-title">
            {title} <span className="muted small">{items.length}</span>
          </div>
          <div className="cs2-grid">
            {items.map((setting) => {
              const value = editedValue(edits, group, setting.key, setting.value);
              const edited = value !== setting.value;
              return (
                <label key={setting.key} className={`cs2-setting${edited ? " edited" : ""}`}>
                  <span title={setting.key}>{setting.key}</span>
                  <input
                    value={value}
                    onChange={(e) => onChange(group, setting.key, setting.value, e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}
