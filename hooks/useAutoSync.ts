import NetInfo from '@react-native-community/netinfo';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { pendingCount, syncNow } from '../db/sync';
import { shouldAutoSync } from './shouldAutoSync';

/**
 * Phase 5 step 2: sync automatically, on two triggers.
 *
 * This hook changes only WHEN sync runs. Everything about what happens during
 * a sync — device identity, compare-and-set validation, rejection handling,
 * replay exclusion, ordering — is untouched; it calls the same `syncNow()` the
 * manual button calls.
 *
 * Deliberately a hook mounted after migrations succeed, rather than a
 * subscription inside db/sync.ts. A module-level listener would start at import
 * time, which is before `useMigrations` has finished — a connectivity change in
 * that window would fire a sync against a database whose tables do not exist
 * yet. It also keeps db/sync.ts a plain function, which is what lets the sync
 * logic be exercised under Node without native modules.
 */
export function useAutoSync() {
  /** Null until the first event: we have no idea what the state was before. */
  const wasConnected = useRef<boolean | null>(null);
  /** Shared by both triggers, so they can never run concurrently. */
  const inFlight = useRef(false);

  useEffect(() => {
    function run(trigger: string) {
      inFlight.current = true;
      syncNow()
        .then((result) => {
          console.log(
            `[auto-sync/${trigger}] pushed ${result.pushed} accepted ${result.accepted} ` +
              `rejected ${result.rejected} applied ${result.appliedLocally}`,
          );
        })
        .catch((error) => {
          // No retry, no backoff, on purpose. The queue is already durable:
          // unsynced operations keep `synced = false` and go out next time,
          // and opId dedupe means a push that committed server-side but never
          // returned is re-pushed harmlessly as a duplicate. Recovery comes
          // from the next trigger or the manual button.
          console.warn(`[auto-sync/${trigger}] failed:`, error?.message ?? error);
        })
        .finally(() => {
          inFlight.current = false;
        });
    }

    // ---- Trigger 1: connectivity restored while the app is watching --------
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      // `isConnected`, NOT `isInternetReachable`. The sync server lives on the
      // LAN, so internet reachability is the wrong question — it can be false
      // or null on a network where the server is perfectly reachable, which
      // would mean auto-sync never fires on exactly the setup being tested.
      const isConnected = state.isConnected === true;
      const previous = wasConnected.current;
      wasConnected.current = isConnected;

      if (!shouldAutoSync(previous, isConnected, inFlight.current)) return;
      run('netinfo');
    });

    // ---- Trigger 2: app returns to the foreground --------------------------
    //
    // Covers the case trigger 1 structurally cannot: the device reconnects
    // while the app is backgrounded or suspended, so no connectivity event is
    // ever observed and `previous` is still null on the next mount.
    //
    // NOTE: no previous-state guard here, unlike NetInfo, and that difference
    // is deliberate. AppState only emits on change, so an 'active' event is
    // already a transition — a ref would be dead weight. More importantly, a
    // `previous === 'background'` guard would BREAK the target case: on iOS,
    // pulling down Control Center (how you toggle airplane mode) puts the app
    // in 'inactive', not 'background', so the sequence is active -> inactive
    // -> active. Filtering on background would ignore the very toggle this
    // trigger exists to catch.
    //
    // The filtering is done by real conditions instead: something queued, a
    // connection, and no sync already running.
    const appStateSubscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (inFlight.current) return;

      void (async () => {
        const queued = await pendingCount();
        if (queued === 0) return;

        // Ask for connectivity directly rather than trusting the ref, which
        // may be stale or still null after a backgrounded reconnect.
        const state = await NetInfo.fetch();
        if (state.isConnected !== true) return;
        if (inFlight.current) return;

        run('foreground');
      })();
    });

    return () => {
      unsubscribeNetInfo();
      appStateSubscription.remove();
    };
  }, []);
}
