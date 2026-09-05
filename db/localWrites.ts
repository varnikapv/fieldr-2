/**
 * A minimal notifier for "this device just recorded a local operation".
 *
 * Exists so `applyMutation` can announce a local write without importing the
 * sync module. That import would close a cycle — db/sync.ts already imports
 * db/mutations.ts — and cycles in Metro fail as an import evaluating to
 * undefined at module-init time, which shows up on device and nowhere else.
 *
 * No imports of its own, so it stays runnable under Node like the rest of the
 * non-native logic.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeLocalWrites(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyLocalWrite(): void {
  for (const listener of listeners) listener();
}
