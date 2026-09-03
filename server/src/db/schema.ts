import { bigint, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * Server-side mirror of the client's `visits` table.
 *
 * Deliberately not the same file as the client schema: drizzle's sqlite and
 * pg builders are different dialects. Column names and semantics are kept
 * identical by hand, because sync compares these fields across the wire.
 *
 * Timestamps are stored as bigint epoch-milliseconds in `number` mode rather
 * than a pg `timestamp`. Last-write-wins compares these values as integers on
 * both sides; keeping the exact same integer representation everywhere means
 * no timezone or precision conversion can quietly change the outcome of a
 * comparison the whole sync protocol rests on.
 */
export const visits = pgTable('visits', {
  id: text('id').primaryKey(),
  patientName: text('patient_name').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export type ServerVisit = typeof visits.$inferSelect;
