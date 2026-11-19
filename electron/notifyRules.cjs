// Pure rules for deciding when to notify. Kept apart from Electron so they can be tested.

// Returns the accounts whose cooldown ended while this session was running and that have
// not been reported yet. `announced` is a Set of keys already reported; new keys are added
// to it, so each ending is returned once.
// Only cooldowns from a Steam page read count. Manual entries and expiries from before this
// session started are ignored, so launching the app does not produce a burst of old alerts.
function findEndedCooldowns(accounts, { sessionStartMs, nowMs, announced }) {
  const ended = [];
  for (const account of accounts) {
    const cooldown = account.cooldown;
    if (!cooldown || cooldown.source !== "steam-page" || !cooldown.expiresAt) continue;
    const endMs = Date.parse(cooldown.expiresAt);
    if (!Number.isFinite(endMs)) continue;
    if (endMs <= sessionStartMs || endMs > nowMs) continue;
    const key = `${account.id}|${cooldown.expiresAt}`;
    if (announced.has(key)) continue;
    announced.add(key);
    ended.push(account);
  }
  return ended;
}

module.exports = { findEndedCooldowns };
