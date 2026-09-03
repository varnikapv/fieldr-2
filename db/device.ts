import { eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { db } from './client';
import { syncState } from './schema';

const DEVICE_ID_KEY = 'deviceId';

let cached: string | null = null;

/**
 * This device's identity, generated once on first launch.
 *
 * Stored in SQLite alongside the mutation log rather than in AsyncStorage or
 * SecureStore, and the reason is lifecycle coupling: the id is a label for a
 * log. If the two could be wiped independently you would end up with an
 * identity that outlived its own operation history — a device calling itself
 * 3f2a while holding none of 3f2a's operations. Same database means a
 * reinstall resets both together, always consistently.
 *
 * Read-or-create, guarded by onConflictDoNothing so a concurrent call cannot
 * produce two ids. Cached in memory so push does not hit SQLite per operation.
 *
 * NOT a credential. Not secret, not authenticated, not a user account — that
 * is a later step. This is a name for narrative and display.
 */
export async function getDeviceId(): Promise<string> {
  if (cached !== null) return cached;

  const existing = await db
    .select()
    .from(syncState)
    .where(eq(syncState.key, DEVICE_ID_KEY))
    .limit(1);

  if (existing.length > 0) {
    cached = existing[0].value;
    return cached;
  }

  await db
    .insert(syncState)
    .values({ key: DEVICE_ID_KEY, value: Crypto.randomUUID() })
    .onConflictDoNothing();

  // Read back rather than trusting what we just wrote — if another caller won
  // the race, its id is the real one.
  const created = await db
    .select()
    .from(syncState)
    .where(eq(syncState.key, DEVICE_ID_KEY))
    .limit(1);

  cached = created[0].value;
  return cached;
}

/**
 * Four hex characters, for reading. A truncation for display only — it
 * collides roughly 1 in 65k, so nothing ever compares these. Code compares
 * full UUIDs.
 */
export function shortDevice(id: string | null | undefined): string {
  return id ? id.slice(0, 4) : 'unknown';
}
