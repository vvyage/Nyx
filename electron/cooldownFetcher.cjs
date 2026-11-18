// Reads each account's "Personal Game Data" CS2 matchmaking page through a
// per-account Electron session. Before each read, main.cjs applies the account's saved
// login cookies to that session (applySteamCookies). Nothing secret is written to
// accounts.json or logged.

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

// Removes every cookie with this name for steamcommunity.com, host-only or domain-wide.
// Without this, an older cookie can be sent first and shadow the new one.
async function removeCookiesNamed(ses, name) {
  const existing = await ses.cookies.get({ url: COMMUNITY, name });
  for (const cookie of existing) {
    const host = cookie.domain.replace(/^\./, "");
    await ses.cookies.remove(`https://${host}${cookie.path}`, cookie.name);
  }
  return existing.length;
}

// Stores cookies obtained from a saved Steam login in this account's partition, replacing
// any earlier ones. Only names are logged.
async function applySteamCookies(steamId64, cookies) {
  const ses = sessionFor(steamId64);
  for (const cookie of cookies) {
    await removeCookiesNamed(ses, cookie.name);
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
  console.info(`[cooldowns] saved login applied for ${steamId64}: set ${cookies.map((c) => c.name).join(", ")}`);
}

// Clears everything stored for an account's session. Called when the account is removed.
async function forgetSession(steamId64) {
  await sessionFor(steamId64).clearStorageData();
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Loads the matchmaking page in a hidden window and parses the cooldown.
// Returns a parser result: cooldown / expired / unknown (never "clear" by absence).
// The caller must apply the account's saved login first.
async function readCooldownPage(steamId64) {
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
        reason: "Steam sent the page to its login. The saved login was not accepted. Save the login again.",
      };
    }
    // Steam serves the profile page instead of the matchmaking page when the login is not
    // accepted for this account's personal data. That is not a parser problem.
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
  applySteamCookies,
  forgetSession,
  readCooldownPage,
};
