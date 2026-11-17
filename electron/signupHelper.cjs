// Assisted Steam signup. The app generates a username and password, opens Steam's join page,
// and watches the user's mailbox (INBOX and spam) for Steam's confirmation email. When the
// email arrives, the app opens its confirmation link. The user fills the form, solves the
// CAPTCHA, clicks Steam's buttons, and chooses "create new account" on Steam's page.
//
// Two modes:
//   - "browser": the join page and the confirmation link open in the user's default browser.
//   - "embedded": both open in an app window. hCaptcha has rejected this window in the past.
//     The app fills empty fields on the join page with the generated values, best effort.
//
// The app never solves CAPTCHAs or calls Steam's signup endpoints. Credentials live in memory
// only and are cleared when the signup is completed, cancelled, or times out. The credentials
// the user confirms (which may be edited) are used for the sign-in.

const crypto = require("node:crypto");
const { BrowserWindow, app, clipboard, shell, session: electronSession } = require("electron");
const { ImapFlow } = require("imapflow");
const steamAuth = require("./steamAuth.cjs");
const utils = require("./signupUtils.cjs");

const JOIN_URL = "https://store.steampowered.com/join/";
const FORM_POLL_MS = 2000;
const MAIL_POLL_MS = 5000;
const MAIL_WAIT_MS = 10 * 60 * 1000;
// Mail sent just before the signup opened still counts.
const MAIL_LOOKBACK_MS = 60 * 1000;
const SIGNUP_TIMEOUT_MS = 30 * 60 * 1000;
// Steam Guard email codes: how long to wait for the email, and how often to check the mailbox.
const STEAM_CODE_WAIT_MS = 90 * 1000;
const STEAM_CODE_POLL_MS = 5000;
// Sign-ins may send mail a little before the sign-in call returns.
const STEAM_CODE_LOOKBACK_MS = 5 * 1000;

// Selectors for Steam's join page, used only in embedded mode. Not verified against the
// live site: if Steam changes a field, update it here.
const FIELDS = {
  email: ["#email"],
  emailConfirm: ["#reenter_email"],
  accountName: ["#accountname"],
  password: ["#password"],
  passwordConfirm: ["#reenter_password"],
};

let active = null;

function presenceScript() {
  return `(() => {
    const fields = ${JSON.stringify(FIELDS)};
    const present = {};
    for (const [key, selectors] of Object.entries(fields)) {
      const el = selectors.map((s) => document.querySelector(s)).find(Boolean);
      if (el) present[key] = el.value === "";
    }
    return present;
  })()`;
}

// Focuses one field if it is still empty. Returns false when it is missing or already filled.
function focusScript(key) {
  return `(() => {
    const selectors = ${JSON.stringify(FIELDS)}[${JSON.stringify(key)}] || [];
    const el = selectors.map((s) => document.querySelector(s)).find(Boolean);
    if (!el || el.value !== "") return false;
    el.focus();
    return true;
  })()`;
}

// Leaves a field after its text is entered, so the page runs its validation the way it does
// when a user tabs away. Steam's form rejects a value set without these events.
function blurScript(key) {
  return `(() => {
    const selectors = ${JSON.stringify(FIELDS)}[${JSON.stringify(key)}] || [];
    const el = selectors.map((s) => document.querySelector(s)).find(Boolean);
    if (el) el.blur();
    return true;
  })()`;
}

// Order matters: the confirm fields repeat the value above them.
const FILL_ORDER = ["email", "emailConfirm", "accountName", "password", "passwordConfirm"];

function valuesFor(session) {
  return {
    email: session.email,
    emailConfirm: session.email,
    accountName: session.username,
    password: session.password,
    passwordConfirm: session.password,
  };
}

function setMessage(session, message) {
  if (active === session) session.message = message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Opens the signup. Returns the generated credentials for the user to review and edit.
async function open(input) {
  if (active) throw new Error("A signup is already open. Finish or cancel it first.");
  const mode = input && input.mode === "browser" ? "browser" : "embedded";
  const email = utils.validEmail(input && input.email);
  const mail = utils.normalizeMailConfig(input && input.mail);

  const session = {
    mode,
    email,
    mail,
    username: utils.generateUsername(),
    password: utils.generatePassword(),
    message: "Opening Steam's signup page...",
    since: Date.now() - MAIL_LOOKBACK_MS,
    watching: false,
    win: null,
    fillTimer: null,
    expires: null,
  };
  active = session;
  session.expires = setTimeout(() => {
    if (active === session) reset();
  }, SIGNUP_TIMEOUT_MS);

  const credentials = { username: session.username, password: session.password, mode };
  try {
    if (mode === "embedded") {
      openEmbedded(session);
    } else {
      await shell.openExternal(JOIN_URL);
    }
  } catch (error) {
    reset();
    throw new Error(`Could not open Steam's signup page: ${error.message}`);
  }
  setMessage(
    session,
    "Fill in the form and submit it. Waiting for Steam's confirmation email in your mailbox...",
  );
  watchForConfirmation(session);
  return credentials;
}

function openEmbedded(session) {
  // No "persist:" prefix: the session lives in memory and is dropped with the window.
  const partition = `signup-${crypto.randomUUID()}`;
  // Electron's default user agent carries an "Electron/x.y" token. Use the plain Chrome
  // agent instead. This only matches a normal browser; it does not solve anything.
  electronSession
    .fromPartition(partition)
    .setUserAgent(app.userAgentFallback.replace(/\s*Electron\/\S+/, ""));

  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    autoHideMenuBar: true,
    title: "Steam account signup",
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  session.win = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("https://")) event.preventDefault();
  });
  win.on("closed", () => {
    // Closing the window does not end the signup; the confirmation still opens in the browser.
    if (session.win === win) session.win = null;
    clearInterval(session.fillTimer);
  });
  session.fillTimer = setInterval(() => fillForm(session), FORM_POLL_MS);
  win.loadURL(JOIN_URL).catch((error) => setMessage(session, `Could not load Steam: ${error.message}`));
}

// Types each empty field with insertText, which sends real input events like a paste does.
// Setting .value directly left Steam's form thinking the password was empty.
async function fillForm(session) {
  if (session.checking || active !== session || !session.win || session.win.isDestroyed()) return;
  session.checking = true;
  try {
    const wc = session.win.webContents;
    const present = await wc.executeJavaScript(presenceScript(), true);
    const wanted = valuesFor(session);
    for (const key of FILL_ORDER) {
      if (!present[key] || !(key in wanted)) continue;
      wc.focus();
      const focused = await wc.executeJavaScript(focusScript(key), true);
      if (!focused) continue;
      await pasteValue(wc, wanted[key]);
      await wc.executeJavaScript(blurScript(key), true);
    }
  } catch {
    // The page may be navigating; the next tick tries again.
  } finally {
    session.checking = false;
  }
}

// Pastes the value into the focused field, the same way a manual Ctrl+V does. Steam's form
// rejects the password when it is typed with insertText, but accepts it when pasted. The
// clipboard's previous text is put back afterwards.
async function pasteValue(wc, value) {
  const previous = clipboard.readText();
  clipboard.writeText(value);
  try {
    wc.paste();
    await sleep(250);
  } finally {
    clipboard.writeText(previous);
  }
}

// Watches the mailbox for Steam's confirmation email, then opens its link.
async function watchForConfirmation(session) {
  if (session.watching) return;
  session.watching = true;
  const deadline = Date.now() + MAIL_WAIT_MS;
  try {
    while (active === session && Date.now() < deadline) {
      const link = await findConfirmationLink(session.mail, session.since);
      if (active !== session) return;
      if (link) {
        await openLink(session, link);
        setMessage(
          session,
          session.mode === "embedded"
            ? "Opened Steam's confirmation link in a separate window. Go back to the signup window, choose to create a new account, then check the name and password below."
            : "Opened Steam's confirmation link. On Steam's page, choose to create a new account, then check the name and password below.",
        );
        return;
      }
      await sleep(MAIL_POLL_MS);
    }
    setMessage(session, "No Steam confirmation email found yet. Check your mailbox, or cancel the signup.");
  } catch (error) {
    setMessage(session, `Mailbox check failed: ${mailErrorText(error)}. Open Steam's confirmation link yourself.`);
  } finally {
    session.watching = false;
  }
}

// imapflow reports most server rejections as "Command failed" and keeps the server's reply in
// responseText. Show that reply, so a bad password or a missing app password is visible.
function mailErrorText(error) {
  const server = typeof error?.responseText === "string" ? error.responseText.trim() : "";
  if (error?.authenticationFailed) {
    return `the mail server rejected the login (${server || error.message}). For Gmail, use a 16-character app password, not your normal password`;
  }
  return server ? `${error.message} (server said: ${server})` : error?.message || "unknown error";
}

async function openLink(session, link) {
  if (session.mode === "embedded") {
    openLinkWindow(link);
  } else {
    await shell.openExternal(link);
  }
}

// Opens the confirmation link in its own window. Loading it in the join window would replace
// the signup form, and Steam's page expects the form window to still be open. The link window
// closes itself once Steam shows that the email is verified.
function openLinkWindow(link) {
  const partition = `signup-link-${crypto.randomUUID()}`;
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    autoHideMenuBar: true,
    title: "Steam email verification",
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("https://")) event.preventDefault();
  });
  win.webContents.on("did-finish-load", async () => {
    try {
      const text = await win.webContents.executeJavaScript("document.body ? document.body.innerText : ''", true);
      if (/email\s+(is\s+)?verified/i.test(text) && !win.isDestroyed()) win.close();
    } catch {
      // The page may still be navigating; the window stays open for the user.
    }
  });
  win.loadURL(link).catch(() => {
    if (!win.isDestroyed()) win.close();
  });
}

// Connects to the mailbox, runs work(client), and logs out.
async function withMailbox(mail, work) {
  const client = new ImapFlow({
    host: mail.host,
    port: mail.port,
    secure: mail.port !== 143,
    auth: { user: mail.user, pass: mail.password },
    logger: false,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// Searches INBOX and the spam folder for the newest Steam email that `pick` finds a value in.
// Returns that value, or null.
async function newestAcrossFolders(client, mail, since, pick) {
  let best = null;
  for (const folder of ["INBOX", utils.spamFolderFor(mail.host)]) {
    const found = await newestMatchInFolder(client, folder, since, pick).catch(() => null);
    if (found && (!best || found.date > best.date)) best = found;
  }
  return best ? best.value : null;
}

// The newest message in one folder, from Steam and received since `since`, for which pick()
// returns a value. Returns { date, value } or null.
async function newestMatchInFolder(client, folder, since, pick) {
  const lock = await client.getMailboxLock(folder);
  try {
    const uids = (await client.search({ from: "steampowered.com", since: new Date(since) }, { uid: true })) || [];
    for (const uid of uids.slice(-5).reverse()) {
      const message = await client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
      if (!message || !message.source) continue;
      const date = message.internalDate ? new Date(message.internalDate).getTime() : 0;
      if (date < since) continue;
      const value = pick(utils.mailText(message.source.toString("utf8")));
      if (value) return { date, value };
    }
    return null;
  } finally {
    lock.release();
  }
}

// The confirmation link in the newest Steam email, or null.
async function findConfirmationLink(mail, since) {
  return withMailbox(mail, (client) => newestAcrossFolders(client, mail, since, utils.extractConfirmationLink));
}

// Waits for Steam's Steam Guard email and submits its code to a pending sign-in. Resolves with
// { submitted: true } or { submitted: false, note } where note says why the user must type the
// code. Only emails received since `since` are used, so an older code is never submitted.
async function submitEmailCode(pendingId, mail, since) {
  const deadline = Date.now() + STEAM_CODE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(STEAM_CODE_POLL_MS);
    let code;
    try {
      code = await withMailbox(mail, (client) =>
        newestAcrossFolders(client, mail, since, utils.extractSteamGuardCode),
      );
    } catch (error) {
      return { submitted: false, note: `Could not read the mailbox: ${mailErrorText(error)}.` };
    }
    if (!code) continue;
    try {
      await steamAuth.submitCode(pendingId, code);
      return { submitted: true };
    } catch (error) {
      return { submitted: false, note: `The code from the email was not accepted: ${error.message}` };
    }
  }
  return { submitted: false, note: "No Steam Guard email reached the mailbox in time." };
}

// Waits for a Steam Guard email received since `since` and returns its code, without submitting
// it anywhere. Used by a separate Steam login (the CS2 license request). Throws when the mailbox
// cannot be read or no code arrives in time.
async function waitForMailCode(mail, since) {
  const deadline = Date.now() + STEAM_CODE_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(STEAM_CODE_POLL_MS);
    const code = await withMailbox(mail, (client) =>
      newestAcrossFolders(client, mail, since, utils.extractSteamGuardCode),
    );
    if (code) return code;
  }
  throw new Error("No Steam Guard email reached the mailbox in time.");
}

// The newest Steam Guard code in the mailbox from the last `windowMs`, or null. A single check,
// no waiting. The code may belong to any account the mailbox receives, so the caller shows it
// for the user to match against the sign-in.
async function latestGuardCode(mail, windowMs) {
  const since = Date.now() - windowMs;
  return withMailbox(mail, (client) => newestAcrossFolders(client, mail, since, utils.extractSteamGuardCode));
}

// Fills in the Steam Guard email code when Steam asks for one and a mailbox is available.
// Returns { codeFromMail, mailNote } for the renderer. Without a mailbox, nothing happens.
async function submitEmailCodeIfNeeded(start, mail, since) {
  if (!mail || !start.guards.includes("EmailCode")) return { codeFromMail: false, mailNote: null };
  const outcome = await submitEmailCode(start.pendingId, mail, since);
  return { codeFromMail: outcome.submitted, mailNote: outcome.submitted ? null : outcome.note };
}

function status() {
  if (!active) return { open: false, message: null };
  return { open: true, message: active.message };
}

// Called after the user has created the account on Steam's page. Starts the sign-in with the
// credentials the user confirmed (edited values included). When Steam asks for an email code,
// the signup's mailbox is read for it. Otherwise the caller collects the code as usual.
async function complete(input) {
  if (!active) throw new Error("No signup is open.");
  const session = active;
  const { username, password } = utils.validSignupCredentials(input);
  const since = Date.now() - STEAM_CODE_LOOKBACK_MS;
  let result;
  try {
    result = await steamAuth.startLogin(username, password);
  } catch (error) {
    throw new Error(
      `${error.message} If the account is not finished yet, finish the signup on Steam's page and try again.`,
    );
  }
  const mail = session.mail;
  if (active === session) reset();
  const fromMail = await submitEmailCodeIfNeeded(result, mail, since);
  return { ...result, ...fromMail };
}

function cancel() {
  reset();
}

function reset() {
  const session = active;
  active = null;
  if (!session) return;
  clearTimeout(session.expires);
  clearInterval(session.fillTimer);
  session.password = "";
  session.email = "";
  session.username = "";
  session.mail = null;
  if (session.win && !session.win.isDestroyed()) session.win.destroy();
  session.win = null;
}

module.exports = {
  open,
  status,
  complete,
  cancel,
  submitEmailCodeIfNeeded,
  waitForMailCode,
  latestGuardCode,
  STEAM_CODE_LOOKBACK_MS,
  FIELDS,
};
