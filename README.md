# Nyx - Steam Account Loader / Helper

Windows desktop app that tracks each Steam account's CS2 matchmaking cooldown.
Everything stays on your PC. Accounts, the encrypted vault live in `%APPDATA%\steam-account-helper\`.

## Install (end users)

1. Run the latest Nyx.exe
2. Windows SmartScreen may warn "unknown publisher" because the build is not
   code-signed. Would cost me too much for this small project. 
   Choose **More info > Run anyway**.
3. On first launch, create a master password. A recovery code is shown once.
   Store it somewhere safe. Without the master password or the recovery code,
   saved logins cannot be decrypted.

## Using it

- **Add an account:** use the Sign in tab (Steam password and Steam Guard code
  are typed into the app and not stored), or the Create tab (see below).
- **Check now / Refresh cooldowns:** reads each account's CS2 matchmaking page.
  Automatic reads run every 30 minutes for accounts with a saved login.
- **Sync from Steam:** imports accounts Steam remembers on this PC and fetches
  names and avatars.
- **Statuses:** Timestamps shows the cooldown. "Clear" means no cooldown. Anything unreadable stays "unknown".
- **Create tab (assisted signup):** generates a username and password, opens Steam's join page, and watches your mailbox for Steam's confirmation link.
  - Gmail requires an app password (2-Step Verification must be on).
  - "App window" mode is the default. "Default browser" is the fallback.
  - Mail credentials are typed each time and never stored.

## Build from source

Requirements: Windows 10 or 11, Node.js LTS.

```powershell
cd app
npm install
npm start          # build the renderer and launch Electron
npm test           # unit tests (node:test)
npm run typecheck
npm run dist       # build + test + Windows installer
```

Output goes to `app\release\`. Clear `ELECTRON_RUN_AS_NODE` before `npm start`,
or Electron runs as plain Node and crashes.

To share the source, send the `app` folder without `node_modules`, `dist`, and
`release`. Recipients run `npm install` first. Never share the
`%APPDATA%\steam-account-helper\` folder: it holds the account list and the
encrypted vault.

## Notes

- The user is responsible for compliance with Steam's terms.
- A human solves any CAPTCHA.
- Uninstalling removes the program, not the data folder above. Delete that
  folder to erase all stored accounts and tokens.
- `npm audit` may report moderate advisories in electron-builder's build-time
  dependencies. They are not shipped in the app. Do not run
  `npm audit fix --force`, which is a breaking change.
