const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTokenVault } = require("./tokenVault.cjs");

const PASSWORD = "correct horse battery";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sah-vault-"));
  return { dir, file: path.join(dir, "vault.json") };
}

test("setup unlocks and tokens round-trip across lock and unlock", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createTokenVault(file);
    assert.deepEqual(store.status(), { exists: false, unlocked: false });
    const { recoveryCode } = await store.setup(PASSWORD);
    assert.match(recoveryCode, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    store.saveToken("76561198000000001", "token-a");
    store.saveToken("76561198000000002", "token-b");
    store.saveToken("76561198000000001", "token-a2");
    assert.equal(store.getToken("76561198000000001"), "token-a2");

    store.lock();
    assert.throws(() => store.getToken("76561198000000001"), /locked/);

    const reopened = createTokenVault(file);
    await reopened.unlock(PASSWORD);
    assert.equal(reopened.getToken("76561198000000002"), "token-b");
    assert.equal(reopened.getToken("76561198000000009"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wrong password is rejected and the vault stays locked", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createTokenVault(file);
    await store.setup(PASSWORD);
    store.lock();
    await assert.rejects(store.unlock("not the password"), /Wrong master password/);
    assert.equal(store.isUnlocked(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery code unlocks the vault and removeToken deletes the record", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createTokenVault(file);
    const { recoveryCode } = await store.setup(PASSWORD);
    store.saveToken("76561198000000001", "token-a");
    store.lock();

    const recovered = createTokenVault(file);
    await recovered.unlockWithRecovery(recoveryCode.toLowerCase());
    assert.equal(recovered.getToken("76561198000000001"), "token-a");
    recovered.removeToken("76561198000000001");
    assert.equal(recovered.getToken("76561198000000001"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup refuses to overwrite an existing vault", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createTokenVault(file);
    await store.setup(PASSWORD);
    await assert.rejects(createTokenVault(file).setup(PASSWORD), /already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the vault file does not contain the plaintext token", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createTokenVault(file);
    await store.setup(PASSWORD);
    store.saveToken("76561198000000001", "SECRET-REFRESH-TOKEN-VALUE");
    assert.equal(fs.readFileSync(file, "utf8").includes("SECRET-REFRESH-TOKEN-VALUE"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mail settings are stored encrypted and do not disturb saved tokens", async () => {
  const { dir, file } = tempFile();
  try {
    const store = createTokenVault(file);
    await store.setup(PASSWORD);
    assert.equal(store.getMailSettings(), null);
    store.saveToken("76561198000000001", "token-a");
    store.saveMailSettings({ email: "me@gmail.com", host: "imap.gmail.com", port: 993, user: "me@gmail.com", password: "abcd efgh ijkl mnop" });
    store.saveMailSettings({ email: "me@gmail.com", host: "imap.gmail.com", port: 993, user: "me@gmail.com", password: "new app pass 1234" });
    assert.equal(store.getMailSettings().password, "new app pass 1234");
    assert.equal(store.getToken("76561198000000001"), "token-a");

    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("new app pass"), "mail password must not be stored in plaintext");

    const reopened = createTokenVault(file);
    await reopened.unlock(PASSWORD);
    assert.equal(reopened.getMailSettings().host, "imap.gmail.com");
    reopened.removeMailSettings();
    assert.equal(reopened.getMailSettings(), null);
    assert.equal(reopened.getToken("76561198000000001"), "token-a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
