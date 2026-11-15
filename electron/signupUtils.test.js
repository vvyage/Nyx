const test = require("node:test");
const assert = require("node:assert/strict");
const utils = require("./signupUtils.cjs");

test("generated usernames are valid Steam account names", () => {
  for (let i = 0; i < 50; i++) {
    const name = utils.generateUsername();
    assert.match(name, /^[a-z0-9_]{3,32}$/);
  }
});

test("generated passwords have all four character classes and the right length", () => {
  for (let i = 0; i < 50; i++) {
    const password = utils.generatePassword();
    assert.equal(password.length, 20);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /\d/);
    assert.match(password, /[!@#$%^&*]/);
  }
});

test("generated passwords differ between calls", () => {
  assert.notEqual(utils.generatePassword(), utils.generatePassword());
});

test("validEmail accepts a plain address and rejects malformed ones", () => {
  assert.equal(utils.validEmail(" me@example.com "), "me@example.com");
  assert.throws(() => utils.validEmail("not-an-email"), /valid email/);
  assert.throws(() => utils.validEmail(""), /valid email/);
  assert.throws(() => utils.validEmail(undefined), /valid email/);
});

test("normalizeMailConfig defaults the port to 993 and trims text fields", () => {
  const config = utils.normalizeMailConfig({ host: " imap.example.com ", user: " me ", password: "pw" });
  assert.deepEqual(config, { host: "imap.example.com", port: 993, user: "me", password: "pw" });
});

test("normalizeMailConfig rejects bad host, port, or missing fields", () => {
  assert.throws(() => utils.normalizeMailConfig({ host: "bad host", user: "me", password: "pw" }), /host/);
  assert.throws(() => utils.normalizeMailConfig({ host: "imap.x.com", port: 70000, user: "me", password: "pw" }), /port/);
  assert.throws(() => utils.normalizeMailConfig({ host: "imap.x.com", user: "", password: "pw" }), /login/);
  assert.throws(() => utils.normalizeMailConfig({ host: "imap.x.com", user: "me", password: "" }), /password/);
});

test("extractVerificationCode finds a 5-character Steam code", () => {
  const body = "Hi,\n\nYour Steam account verification code is: K7P9Q\n\nThanks";
  assert.equal(utils.extractVerificationCode(body), "K7P9Q");
});

test("extractVerificationCode returns null when no code is present", () => {
  assert.equal(utils.extractVerificationCode("Welcome to Steam, enjoy your games."), null);
  assert.equal(utils.extractVerificationCode("code is hello there"), null);
});

test("decodeQuotedPrintable joins soft breaks so a split code is found", () => {
  const raw = "verification code: K7P=\r\n9Q";
  assert.equal(utils.extractVerificationCode(utils.decodeQuotedPrintable(raw)), "K7P9Q");
});

test("presetForEmail suggests Gmail for gmail.com and nothing for other domains", () => {
  assert.equal(utils.presetForEmail("me@gmail.com").id, "gmail");
  assert.equal(utils.presetForEmail("ME@Hotmail.com").id, "outlook");
  assert.equal(utils.presetForEmail("me@example.org"), null);
});

test("spamFolderFor uses the preset folder, or Spam for a custom host", () => {
  assert.equal(utils.spamFolderFor("imap.gmail.com"), "[Gmail]/Spam");
  assert.equal(utils.spamFolderFor("imap.example.com"), "Spam");
});

test("validSignupCredentials accepts Steam-style names and rejects others", () => {
  assert.deepEqual(utils.validSignupCredentials({ username: " sah_abc12 ", password: "longenough1" }), {
    username: "sah_abc12",
    password: "longenough1",
  });
  assert.throws(() => utils.validSignupCredentials({ username: "no spaces", password: "longenough1" }), /account name/);
  assert.throws(() => utils.validSignupCredentials({ username: "ok_name", password: "short" }), /password/);
});

test("extractConfirmationLink returns a steampowered.com confirmation link from HTML", () => {
  const html =
    '<p><a href="https://help.steampowered.com/faq">Help</a></p>' +
    '<a href="https://store.steampowered.com/account/confirm?token=abc&amp;x=1">Confirm my email</a>';
  assert.equal(utils.extractConfirmationLink(html), "https://store.steampowered.com/account/confirm?token=abc&x=1");
});

test("extractConfirmationLink rejects non-Steam, non-https, and help-only links", () => {
  assert.equal(utils.extractConfirmationLink('<a href="https://evil.example.com/confirm">x</a>'), null);
  assert.equal(utils.extractConfirmationLink('<a href="http://store.steampowered.com/confirm">x</a>'), null);
  assert.equal(utils.extractConfirmationLink('<a href="https://help.steampowered.com/faq">x</a>'), null);
  assert.equal(utils.extractConfirmationLink("no links here"), null);
});

test("extractConfirmationLink works on quoted-printable mail once decoded", () => {
  const raw = 'href=3D"https://store.steampowered.com/verify?t=3Dxyz"';
  assert.equal(
    utils.extractConfirmationLink(utils.decodeQuotedPrintable(raw)),
    "https://store.steampowered.com/verify?t=xyz",
  );
});
