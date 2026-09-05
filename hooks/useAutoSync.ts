import NetInfo from '@react-native-community/netinfo';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { subscribeLocalWrites } from '../db/localWrites';
import { pendingCount, syncNow } from '../db/sync';
import { shouldAutoSync } from './shouldAutoSync';

/**
 * Phase 5 steps 2 and 4: sync automatically, on three triggers.
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
/**
 * Long enough to coalesce a burst of taps, short enough to still feel like the
 * edit synced immediately.
 */
const LOCAL_WRITE_DEBOUNCE_MS = 500;

export function useAutoSync() {
  /** Null until the first event: we have no idea what the state was before. */
  const wasConnected = useRef<boolean | null>(null);
  /** Shared by all triggers, so they can never run concurrently. */
  const inFlight = useRef(false);
  /** A trigger arrived while a sync was running: run once more afterwards. */
  const rerun = useRef(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function run(trigger: string) {
      // Re-arm rather than drop. Without this, an edit made while a sync is
      // in flight would sit queued until the next reconnect, foreground or
      // manual press — which is precisely the gap the local-write trigger
      // exists to close, just moved somewhere less obvious.
      if (inFlight.current) {
        rerun.current = true;
        return;
      }

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
          if (rerun.current) {
            rerun.current = false;
            run('rerun');
          }
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

    // ---- Trigger 3: a local write, while already online --------------------
    //
    // An always-connected device would otherwise queue an edit silently until
    // the next connectivity transition, foreground, or button press.
    //
    // Debounced: a burst of quick edits (ticking several follow-ups) becomes
    // one sync instead of one request each. Debouncing costs nothing here
    // because push sends the ENTIRE pending queue — a later sync fully
    // subsumes the earlier ones it replaced, so nothing is delayed beyond the
    // window itself.
    const unsubscribeLocalWrites = subscribeLocalWrites(() => {
      if (debounce.current) clearTimeout(debounce.current);

      debounce.current = setTimeout(() => {
        debounce.current = null;

        void (async () => {
          // Offline is the normal case for this app, and firing a doomed
          // request on every offline edit would be noise, not resilience.
          const state = await NetInfo.fetch();
          if (state.isConnected !== true) return;

          run('local-write');
        })();
      }, LOCAL_WRITE_DEBOUNCE_MS);
    });

    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      unsubscribeNetInfo();
      appStateSubscription.remove();
      unsubscribeLocalWrites();
    };
  }, []);
}
