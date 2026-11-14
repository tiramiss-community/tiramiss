# Local outbox and Note activity #324 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Publish local outbox collections and local Note Create/Announce activities with fixed-source behavior.

**Architecture:** Plain federation contracts own candidate selection and collection documents. TypeORM and existing timelinesRedis adapters acquire facts; composition prepares existing Note materials. HTTP owns query parsing, routing, negotiation and response metadata. No UseCase calls another UseCase.

**Tech Stack:** TypeScript, Hono, TypeORM/PostgreSQL, ioredis, Vitest; installed Node 26.4.0 and pnpm 12.9.1 only.

**Spec:** Issue #324, GOALS.md and ROADMAP.md; authoritative source `8e07cf085adf7009583d234a208e30436f020e26`, supplied upstream/architecture/evidence/plan reports.

## Global Constraints

No migration/entity synchronization, dependencies, configuration, producer rewrites, locale/CHANGELOG edits, historical evidence rewrites, commits or external mutations. Preserve #176/#127 OPEN, notes/create partial, postingComplete:false, D7, PG notification storage and deferred ordering. Independent writer owns the outbox corpus/probe/observations; parent owns evidence successor and inventory.

## Review Focus

- Raw malformed/empty/decoded UTF16 path boundaries must precede federation/CORS.
- Empty/repeated cursor parameters preserve source validation and URL normalization.
- Cached filtered/missing IDs advance fallback from the last consumed candidate.
- Redis errors fail rather than silently fall back; null exec is empty.
- Publication pure Renotes require a target; quotes tolerate missing targets; delivery remains unchanged.

### Task 1: Plain selection and publication contracts

Files: new federation local-outbox module, new published-activity composition, minimal note-activity/public export changes; unit tests.
Interfaces: OutboxReader local-user/count, DB page, timeline lists and hydrated candidate facts; readOutboxNotes and renderOutboxCollection consume plain values. preparePublishedActivity returns bare Create/Announce using existing publication materials.
- [x] Write and run RED for nearest-newer, refill/fallback cursor, missing pure target, bare context.
- [x] Implement source candidate ordering/filter/refill and renderer reuse, retaining delivery defaults.
- [x] Run focused GREEN.

### Task 2: Database/Redis adapters and HTTP wiring

Files: new platform outbox adapters, HTTP activity/outbox adapter, composition factory; existing HTTP app and publication row mapper exports.
Interfaces: createOutboxReader(manager,timelinesRedis) implements Task 1 ports. HTTP calls federation gate then query validation/local lookup, returning plain documents.
- [x] Write and run RED for actual HTTP route behavior before registration.
- [x] Implement local-only activity lookup; exact DB predicate/order, full Redis list reads, joined candidate projection, raw routing/query and metadata.
- [x] Run focused HTTP/composition GREEN and typecheck.

### Task 3: Real dependency validation and handoff

Files: new listening HTTP/PG/Redis integration; dedicated independent static fixture consumer when available; this plan status only.
- [ ] Execute authored tests for duplicate/stale/missing/filtered cache candidates, refill/fallback/since, WRONGTYPE, DB-only differences and HTTP posting producer; capture GET DML excluding explicitly established infrastructure exceptions.
- [x] Attempt real integration using dedicated PG56474/Redis57474; record sandbox failures without reporting skips as passes.
- [x] Run focused unit, build, typecheck, changed-file lint, SPDX and locale checks; save every log and binary patch under supplied /tmp directory.
- [x] Report exact files, interfaces, counts, failures and hashes requiring parent successor work.

## Execution record

- Tasks 1–2 implemented after RED: absent outbox contract (18 failures), unregistered HTTP routes (2 failures), bare activity context (1 failure), malformed OPTIONS routing (2 failures). GREEN covers the plain selection/publication/HTTP contracts and existing featured/follow behavior.
- Task 3 authored 23 listening HTTP/PG/Redis cases. Execution failed during setup with sandbox `connect EPERM 127.0.0.1:56474`; all 23 cases remain unexecuted here. Parent must run them against dedicated dependencies.
- Independent corpus/observations became readable in the installed parent tree. A static-import consumer covers all 104 source cases plus fixture identity (105 tests), including documents, headers, related reads, cache batches and fallback arguments. Only the source probe's foreign-VM TypeError diagnostic `{}` is compared separately from the adapter's standard error JSON. No fixture bytes were changed.
- The worker uses a temporary `/tmp/.../runtime-writer-source-vitest.config.mjs` resolver for those two absent worker fixtures. Parent must integrate both patches and rerun canonical test discovery. The narrow JSON declarations support static test imports without changing project configuration.
- Ruling: explicit static empty-path registrations avoid Hono's empty regexp capture crash while preserving source routing. No existing route was changed.
- Focused units, build and test typecheck passed before final shipping checks; exact final counts/logs and historical input digests are in the runtime writer handoff under `/tmp/tiramiss-s1-324-20261114/`. No parent/CI verification is claimed.
