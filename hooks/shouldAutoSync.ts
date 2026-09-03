/**
 * The auto-sync trigger decision, isolated from NetInfo so it can be tested
 * without native modules.
 *
 * Fire only on the TRANSITION from offline to online — never on the state.
 * NetInfo emits on every connectivity change and once on subscribe, so
 * reacting to "is currently connected" would sync on signal-strength changes,
 * cellular handovers and SSID switches.
 *
 * @param previous  connectivity at the last event; null before the first one
 * @param isConnected  connectivity now
 * @param inFlight  whether a sync is already running
 */
export function shouldAutoSync(
  previous: boolean | null,
  isConnected: boolean,
  inFlight: boolean,
): boolean {
  // Already syncing: a flap must not start a second concurrent run.
  if (inFlight) return false;

  // Must be online now...
  if (!isConnected) return false;

  // ...and must have been *known* to be offline before. `null` is the first
  // event, where we have no previous state — so launching while already
  // online deliberately syncs nothing.
  return previous === false;
}
