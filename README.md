# FieldNote

An offline-first sync engine, built by hand, demonstrated through a field-data
app for community health workers. The app is the harness; the sync engine is
the point.

Build order and working agreements live in [Agents.md](./Agents.md).

## Current phase

**Phase 2 — naive push/pull sync.** Last-write-wins against a Hono server on
Neon Postgres. Deliberately the wrong long-term design: the goal of this phase
is to trigger and observe silent data loss, not to make sync work cleanly.

## Stack

- Expo (managed) + React Native, TypeScript
- expo-sqlite for local storage
- Drizzle ORM + drizzle-kit, migrations generated and applied on device
- expo-crypto for client-generated UUIDs
- Hono on plain Node + Neon Postgres (`server/`), neon-http driver

## Running it

```sh
cd server && npm run dev     # Hono on :8787, bound to 0.0.0.0 for LAN access
npx expo start               # app; set EXPO_PUBLIC_API_URL to this machine's LAN IP
```

## Design decisions

**Client-generated UUIDs, never server-assigned.** Creating a record cannot
depend on reaching a server, because for hours at a time there is no server to
reach. If the server minted the id, either offline creation is impossible
outright, or you patch around it with a temporary local id that gets swapped
for the real one on reconnect — and every reference to that record (an
observation pointing at a visit, a queued mutation, a foreign key) then has to
be rewritten at swap time, on every device, in the right order. A
client-generated UUID is permanent from the instant of creation, so nothing
downstream ever needs remapping.

**Timestamps as epoch-millisecond integers.** Integers sort and compare with no
parsing and no timezone ambiguity. Drizzle's `timestamp_ms` mode stores the
plain int but hands TypeScript a `Date`. These are *device* clock readings —
harmless in phase 1, where one device only sorts its own rows, and deliberately
load-bearing in phase 2, where comparing them across devices under
last-write-wins is what is supposed to lose data.

**List sorted by `createdAt`, not `updatedAt`.** Sorting by `updatedAt` would
make an edited row jump to the top of the list. With no edit UI until phase 4,
the two are identical today — so lock in the predictable one now and make the
reorder-on-edit call deliberately later, rather than inheriting it by accident.

**Real migration pipeline, not `CREATE TABLE IF NOT EXISTS`.** The schema
changes in every remaining phase, drizzle tracks which migrations have already
run on a given device, and the same schema file is meant to be shared with the
server from phase 2. Standing the pipeline up with one table and nothing to
lose is cheaper than standing it up in the middle of a phase 3 sync bug.

## Phase 2: last-write-wins, and why it is wrong

**The rule.** For a row present on both sides, compare `updatedAt`; the newer
one's *entire row* replaces the other. Not a field-level merge — a whole-record
overwrite. Implemented server-side as a single `INSERT ... ON CONFLICT DO
UPDATE` with a `WHERE` clause, so the comparison is atomic rather than a
read-then-write race, and mirrored exactly in `db/sync.ts` on the client.

**Why whole-row replacement loses data.** Two devices editing *different fields*
of the same visit have not actually conflicted — a human merging by hand would
keep both edits. LWW cannot see fields, only the row's timestamp, so the newer
row wins wholesale and the loser's edit is discarded.

**Why the loss is silent.** No error fires, because nothing failed. Both writes
were individually valid, and an overwrite is what LWW calls success. The push
that destroys an edit returns `applied: 1`. This is the dangerous part: not that
something breaks, but that everything works perfectly while quietly destroying
data.

**Why the timestamps cannot be trusted anyway.** `updatedAt` is `Date.now()` on
a phone. Two devices with clock skew produce values that cannot be honestly
ordered, so LWW really means "whichever device *claims* the later time wins."

**The tie-break.** On an exact millisecond tie, content decides: `patientName`
and `notes` joined with a `0x01` separator, compared byte-wise (`collate "C"` on
the server, matching JS code-unit order on the client). It is arbitrary, but it
is deterministic and identical on both sides, which is what stops the two
devices from diverging permanently. Note the tie-break *cannot* use `id` — a
conflict is by definition two rows with the same `id`, so an id comparison is
always equal and resolves nothing.

Phase 3 replaces all of this by syncing ordered operations instead of rows.

## What broke and what I changed

Written as failures are actually hit.




### Observed: last-write-wins destroying an edit (protocol level)
Reproduced against the running server before device testing. One visit synced to
both sides; device A renames the patient (`updatedAt` 2000), device B edits the
notes (`updatedAt` 3000). Both push. Server ends up with B's notes *and B's stale
copy of the patient name* — A's rename is gone. Both pushes returned
`applied: 1` and neither device saw an error.

### Observed on real devices: an edit destroyed, and the report that hid it
Ran the two-device conflict on a phone and a simulator. Both devices held the
same visit, both went offline, each edited it, both reconnected and synced. The
device with the older `updatedAt` lost its edit: its row reverted to the other
device's version, and its sync summary read `overwritten 1`. No error appeared
on either device, and the losing device's push had reported success.

The confusing part was the reporting, not the sync. Syncing a second time on the
losing device showed `overwritten 0` — correctly, because by then local already
matched the server and there was nothing left to destroy. The overwrite is a
one-shot event and the summary only ever describes the most recent sync, so the
evidence of the loss is exactly one tap wide. Worth noting as a lesson in its
own right: a naive sync destroys data quietly, and naive instrumentation loses
the only trace of it just as quietly.

### Fixed: empty push reported `discarded: undefined`
The push endpoint's early return for a zero-row body omitted the `discarded`
field the non-empty path returns, so a device with nothing to push rendered
"server discarded undefined" in its summary. Made the response shape consistent.
