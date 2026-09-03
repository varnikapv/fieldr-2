import NetInfo from '@react-native-community/netinfo';
import { useEffect, useRef } from 'react';

import { syncNow } from '../db/sync';
import { shouldAutoSync } from './shouldAutoSync';

/**
 * Phase 5 step 2: fire a sync when connectivity is restored.
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
 * yet. Mounting it behind the success branch makes that impossible rather than
 * merely unlikely. It also keeps db/sync.ts a plain function, which is what
 * lets the sync logic be exercised under Node without native modules.
 */
export function useAutoSync() {
  /** Null until the first event: we have no idea what the state was before. */
  const wasConnected = useRef<boolean | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      // `isConnected`, NOT `isInternetReachable`. The sync server lives on the
      // LAN, so internet reachability is the wrong question — it can be false
      // or null on a network where the server is perfectly reachable, which
      // would mean auto-sync never fires on exactly the setup being tested.
      const isConnected = state.isConnected === true;
      const previous = wasConnected.current;
      wasConnected.current = isConnected;

      // Transition-only, plus the in-flight guard. Kept in a pure function so
      // the trigger rule can be tested without native modules — see
      // shouldAutoSync.ts.
      if (!shouldAutoSync(previous, isConnected, inFlight.current)) return;
      inFlight.current = true;

      syncNow()
        .then((result) => {
          console.log(
            `[auto-sync] pushed ${result.pushed} accepted ${result.accepted} ` +
              `rejected ${result.rejected} applied ${result.appliedLocally}`,
          );
        })
        .catch((error) => {
          // No retry, no backoff, on purpose. The queue is already durable:
          // unsynced operations keep `synced = false` and go out next time,
          // and opId dedupe means a push that committed server-side but never
          // returned is re-pushed harmlessly as a duplicate. Recovery comes
          // from the next connectivity transition or the manual button.
          console.warn('[auto-sync] failed:', error?.message ?? error);
        })
        .finally(() => {
          inFlight.current = false;
        });
    });

    return unsubscribe;
  }, []);
}
