// Parser for the Steam Community CS2 "Personal Game Data" matchmaking page:
//   https://steamcommunity.com/profiles/<steamid64>/gcpd/730/?tab=matchmaking
// Pure functions only: no network, no cookies, no credentials.
//
// Real markup (verified against saved pages): each table has a <th> header row,
// then one <tr> whose <td> cells line up with the headers by position.

const COOLDOWN_HEADER = "Competitive Cooldown Expiration";
const NO_DATA_MARKER = /no_personal_data_stored_message|No personal game data stored/i;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns an ISO-8601 UTC string for a "YYYY-MM-DD HH:MM:SS GMT" value, or null.
function parseSteamGmtTimestamp(text) {
  const match = TIMESTAMP_PATTERN.exec(String(text).trim());
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cellsOf(rowHtml, tag) {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...rowHtml.matchAll(pattern)].map((m) => htmlToText(m[1]));
}

// Finds the value under the cooldown header, matched by column position.
function findCooldownCell(html) {
  const tables = [...String(html).matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  for (const [, tableBody] of tables) {
    const rows = [...tableBody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
    const headerIndex = rows.findIndex((row) =>
      cellsOf(row, "th").includes(COOLDOWN_HEADER),
    );
    if (headerIndex === -1) {
      continue;
    }
    const column = cellsOf(rows[headerIndex], "th").indexOf(COOLDOWN_HEADER);
    const valueRow = rows.slice(headerIndex + 1).find((row) => cellsOf(row, "td").length > 0);
    if (!valueRow) {
      return { found: true, value: null };
    }
    return { found: true, value: cellsOf(valueRow, "td")[column] ?? null };
  }
  return { found: false, value: null };
}

/**
 * Reads the "Competitive Cooldown Expiration" value.
 * status:
 *   "cooldown" - timestamp is in the future (active countdown)
 *   "expired"  - timestamp is in the past
 *   "clear"    - Steam reports no personal game data for matchmaking (no cooldown).
 *   "unknown"  - row missing, blank, or unparseable. Never treated as "no cooldown".
 */
function parseCompetitiveCooldown(html, now = new Date()) {
  const cell = findCooldownCell(html);

  if (!cell.found) {
    // Steam's own "no data" message means the account has no matchmaking history, so no
    // cooldown can exist. Any other missing table stays unknown.
    if (NO_DATA_MARKER.test(String(html))) {
      return {
        status: "clear",
        expiresAt: null,
        reason: "No personal game data stored for CS2 Matchmaking on this account.",
      };
    }
    return {
      status: "unknown",
      expiresAt: null,
      reason: "Competitive Cooldown Expiration table not found on the page.",
    };
  }

  const expiresAt = parseSteamGmtTimestamp(cell.value ?? "");
  if (!expiresAt) {
    return {
      status: "unknown",
      expiresAt: null,
      reason: "Competitive Cooldown Expiration cell is blank or unreadable.",
    };
  }

  const isFuture = Date.parse(expiresAt) > now.getTime();
  return {
    status: isFuture ? "cooldown" : "expired",
    expiresAt,
    reason: isFuture ? "Cooldown active until expiresAt." : "Cooldown timestamp is in the past.",
  };
}

module.exports = {
  htmlToText,
  parseSteamGmtTimestamp,
  parseCompetitiveCooldown,
};
