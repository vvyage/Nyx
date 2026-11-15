const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseActiveUser } = require("./steamClient.cjs");

// 0x265aeeb2 is the 32-bit account ID; adding the SteamID64 base gives 76561198603759282.
const SAMPLE = (pid, activeUser) => `HKEY_CURRENT_USER\\Software\\Valve\\Steam\\ActiveProcess
    pid    REG_DWORD    ${pid}
    SteamClientDll    REG_SZ    c:\\program files (x86)\\steam\\steamclient.dll
    Universe    REG_SZ    Public
    ActiveUser    REG_DWORD    ${activeUser}
`;

test("active user is returned when Steam has a running process", () => {
  assert.equal(parseActiveUser(SAMPLE("0x7290", "0x265aeeb2")), "76561198603759282");
});

test("a zero pid means no account is signed in, even if ActiveUser keeps a value", () => {
  assert.equal(parseActiveUser(SAMPLE("0x0", "0x265aeeb2")), null);
});

test("a zero ActiveUser means no account is signed in", () => {
  assert.equal(parseActiveUser(SAMPLE("0x7290", "0x0")), null);
});

test("missing values return null", () => {
  assert.equal(parseActiveUser(""), null);
  assert.equal(parseActiveUser("    ActiveUser    REG_DWORD    0x265aeeb2"), null);
});
