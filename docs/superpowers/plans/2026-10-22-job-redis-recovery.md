# Job Redis generation recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans, then independent review until findings converge.

**Goal:** Recover lost Redis gates without reusing queue generations or guessing that durable reservations are free.

**Architecture:** A dedicated PostgreSQL session advisory lock serializes startup coordinators across short DB transactions and Redis operations. Durable recovery_pending flags fence dispatch and execution claims until both gates are advanced and every older reservation is retired and released. Healthy concurrent starters join the same generation. The real worker/lifecycle and business handlers remain subsequent J2 work.

**Tech Stack:** TypeORM QueryBuilder, PostgreSQL advisory locks, pinned BullMQ 6.3.11 Lua, Vitest with real DB/Redis.

**Spec:** `docs/superpowers/specs/2026-10-21-job-persistence-design.md` §6.1 and §9.

## Global constraints

- Both queues retain their 10000 reservation bounds. Reconciliation reads at most100 rows per batch and never resets counters.
- No execution attempts, deadlines, immutable payloads or logical DB charges are reset by queue recovery.
- DB generation commits before Redis gates advance. New claims wait while recovery is pending; active business execution ownership is retained.
- CAS compares exact decimal strings, including generations beyond JavaScript safe integers. Future/invalid Redis gates fail closed.
- No applied migration edits, backend-upstream changes, fake handlers or automatic worker activation.

## Review focus

- DB commit followed by initializer death must resume the pending generation without another increment.
- One gate initialized before failure must not expose either queue to claims.
- Active or ambiguous old entries must retain capacity and fail startup.
- Concurrent starters must not reset a healthy worker's generation.
- Lost coordinator connection or changed Redis gate must not permit stale initialization to overwrite a newer generation.

### Task1: Persist and enforce the startup fence

Files: new `platform/database/post-work/recovery-migration.ts`; modify dispatch-schema.ts, migration-sources.ts, dispatch.ts, local-execution.ts; test `test/integration/post-work-recovery.test.ts`.

- [x] Write real DB tests: pending controls reject both dispatch and local execution claims without attempts/seq mutations; schema matches; migration up/down preserves control values.
- [x] Observe failure, add recovery_pending boolean defaultfalse via new migration, enforce after acquiring sorted controls.
- [x] Verify near tests and schema checks.

### Task2: Coordinate recovery and Redis CAS

Files: new `platform/database/post-work/recovery.ts`; modify jobs/bullmq-dispatch.ts; same integration test.

Interfaces: `recoverPostWork(source, transport)` returns `{deliver,postLocal}` generation strings. Transport provides readGeneration(queue), replaceGeneration(queue,expected,next), retire(reservation). It must run before future consumers/scanners/HTTP readiness. A dedicated DataSource/session owns the advisory lock and is destroyed on every exit.

- [x] Test fresh start, healthy concurrent join, Redis namespace loss with real queued entries, stale enqueue rejection and new seq recovery.
- [x] Test partial gate/DB commit ambiguity, active and response-lost retirement, future gate, CAS mismatch and >2^53 generation.
- [x] Observe missing recovery behavior fail, implement short locked DB prepare/finalize transactions with persistent pending flags, CAS gates, bounded old-reservation batches and idempotent release. Pending restart reuses committed generations.
- [x] Verify failures leave pending/counters intact; successful restart drains reservations before clearing pending. Preserve logical row/byte charges and business state.

### Task3: Deliver

- [x] Update README with caller/startup requirements and remaining J2 business/lifecycle/J3 work.
- [x] Run unit/near integration/build/typecheck, schema+migration roundtrip, shipping lint/SPDX/locale/diff.
- [x] Independent review, fix and repeat until actionable findings converge.
- [x] Prepare the verified branch and PR description for authorized publication referencing #124 without closing it.


## Execution record

- Base develop52d921b77a (merged PR152); worktree `/tmp/tiramiss-job-recovery-124`, branch `feat/backend-next-job-recovery-124`.
- Design reviewed independently before implementation; the persisted pending fence and CAS approach were accepted.
- RED: missing recovery module/column, followed by the exported recovery stub failing9 cases while the DB fence/schema cases passed. GREEN:14 recovery integration cases passed.
- Fault tests include before either gate, after one gate, Redis acknowledgement loss, gate loss during reconciliation, active entry, retire response loss, and real PostgreSQL coordinator session termination. Four concurrent starters share one generation;101 unexpired old entries drain; bigint generations retain exact strings.
- Unit185 PASS; integration138 PASS; build/typecheck PASS; migration roundtrip and schema check PASS; shipping lint11/SPDX2956/locale PASS; diff check PASS.
- Existing pg concurrent-query migration deprecation warnings remain unchanged. No backend API, legacy backend, frontend, locale or upstream managed files changed. No process tests: the new entry is intentionally not wired to process startup yet.
- Independent whole-branch review:0 actionable findings. No rulings or deferred minor findings.
- Product business handlers, real Note producer, AP recipients/host/send semantics, notification storage/effect and worker/scanner health/shutdown integration remain J2 work. J3 remains separate. #124 is not closed.
