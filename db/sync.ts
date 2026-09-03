import { asc, eq, inArray } from 'drizzle-orm';

import { db } from './client';
import {
  applyRemoteMutation,
  hasMutation,
  markRejected,
  rebuildProjection,
  recordServerSeq,
  toRecord,
} from './mutations';
import {
  mutations,
  syncState,
  type EntityName,
  type MutationKind,
  type MutationPatch,
} from './schema';

/**
 * Wire format — must stay identical to server/src/routes/sync.ts.
 *
 * As of phase 3 we ship OPERATIONS, not rows. Timestamps are epoch-millisecond
 * integers so both sides handle the identical number.
 */
export type WireMutation = {
  opId: string;
  entity: EntityName;
  entityId: string;
  kind: MutationKind;
  patch: MutationPatch;
  timestamp: number;
  deviceId: string | null;
};

export type RejectionReason = 'stale' | 'invalid_transition';

/** Per-operation verdict. A rejection is a verdict, not a failed request. */
export type OpResult =
  | { opId: string; outcome: 'accepted'; serverSeq: number }
  | { opId: string; outcome: 'duplicate' }
  | {
      opId: string;
      outcome: 'rejected';
      reason: RejectionReason;
      /** Server's current value, plus which device set it. */
      current: { status?: string; byDevice?: string | null } | null;
    };

/** What the server adds when it accepts an operation. */
export type WireServerMutation = WireMutation & { serverSeq: number };

export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

const CURSOR_KEY = 'lastServerSeq';

export type SyncResult = {
  pushed: number;
  accepted: number;
  /** Operations the server had already seen — duplicates, not errors. */
  alreadyOnServer: number;
  /** Operations the server refused. Flagged locally, excluded from replay. */
  rejected: number;
  pulled: number;
  appliedLocally: number;
  /** Pulled operations this device had already recorded (usually its own). */
  skippedAsDuplicate: number;
  at: Date;
};

async function readCursor(): Promise<number> {
  const row = await db
    .select()
    .from(syncState)
    .where(eq(syncState.key, CURSOR_KEY))
    .limit(1);
  return row.length > 0 ? Number(row[0].value) : 0;
}

async function writeCursor(value: number): Promise<void> {
  await db
    .insert(syncState)
    .values({ key: CURSOR_KEY, value: String(value) })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { value: String(value) },
    });
}

/** How many operations are waiting to be pushed. */
export async function pendingCount(): Promise<number> {
  const rows = await db
    .select({ seq: mutations.seq })
    .from(mutations)
    .where(eq(mutations.synced, false));
  return rows.length;
}

export async function syncNow(): Promise<SyncResult> {
  // ---- PUSH: unsynced operations, oldest first ----------------------------
  // Order matters: an insert must reach the server before the update that
  // depends on it, and `seq` is what guarantees that within this device.
  const pending = await db
    .select()
    .from(mutations)
    .where(eq(mutations.synced, false))
    .orderBy(asc(mutations.seq));

  let alreadyOnServer = 0;
  let accepted = 0;
  let rejected = 0;

  if (pending.length > 0) {
    const response = await fetch(`${API_BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mutations: pending.map(toRecord) }),
    });
    if (!response.ok) {
      throw new Error(`push failed: HTTP ${response.status}`);
    }
    const { results } = (await response.json()) as { results: OpResult[] };

    // Each operation gets its own verdict. A rejection does not fail the
    // batch, and it does not throw — the other operations still committed.
    for (const outcome of results) {
      if (outcome.outcome === 'rejected') {
        await markRejected(
          outcome.opId,
          outcome.reason,
          outcome.current?.byDevice ?? null,
        );
        rejected += 1;
        continue;
      }
      if (outcome.outcome === 'accepted') {
        await recordServerSeq(outcome.opId, outcome.serverSeq);
        accepted += 1;
        continue;
      }
      alreadyOnServer += 1;
    }

    // Anything the server answered about is no longer pending. A failed push
    // throws above instead, leaving entries queued for the next attempt —
    // safe because the server dedupes on opId.
    await db
      .update(mutations)
      .set({ synced: true })
      .where(
        inArray(
          mutations.seq,
          pending.map((entry) => entry.seq),
        ),
      );
  }

  // ---- PULL: operations after our cursor ----------------------------------
  const since = await readCursor();
  const pullResponse = await fetch(`${API_BASE_URL}/sync/pull?since=${since}`);
  if (!pullResponse.ok) {
    throw new Error(`pull failed: HTTP ${pullResponse.status}`);
  }
  const { mutations: incoming } = (await pullResponse.json()) as {
    mutations: WireServerMutation[];
  };

  let appliedLocally = 0;
  let skippedAsDuplicate = 0;
  let highestSeq = since;

  for (const entry of incoming) {
    highestSeq = Math.max(highestSeq, entry.serverSeq);

    // Our own operations come back to us on pull. We must not apply the effect
    // twice — but we DO need the serverSeq, because that is this device's only
    // way to learn where its own operations sit in the shared order.
    if (await hasMutation(entry.opId)) {
      await recordServerSeq(entry.opId, entry.serverSeq);
      skippedAsDuplicate += 1;
      continue;
    }

    await applyRemoteMutation(
      {
        opId: entry.opId,
        entity: entry.entity,
        entityId: entry.entityId,
        kind: entry.kind,
        patch: entry.patch,
        timestamp: entry.timestamp,
        deviceId: entry.deviceId,
      },
      entry.serverSeq,
    );
    appliedLocally += 1;
  }

  // Replay everything in the shared order. Operations were applied above as
  // they arrived, which is precisely the ordering that cannot be trusted —
  // this is what makes every device land on the same state.
  await rebuildProjection();

  if (highestSeq > since) {
    await writeCursor(highestSeq);
  }

  return {
    pushed: pending.length,
    accepted,
    rejected,
    alreadyOnServer,
    pulled: incoming.length,
    appliedLocally,
    skippedAsDuplicate,
    at: new Date(),
  };
}
