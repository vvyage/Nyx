const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCookieLine, parseCookieDetails } = require("./steamAuth.cjs");

test("reads the Domain attribute, without a leading dot, lower-cased", () => {
  assert.deepEqual(
    parseCookieDetails("steamLoginSecure=abc; Path=/; Secure; Domain=.SteamCommunity.com"),
    { name: "steamLoginSecure", value: "abc", domain: "steamcommunity.com" },
  );
  assert.deepEqual(parseCookieDetails("sessionid=1; Path=/"), { name: "sessionid", value: "1", domain: "" });
  assert.equal(parseCookieDetails("=value; Domain=steamcommunity.com"), null);
});

test("parses a bare name=value cookie", () => {
  assert.deepEqual(parseCookieLine("steamLoginSecure=76561198000000001%7C%7Ctoken"), {
    name: "steamLoginSecure",
    value: "76561198000000001%7C%7Ctoken",
  });
});

test("ignores cookie attributes", () => {
  assert.deepEqual(
    parseCookieLine("steamLoginSecure=abc==; Path=/; Secure; HttpOnly; SameSite=None; Domain=steamcommunity.com"),
    { name: "steamLoginSecure", value: "abc==" },
  );
});

test("rejects lines without a name or value", () => {
  assert.equal(parseCookieLine("=value"), null);
  assert.equal(parseCookieLine("name="), null);
  assert.equal(parseCookieLine("no-equals-sign"), null);
});
