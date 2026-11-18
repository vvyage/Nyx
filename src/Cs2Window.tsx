import { useEffect, useMemo, useState } from "react";
import type { Account, Cs2Binding, Cs2Setting, Cs2Settings, Cs2State, Cs2TabId } from "./types";
import { Avatar, errorText } from "./shared";
import { Icon } from "./Icon";

const TABS: { id: Cs2TabId; label: string }[] = [
  { id: "video", label: "Video" },
  { id: "crosshair", label: "Crosshair" },
  { id: "mouse", label: "Mouse" },
  { id: "keybinds", label: "Keybinds" },
];

export function cs2TabFrom(value: string | null): Cs2TabId {
  return TABS.some((tab) => tab.id === value) ? (value as Cs2TabId) : "video";
}

// In-game names for video settings, keyed by the setting name in cs2_video.txt. A setting with no
// entry shows its file name without the "setting." prefix.
export const VIDEO_LABELS: Record<string, string> = {};

// Which convars each tab shows. Other convars (joystick, name, skill, and so on) stay in the file
// and are not shown.
const CROSSHAIR_CONVAR = /^(crosshair$|cl_crosshair|cl_grenadecrosshair)/;
const MOUSE_CONVARS = new Set([
  "sensitivity",
  "sensitivity_y_scale",
  "m_yaw",
  "m_pitch",
  "zoom_sensitivity_ratio",
  "viewmodel_fov",
  "viewmodel_offset_x",
  "viewmodel_offset_y",
  "viewmodel_offset_z",
]);

type SettingGroup = "video" | "convars";
// Values changed from the selected backup. Each group maps a setting or key name to its new value.
type Edits = Record<SettingGroup | "bindings", Record<string, string>>;

const NO_EDITS: Edits = { video: {}, convars: {}, bindings: {} };
const UNBOUND = "<unbound>";

// Root of the CS2 window. It is a standalone popup and follows the account the main window selects.
// Saving edits makes a new backup. Write to Steam also changes Steam's own CS2 files (Steam closed).
export function Cs2Window({ initialId, initialTab }: { initialId: string; initialTab: Cs2TabId }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState(initialId);
  const [tab, setTab] = useState<Cs2TabId>(initialTab);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.sah
      .listAccounts()
      .then(setAccounts)
      .catch(() => {})
      .finally(() => setLoaded(true));
    const offAccounts = window.sah.onAccountsChanged(setAccounts);
    const offSelect = window.sah.onCs2Select(setAccountId);
    const offTab = window.sah.onCs2Tab((next) => setTab(cs2TabFrom(next)));
    return () => {
      offAccounts();
      offSelect();
      offTab();
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
  return <Cs2Body key={account.id} account={account} tab={tab} onTab={setTab} />;
}

function editedValue(edits: Record<string, string>, key: string, original: string): string {
  return Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : original;
}

// Adds, changes, or drops one edit. An edit equal to its original value is dropped.
function withEdit(prev: Edits, group: keyof Edits, key: string, original: string | undefined, value: string): Edits {
  const next = { ...prev[group] };
  if (value === original) delete next[key];
  else next[key] = value;
  return { ...prev, [group]: next };
}

// Keybind rows: the backup's bindings with edits applied, then any newly added keys.
interface BindRow {
  key: string;
  command: string;
  original: string | undefined;
  edited: boolean;
}

function bindingRows(base: Cs2Binding[] | null, edits: Record<string, string>): BindRow[] {
  const baseKeys = new Set((base ?? []).map((bind) => bind.key));
  const rows: BindRow[] = (base ?? []).map((bind) => ({
    key: bind.key,
    command: editedValue(edits, bind.key, bind.command),
    original: bind.command,
    edited: Object.prototype.hasOwnProperty.call(edits, bind.key),
  }));
  for (const [key, command] of Object.entries(edits)) {
    if (!baseKeys.has(key)) rows.push({ key, command, original: undefined, edited: true });
  }
  return rows;
}

function Cs2Body({ account, tab, onTab }: { account: Account; tab: Cs2TabId; onTab: (tab: Cs2TabId) => void }) {
  const [state, setState] = useState<Cs2State | null>(null);
  // The backup being viewed. Edits start from it and are saved as a new backup.
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<Cs2Settings | null>(null);
  const [bindings, setBindings] = useState<Cs2Binding[] | null>(null);
  const [filter, setFilter] = useState("");
  // Only values that differ from the backup are kept here.
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const [newKey, setNewKey] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const changedCount =
    Object.keys(edits.video).length + Object.keys(edits.convars).length + Object.keys(edits.bindings).length;

  useEffect(() => {
    window.sah
      .cs2List(account.id)
      .then((next) => {
        setState(next);
        setSelectedId(next.snapshots[0]?.id ?? "");
      })
      .catch((e) => setError(errorText(e)));
  }, [account.id]);

  // Loads the settings and keybinds of the selected backup. Switching backups drops the edits.
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setEdits(NO_EDITS);
    setSettings(null);
    setBindings(null);
    window.sah
      .cs2Settings(account.id, selectedId)
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
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
  }, [account.id, selectedId]);

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

  function changeValue(group: SettingGroup, key: string, original: string, value: string) {
    setEdits((prev) => withEdit(prev, group, key, original, value));
  }

  function changeBinding(key: string, original: string | undefined, value: string) {
    setEdits((prev) => withEdit(prev, "bindings", key, original, value));
  }

  function addBinding() {
    const key = newKey.trim();
    const command = newCommand.trim();
    if (!key || !command) return;
    const original = bindings?.find((bind) => bind.key === key)?.command;
    setEdits((prev) => withEdit(prev, "bindings", key, original, command));
    setNewKey("");
    setNewCommand("");
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

  async function applyToSteam() {
    if (!selectedId || changedCount === 0) return;
    const ok = window.confirm(
      "Write these changes into Steam's CS2 files for this account?\n\n" +
        "The current Steam files are saved as a backup first. If Steam Cloud sync is on for CS2, " +
        "Steam may overwrite this change later. Turn off CS2 cloud sync in Steam to keep it.",
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sah.cs2ApplyToSteam(account.id, edits);
      setState(result.state);
      setEdits(NO_EDITS);
      setNotice(
        `Written to Steam's CS2 files (${result.changedCount} change${result.changedCount === 1 ? "" : "s"}). ` +
          (result.backupId ? "The previous Steam files are kept as a backup." : "Steam's previous files were not backed up."),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const latest = state?.snapshots[0] ?? null;
  const needle = filter.trim().toLowerCase();

  // Settings shown on the current tab, with the group they are stored in.
  const tabItems = useMemo<{ group: SettingGroup; item: Cs2Setting }[]>(() => {
    if (!settings || tab === "keybinds") return [];
    if (tab === "video") {
      return (settings.video ?? []).map((item) => ({ group: "video" as const, item }));
    }
    const convars = settings.convars ?? [];
    const pick = (key: string) => (tab === "crosshair" ? CROSSHAIR_CONVAR.test(key) : MOUSE_CONVARS.has(key));
    return convars.filter((item) => pick(item.key)).map((item) => ({ group: "convars", item }));
  }, [settings, tab]);

  const visibleItems = tabItems.filter(
    ({ item }) => !needle || item.key.toLowerCase().includes(needle) || (item.key in VIDEO_LABELS && VIDEO_LABELS[item.key].toLowerCase().includes(needle)),
  );

  const rows = useMemo(() => bindingRows(bindings, edits.bindings), [bindings, edits.bindings]);
  const visibleRows = rows.filter(
    (row) => !needle || row.key.toLowerCase().includes(needle) || row.command.toLowerCase().includes(needle),
  );

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
            {latest ? `Last imported ${new Date(latest.createdAt).toLocaleString()}` : "Not imported yet."}
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
          {TABS.map((item) => (
            <button key={item.id} className={tab === item.id ? "tab active" : "tab"} onClick={() => onTab(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <input
          className="cs2-filter"
          placeholder={tab === "keybinds" ? "Filter by key or command" : "Filter"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="cs2-body">
        {!selectedId ? (
          <p className="muted small">No backup yet. Import from Steam first.</p>
        ) : tab === "keybinds" ? (
          bindings ? (
            <>
              {visibleRows.length === 0 && <p className="muted small">No keybinds match.</p>}
              <ul className="cs2-binds">
                {visibleRows.map((row, index) => (
                  <li key={`${row.key}-${index}`} className={row.edited ? "cs2-bind edited" : "cs2-bind"}>
                    <span className="cs2-bind-key">{row.key}</span>
                    <input
                      value={row.command}
                      onChange={(e) => changeBinding(row.key, row.original, e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      className="ghost small"
                      onClick={() => changeBinding(row.key, row.original, UNBOUND)}
                      disabled={row.command === UNBOUND}
                    >
                      Unbind
                    </button>
                  </li>
                ))}
              </ul>
              <div className="cs2-bind-add">
                <input
                  placeholder="Key (e.g. F5)"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <input
                  placeholder="Command (e.g. +jump)"
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="ghost" onClick={addBinding} disabled={!newKey.trim() || !newCommand.trim()}>
                  Add keybind
                </button>
              </div>
            </>
          ) : (
            <p className="muted small">Loading keybinds...</p>
          )
        ) : settings ? (
          <SettingsList
            tab={tab}
            items={visibleItems}
            edits={edits}
            onChange={changeValue}
            emptyText={needle ? "No settings match." : "No settings in this backup for this tab."}
          />
        ) : (
          <p className="muted small">Loading settings...</p>
        )}
      </div>

      {selectedId && (
        <div className="cs2-footer">
          <span className="small muted">
            {changedCount > 0
              ? `${changedCount} changed. Save as a backup, or write to Steam (Steam must be closed).`
              : "Change a value, then save it as a backup or write it to Steam."}
          </span>
          <div className="row">
            <button className="ghost" onClick={() => setEdits(NO_EDITS)} disabled={busy || changedCount === 0}>
              Discard
            </button>
            <button className="ghost" onClick={saveEdits} disabled={busy || changedCount === 0}>
              <Icon name="check" />
              Save as new backup
            </button>
            <button onClick={applyToSteam} disabled={busy || changedCount === 0} title="Steam must be closed">
              Write to Steam
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Editable settings of one tab. Video entries use their in-game names when known.
function SettingsList({
  tab,
  items,
  edits,
  onChange,
  emptyText,
}: {
  tab: Cs2TabId;
  items: { group: SettingGroup; item: Cs2Setting }[];
  edits: Edits;
  onChange: (group: SettingGroup, key: string, original: string, value: string) => void;
  emptyText: string;
}) {
  if (items.length === 0) return <p className="muted small">{emptyText}</p>;
  return (
    <section className="cs2-group">
      <div className="cs2-grid">
        {items.map(({ group, item }) => {
          const value = editedValue(edits[group], item.key, item.value);
          const edited = value !== item.value;
          const label = tab === "video" ? VIDEO_LABELS[item.key] ?? item.key.replace(/^setting\./, "") : item.key;
          return (
            <label key={`${group}-${item.key}`} className={`cs2-setting${edited ? " edited" : ""}`}>
              <span title={item.key}>{label}</span>
              <input
                value={value}
                onChange={(e) => onChange(group, item.key, item.value, e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          );
        })}
      </div>
    </section>
  );
}
