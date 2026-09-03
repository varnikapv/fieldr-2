import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client';
import { visits } from '../db/schema';

/**
 * Wire format. Timestamps cross as epoch-millisecond integers — JSON has no
 * date type, and both sides must compare the identical integer.
 */
export type WireVisit = {
  id: string;
  patientName: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
};

function parseVisits(body: unknown): WireVisit[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { visits?: unknown }).visits;
  if (!Array.isArray(raw)) return null;

  const parsed: WireVisit[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const v = item as Record<string, unknown>;
    if (
      typeof v.id !== 'string' ||
      typeof v.patientName !== 'string' ||
      typeof v.notes !== 'string' ||
      !Number.isFinite(v.createdAt) ||
      !Number.isFinite(v.updatedAt)
    ) {
      return null;
    }
    parsed.push({
      id: v.id,
      patientName: v.patientName,
      notes: v.notes,
      createdAt: v.createdAt as number,
      updatedAt: v.updatedAt as number,
    });
  }
  return parsed;
}

const sync = new Hono();

/**
 * PUSH — client sends its local rows, server resolves last-write-wins.
 *
 * The rule, stated exactly once so the client can be checked against it:
 *   incoming replaces existing IF incoming.updatedAt > existing.updatedAt,
 *   OR the timestamps are identical AND incoming's (patientName, notes) sorts
 *   after existing's.
 *
 * The tie-break exists because two devices editing within the same millisecond
 * is common in testing. It cannot use `id` — a conflict is by definition two
 * rows with the SAME id — so it compares content. Arbitrary, but deterministic:
 * both sides independently reach the same verdict, which is what keeps the two
 * devices from diverging permanently.
 *
 * Note what this does NOT do: look at fields individually. The whole row wins
 * or the whole row loses. That is the naive part, and the data loss you are
 * about to observe.
 */
sync.post('/push', async (c) => {
  const body = await c.req.json().catch(() => null);
  const incoming = parseVisits(body);

  if (!incoming) {
    return c.json({ error: 'expected { visits: [{ id, patientName, notes, createdAt, updatedAt }] }' }, 400);
  }
  if (incoming.length === 0) {
    return c.json({ received: 0, applied: 0, discarded: 0 });
  }

  const applied = await db
    .insert(visits)
    .values(incoming)
    .onConflictDoUpdate({
      target: visits.id,
      set: {
        patientName: sql`excluded.patient_name`,
        notes: sql`excluded.notes`,
        createdAt: sql`excluded.created_at`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`
        excluded.updated_at > ${visits.updatedAt}
        or (
          excluded.updated_at = ${visits.updatedAt}
          and (excluded.patient_name || e'\\x01' || excluded.notes) collate "C"
            > (${visits.patientName} || e'\\x01' || ${visits.notes}) collate "C"
        )
      `,
    })
    .returning({ id: visits.id });

  // Rows the WHERE clause skipped were silently discarded — no error, because
  // losing under last-write-wins is not an error condition here.
  return c.json({
    received: incoming.length,
    applied: applied.length,
    discarded: incoming.length - applied.length,
  });
});

/**
 * PULL — the whole table, every time. No `since` cursor on purpose: this phase
 * is about observing conflict behaviour, not about efficient transfer.
 */
sync.get('/pull', async (c) => {
  const rows = await db.select().from(visits);
  return c.json({ visits: rows satisfies WireVisit[] });
});

export default sync;
