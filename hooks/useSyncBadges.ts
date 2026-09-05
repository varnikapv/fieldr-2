import { and, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useMemo } from 'react';

import { db } from '../db/client';
import { mutations, type EntityName } from '../db/schema';
import { toIdSet } from './toIdSet';

/**
 * Derived UI state for sync badges. Read-only: nothing here writes, and
 * nothing about mutation logic, replay, validation, rejection handling or the
 * sync triggers changes. The mutation log already knows all of this — these
 * are queries against it, not new state to keep in step.
 */

/**
 * Entities with an operation the server has not answered about yet.
 *
 * `synced = false` is the precise predicate: it means "no verdict yet". A
 * rejected operation has `synced = true` — the server *did* answer, it just
 * said no — so a rejection is not pending, it is a different badge.
 *
 * One subscription per screen rather than one per row: every write to
 * `mutations` re-runs this, and doing that N times for N rows would be waste.
 */
export function usePendingIds(entity: EntityName): Set<string> {
  const { data } = useLiveQuery(
    db
      .select({ entityId: mutations.entityId })
      .from(mutations)
      // Filtered by entity as well as id. Both tables use UUIDs so a collision
      // is vanishingly unlikely, but "these ids happen not to collide" is a
      // weaker guarantee than asking for the right entity outright.
      .where(and(eq(mutations.entity, entity), eq(mutations.synced, false))),
  );

  return useMemo(() => toIdSet(data ?? []), [data]);
}

/**
 * Entities with an operation the server refused.
 *
 * The badge is permanent by design. Phase 4 deliberately has no resolution UI,
 * so there is no action that makes a rejection "handled" — and a marker that
 * quietly cleared itself would be the same silent disappearance this project
 * exists to eliminate. Clearing it is the next step's problem.
 */
export function useRejectedIds(entity: EntityName): Set<string> {
  const { data } = useLiveQuery(
    db
      .select({ entityId: mutations.entityId })
      .from(mutations)
      .where(and(eq(mutations.entity, entity), eq(mutations.rejected, true))),
  );

  return useMemo(() => toIdSet(data ?? []), [data]);
}
