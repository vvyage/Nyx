// Pure helpers for the assisted signup: generated credentials, mailbox settings checks,
// and verification-code parsing. No Electron or network access, so they are unit-tested.

const crypto = require("node:crypto");

const USERNAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
const PASSWORD_LENGTH = 20;

function randomFrom(chars, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

// Steam account names use letters, digits, and underscores (3 to 32 characters).
function generateUsername() {
  return `sah_${randomFrom(USERNAME_CHARS, 10)}`;
}

// A random password that has a lowercase letter, an uppercase letter, a digit, and a symbol.
function generatePassword() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const password = randomFrom(PASSWORD_CHARS, PASSWORD_LENGTH);
    if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[!@#$%^&*]/.test(password)) {
      return password;
    }
  }
  throw new Error("Could not generate a password. Try again.");
}

function validEmail(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new Error("Enter a valid email address for the new account.");
  }
  return text;
}

// Checks the mailbox settings the app uses to read the verification email.
// The mailbox password is passed through as typed; it is never stored.
function normalizeMailConfig(input) {
  const host = typeof input?.host === "string" ? input.host.trim() : "";
  const user = typeof input?.user === "string" ? input.user.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  const port = input?.port === undefined || input?.port === "" ? 993 : Number(input.port);
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error("Enter the mail server host, e.g. imap.gmail.com.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Mail port must be between 1 and 65535.");
  if (!user || user.length > 254) throw new Error("Enter the mailbox login.");
  if (!password || password.length > 500) throw new Error("Enter the mailbox password or app password.");
  return { host, port, user, password };
}

// Steam's verification codes are 5 characters, uppercase letters and digits. A line that
// mentions "code" or "verification" is searched for a 5-character token that has a digit,
// or that ends the line (so a plain-word token like "STEAM" is not mistaken for a code).
function extractVerificationCode(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const keyword = /[Cc]ode|[Vv]erification/.exec(line);
    if (!keyword) continue;
    const rest = line.slice(keyword.index + keyword[0].length);
    for (const match of rest.matchAll(/(?<![A-Za-z0-9])([A-Z0-9]{5})(?![A-Za-z0-9])/g)) {
      const value = match[1];
      const after = rest.slice(match.index + value.length);
      if (/\d/.test(value) || /^[^A-Za-z0-9]*$/.test(after)) return value;
    }
  }
  return null;
}

// Undoes quoted-printable encoding enough to read short codes in an email body.
function decodeQuotedPrintable(text) {
  return String(text)
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Reads the 5-character Steam Guard code from a sign-in email. HTML tags become line breaks
// first, so a code in its own table cell is found too.
function extractSteamGuardCode(raw) {
  const lines = String(raw)
    .replace(/<[^>]+>/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const direct = extractVerificationCode(lines.join("\n"));
  if (direct) return direct;
  // A code alone on the line after a "code" line, as in an HTML cell.
  for (let i = 0; i < lines.length - 1; i++) {
    const next = lines[i + 1];
    if (/[Cc]ode|[Vv]erification/.test(lines[i]) && /^[A-Z0-9]{5}$/.test(next) && /\d/.test(next)) return next;
  }
  return null;
}

// Decodes the body of a raw message as text the code and link finders can search: the
// quoted-printable text, plus any base64 lines decoded in place (base64 mail bodies are
// written as lines of 76 characters).
function mailText(source) {
  const text = decodeQuotedPrintable(source);
  const decoded = [];
  for (const line of text.match(/^[A-Za-z0-9+/]{40,}={0,2}$/gm) || []) {
    decoded.push(Buffer.from(line, "base64").toString("utf8"));
  }
  return decoded.length ? `${text}\n${decoded.join("\n")}` : text;
}

// IMAP settings for common providers. The renderer keeps a matching list (mailPresets.ts).
const MAIL_PRESETS = [
  { id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, spam: "[Gmail]/Spam", domains: ["gmail.com", "googlemail.com"] },
  { id: "outlook", label: "Outlook / Hotmail", host: "outlook.office365.com", port: 993, spam: "Junk Email", domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"] },
  { id: "yahoo", label: "Yahoo", host: "imap.mail.yahoo.com", port: 993, spam: "Bulk", domains: ["yahoo.com"] },
  { id: "icloud", label: "iCloud", host: "imap.mail.me.com", port: 993, spam: "Junk", domains: ["icloud.com", "me.com"] },
];

function presetForEmail(email) {
  const domain = String(email || "").split("@")[1]?.toLowerCase();
  return MAIL_PRESETS.find((preset) => preset.domains.includes(domain)) || null;
}

// The spam folder name for a host: a preset's folder, or "Spam" for a custom server.
function spamFolderFor(host) {
  const preset = MAIL_PRESETS.find((p) => p.host === host);
  return preset ? preset.spam : "Spam";
}

// Steam account names: letters, digits, and underscores (3 to 32 characters).
// Passwords: 8 to 64 characters.
function validSignupCredentials(input) {
  const username = typeof input?.username === "string" ? input.username.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    throw new Error("The account name must be 3 to 32 letters, digits, or underscores.");
  }
  if (password.length < 8 || password.length > 64) throw new Error("The password must be 8 to 64 characters.");
  return { username, password };
}

// Finds the link in a decoded Steam email that confirms the new account (decode the raw
// message with decodeQuotedPrintable first). Only https links on steampowered.com (or a
// subdomain) are accepted. Links that look like confirmations are preferred. Help and
// support links are never returned.
function extractConfirmationLink(text) {
  const decoded = String(text).replace(/&amp;/g, "&").replace(/&#x3D;/gi, "=").replace(/&#61;/g, "=");
  const candidates = [];
  for (const match of decoded.matchAll(/https:\/\/[^\s"'<>()]+/g)) {
    const raw = match[0].replace(/[.,;:]+$/, "");
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const host = url.hostname.toLowerCase();
    if (host !== "steampowered.com" && !host.endsWith(".steampowered.com")) continue;
    if (host.startsWith("help.") || host.startsWith("support.")) continue;
    candidates.push(url.href);
  }
  return candidates.find((href) => /confirm|verif|activat/i.test(href)) || null;
}

module.exports = {
  generateUsername,
  generatePassword,
  validEmail,
  normalizeMailConfig,
  extractVerificationCode,
  extractSteamGuardCode,
  decodeQuotedPrintable,
  mailText,
  MAIL_PRESETS,
  presetForEmail,
  spamFolderFor,
  validSignupCredentials,
  extractConfirmationLink,
};
