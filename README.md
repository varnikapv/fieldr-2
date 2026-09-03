# FieldNote

An offline-first sync engine, built by hand, demonstrated through a field-data
app for community health workers. The app is the harness; the sync engine is
the point.

Build order and working agreements live in [Agents.md](./Agents.md).

## Current phase

**Phase 5 (step 1 of 3) — device identity.** Operations carry which device
authored them, so a rejection can name the device that beat you. Auto-sync and
optimistic/pending UI are separate later steps.

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

## Phase 3: the mutation log

**The unit of sync is an operation, not a row.** Each log entry records an
intent — "set `notes` to X on visit Z at time T" — carrying a patch of *only
the fields that changed*. That absence is the entire fix: a field nobody
edited is not in the payload, so it physically cannot overwrite anyone else's
edit. Not better timestamps, not server validation. The field never being sent.

**Operations flow both directions.** Pushing operations while pulling whole
rows would leave the receiving device exactly as broken as phase 2, so pull
returns operations too, ordered by a server-assigned `serverSeq`. That sequence
is a *cursor*, not identity — `opId` and `entityId` stay client-generated, so
nothing on a device ever waits for a server number to exist.

**Dedupe by `opId`.** An operation the server already holds is a no-op success,
not an error. That is what makes a retried push safe, which in turn is what
lets a client mark entries synced only after acknowledgement. Note `opId`
succeeds as a tiebreaker exactly where row `id` failed in phase 2: a conflict
there was two rows sharing an id, whereas an operation id is unique per
operation.

**`visits` is a projection.** The log is the source of truth; `visits` exists so
the UI has something indexed to query. Nothing writes to it except mutation
application (`db/mutations.ts` on the client, `project()` on the server). A
direct write would be a state change with no operation behind it, and it would
never sync.

**What phase 3 does NOT fix.** Two devices editing the *same* field is a real
conflict, still resolved silently — the loser's text is gone with no prompt and
no error. Making that visible and reconcilable is phase 4. Clock skew is also
untouched: phase 3 narrows the blast radius from a whole row to a single field,
but a skewed clock still wins a same-field race. Causal ordering is phase 6.

## Phase 4: server-side validation and rejection

Phase 3 kept both edits when two devices changed *different* fields, but a
genuine same-field conflict still resolved silently: one edit won, the other
vanished with no trace. Phase 4 closes that.

**The shared follow-up list.** A separate table from `visits`, and the reason is
the conflict surface, not the field list. Visits collide on free text;
follow-ups collide on an enumerated `status`. You cannot reject an invalid
transition on a free-text field — squeezing status into a notes column would
make it unvalidatable, and validation is the entire point of this phase.

**Compare-and-set on `status`, and nothing else.** An operation that changes
status carries both sides — `{ from: 'open', to: 'done' }`. `from` is what the
device *believed* when the user acted. The server applies the change only if
that belief still holds; otherwise it refuses. This is the only concurrency
check in the system: no version counters, no generation numbers, and
explicitly no timestamp comparison, because a device clock cannot decide
whether someone else already acted.

`title` is deliberately never validated. Free text has no notion of "already
done", and rejecting it would reintroduce exactly the false conflicts phase 3
existed to remove.

**Per-operation results.** Push returns a verdict for every operation —
`accepted` (with its `serverSeq`), `duplicate`, or `rejected` (with a reason
code and the server's current value). One refused operation does not fail the
batch; everything else still commits. A rejection is a verdict, not an error.

**Rejected operations are never written to the server's log.** The log records
what actually happened, and an operation the server refused did not happen.

**On the client, a rejected operation is excluded from replay.** This is the
subtle part. The server never applied it, so replaying it locally would leave
the device displaying a value the server refused — silently disagreeing with
everyone else. Skipping it makes the item snap back to server truth, and that
snap-back is the user-visible form of the conflict. The operation stays in the
log, flagged, as a record of what this device attempted.

**No resolution UI, and no auto-retry.** A rejected operation is surfaced in
the sync inspector as "needs review" and left there. Auto-retrying would mean
silently re-applying an intent the server just refused — whether `done` still
makes sense after someone else reopened an item is a semantic judgment, and a
machine guessing it quietly is how the phase 2 class of bug comes back wearing
a new costume.

**Still anonymous.** No device id, no auth. Rejections describe state ("already
marked done"), not who did it. Identity is phase 5.

## Phase 5, step 1: device identity

A UUID generated on first launch and stored in SQLite's `sync_state` table,
beside the mutation log.

**Why SQLite and not AsyncStorage or SecureStore.** Lifecycle coupling. The
device id is a *label for a log*. If the two can be wiped independently you get
an identity that outlives its own history — a device calling itself `3f2a`
while holding none of `3f2a`'s operations. Keeping both in one database means a
reinstall resets them together. SecureStore has the sharpest version of this
problem, since keychain entries can survive app uninstall on iOS. It is also
simply the wrong tool: this is not a credential.

**Stored per operation, on both sides.** The alternative — sending it only as a
push-time header — collapses into the same thing, because attribution has to
travel for the inspector to say *another* device resolved an item, so the
server must store it and return it on pull anyway. The only thing header-only
saves is stamping locally-authored operations, and that leaves `NULL` meaning
"me" while pulled operations carry real ids. Every consumer would have to
remember that special case. One denormalized column removes the whole class.

**It lives in the envelope, never in the patch.** The patch describes field
changes; authorship is metadata about the operation. That separation is
structural, not stylistic: it means the compare-and-set check cannot read the
device id even by accident.

### Boundary: device id is display-only

This is a rule, not a preference, and it is written down here because
attribution *invites* misuse once it exists.

The device id is **never** consulted for:

- accepting or rejecting an operation — compare-and-set inspects `status`
  values and nothing else
- ordering — `serverSeq` alone defines the shared order
- tie-breaking — ties are broken by content, never by who sent it
- authority or priority — no device outranks another

It is used for exactly two things: showing you your own id in the sync
inspector, and naming the other device in a rejection message ("Device 8166
changed this first"). Introducing device priority, or ordering by device, would
reintroduce an arbitrary authority the log does not need and cannot justify —
the ordering is already deterministic without it.

This is also not authentication. The id is self-asserted, unverified, and
trivially forgeable. It is a name, not a claim. Real identity is a later step.

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

### Devices diverged permanently, and it was my own design error
Phase 3's first implementation passed the test it was built for — two devices
editing different fields of one visit both kept their edits — and then failed
the test that was only supposed to demonstrate a known gap.

Scenario: two devices, both offline, both edit the *same* field. Expected
outcome was one silent winner, agreed on by everyone, with the loser's text
gone. That is phase 4's gap and it is fine for now. What actually happened:

```
C sees: notes="D says: discharge"
D sees: notes="C says: refer to clinic"
converged: false
```

Not one edit lost — two devices holding different values for the same field,
forever, with no further syncing able to reconcile them. Strictly worse than
the phase 2 bug this phase existed to fix.

**Why.** Each device applied its own operation immediately when the edit
happened, then applied pulled operations in arrival order, with no check on
whether an arriving operation was *older* than one already applied to that
field. C's operation was assigned `serverSeq` 5, D's got 6. C applied its own,
pulled 6, and landed on D's value. D applied its own, pulled 5 — C's *older*
operation — and landed on C's value. Each device ended on whatever it happened
to see last. **Arrival order was deciding the winner, and arrival order differs
per device.** A log gives you the right *unit* of sync, but it does not give
you convergence for free; convergence needs a single order that every device
replays identically.

**The fix.** `visits` is now rebuilt from the log on every sync, replaying
server-confirmed operations in `serverSeq` order, then the device's own
not-yet-confirmed operations in local `seq` order. Every device replays the
same confirmed prefix in the same sequence, so arrival order stops mattering.
This also required a device to learn the `serverSeq` of *its own* operations —
they come back on pull and were previously skipped as duplicates, so pull now
records the sequence even when it skips re-applying the effect.

Considered and rejected: per-field version metadata (more efficient, but grows
the schema on both sides) and rebase-on-pull (the shape real systems use, but
it is phase 5's machinery arriving early). Rebuilding from the log is O(log
size) per sync, which is irrelevant at this scale, and it makes "`visits` is a
projection of the mutation log" literally true instead of aspirational.

After the fix, the same scenario converges on one winner on both devices, and
the different-fields scenario still keeps both edits.

### Phase 4 verified: the phase 3 gap, closed
Four scenarios run against the live server before device testing.

Two devices, both offline, both mark the same item done. First one in is
accepted. The second is refused with `stale`, and the response carries the
server's current value (`{"status":"done"}`). The refused device's item reverts
to `done`, and its attempt shows up flagged in the sync inspector. Both devices
agree, and nothing was destroyed silently — the same scenario in phase 3 threw
one edit away with no trace.

Also verified: a resolve racing a reopen is refused the same way; two devices
retitling the same item are both accepted and converge (free text is never
validated, so phase 3's behaviour is preserved exactly); and a `done -> done`
operation is refused as `invalid_transition`.

### Simulation harness collided with its own earlier runs
Unrelated to the app, but worth recording because the symptom was misleading.
The verification harness generated operation ids as `op-0001`, `op-0002`, and
so on. Re-running it against a server that still held rows from a previous run
meant every operation came back `duplicate`, the server correctly skipped
projecting them, and the item under test never existed — which surfaced as a
confusing `Cannot read properties of undefined`. The server behaved correctly
throughout; the harness was wrong. Switched it to random ids.

### Observed on real devices: a refused edit, explained
Ran the same-field conflict on two devices. Both offline, both marked the same
follow-up item done. The first device in was accepted; the second was refused,
and the sync inspector showed the flagged card:

> Rejected: stale — Someone else changed this first. Your change was not applied.

That single line is the difference between phase 3 and phase 4. The same
scenario in phase 3 picked a winner silently and left no trace anywhere that a
second edit had ever existed. Here the losing device keeps a record of what it
attempted, learns why it failed, and converges with everyone else instead of
quietly disagreeing.

### Phase 5 step 1 verified: rejection names the other device
Two devices, both offline, both mark the same item done. The second is refused
as before, but the flagged card now reads:

> Rejected: stale — Device 8166 changed this first. Your change was not applied.

Confirmed that the named id is the first device's real id, and that the server
stores authorship per operation (both of device A's operations came back
attributed to it on pull). Nothing about acceptance or rejection changed: the
same operation is refused for the same reason as in phase 4, only the
explanation got better.
