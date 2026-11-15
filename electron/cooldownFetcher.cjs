// Reads each account's "Personal Game Data" CS2 matchmaking page through a
// per-account Electron web session. The user signs in to Steam's web login once per
// account inside the app; Chromium stores those cookies in the partition, encrypted
// with Windows DPAPI. Nothing secret is written to accounts.json or logged.

const { BrowserWindow, app, session } = require("electron");
const { parseCompetitiveCooldown } = require("./steam-gcpd.cjs");

const COMMUNITY = "https://steamcommunity.com";
const PAGE_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 3_000;

function partitionFor(steamId64) {
  return `persist:acct-${steamId64}`;
}

function gcpdUrl(steamId64) {
  return `${COMMUNITY}/profiles/${steamId64}/gcpd/730/?tab=matchmaking`;
}

// Returns the account's partition session with a plain Chrome user agent, since the
// default Electron agent can be refused by Steam's login page.
function sessionFor(steamId64) {
  const ses = session.fromPartition(partitionFor(steamId64));
  ses.setUserAgent(app.userAgentFallback.replace(/\s*Electron\/\S+/, ""));
  return ses;
}

// steamLoginSecure is "<steamid64>||<token>" (URL-encoded). Only the SteamID is read.
async function loggedInSteamId(steamId64) {
  const cookies = await sessionFor(steamId64).cookies.get({
    url: COMMUNITY,
    name: "steamLoginSecure",
  });
  if (cookies.length === 0) {
    return null;
  }
  const match = decodeURIComponent(cookies[0].value).match(/^(\d{17})\|\|/);
  return match ? match[1] : null;
}

async function isWebSignedIn(steamId64) {
  return (await loggedInSteamId(steamId64)) === steamId64;
}

// Removes every cookie with this name for steamcommunity.com, host-only or domain-wide.
// Without this, an older cookie from a web sign-in can be sent first and shadow the new one.
async function removeCookiesNamed(ses, name) {
  const existing = await ses.cookies.get({ url: COMMUNITY, name });
  for (const cookie of existing) {
    const host = cookie.domain.replace(/^\./, "");
    await ses.cookies.remove(`https://${host}${cookie.path}`, cookie.name);
  }
  return existing.length;
}

// Stores cookies obtained from a saved Steam login in this account's partition, so the
// page read below works the same as after a manual web sign-in. Only names are logged.
async function applySteamCookies(steamId64, cookies) {
  const ses = sessionFor(steamId64);
  const replaced = [];
  for (const cookie of cookies) {
    const removed = await removeCookiesNamed(ses, cookie.name);
    if (removed > 0) replaced.push(`${cookie.name} x${removed}`);
    await ses.cookies.set({
      url: COMMUNITY,
      name: cookie.name,
      value: cookie.value,
      domain: "steamcommunity.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    });
  }
  console.info(
    `[cooldowns] saved login applied for ${steamId64}: set ${cookies.map((c) => c.name).join(", ")}` +
      (replaced.length ? `; replaced ${replaced.join(", ")}` : ""),
  );
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Opens Steam's web login in this account's partition. The user types credentials
// and Steam Guard codes themselves. Resolves when the window closes.
function signInWeb(steamId64) {
  return new Promise((resolve) => {
    sessionFor(steamId64);
    const win = new BrowserWindow({
      width: 980,
      height: 760,
      title: "Sign in to Steam (web)",
      webPreferences: {
        partition: partitionFor(steamId64),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.loadURL(`${COMMUNITY}/login/home/`).catch(() => {});
    win.on("closed", async () => {
      try {
        const signedIn = await loggedInSteamId(steamId64);
        if (signedIn === steamId64) {
          resolve({ ok: true, message: "Web session saved for this account." });
        } else if (signedIn) {
          await sessionFor(steamId64).clearStorageData();
          resolve({
            ok: false,
            message: "Signed in as a different Steam account. Nothing was saved; sign in as this account.",
          });
        } else {
          resolve({ ok: false, message: "Not signed in. Nothing was saved." });
        }
      } catch {
        resolve({ ok: false, message: "Could not read the web session." });
      }
    });
  });
}

// Loads the matchmaking page in a hidden window and parses the cooldown.
// Returns a parser result: cooldown / expired / unknown (never "clear" by absence).
async function readCooldownPage(steamId64) {
  if (!(await isWebSignedIn(steamId64))) {
    return {
      status: "unknown",
      expiresAt: null,
      reason: "No Steam web session for this account. Use Web sign-in first.",
    };
  }

  // One retry when the table is missing: a page can come back as an interstitial or a
  // partial render, and that should not overwrite a readable result on the first try.
  const first = await loadAndParse(steamId64);
  if (!isMissingTable(first)) return first;
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return loadAndParse(steamId64);
}

const MISSING_TABLE_REASON = "Competitive Cooldown Expiration table not found on the page.";

function isMissingTable(result) {
  return result.status === "unknown" && result.reason.startsWith(MISSING_TABLE_REASON);
}

// Loads the page once in a hidden window and parses it. Adds the final URL and page
// title to a missing-table reason so the cause is visible without the page itself.
async function loadAndParse(steamId64) {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: {
      partition: partitionFor(steamId64),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await withTimeout(win.loadURL(gcpdUrl(steamId64)), PAGE_TIMEOUT_MS, "Page load timed out.");
    const finalUrl = win.webContents.getURL();
    if (/steamcommunity\.com\/(login|openid)/i.test(finalUrl)) {
      return {
        status: "unknown",
        expiresAt: null,
        reason: "Steam web session expired. Use Web sign-in again.",
      };
    }
    // Steam serves the profile page instead of the matchmaking page when the session is
    // not accepted for this account's personal data. That is not a parser problem.
    if (!/\/gcpd\/730\//.test(new URL(finalUrl).pathname)) {
      return {
        status: "unknown",
        expiresAt: null,
        reason: `Steam showed the profile page (${new URL(finalUrl).pathname}) instead of the matchmaking page. The saved login was not accepted for this page.`,
      };
    }
    const html = String(await win.webContents.executeJavaScript("document.documentElement.outerHTML", true));
    const result = parseCompetitiveCooldown(html);
    if (isMissingTable(result)) {
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
      const pathOnly = new URL(finalUrl).pathname;
      return {
        ...result,
        reason: `${MISSING_TABLE_REASON} Page: ${pathOnly}, title "${title.slice(0, 80)}".`,
      };
    }
    return result;
  } finally {
    win.destroy();
  }
}

module.exports = {
  isWebSignedIn,
  applySteamCookies,
  signInWeb,
  readCooldownPage,
};
