const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createFreeLicenseRequester } = require("./freeLicense.cjs");

// Builds a fake steam-user class. `script` decides what the fake does after logOn.
function fakeSteamUser(script) {
  const instances = [];
  class FakeSteamUser extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.loggedOff = false;
      this.logOnArgs = null;
      instances.push(this);
    }
    logOn(details) {
      this.logOnArgs = details;
      script(this);
    }
    requestFreeLicense(appIds, callback) {
      this.requestedApps = appIds;
      this.requestCallback = callback;
    }
    logOff() {
      this.loggedOff = true;
    }
  }
  return { FakeSteamUser, instances };
}

test("requests CS2 after logon, reports granted, and logs off", async () => {
  const { FakeSteamUser, instances } = fakeSteamUser((client) => {
    setImmediate(() => {
      client.emit("loggedOn");
      setImmediate(() => client.requestCallback(null, [0], [730]));
    });
  });
  const request = createFreeLicenseRequester({ SteamUser: FakeSteamUser });
  const result = await request({ accountName: "sah_test", password: "pw", getGuardCode: async () => "ABCDE" });
  assert.deepEqual(result, { granted: true });
  const client = instances[0];
  assert.deepEqual(client.requestedApps, [730]);
  assert.equal(client.loggedOff, true);
  assert.equal(client.options.dataDirectory, null);
  assert.equal(client.options.autoRelogin, false);
  assert.deepEqual(client.logOnArgs, { accountName: "sah_test", password: "pw" });
});

test("reports not granted when Steam returns no CS2 app", async () => {
  const { FakeSteamUser } = fakeSteamUser((client) => {
    setImmediate(() => {
      client.emit("loggedOn");
      setImmediate(() => client.requestCallback(null, [], []));
    });
  });
  const request = createFreeLicenseRequester({ SteamUser: FakeSteamUser });
  const result = await request({ accountName: "a", password: "b", getGuardCode: async () => "x" });
  assert.deepEqual(result, { granted: false });
});

test("passes the Steam Guard code from getGuardCode to steam-user", async () => {
  const { FakeSteamUser } = fakeSteamUser((client) => {
    setImmediate(() => client.emit("steamGuard", "g***@example.com", (code) => {
      client.codeSent = code;
      client.emit("loggedOn");
      setImmediate(() => client.requestCallback(null, [], [730]));
    }, false));
  });
  const request = createFreeLicenseRequester({ SteamUser: FakeSteamUser });
  const result = await request({ accountName: "a", password: "b", getGuardCode: async () => "QWERT" });
  assert.deepEqual(result, { granted: true });
});

test("a Steam login error rejects and logs off", async () => {
  const { FakeSteamUser, instances } = fakeSteamUser((client) => {
    setImmediate(() => client.emit("error", new Error("InvalidPassword")));
  });
  const request = createFreeLicenseRequester({ SteamUser: FakeSteamUser });
  await assert.rejects(
    request({ accountName: "a", password: "b", getGuardCode: async () => "x" }),
    /Steam login failed: InvalidPassword/,
  );
  assert.equal(instances[0].loggedOff, true);
});

test("a failed Steam Guard code lookup rejects", async () => {
  const { FakeSteamUser } = fakeSteamUser((client) => {
    setImmediate(() => client.emit("steamGuard", "example.com", () => {}, false));
  });
  const request = createFreeLicenseRequester({ SteamUser: FakeSteamUser });
  await assert.rejects(
    request({ accountName: "a", password: "b", getGuardCode: async () => { throw new Error("no mail"); } }),
    /no mail/,
  );
});

test("times out when Steam never answers", async () => {
  const { FakeSteamUser, instances } = fakeSteamUser(() => {});
  const request = createFreeLicenseRequester({ SteamUser: FakeSteamUser, timeoutMs: 20 });
  await assert.rejects(
    request({ accountName: "a", password: "b", getGuardCode: async () => "x" }),
    /did not answer/,
  );
  assert.equal(instances[0].loggedOff, true);
});
