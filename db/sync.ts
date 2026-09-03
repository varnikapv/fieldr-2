import { eq } from 'drizzle-orm';

import { db } from './client';
import { visits, type Visit } from './schema';

/**
 * Wire format — must stay identical to server/src/routes/sync.ts.
 * Timestamps are epoch-millisecond integers, not Date and not ISO strings:
 * both sides have to compare the exact same integer.
 */
export type WireVisit = {
  id: string;
  patientName: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
};

export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787';

export type SyncResult = {
  pushed: number;
  discardedByServer: number;
  pulled: number;
  insertedLocally: number;
  /** Local rows replaced by the server's version. This is the data loss. */
  overwrittenLocally: number;
  keptLocal: number;
  at: Date;
};

function toWire(visit: Visit): WireVisit {
  return {
    id: visit.id,
    patientName: visit.patientName,
    notes: visit.notes,
    createdAt: visit.createdAt.getTime(),
    updatedAt: visit.updatedAt.getTime(),
  };
}

/**
 * The last-write-wins rule, client side. This MUST agree with the server's
 * `setWhere` clause exactly — if the two sides ever disagreed about who won,
 * the devices would diverge permanently and never converge again.
 *
 * Newer `updatedAt` wins outright. On an exact millisecond tie, content
 * decides: the two fields are joined with a low separator byte and compared
 * byte-wise, matching the server's `collate "C"` comparison. Arbitrary, but
 * deterministic and identical on both sides.
 *
 * Note what is absent: any notion of individual fields. The winner's entire
 * row replaces the loser's entire row.
 */
export function incomingWins(incoming: WireVisit, existing: WireVisit): boolean {
  if (incoming.updatedAt !== existing.updatedAt) {
    return incoming.updatedAt > existing.updatedAt;
  }
  const a = `${incoming.patientName}${incoming.notes}`;
  const b = `${existing.patientName}${existing.notes}`;
  return a > b;
}

export async function syncNow(): Promise<SyncResult> {
  const local = await db.select().from(visits);

  const pushResponse = await fetch(`${API_BASE_URL}/sync/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visits: local.map(toWire) }),
  });
  if (!pushResponse.ok) {
    throw new Error(`push failed: HTTP ${pushResponse.status}`);
  }
  const pushed = (await pushResponse.json()) as {
    received: number;
    applied: number;
    discarded: number;
  };

  const pullResponse = await fetch(`${API_BASE_URL}/sync/pull`);
  if (!pullResponse.ok) {
    throw new Error(`pull failed: HTTP ${pullResponse.status}`);
  }
  const { visits: remote } = (await pullResponse.json()) as {
    visits: WireVisit[];
  };

  const localById = new Map(local.map((visit) => [visit.id, toWire(visit)]));

  let insertedLocally = 0;
  let overwrittenLocally = 0;
  let keptLocal = 0;

  for (const incoming of remote) {
    const existing = localById.get(incoming.id);

    if (!existing) {
      await db.insert(visits).values({
        id: incoming.id,
        patientName: incoming.patientName,
        notes: incoming.notes,
        createdAt: new Date(incoming.createdAt),
        updatedAt: new Date(incoming.updatedAt),
      });
      insertedLocally += 1;
      continue;
    }

    if (incomingWins(incoming, existing)) {
      // The local version is destroyed here. No error, no prompt, and no
      // record of what it used to say — overwriting is what last-write-wins
      // calls success. The console line below exists only so the moment of
      // loss is observable at all.
      console.log(
        `[sync] overwriting local ${incoming.id.slice(0, 8)}: ` +
          `"${existing.patientName}" / "${existing.notes}" -> ` +
          `"${incoming.patientName}" / "${incoming.notes}"`,
      );
      await db
        .update(visits)
        .set({
          patientName: incoming.patientName,
          notes: incoming.notes,
          createdAt: new Date(incoming.createdAt),
          updatedAt: new Date(incoming.updatedAt),
        })
        .where(eq(visits.id, incoming.id));
      overwrittenLocally += 1;
      continue;
    }

    keptLocal += 1;
  }

  return {
    pushed: pushed.received,
    discardedByServer: pushed.discarded,
    pulled: remote.length,
    insertedLocally,
    overwrittenLocally,
    keptLocal,
    at: new Date(),
  };
}
