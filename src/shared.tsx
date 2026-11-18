import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Account, DisplayStatus, LoginStart, UpdateStatus } from "./types";
import { formatDuration } from "./status";
import logo from "./assets/logo.png";
import { Starfield } from "./Starfield";
import { Icon, type IconName } from "./Icon";

// Duration of the left-to-right wipe when a window opens.
const WIPE_MS = 320;

const SHOWN_CLIP = "inset(0 0 0 0)";
const HIDDEN_CLIP = "inset(0 100% 0 0)";

// Wipes the whole window (box and content) from left to right. Opening reveals it from the
// left edge; closing hides it back toward the left. The window is transparent, so the clipped
// area shows the desktop rather than an empty box.
function playWipe(win: HTMLElement, open: boolean): Promise<void> {
  const anim = win.animate(
    [{ clipPath: open ? HIDDEN_CLIP : SHOWN_CLIP }, { clipPath: open ? SHOWN_CLIP : HIDDEN_CLIP }],
    { duration: WIPE_MS, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
  );
  return anim.finished.then(
    () => undefined,
    () => undefined,
  );
}

// Window chrome shared by the main window and the account panel: a slim title bar on top.
// A locked title bar cannot drag its window (used by the attached panel), and the panel
// has no minimize button.
// The window is wiped in from left to right when it mounts, and wiped out the same way
// in reverse when the main process asks it to close.
export function Frame({
  children,
  title = "Nyx",
  draggable = true,
  minimizable = true,
  closable = true,
  showVersion = false,
  groupDrag = false,
}: {
  children: ReactNode;
  title?: string;
  draggable?: boolean;
  minimizable?: boolean;
  closable?: boolean;
  showVersion?: boolean;
  // Dragging the title bar moves the main window, and with it every attached window.
  groupDrag?: boolean;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState<string | null>(null);
  const dragPoint = useRef<{ x: number; y: number } | null>(null);

  // Group drag: sends the pointer movement to the main process, which moves the main window.
  // The attached windows follow through its move event.
  function onGroupPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragPoint.current = { x: event.screenX, y: event.screenY };
  }
  function onGroupPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const last = dragPoint.current;
    if (!last) return;
    // Whole pixels; the remainder stays in the anchor so the drag does not drift.
    const dx = Math.round(event.screenX - last.x);
    const dy = Math.round(event.screenY - last.y);
    if (dx === 0 && dy === 0) return;
    dragPoint.current = { x: last.x + dx, y: last.y + dy };
    window.sah.moveWindowGroup(dx, dy).catch(() => undefined);
  }
  function onGroupPointerUp(event: ReactPointerEvent<HTMLElement>) {
    dragPoint.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  useEffect(() => {
    if (!showVersion) return;
    window.sah
      .getAppVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, [showVersion]);

  useEffect(() => {
    const el = windowRef.current;
    if (!el) return;
    let cancelled = false;
    // Shows the window, then starts the wipe once it is on screen.
    window.sah
      .revealWindow()
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) void playWipe(el, true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="window" ref={windowRef}>
      <header
        className={groupDrag ? "titlebar group-drag" : draggable ? "titlebar" : "titlebar locked"}
        onPointerDown={groupDrag ? onGroupPointerDown : undefined}
        onPointerMove={groupDrag ? onGroupPointerMove : undefined}
        onPointerUp={groupDrag ? onGroupPointerUp : undefined}
        onPointerCancel={groupDrag ? onGroupPointerUp : undefined}
      >
        <div className="titlebar-brand">
          <img className="titlebar-logo" src={logo} alt="" />
          <span>{title}</span>
          {version && <span className="titlebar-version">v{version}</span>}
        </div>
        <div className="window-controls">
          {minimizable && (
            <button
              className="window-btn"
              title="Minimize"
              aria-label="Minimize"
              onClick={() => window.sah.minimizeWindow()}
            >
              <Icon name="minus" size={12} />
            </button>
          )}
          {closable && (
            <button
              className="window-btn close"
              title="Close"
              aria-label="Close"
              onClick={() => window.sah.closeWindow()}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      </header>
      <div className="content">
        <Starfield />
        {children}
      </div>
    </div>
  );
}

// Update button for the toolbar and the unlock screen. Renders nothing unless an update is
// found or downloaded. Available: download. Downloaded: restart and install.
export function UpdateButton({ onError }: { onError?: (message: string) => void }) {
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle", version: null, percent: 0 });

  useEffect(() => {
    window.sah.getUpdateStatus().then(setUpdate).catch(() => undefined);
    return window.sah.onUpdateStatus(setUpdate);
  }, []);

  async function clicked() {
    try {
      if (update.state === "downloaded") {
        await window.sah.installUpdate();
        return;
      }
      await window.sah.downloadUpdate();
    } catch (e) {
      onError?.(errorText(e));
    }
  }

  if (update.state === "available") {
    return (
      <button className="update-btn" onClick={clicked} title={`Download Nyx ${update.version}`}>
        Update to {update.version}
      </button>
    );
  }
  if (update.state === "downloading") {
    return (
      <button className="update-btn" disabled title="Downloading the update">
        Downloading {update.percent}%
      </button>
    );
  }
  if (update.state === "downloaded") {
    return (
      <button className="update-btn" onClick={clicked} title="Close Nyx and install the update">
        Restart to update
      </button>
    );
  }
  return null;
}

export function isClear(status: DisplayStatus): boolean {
  return status.kind === "expired" || status.kind === "clear";
}

// Why Sign in is unavailable for an account, or null when it is available.
export function signInBlock(account: Account): string | null {
  if (account.steamSignedIn) return "Steam is already signed in as this account.";
  if (!account.steam) return "Steam does not list this account on this machine.";
  if (!account.steam.rememberPassword) {
    return "Steam does not remember this account's password. Sign in once manually with 'Remember my password'.";
  }
  return null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Avatar({ url, name, size }: { url: string | null; name: string; size: "sm" | "lg" }) {
  if (url) {
    return <img className={`avatar ${size}`} src={url} alt="" />;
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return <span className={`avatar ${size} fallback`}>{initial}</span>;
}

// Summary count in the toolbar, e.g. "1 cooldown".
export function Count({
  icon,
  value,
  label,
  tone,
}: {
  icon: IconName;
  value: number;
  label: string;
  tone: "warn" | "ok" | "muted";
}) {
  return (
    <div className={`count ${tone}`}>
      <Icon name={icon} size={14} />
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

// Small status chip on a card: Steam, saved login.
export function Badge({
  icon,
  label,
  state,
  title,
}: {
  icon: IconName;
  label: string;
  state: "on" | "off" | "active";
  title?: string;
}) {
  return (
    <span className={`badge ${state}`} title={title}>
      <Icon name={icon} size={12} />
      {label}
    </span>
  );
}

// Message shown while a sign-in waits for a Steam Guard code the user must type.
export function guardNotice(start: LoginStart): string {
  if (!start.guards.includes("EmailCode")) return "Enter the code from your Steam mobile app.";
  const ask = "Enter the Steam Guard code from the email Steam sent.";
  return start.mailNote ? `${start.mailNote} ${ask}` : ask;
}

export function Pill({ status, now }: { status: DisplayStatus; now: Date }) {
  if (status.kind === "blocked") {
    return (
      <span className="pill warn">
        <Icon name="clock" size={12} />
        {formatDuration(status.until.getTime() - now.getTime())}
      </span>
    );
  }
  if (isClear(status)) {
    return (
      <span className="pill ok">
        <Icon name="check" size={12} />
        Clear
      </span>
    );
  }
  return (
    <span className="pill muted">
      <Icon name="help" size={12} />
      Unknown
    </span>
  );
}

export function DetailStatus({ status, now }: { status: DisplayStatus; now: Date }) {
  if (status.kind === "blocked") {
    return (
      <>
        <span className="detail-main warn-text">
          {formatDuration(status.until.getTime() - now.getTime())} left
        </span>
        <span className="detail-sub">Until {status.until.toLocaleString()}</span>
      </>
    );
  }
  if (status.kind === "expired") {
    return (
      <>
        <span className="detail-main ok-text">Clear</span>
        <span className="detail-sub">Expired {status.until.toLocaleString()}</span>
      </>
    );
  }
  if (status.kind === "clear") {
    return (
      <>
        <span className="detail-main ok-text">Clear</span>
        <span className="detail-sub">No matchmaking data on this account</span>
      </>
    );
  }
  return (
    <>
      <span className="detail-main muted">Unknown</span>
      <span className="detail-sub">{status.detail}</span>
    </>
  );
}
