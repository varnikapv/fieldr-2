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
 * Timestamps are epoch-millisecond integers. `timestamp_ms` mode stores the
 * plain int in SQLite but hands TypeScript a `Date`. These are *device* clock
 * readings — fine here, where a single device only sorts its own rows, and
 * deliberately load-bearing in phase 2, where comparing them across devices
 * under last-write-wins is what is supposed to lose data.
 */
export const visits = sqliteTable('visits', {
  id: text('id').primaryKey(),
  patientName: text('patient_name').notNull(),
  notes: text('notes').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export type Visit = typeof visits.$inferSelect;
export type NewVisit = typeof visits.$inferInsert;
