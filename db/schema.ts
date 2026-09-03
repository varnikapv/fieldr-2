import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A visit to a household.
 *
 * `id` is a client-generated UUID (expo-crypto), never server-assigned and
 * never auto-increment: a record has to be fully addressable the instant it is
 * created, with no network. If the server minted the id, either offline
 * creation is impossible, or every reference to a row (foreign keys, queued
 * mutations) would need rewriting when a temporary local id got swapped for
 * the real one.
 *
 * As of phase 3 this table is a MATERIALIZED PROJECTION of the mutation log,
 * not the source of truth. It exists so the UI has something indexed to query.
 *
 * DISCIPLINE RULE: nothing writes to this table except mutation application in
 * db/mutations.ts. A direct write here would be a state change with no
 * operation behind it, and it would never sync.
 */
export const visits = sqliteTable('visits', {
  id: text('id').primaryKey(),
  patientName: text('patient_name').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  // Kept for display only. As of phase 3 this no longer resolves anything:
  // conflicts are decided by the log, not by comparing this column.
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Visit = typeof visits.$inferSelect;
export type NewVisit = typeof visits.$inferInsert;

/** Fields of a visit that a mutation is allowed to change. */
export type VisitPatch = Partial<{
  patientName: string;
  notes: string;
  createdAt: number;
}>;

export type FollowUpStatus = 'open' | 'done';

/**
 * A status change carries BOTH sides, not just the new value.
 *
 * `from` is what the client believed the status was when the user acted. The
 * server accepts the operation only if that still matches reality — a
 * compare-and-set. This is the only conflict check phase 4 adds: no version
 * counters, no timestamp comparisons.
 */
export type StatusChange = { from: FollowUpStatus; to: FollowUpStatus };

/**
 * `title` is free text and keeps phase 3's plain replay semantics — it is
 * never rejected. Only `status` is validated, because only a state machine
 * gives "someone already did this" a meaning worth enforcing.
 */
export type FollowUpPatch = Partial<{
  title: string;
  status: StatusChange;
  createdAt: number;
}>;

export type MutationPatch = VisitPatch & FollowUpPatch;

export type EntityName = 'visits' | 'follow_ups';

/**
 * The shared follow-up list — the one entity multiple people genuinely edit
 * at once. A separate table from `visits` because its conflict surface is
 * different: visits collide on free text, follow-ups collide on an enumerated
 * state. You cannot reject an invalid transition on a free-text field, and
 * rejection is the whole point of phase 4.
 *
 * Also a projection of the mutation log. Same discipline rule as `visits`:
 * nothing writes here except mutation application.
 */
export const followUps = sqliteTable('follow_ups', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').$type<FollowUpStatus>().notNull().default('open'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type FollowUp = typeof followUps.$inferSelect;

export type MutationKind = 'insert' | 'update' | 'delete';

/**
 * The mutation log — the source of truth as of phase 3.
 *
 * Each row records an INTENT ("set notes to X on visit Z at time T"), not a
 * snapshot of state. This is the fix for phase 2's data loss: a snapshot
 * carries fields the user never touched, and those stale fields overwrite real
 * edits. A patch physically cannot contain a field nobody changed.
 */
export const mutations = sqliteTable('mutations', {
  /**
   * Local monotonic ordering. Two edits on one device within the same
   * millisecond must still replay in the order they happened, which a
   * timestamp alone cannot guarantee. This is ordering within a single
   * device's own log — not distributed causality, which is phase 6.
   */
  seq: integer('seq').primaryKey({ autoIncrement: true }),

  /**
   * Identity of the OPERATION (not the record), client-generated. Makes push
   * idempotent: the server dedupes on this, so a retried push is harmless.
   * Note this is the tiebreaker that `id` could not be in phase 2 — a conflict
   * there was two rows sharing an id, whereas opId is unique per operation.
   */
  opId: text('op_id').notNull().unique(),

  /** Which table. 'visits' today; observations and follow-ups arrive later. */
  entity: text('entity').notNull(),

  /** Which record. */
  entityId: text('entity_id').notNull(),

  kind: text('kind').$type<MutationKind>().notNull(),

  /** Only the fields that actually changed. Absence is the whole point. */
  patch: text('patch', { mode: 'json' }).$type<MutationPatch>().notNull(),

  /**
   * Device clock. Phase 3 does NOT fix clock trust — it narrows the blast
   * radius from a whole row to a single field. A skewed clock still wins a
   * same-field race.
   */
  timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),

  /** False until the server has acknowledged this entry. Drives push. */
  synced: integer('synced', { mode: 'boolean' }).notNull().default(false),

  /**
   * Position in the server's shared order, learned on pull — null until then.
   *
   * This is what makes replay deterministic across devices: every device
   * replays server-confirmed operations in this order, then its own
   * not-yet-confirmed operations. Without it a device cannot place its OWN
   * operations in the shared sequence, and two devices can end up applying
   * the same pair of operations in opposite orders and diverge forever.
   */
  serverSeq: integer('server_seq'),

  /**
   * The server refused this operation. It was never applied anywhere, so it
   * MUST be excluded from replay — otherwise this device would keep showing a
   * value the server rejected and would silently disagree with every other
   * device. Excluding it is what makes the local state snap back to server
   * truth, which is the user-visible form of the conflict.
   */
  rejected: integer('rejected', { mode: 'boolean' }).notNull().default(false),

  /** 'stale' or 'invalid_transition'. Null unless rejected. */
  rejectionReason: text('rejection_reason'),

  /** Which device made the change that beat ours. Null unless known. */
  rejectionByDevice: text('rejection_by_device'),

  /**
   * Which device authored this operation. Envelope metadata, NOT part of the
   * patch — that separation is what structurally prevents it from ever being
   * read by the server's compare-and-set check.
   *
   * Display and narrative only. Never consulted for acceptance, rejection,
   * ordering, or tie-breaking. Null on operations recorded before phase 5.
   */
  deviceId: text('device_id'),
});

export type Mutation = typeof mutations.$inferSelect;
export type NewMutation = typeof mutations.$inferInsert;

/**
 * Small key/value table. Currently holds only the pull cursor: the highest
 * server sequence this device has already replayed.
 */
export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
