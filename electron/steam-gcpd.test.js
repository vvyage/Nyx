const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSteamGmtTimestamp,
  parseCompetitiveCooldown,
} = require("./steam-gcpd.cjs");

// Fixtures copied from real saved pages (only the relevant table, no account data).
const cooldownTable = (value) => `
<div id="personaldata_elements_container">
<table class="generic_kv_table"><tbody><tr>
<th>Competitive Cooldown Expiration</th>
<th>Competitive Cooldown Level</th>
<th>Acknowledged</th>
</tr>
<tr>
<td>${value}</td><td>&nbsp;</td><td>No</td>
</tr>
</tbody></table>
<br><br><br><table class="generic_kv_table"><tbody><tr>
<th>Matchmaking Mode</th>
<th>Last Match</th>
</tr>
<tr>
<td>Casual</td><td>2026-11-14 07:37:29 GMT</td>
</tr>
</tbody></table>
</div>`;

const noDataPage = `
<div id="no_personal_data_stored_message">
No personal game data stored for Counter-Strike 2 "Matchmaking".
</div>`;

const NOW = new Date("2026-11-14T07:56:00Z");

test("parses a GMT timestamp into ISO UTC", () => {
  assert.equal(
    parseSteamGmtTimestamp("2026-11-15 03:33:51 GMT"),
    "2026-11-15T03:33:51.000Z",
  );
});

test("gingerbottom page: future cooldown is active with absolute expiry", () => {
  const result = parseCompetitiveCooldown(cooldownTable("2026-11-15 03:33:51 GMT"), NOW);

  assert.equal(result.status, "cooldown");
  assert.equal(result.expiresAt, "2026-11-15T03:33:51.000Z");
});

test("voyage page: past cooldown timestamp is expired, not active", () => {
  const result = parseCompetitiveCooldown(cooldownTable("2026-11-05 15:09:55 GMT"), NOW);

  assert.equal(result.status, "expired");
  assert.equal(result.expiresAt, "2026-11-05T15:09:55.000Z");
});

test("lanker page: no personal game data is clear (no matchmaking cooldown)", () => {
  const result = parseCompetitiveCooldown(noDataPage, NOW);

  assert.equal(result.status, "clear");
  assert.equal(result.expiresAt, null);
  assert.match(result.reason, /No personal game data stored/);
});

test("blank cooldown cell is unknown, never clear", () => {
  const result = parseCompetitiveCooldown(cooldownTable("&nbsp;"), NOW);

  assert.equal(result.status, "unknown");
  assert.equal(result.expiresAt, null);
});

test("a page with no cooldown table or no-data marker is unknown", () => {
  const result = parseCompetitiveCooldown("<html><body>Sign in</body></html>", NOW);

  assert.equal(result.status, "unknown");
});

test("unrelated dates in other tables are ignored", () => {
  const html = cooldownTable("&nbsp;");
  const result = parseCompetitiveCooldown(html, NOW);

  assert.equal(result.status, "unknown");
});
