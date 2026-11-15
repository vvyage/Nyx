// Encrypted token vault. Pure crypto, no Electron imports, so it can be tested directly.
//
// Layout (JSON file written by the caller):
//   { version, kdf: { N, r, p, salt_master, salt_recovery },
//     wrapped: { master: {iv,tag,ct}, recovery: {iv,tag,ct} },   // data key, wrapped twice
//     data: {iv,tag,ct} }                                       // records, encrypted with data key
//
// - A random 32-byte data key (DEK) encrypts the records.
// - The DEK is wrapped under a key from the master password (scrypt) and under a key from
//   a one-time recovery code (scrypt). Either one unlocks the vault.
// - Nothing here logs or returns plaintext secrets except by explicit call.

const crypto = require("node:crypto");

const VERSION = 1;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LEN = 32;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function scryptKey(secret, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function aesEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function aesDecrypt(key, box) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
}

// 20 characters from a 32-symbol alphabet (~100 bits), shown as 4 groups of 5.
function generateRecoveryCode() {
  const bytes = crypto.randomBytes(20);
  let out = "";
  for (const b of bytes) out += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
  return out.match(/.{5}/g).join("-");
}

function normalizeRecoveryCode(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Creates a new vault. Returns the file contents and the recovery code, which the
// caller must show to the user once and never store in plaintext.
async function createVault(masterPassword, recordsJson = "[]") {
  requirePassword(masterPassword);
  const dek = crypto.randomBytes(KEY_LEN);
  const recoveryCode = generateRecoveryCode();
  const salts = { salt_master: crypto.randomBytes(16), salt_recovery: crypto.randomBytes(16) };
  const masterKek = await scryptKey(masterPassword, salts.salt_master);
  const recoveryKek = await scryptKey(normalizeRecoveryCode(recoveryCode), salts.salt_recovery);
  const file = {
    version: VERSION,
    kdf: {
      name: "scrypt",
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt_master: salts.salt_master.toString("base64"),
      salt_recovery: salts.salt_recovery.toString("base64"),
    },
    wrapped: {
      master: aesEncrypt(masterKek, dek),
      recovery: aesEncrypt(recoveryKek, dek),
    },
    data: aesEncrypt(dek, Buffer.from(recordsJson, "utf8")),
  };
  dek.fill(0);
  masterKek.fill(0);
  recoveryKek.fill(0);
  return { file, recoveryCode };
}

// Returns an unlocked session holding the data key. Throws on a wrong secret.
async function unlockWithPassword(file, masterPassword) {
  checkFile(file);
  const kek = await scryptKey(masterPassword, Buffer.from(file.kdf.salt_master, "base64"));
  return openSession(file, file.wrapped.master, kek);
}

async function unlockWithRecoveryCode(file, recoveryCode) {
  checkFile(file);
  const kek = await scryptKey(
    normalizeRecoveryCode(recoveryCode),
    Buffer.from(file.kdf.salt_recovery, "base64"),
  );
  return openSession(file, file.wrapped.recovery, kek);
}

function openSession(file, wrappedBox, kek) {
  let dek;
  try {
    dek = aesDecrypt(kek, wrappedBox);
  } catch {
    throw new Error("Wrong master password or recovery code.");
  } finally {
    kek.fill(0);
  }
  return new Session(file, dek);
}

// Holds the data key in memory. Call lock() to wipe it.
class Session {
  constructor(file, dek) {
    this.file = file;
    this.dek = dek;
  }

  readRecords() {
    this.assertOpen();
    return JSON.parse(aesDecrypt(this.dek, this.file.data).toString("utf8"));
  }

  // Re-encrypts the records under the same data key and returns the new file contents.
  writeRecords(records) {
    this.assertOpen();
    const data = aesEncrypt(this.dek, Buffer.from(JSON.stringify(records), "utf8"));
    this.file = { ...this.file, data };
    return this.file;
  }

  // Replaces the master password. The recovery wrap and the data key are unchanged.
  async changeMasterPassword(newPassword) {
    this.assertOpen();
    requirePassword(newPassword);
    const salt = crypto.randomBytes(16);
    const kek = await scryptKey(newPassword, salt);
    this.file = {
      ...this.file,
      kdf: { ...this.file.kdf, salt_master: salt.toString("base64") },
      wrapped: { ...this.file.wrapped, master: aesEncrypt(kek, this.dek) },
    };
    kek.fill(0);
    return this.file;
  }

  lock() {
    if (this.dek) this.dek.fill(0);
    this.dek = null;
  }

  assertOpen() {
    if (!this.dek) throw new Error("Vault is locked.");
  }
}

function checkFile(file) {
  if (!file || file.version !== VERSION || file.kdf?.name !== "scrypt") {
    throw new Error("Unsupported or corrupt vault file.");
  }
}

function requirePassword(password) {
  if (typeof password !== "string" || password.length < 10) {
    throw new Error("Master password must be at least 10 characters.");
  }
}

module.exports = {
  createVault,
  unlockWithPassword,
  unlockWithRecoveryCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
  Session,
};
