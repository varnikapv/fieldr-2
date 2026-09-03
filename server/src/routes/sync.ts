import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client';
import {
  followUps,
  mutations,
  visits,
  type EntityName,
  type MutationKind,
  type MutationPatch,
} from '../db/schema';

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

export type OpResult =
  | { opId: string; outcome: 'accepted'; serverSeq: number }
  | { opId: string; outcome: 'duplicate' }
  | {
      opId: string;
      outcome: 'rejected';
      reason: RejectionReason;
      /** Current server value, plus which device set it. Display only. */
      current: { status?: string; byDevice?: string | null } | null;
    };

const KINDS: MutationKind[] = ['insert', 'update', 'delete'];
const ENTITIES: EntityName[] = ['visits', 'follow_ups'];

function parseMutations(body: unknown): WireMutation[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { mutations?: unknown }).mutations;
  if (!Array.isArray(raw)) return null;

  const parsed: WireMutation[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const m = item as Record<string, unknown>;
    if (
      typeof m.opId !== 'string' ||
      typeof m.entity !== 'string' ||
      !ENTITIES.includes(m.entity as EntityName) ||
      typeof m.entityId !== 'string' ||
      typeof m.kind !== 'string' ||
      !KINDS.includes(m.kind as MutationKind) ||
      typeof m.patch !== 'object' ||
      m.patch === null ||
      !Number.isFinite(m.timestamp)
    ) {
      return null;
    }
    parsed.push({
      opId: m.opId,
      entity: m.entity as EntityName,
      entityId: m.entityId,
      kind: m.kind as MutationKind,
      patch: m.patch as MutationPatch,
      timestamp: m.timestamp as number,
      deviceId: typeof m.deviceId === 'string' ? m.deviceId : null,
    });
  }
  return parsed;
}

/**
 * Who last changed this item's status. Used ONLY to explain a rejection in
 * words — it is not an input to the accept/reject decision, which has already
 * been made by the time this is called.
 */
async function lastStatusWriter(entityId: string): Promise<string | null> {
  const rows = await db
    .select({ deviceId: mutations.deviceId })
    .from(mutations)
    .where(
      and(
        eq(mutations.entityId, entityId),
        eq(mutations.entity, 'follow_ups'),
        sql`jsonb_exists(${mutations.patch}, 'status')`,
      ),
    )
    .orderBy(desc(mutations.serverSeq))
    .limit(1);

  return rows.length > 0 ? rows[0].deviceId : null;
}

/**
 * THE ONLY CONFLICT CHECK IN THE SYSTEM.
 *
 * Compare-and-set on `status`, and nothing else. No version counters, no
 * generation numbers, no timestamp comparison — a device clock cannot decide
 * whether someone else already acted.
 *
 * `title` is deliberately not validated: free text has no notion of "already
 * done", and rejecting it would reintroduce the false conflicts phase 3 spent
 * its whole existence removing.
 *
 * Device id is deliberately absent from this function. It lives in the
 * envelope, not the patch, so it is not reachable here even by accident.
 *
 * Returns null to accept, or a rejection.
 */
async function validate(
  entry: WireMutation,
): Promise<{
  reason: RejectionReason;
  current: { status?: string; byDevice?: string | null } | null;
} | null> {
  if (entry.entity !== 'follow_ups' || entry.kind !== 'update') return null;

  const change = entry.patch.status;
  if (change === undefined) return null; // title-only edit: nothing to validate

  // A no-op transition is meaningless regardless of who else acted — this is
  // the done -> done case.
  if (change.from === change.to) {
    return {
      reason: 'invalid_transition',
      current: { status: change.to, byDevice: await lastStatusWriter(entry.entityId) },
    };
  }

  const existing = await db
    .select({ status: followUps.status })
    .from(followUps)
    .where(eq(followUps.id, entry.entityId))
    .limit(1);

  if (existing.length === 0) {
    // Nothing to compare against — the record has not arrived here yet.
    return { reason: 'stale', current: null };
  }

  // The heart of it: the client acted on a belief about the world. If that
  // belief no longer holds, someone else got there first, and we refuse
  // rather than silently overwrite them.
  if (existing[0].status !== change.from) {
    return {
      reason: 'stale',
      current: {
        status: existing[0].status,
        byDevice: await lastStatusWriter(entry.entityId),
      },
    };
  }

  return null;
}

async function project(entry: WireMutation): Promise<void> {
  if (entry.entity === 'follow_ups') {
    if (entry.kind === 'insert') {
      await db
        .insert(followUps)
        .values({
          id: entry.entityId,
          title: entry.patch.title ?? '',
          status: 'open',
          createdAt: entry.patch.createdAt ?? entry.timestamp,
          updatedAt: entry.timestamp,
        })
        .onConflictDoNothing();
      return;
    }

    if (entry.kind === 'update') {
      const changes: Record<string, unknown> = {};
      if (entry.patch.title !== undefined) changes.title = entry.patch.title;
      if (entry.patch.status !== undefined) changes.status = entry.patch.status.to;
      if (Object.keys(changes).length === 0) return;

      changes.updatedAt = sql`greatest(${followUps.updatedAt}, ${entry.timestamp})`;
      await db.update(followUps).set(changes).where(eq(followUps.id, entry.entityId));
    }
    return;
  }

  if (entry.kind === 'insert') {
    await db
      .insert(visits)
      .values({
        id: entry.entityId,
        patientName: entry.patch.patientName ?? '',
        notes: entry.patch.notes ?? '',
        createdAt: entry.patch.createdAt ?? entry.timestamp,
        updatedAt: entry.timestamp,
      })
      .onConflictDoNothing();
    return;
  }

  if (entry.kind === 'update') {
    const changes: Record<string, unknown> = {};
    if (entry.patch.patientName !== undefined) {
      changes.patientName = entry.patch.patientName;
    }
    if (entry.patch.notes !== undefined) changes.notes = entry.patch.notes;
    if (Object.keys(changes).length === 0) return;

    // Display-only monotonic guard, not a conflict decision.
    changes.updatedAt = sql`greatest(${visits.updatedAt}, ${entry.timestamp})`;
    await db.update(visits).set(changes).where(eq(visits.id, entry.entityId));
  }
}

const sync = new Hono();

/**
 * PUSH — validate, then log and project.
 *
 * Results are PER OPERATION, not aggregate. One rejected operation must not
 * fail the batch: everything else in the push still commits. A rejection is a
 * verdict, not an error.
 *
 * A rejected operation is never written to the log. The log records what
 * actually happened; an operation the server refused did not happen.
 */
sync.post('/push', async (c) => {
  const body = await c.req.json().catch(() => null);
  const incoming = parseMutations(body);

  if (!incoming) {
    return c.json(
      { error: 'expected { mutations: [{ opId, entity, entityId, kind, patch, timestamp }] }' },
      400,
    );
  }

  const results: OpResult[] = [];

  for (const entry of incoming) {
    const rejection = await validate(entry);
    if (rejection) {
      results.push({
        opId: entry.opId,
        outcome: 'rejected',
        reason: rejection.reason,
        current: rejection.current,
      });
      continue;
    }

    const inserted = await db
      .insert(mutations)
      .values({
        opId: entry.opId,
        entity: entry.entity,
        entityId: entry.entityId,
        kind: entry.kind,
        patch: entry.patch,
        timestamp: entry.timestamp,
        deviceId: entry.deviceId,
      })
      .onConflictDoNothing({ target: mutations.opId })
      .returning({ serverSeq: mutations.serverSeq });

    if (inserted.length === 0) {
      results.push({ opId: entry.opId, outcome: 'duplicate' });
      continue;
    }

    await project(entry);
    results.push({
      opId: entry.opId,
      outcome: 'accepted',
      serverSeq: Number(inserted[0].serverSeq),
    });
  }

  return c.json({ results });
});

/**
 * PULL — operations after the caller's cursor, in server order.
 * Rows are never sent; a device receiving whole rows would be back in phase 2.
 */
sync.get('/pull', async (c) => {
  const sinceParam = Number(c.req.query('since') ?? 0);
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : 0;

  const rows = await db
    .select()
    .from(mutations)
    .where(gt(mutations.serverSeq, since))
    .orderBy(asc(mutations.serverSeq));

  return c.json({ mutations: rows });
});

export default sync;
