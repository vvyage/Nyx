const test = require("node:test");
const assert = require("node:assert/strict");
const vault = require("./vault.cjs");

const PASSWORD = "correct horse battery";
const RECORDS = JSON.stringify([{ steamId64: "76561198000000000", refreshToken: "secret-token-value" }]);

test("round-trips records with the master password", async () => {
  const { file } = await vault.createVault(PASSWORD, RECORDS);
  const session = await vault.unlockWithPassword(file, PASSWORD);
  assert.deepEqual(session.readRecords(), JSON.parse(RECORDS));
});

test("wrong master password is rejected", async () => {
  const { file } = await vault.createVault(PASSWORD, RECORDS);
  await assert.rejects(vault.unlockWithPassword(file, "wrong password here"), /Wrong master password/);
});

test("recovery code unlocks the vault, with or without dashes and case", async () => {
  const { file, recoveryCode } = await vault.createVault(PASSWORD, RECORDS);
  const plain = recoveryCode.replace(/-/g, "").toLowerCase();
  const session = await vault.unlockWithRecoveryCode(file, plain);
  assert.deepEqual(session.readRecords(), JSON.parse(RECORDS));
});

test("wrong recovery code is rejected", async () => {
  const { file } = await vault.createVault(PASSWORD, RECORDS);
  await assert.rejects(vault.unlockWithRecoveryCode(file, vault.generateRecoveryCode()), /Wrong master password/);
});

test("stored file does not contain the plaintext token", async () => {
  const { file } = await vault.createVault(PASSWORD, RECORDS);
  assert.equal(JSON.stringify(file).includes("secret-token-value"), false);
});

test("tampered ciphertext fails authentication", async () => {
  const { file } = await vault.createVault(PASSWORD, RECORDS);
  const ct = Buffer.from(file.data.ct, "base64");
  ct[0] ^= 0xff;
  const tampered = { ...file, data: { ...file.data, ct: ct.toString("base64") } };
  const session = await vault.unlockWithPassword(tampered, PASSWORD);
  assert.throws(() => session.readRecords());
});

test("writeRecords persists new records readable after reopen", async () => {
  const { file } = await vault.createVault(PASSWORD, "[]");
  const session = await vault.unlockWithPassword(file, PASSWORD);
  const next = session.writeRecords([{ steamId64: "76561198000000001", refreshToken: "t2" }]);
  const reopened = await vault.unlockWithPassword(next, PASSWORD);
  assert.deepEqual(reopened.readRecords(), [{ steamId64: "76561198000000001", refreshToken: "t2" }]);
});

test("changing the master password invalidates the old one", async () => {
  const { file } = await vault.createVault(PASSWORD, RECORDS);
  const session = await vault.unlockWithPassword(file, PASSWORD);
  const changed = await session.changeMasterPassword("a new master password");
  await assert.rejects(vault.unlockWithPassword(changed, PASSWORD), /Wrong master password/);
  const reopened = await vault.unlockWithPassword(changed, "a new master password");
  assert.deepEqual(reopened.readRecords(), JSON.parse(RECORDS));
});

test("locked session refuses to read", async () => {
  const { file } = await vault.createVault(PASSWORD, RECORDS);
  const session = await vault.unlockWithPassword(file, PASSWORD);
  session.lock();
  assert.throws(() => session.readRecords(), /locked/);
});

test("short master password is refused", async () => {
  await assert.rejects(vault.createVault("short"), /at least 10/);
});
