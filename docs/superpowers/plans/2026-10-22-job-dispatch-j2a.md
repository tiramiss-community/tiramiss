# J2a: durable BullMQ dispatch implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this plan. Independent whole-branch review is required before opening the PR.

**Goal:** Implement the bounded dispatch half of #124 J2, carrying J1 work IDs into BullMQ without losing DB work or exceeding the reserved queue capacity.

**Architecture:** PostgreSQL owns per-item dispatch claims and per-sequence reservations. A BullMQ 6.3.11 adapter prepends a generation/token/absolute-expiry fence to the installed addStandardJob Lua script, making the fence and insertion atomic. Retirement fences delayed producers before checking/removing the queue entry; only then may PostgreSQL release its reservation.

**Tech Stack:** TypeORM, PostgreSQL 18, Redis 8, BullMQ 6.3.11, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-job-persistence-design.md` §§4.2, 6.1–6.2, 9.

## Global constraints

- Claims last 30 seconds; tokens expire at reservation time +60 seconds without renewal; re-enqueue is eligible after 60 seconds.
- At most 100 candidates per scan, each in its own transaction; queue reservations default to 10000; no dispatch increments execution attempts.
- DB/Redis clock skew >5000ms rejects enqueue; Redis TIME checks absolute expiry inside Lua.
- Queue payload contains workId/kind/schemaVersion/dispatchSeq/queueGeneration only; payloads and secrets remain outside Redis.
- Normal CRUD uses TypeORM QueryBuilder. Frozen migrations are never edited.
- J2b execution/notification/AP recipients, automatic lifecycle startup, Redis-loss generation recovery, and J3 administration/cleanup remain explicitly incomplete. No placeholder handler is connected to the production worker.

## Review focus

- Delayed enqueue after retirement, including deletion of the token after its absolute expiry, cannot recreate an entry.
- One queue's full capacity must not prevent later candidates in another queue from dispatching.
- Duplicate enqueue/release and expired owners cannot add reservations or decrement counters twice.
- Active entries cannot release their DB queue reservation; terminal/missing entries can after fencing.
- Redis/DB failures preserve reservations and require reconciliation rather than guessing that enqueue failed.

### Task 1: fenced BullMQ adapter

Files: create `src/platform/jobs/dispatch.ts`, `src/platform/jobs/bullmq-dispatch.ts`, `test/integration/bullmq-dispatch.test.ts`; modify package manifest and lockfile.

Interface: `DispatchReservation` holds workId, kind, schemaVersion, dispatchSeq, queueKey (`deliver`/`postLocal`), queueGeneration, token, reservedAtMs, tokenExpiresAtMs. `BullmqDispatch` exposes `initialize(queueKey,generation)`, `enqueue(reservation,dbNowMs)`, `retire(reservation):Promise<boolean>`, `close()`.

- [x] Write tests and observe missing adapter failures.
- [x] Implement a dedicated connection/backend with the installed BullMQ standard-add script fenced in the same Redis operation. Fail closed for missing/mismatched generation, expired/retired token and skew. Reject nonstandard add paths.
- [x] Test real Worker consumption and exact ID-only data, duplicate enqueue, retirement before add, expired-token recreation, stale generation, active retirement, failed/missing entry retirement, and clock skew.
- [x] Run integration tests and typecheck.

### Task 2: database dispatch claims and reservations

Files: create `src/platform/database/post-work/dispatch.ts`, `dispatch-schema.ts`, `dispatch-migration.ts`, `test/integration/post-work-dispatch.test.ts`; modify metadata registration.

Interface: `PostWorkDispatchStore(source)` exposes `claim(owner):Promise<{status:'empty'|'waiting'}|{status:'claimed',reservation:DispatchReservation}>`, `enqueued(reservation,owner):Promise<boolean>`, `release(reservation):Promise<boolean>`, `pending(limit=100)`, `databaseNowMs()`; `reconcilePostWork(store,transport)` fences at most100 expired reservations and releases only confirmed entries; `scanPostWork(store,transport,owner)` claims/enqueues at most100 entries without execution handlers.

- [x] Write failing DB tests for concurrent claims and queue capacity.
- [x] Add frozen migration up/down for `work_control` and `queue_dispatch`, including accounting, uniqueness, bounds and scan indices. Baseline controls are charged.
- [x] Implement item-level transactions with SKIP LOCKED and conditional lease checks, queue and global row/byte reservation. Full queues move only that candidate to capacity_wait with +30s next attempt; no seq/attempt consumption. Keep request/item progress intact.
- [x] Enqueue confirmation requires owner/epoch; release requires transport retirement confirmation by orchestration and is idempotent. Retained dispatch rows keep DB charges.
- [x] Test claims, capacity bypass across queues, 60s resend eligibility, owner expiry, enqueue/DB gap, retirement/release once, migration up/down and schema drift.
- [x] Run integration tests and typecheck.

### Task 3: document, review and ship

- [x] Document bounded API and next J2b work; keep #124 open.
- [x] Run package unit/integration tests, build/typecheck and shipping checks.
- [x] Obtain independent review; fix findings and repeat until no actionable findings remain.
- [x] Commit, push and create a PR using the repository template.

Pre-flight: Task2 consumes Task1 DispatchReservation and transport methods; signatures match. Task3 consumes both deliverables. Generation1 initialization is only for a new, empty Redis namespace; generation recovery/startup is J2b and this adapter is not automatically enabled.


Review rulings:
- Distinguish an empty scan from a processed capacity-wait candidate so the scan continues.
- Seq increases on every successful claim and, together with owner and valid lease, fences confirmation even if owners are reused.
- Dispatch DB charges preserve normal90%/deletion100% limits.
- AP expansion/page belongs to postLocal and also checks deliver pause; only ap.send belongs to deliver.
- Reconciliation orders by persisted last_checked_at, updating it before each attempt to prevent active early entries starving later reservations.
- Retirement and queue release do not release retained DB row/byte charges; J3 cleanup owns that separately.


Validation (2026-10-22): unit174, integration77, acceptance63, process20 passed (334 total). Build/typecheck/sync:check passed. Changed-file lint12, SPDX2947, locale safety and diff checks passed. The existing pg warning originates from the fixed upstream migration's concurrent queries; managed upstream files remain unchanged.

Independent review: initial plan improvements incorporated; two code findings (queue mapping, reconciliation starvation) reproduced as failing regressions and fixed. Final rereview, including DB-local timestamp comparisons, reported no findings. J2b and J3 remain required before #124 completion.
