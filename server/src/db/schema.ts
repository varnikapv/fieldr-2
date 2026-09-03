import { bigint, bigserial, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * Server-side projection of the mutation log.
 *
 * As of phase 3 this is derived state, exactly as on the client: rows here are
 * only ever written by applying operations from `mutations`.
 */
export const visits = pgTable('visits', {
  id: text('id').primaryKey(),
  patientName: text('patient_name').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export type VisitPatch = Partial<{
  patientName: string;
  notes: string;
  createdAt: number;
}>;

export type FollowUpStatus = 'open' | 'done';

/** Both sides of a status change — `from` is what the client believed. */
export type StatusChange = { from: FollowUpStatus; to: FollowUpStatus };

export type FollowUpPatch = Partial<{
  title: string;
  status: StatusChange;
  createdAt: number;
}>;

export type MutationPatch = VisitPatch & FollowUpPatch;

export type EntityName = 'visits' | 'follow_ups';

/** The shared, multi-editor list. Projection of the log, same as `visits`. */
export const followUps = pgTable('follow_ups', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').$type<FollowUpStatus>().notNull().default('open'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export type ServerFollowUp = typeof followUps.$inferSelect;

export type MutationKind = 'insert' | 'update' | 'delete';

/**
 * The server's copy of the mutation log — the source of truth.
 *
 * `serverSeq` is assigned here and drives the pull cursor. Note what it is
 * NOT: identity. `opId` and `entityId` remain client-generated, so nothing on
 * a device ever waits for a server-assigned number to exist. Phase 1's
 * principle is intact.
 */
export const mutations = pgTable('mutations', {
  serverSeq: bigserial('server_seq', { mode: 'number' }).primaryKey(),
  opId: text('op_id').notNull().unique(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  kind: text('kind').$type<MutationKind>().notNull(),
  patch: jsonb('patch').$type<MutationPatch>().notNull(),
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),

  /**
   * Which device authored this operation. Envelope metadata, not part of the
   * patch. Display and narrative only — never read by validation, never used
   * for ordering or tie-breaking.
   */
  deviceId: text('device_id'),
});

export type ServerMutation = typeof mutations.$inferSelect;
