const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSteamIdInput, parseProfileXml } = require("./steamProfile.cjs");

test("accepts a bare SteamID64", () => {
  assert.equal(parseSteamIdInput("76561198605042789"), "76561198605042789");
});

test("accepts a full profile link with and without scheme or trailing path", () => {
  const id = "76561198605042789";
  assert.equal(parseSteamIdInput(`https://steamcommunity.com/profiles/${id}`), id);
  assert.equal(parseSteamIdInput(`https://steamcommunity.com/profiles/${id}/`), id);
  assert.equal(parseSteamIdInput(`https://www.steamcommunity.com/profiles/${id}/gcpd/730/`), id);
  assert.equal(parseSteamIdInput(`steamcommunity.com/profiles/${id}`), id);
  assert.equal(parseSteamIdInput(`  https://steamcommunity.com/profiles/${id}  `), id);
});

test("rejects vanity, foreign hosts, and malformed input", () => {
  assert.equal(parseSteamIdInput("https://steamcommunity.com/id/somename"), null);
  assert.equal(parseSteamIdInput("https://example.com/profiles/76561198605042789"), null);
  assert.equal(parseSteamIdInput("https://steamcommunity.com/profiles/123"), null);
  assert.equal(parseSteamIdInput("not a steam thing"), null);
  assert.equal(parseSteamIdInput(""), null);
  assert.equal(parseSteamIdInput(undefined), null);
});

test("parses persona name and avatar from profile XML", () => {
  const xml = `<?xml version="1.0"?><profile><steamID><![CDATA[Ginger &amp; Co]]></steamID>
<avatarFull><![CDATA[https://avatars.steamstatic.com/abc_full.jpg]]></avatarFull></profile>`;
  assert.deepEqual(parseProfileXml(xml), {
    profileName: "Ginger & Co",
    avatarUrl: "https://avatars.steamstatic.com/abc_full.jpg",
  });
});

test("accepts Steam's akamai avatar host returned by the public XML", () => {
  const akamai = `<profile><steamID><![CDATA[gingerbottom]]></steamID><avatarFull><![CDATA[https://avatars.akamai.steamstatic.com/3cf_full.jpg]]></avatarFull></profile>`;
  assert.deepEqual(parseProfileXml(akamai), {
    profileName: "gingerbottom",
    avatarUrl: "https://avatars.akamai.steamstatic.com/3cf_full.jpg",
  });
});

test("accepts Steam's fastly avatar host and drops other hosts and plain http", () => {
  const fastly = `<profile><steamID>x</steamID><avatarFull><![CDATA[https://avatars.fastly.steamstatic.com/a_full.jpg]]></avatarFull></profile>`;
  assert.equal(parseProfileXml(fastly).avatarUrl, "https://avatars.fastly.steamstatic.com/a_full.jpg");
  const foreign = `<profile><steamID>x</steamID><avatarFull>https://evil.example/a.jpg</avatarFull></profile>`;
  assert.deepEqual(parseProfileXml(foreign), { profileName: "x", avatarUrl: null });
  const insecure = `<profile><steamID>x</steamID><avatarFull>http://avatars.steamstatic.com/a.jpg</avatarFull></profile>`;
  assert.equal(parseProfileXml(insecure).avatarUrl, null);
  assert.equal(parseProfileXml("<response><error>The specified profile could not be found.</error></response>"), null);
});
