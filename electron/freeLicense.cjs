// Requests the free-to-play CS2 license (app 730) for a newly created account. Steam does not
// grant it until a client asks, and steam-session's web tokens cannot be used for that request,
// so this logs in with steam-user using the account's password. The Steam Guard email code is
// supplied by getGuardCode. Nothing is stored: no machine auth token, no server list, and the
// session is logged off as soon as the request finishes.

const CS2_APP_ID = 730;
// Covers the time Steam takes to send and accept the email code.
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

// Returns a function that performs the request. SteamUser is injectable so tests can use a fake.
function createFreeLicenseRequester({ SteamUser, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return function requestCs2License({ accountName, password, getGuardCode }) {
    return new Promise((resolve, reject) => {
      const client = new SteamUser({ dataDirectory: null, autoRelogin: false });
      let settled = false;
      let timer = null;

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          client.logOff();
        } catch {
          // Already disconnected.
        }
        if (error) reject(error);
        else resolve(result);
      }

      timer = setTimeout(() => finish(new Error("Steam did not answer the CS2 license request in time.")), timeoutMs);

      client.on("error", (error) => {
        finish(new Error(`Steam login failed: ${error && error.message ? error.message : "unknown error"}`));
      });

      client.on("steamGuard", async (_domain, callback) => {
        try {
          callback(await getGuardCode());
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });

      client.on("loggedOn", () => {
        client.requestFreeLicense([CS2_APP_ID], (error, grantedPackages, grantedAppIds) => {
          if (error) {
            finish(new Error(`Steam refused the CS2 license request: ${error.message}`));
            return;
          }
          const granted = Array.isArray(grantedAppIds) && grantedAppIds.includes(CS2_APP_ID);
          finish(null, { granted });
        });
      });

      client.logOn({ accountName, password });
    });
  };
}

module.exports = { CS2_APP_ID, createFreeLicenseRequester };
