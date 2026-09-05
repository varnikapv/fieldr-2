# AGENTS.md — FieldNote (offline-first sync engine)

## What this project actually is
Not a field-data app. A hand-engineered offline-first sync engine, demonstrated
through a field-data app for community health workers. The app is the demo
harness. The sync engine is the point.

This is a learning rebuild. A previous version used WatermelonDB, which
handled sync automatically — it was never understood deeply enough to explain
or debug. This rebuild exists so every sync mechanism can be explained,
defended, and maintained by the person who owns it — not so that no code gets
written by AI.

## How work actually happens here
Claude can write code. What Claude must not do is make the design decisions
silently and hand over a working result the user hasn't engineered.

For any non-trivial piece (schema shape, sync protocol, conflict resolution,
retry/rebase logic, ID strategy, anything touching the mutation log):
1. Discuss the approach and trade-offs first. Don't jump straight to code.
2. The user states the decision in their own words before it's implemented —
   even briefly ("okay so client generates the UUID because—"). If they can't,
   that's the signal to explain more, not to proceed.
   When checking this, don't just ask an open "explain it back" question —
   offer 2-3 concrete framings or options for the user to pick between or
   react to (e.g. "is it closer to X, or to Y?"). Free recall from nothing is
   a worse test of understanding than reacting to a sharp option, and it's
   more friction for no benefit. Reserve pure open recall for load-bearing
   decisions the user themselves flags as important — everything else can be
   options-first.
3. Claude implements it.
4. The user should be able to walk through the resulting code line by line
   afterward. If a review makes clear they can't, stop and re-explain rather
   than moving to the next piece.

Boilerplate (nav setup, styling, config, test scaffolding) doesn't need this
ceremony — write it directly.

The test for "is this understood enough": could the user explain this
specific piece to an interviewer, unprompted, including why it's built this
way and not some simpler way? If not, pause there before adding more.

## Hard rule: do not build ahead of the current phase
Check `Phase: N` below before implementing anything. If a request implies work
from a later phase, say so and ask whether to jump ahead deliberately or stay
in scope. Don't silently build later-phase functionality because it's
convenient or the code is already halfway there.

## Hard rule: observe the failure before fixing it
Each phase transition exists to fix a specific, concrete failure of the
previous phase (e.g. two devices editing the same record under naive
last-write-wins and one silently losing data). Before implementing the fix,
confirm the failure has actually been triggered and seen — a screenshot, a
log, a described repro — not assumed. If it hasn't been observed yet, run the
failing scenario first.

## Current phase
`Phase: 5 (step 4 — sync on local write; 6+ optional, not started)`
Update this yourself as phases complete.

## The full ladder (context for every phase, not just the current one)
1. **Local-only** — SQLite on device, no server exists, no network code.
   Client-generated UUIDs from day one.
2. **Naive push/pull sync** — last-write-wins against a server. Deliberately
   built to fail: the goal of this phase is to trigger and observe data loss
   with two devices editing the same record.
3. **Mutation log** — stop syncing rows, sync ordered operations instead.
   Direct response to phase 2's failure.
4. **Conflict handling** — server validates/rejects a mutation; client
   reconciles its local queue against the rejection. Exercised via the shared
   follow-up list (the one entity multiple people genuinely edit).
5. **Optimistic UI + device identity** — writes land instantly, roll back
   cleanly on rejection; auth/device ID introduced here, not earlier.
6+. **Optional, not required for the resume goal:** causal ordering under
   out-of-order/duplicate delivery, log compaction, blob attachment sync
   (photos, independent lifecycle from metadata). Only pursue these if there's
   real spare time — the project is portfolio-ready after phase 4-5.

## Stack (do not substitute without asking)
- Client: Expo (managed) + React Native
- Local DB: expo-sqlite
- ORM/schema: Drizzle ORM + drizzle-kit (schema shared client/server)
- IDs: client-generated UUIDs via expo-crypto. Never server-assigned, never
  auto-increment — this is why offline creation is possible at all.
- Server (phase 2+): Hono on plain Node, run locally. Do not deploy to
  Cloudflare Workers or introduce Durable Objects unless explicitly asked.
- Server DB (phase 2+): Neon Postgres
- Deliberately dropped: WatermelonDB. Don't reintroduce it or suggest it as a
  shortcut — replacing what it did automatically is the reason this exists.

## Scope (final — confirm before adding to this)
Entities: Household → Visit → Observation, one shared multi-editor follow-up
list, soft deletes on visits, photo attachments (phase 6+, own sync lifecycle).
Screens: household list, visit capture, follow-up list, sync inspector. Four
screens, no more. No dashboards, reports, exports, notifications, or AI
features — cut on purpose to keep this demo-sized, not backlog.

## Testing philosophy
Every phase has a manual, narratable test (e.g. "add records in airplane
mode, force-quit, reopen, confirm they persist"). When a phase looks done,
state that test explicitly and have the user actually run it before marking
the phase complete — passing code isn't the same as an understood, verified
phase.

## README discipline
Keep a "what broke and what I changed" section, written as failures are
actually hit — not backfilled at the end. This becomes the strongest part of
the README and the most interview-relevant section. Prompt to add an entry
whenever a real bug gets found and fixed.

## Tone
The first build felt "handed to" the user rather than built by them, which is
what this rebuild is correcting. Optimize for the user being able to defend
every design decision in an interview, not for finishing fast. When there's a
faster way and a way that builds understanding, default to the latter unless
told otherwise — but don't turn writing code into an obstacle course either;
the goal is engineering ownership, not typing everything by hand.