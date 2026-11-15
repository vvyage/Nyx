// Parses user input into a SteamID64 and reads public profile info.
// Only the persona name and avatar URL are returned; nothing is stored here.

// Steam serves avatars from these hosts; they must match the renderer CSP img-src.
// The public XML currently returns avatars.akamai.steamstatic.com; the others are also served.
const AVATAR_HOSTS = new Set([
  "avatars.steamstatic.com",
  "avatars.fastly.steamstatic.com",
  "avatars.akamai.steamstatic.com",
]);

function isSteamAvatarUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && AVATAR_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// Accepts a 17-digit SteamID64, or a steamcommunity.com /profiles/<id> link
// (with or without scheme or trailing path). Vanity /id/ links return null.
function parseSteamIdInput(input) {
  const text = String(input ?? "").trim();
  if (/^\d{17}$/.test(text)) {
    return text;
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "steamcommunity.com") {
    return null;
  }
  const match = url.pathname.match(/^\/profiles\/(\d{17})(?:\/|$)/);
  return match ? match[1] : null;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return match ? decodeEntities(match[1]).trim() : null;
}

// Parses the public profile XML (?xml=1). Returns null when Steam reports an error.
function parseProfileXml(xml) {
  if (/<error>/.test(xml)) {
    return null;
  }
  const profileName = readTag(xml, "steamID") || null;
  const avatar = readTag(xml, "avatarFull");
  return {
    profileName,
    // Only Steam's avatar host is accepted, matching the renderer CSP.
    avatarUrl: avatar && isSteamAvatarUrl(avatar) ? avatar : null,
  };
}

// A browser-like User-Agent, so Steam does not treat the request as a bot.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Throws on HTTP errors and network failures, so the caller can retry and log the reason.
async function fetchProfileSummary(steamId64, fetchImpl = fetch) {
  const response = await fetchImpl(`https://steamcommunity.com/profiles/${steamId64}/?xml=1`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Steam profile returned HTTP ${response.status}`);
  }
  return parseProfileXml(await response.text());
}

module.exports = { parseSteamIdInput, parseProfileXml, fetchProfileSummary };
