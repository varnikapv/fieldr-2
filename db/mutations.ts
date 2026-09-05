import { asc, eq, sql } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { db } from './client';
import { getDeviceId } from './device';
import { notifyLocalWrite } from './localWrites';
import {
  followUps,
  mutations,
  visits,
  type EntityName,
  type FollowUp,
  type FollowUpStatus,
  type Mutation,
  type MutationKind,
  type MutationPatch,
  type Visit,
  type VisitPatch,
} from './schema';

/**
 * THE SINGLE WRITE PATH.
 *
 * Nothing else in the app may write to `visits`. Every state change goes
 * through here so that the log entry and its effect land together — if those
 * two could diverge, the log would stop being a truthful record of local
 * state and everything downstream (sync, replay, phase 4 reconciliation)
 * would be built on sand.
 */

export type MutationRecord = {
  opId: string;
  entity: EntityName;
  entityId: string;
  kind: MutationKind;
  patch: MutationPatch;
  timestamp: number;
  /** Envelope metadata. Never part of the patch, never read by validation. */
  deviceId?: string | null;
};

/**
 * Apply a mutation's patch to the projection.
 *
 * Only the keys present in `patch` are touched. That absence is the phase 2
 * fix: a field nobody edited is not in the payload, so it cannot overwrite
 * anyone else's edit.
 */
async function project(record: MutationRecord): Promise<void> {
  if (record.entity === 'follow_ups') {
    await projectFollowUp(record);
    return;
  }

  const { entityId, kind, patch, timestamp } = record;

  if (kind === 'insert') {
    await db
      .insert(visits)
      .values({
        id: entityId,
        patientName: patch.patientName ?? '',
        notes: patch.notes ?? '',
        createdAt: new Date(patch.createdAt ?? timestamp),
        updatedAt: new Date(timestamp),
      })
      .onConflictDoNothing();
    return;
  }

  if (kind === 'update') {
    const changes: Partial<Visit> = { updatedAt: new Date(timestamp) };
    if (patch.patientName !== undefined) changes.patientName = patch.patientName;
    if (patch.notes !== undefined) changes.notes = patch.notes;

    await db.update(visits).set(changes).where(eq(visits.id, entityId));
    return;
  }

  // 'delete' is defined in the schema but has no UI yet. Soft deletes are in
  // scope for the project; reshaping the log later would be worse than
  // reserving the verb now.
}

async function projectFollowUp(record: MutationRecord): Promise<void> {
  const { entityId, kind, patch, timestamp } = record;

  if (kind === 'insert') {
    // New items always start 'open', so an insert never carries a status
    // change and is never subject to compare-and-set.
    await db
      .insert(followUps)
      .values({
        id: entityId,
        title: patch.title ?? '',
        status: 'open',
        createdAt: new Date(patch.createdAt ?? timestamp),
        updatedAt: new Date(timestamp),
      })
      .onConflictDoNothing();
    return;
  }

  if (kind === 'update') {
    const changes: Partial<FollowUp> = { updatedAt: new Date(timestamp) };
    if (patch.title !== undefined) changes.title = patch.title;
    // Projection applies the `to` side. The `from` side exists for the
    // server's compare-and-set and is not used here.
    if (patch.status !== undefined) changes.status = patch.status.to;

    await db.update(followUps).set(changes).where(eq(followUps.id, entityId));
  }
}

/**
 * Append to the log and apply the effect. The two happen together — see the
 * note at the top of this file for why that matters.
 *
 * `synced` distinguishes locally-created entries (false — must be pushed) from
 * entries replayed from the server (true — the server already has them).
 */
export async function applyMutation(
  record: MutationRecord,
  options: { synced: boolean; serverSeq?: number } = { synced: false },
): Promise<void> {
  // Locally-authored operations are stamped with this device. Operations
  // replayed from the server keep whichever device actually authored them —
  // INCLUDING null, which means "authored before device identity existed".
  //
  // `??` would be wrong here: it cannot distinguish "no author field" (local,
  // stamp me) from "author is explicitly null" (remote, historical). Using it
  // made every device claim authorship of every pre-phase-5 operation it
  // replayed, which would eventually name the wrong device in a rejection.
  const deviceId =
    record.deviceId === undefined ? await getDeviceId() : record.deviceId;

  await db.insert(mutations).values({
    opId: record.opId,
    entity: record.entity,
    entityId: record.entityId,
    kind: record.kind,
    patch: record.patch,
    timestamp: new Date(record.timestamp),
    synced: options.synced,
    serverSeq: options.serverSeq ?? null,
    deviceId,
  });

  await project(record);

  // Announce local writes only. Operations replayed from the server arrive
  // here with `synced: true`, so they cannot trigger a sync — which is what
  // structurally prevents a pull from firing syncs that pull more operations
  // that fire more syncs. No suppression flag to remember to set.
  if (!options.synced) notifyLocalWrite();
}

/**
 * Rebuild `visits` from the log, in the one order every device agrees on:
 * server-confirmed operations by `serverSeq`, then this device's own
 * not-yet-confirmed operations by local `seq`.
 *
 * This is what guarantees convergence. Applying operations as they happen to
 * arrive lets each device end on whatever it saw last, which is exactly the
 * divergence bug this replaces: two devices held different values for the same
 * field permanently, because arrival order decided the winner instead of a
 * shared order.
 *
 * Cost is O(log size) per sync. Fine at this scale; log compaction is phase 6.
 */
export async function rebuildProjection(): Promise<void> {
  const ordered = await db
    .select()
    .from(mutations)
    // Rejected operations are excluded: the server never applied them, so
    // replaying them would show a value the server refused.
    .where(eq(mutations.rejected, false))
    .orderBy(
      // NULL serverSeq (not yet confirmed) sorts last, so local work sits on
      // top of the shared prefix.
      sql`case when ${mutations.serverSeq} is null then 1 else 0 end`,
      asc(mutations.serverSeq),
      asc(mutations.seq),
    );

  await db.delete(visits);
  await db.delete(followUps);

  for (const row of ordered) {
    await project(toRecord(row));
  }
}

/**
 * Mark an operation the server refused. It stays in the log as a record of
 * what this device attempted, flagged for review — but it is skipped on replay,
 * so the projection reverts to what the server actually holds.
 */
export async function markRejected(
  opId: string,
  reason: string,
  byDevice: string | null,
): Promise<void> {
  await db
    .update(mutations)
    .set({
      rejected: true,
      rejectionReason: reason,
      rejectionByDevice: byDevice,
      synced: true,
    })
    .where(eq(mutations.opId, opId));
}

/** Record the server's ordering for an operation we already hold. */
export async function recordServerSeq(opId: string, serverSeq: number): Promise<void> {
  await db
    .update(mutations)
    .set({ serverSeq, synced: true })
    .where(eq(mutations.opId, opId));
}

/** True if this operation has already been recorded locally. */
export async function hasMutation(opId: string): Promise<boolean> {
  const existing = await db
    .select({ seq: mutations.seq })
    .from(mutations)
    .where(eq(mutations.opId, opId))
    .limit(1);
  return existing.length > 0;
}

export async function createVisit(input: {
  patientName: string;
  notes: string;
}): Promise<string> {
  const entityId = Crypto.randomUUID();
  const timestamp = Date.now();

  // An insert's patch carries every field, because every field genuinely
  // changed — from not existing to existing.
  await applyMutation({
    opId: Crypto.randomUUID(),
    entity: 'visits',
    entityId,
    kind: 'insert',
    patch: {
      patientName: input.patientName,
      notes: input.notes,
      createdAt: timestamp,
    },
    timestamp,
  });

  return entityId;
}

/**
 * Diff the edit against what the record currently says, and record ONLY what
 * changed. This is where phase 2's bug dies: touch the notes and
 * `patientName` never enters the payload, so it cannot clobber another
 * device's rename.
 *
 * Returns false when nothing changed — no operation, no log entry, nothing to
 * sync.
 */
export async function updateVisit(
  current: Visit,
  draft: { patientName: string; notes: string },
): Promise<boolean> {
  const patch: VisitPatch = {};
  if (draft.patientName !== current.patientName) {
    patch.patientName = draft.patientName;
  }
  if (draft.notes !== current.notes) {
    patch.notes = draft.notes;
  }

  if (Object.keys(patch).length === 0) return false;

  await applyMutation({
    opId: Crypto.randomUUID(),
    entity: 'visits',
    entityId: current.id,
    kind: 'update',
    patch,
    timestamp: Date.now(),
  });

  return true;
}

export async function createFollowUp(title: string): Promise<string> {
  const entityId = Crypto.randomUUID();
  const timestamp = Date.now();

  await applyMutation({
    opId: Crypto.randomUUID(),
    entity: 'follow_ups',
    entityId,
    kind: 'insert',
    patch: { title, createdAt: timestamp },
    timestamp,
  });

  return entityId;
}

export async function renameFollowUp(item: FollowUp, title: string): Promise<boolean> {
  if (title === item.title) return false;

  // Free text: no from/to, no validation, plain phase 3 semantics.
  await applyMutation({
    opId: Crypto.randomUUID(),
    entity: 'follow_ups',
    entityId: item.id,
    kind: 'update',
    patch: { title },
    timestamp: Date.now(),
  });

  return true;
}

/**
 * Carries what this device believed the status was. If the server finds that
 * belief is no longer true, it rejects the operation instead of overwriting
 * someone else's change.
 */
export async function setFollowUpStatus(
  item: FollowUp,
  to: FollowUpStatus,
): Promise<boolean> {
  if (item.status === to) return false;

  await applyMutation({
    opId: Crypto.randomUUID(),
    entity: 'follow_ups',
    entityId: item.id,
    kind: 'update',
    patch: { status: { from: item.status, to } },
    timestamp: Date.now(),
  });

  return true;
}

/** Record a mutation that came from the server, with its place in the order. */
export async function applyRemoteMutation(
  record: MutationRecord,
  serverSeq: number,
): Promise<void> {
  await applyMutation(record, { synced: true, serverSeq });
}

export function toRecord(row: Mutation): MutationRecord {
  return {
    opId: row.opId,
    entity: row.entity as EntityName,
    entityId: row.entityId,
    kind: row.kind,
    patch: row.patch,
    timestamp: row.timestamp.getTime(),
    deviceId: row.deviceId,
  };
}
