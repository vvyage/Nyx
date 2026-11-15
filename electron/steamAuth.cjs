// Steam sign-in through steam-session, used to obtain a refresh token for one account.
// The password and Steam Guard codes are passed straight to steam-session and never
// stored, logged, or sent back to the renderer. Only the refresh token is kept, and
// only inside the encrypted token vault (tokenVault.cjs).

const crypto = require("node:crypto");
const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType, EResult } = require("steam-session");

// Login attempts that are never finished are cancelled after this long.
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const pending = new Map();

const FRIENDLY = {
  [EResult.InvalidPassword]: "Wrong password.",
  [EResult.TwoFactorCodeMismatch]: "Steam Guard code is wrong or expired. Enter the current code.",
  [EResult.InvalidLoginAuthCode]: "Steam Guard code is wrong or expired. Check the email and enter the newest code.",
  [EResult.RateLimitExceeded]: "Steam is rate-limiting sign-ins. Wait a while before trying again.",
};

function friendlyError(error) {
  const code = error && typeof error.eresult === "number" ? error.eresult : null;
  if (code !== null && FRIENDLY[code]) return new Error(FRIENDLY[code]);
  const name = error && error.message ? error.message : "Sign-in failed.";
  return new Error(`Steam sign-in failed: ${name}`);
}

function guardName(type) {
  return EAuthSessionGuardType[type] || "Unknown";
}

// Starts a sign-in with the account name and password. Resolves with the Steam Guard
// methods Steam requires, or an empty list when no code is needed.
async function startLogin(accountName, password) {
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  const done = new Promise((resolve, reject) => {
    session.on("authenticated", () => {
      resolve({
        steamId64: session.steamID.getSteamID64(),
        refreshToken: session.refreshToken,
      });
    });
    session.on("error", (error) => reject(friendlyError(error)));
    session.on("timeout", () => reject(new Error("Steam Guard approval timed out.")));
  });
  done.catch(() => {});

  let result;
  try {
    result = await session.startWithCredentials({ accountName, password });
  } catch (error) {
    throw friendlyError(error);
  }

  const pendingId = crypto.randomUUID();
  const timer = setTimeout(() => cancelPending(pendingId), PENDING_TIMEOUT_MS);
  pending.set(pendingId, { session, done, timer });

  const guards = result.actionRequired ? result.validActions.map((action) => guardName(action.type)) : [];
  return { pendingId, guards };
}

// Submits an email or authenticator code for a pending sign-in.
async function submitCode(pendingId, code) {
  const entry = requirePending(pendingId);
  try {
    await entry.session.submitSteamGuardCode(code);
  } catch (error) {
    throw friendlyError(error);
  }
}

// Waits for the sign-in to finish (after a code, or after approval in the Steam app).
// Resolves with the signed-in SteamID64 and refresh token.
async function finishLogin(pendingId) {
  const entry = requirePending(pendingId);
  try {
    return await entry.done;
  } finally {
    cancelPending(pendingId);
  }
}

function cancelPending(pendingId) {
  const entry = pending.get(pendingId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(pendingId);
  try {
    entry.session.cancelLoginAttempt();
  } catch {
    // The attempt may already be finished.
  }
}

function cancelAllPending() {
  for (const id of [...pending.keys()]) cancelPending(id);
}

function requirePending(pendingId) {
  const entry = pending.get(pendingId);
  if (!entry) throw new Error("This sign-in attempt has expired. Start again.");
  return entry;
}

// Turns a stored refresh token into the cookies the community site needs: { name, value,
// domain }. steam-session returns cookies for several Steam hosts (login, store, and so
// on), each with its own steamLoginSecure. Only steamcommunity.com cookies are kept, so
// a cookie meant for another host is never written as the community login.
async function webCookiesFor(refreshToken) {
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  session.refreshToken = refreshToken;
  let lines;
  try {
    lines = await session.getWebCookies();
  } catch (error) {
    throw friendlyError(error);
  }
  const cookies = lines.map(parseCookieDetails).filter((cookie) => cookie && cookie.domain === "steamcommunity.com");
  if (!cookies.some((cookie) => cookie.name === "steamLoginSecure")) {
    throw new Error("Steam returned no community login cookie.");
  }
  return cookies;
}

// Like parseCookieLine, but also returns the Domain attribute (leading dot removed,
// lower-cased), or "" when the line has none.
function parseCookieDetails(line) {
  const cookie = parseCookieLine(line);
  if (!cookie) return null;
  const attribute = String(line)
    .split(";")
    .map((part) => part.trim())
    .find((part) => /^domain=/i.test(part));
  const domain = attribute ? attribute.slice("domain=".length).replace(/^\./, "").toLowerCase() : "";
  return { ...cookie, domain };
}

// Parses "name=value; Path=/; Secure; ..." into { name, value }. Attributes are ignored:
// the caller sets its own domain, path, and flags.
function parseCookieLine(line) {
  const first = String(line).split(";")[0];
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  return name && value ? { name, value } : null;
}

module.exports = {
  startLogin,
  submitCode,
  finishLogin,
  cancelAllPending,
  webCookiesFor,
  parseCookieLine,
  parseCookieDetails,
};
