# Physical work capacity #166 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stop business admission and durable expansion when PostgreSQL volume capacity is low or unknown, and resume only with fresh physical and valid logical capacity.

**Architecture:** DB-host monitoring supplies an atomic JSON observation file mounted into application processes. Managed HTTP/workers sample it every 60 seconds into the shared capacity row. Existing transaction reservations check the persisted observation using DB time; queries and eligible cleanup remain available. Offline reconciliation locks all charged tables and atomically reconciles counters and conservative upward coefficient changes.

**Tech Stack:** Node filesystem/statfs, TypeORM, PostgreSQL, Vitest.

**Spec:** ../specs/2026-10-21-job-persistence-design.md §6.2; Issues #166, #124, #114. PR #205 merged at baseline `621d74caa106fb524681643257d32aaa8fcb7cec`.

## Global Constraints

- 60-second polling; observation age >=120 seconds or free <max(2 GiB,10% total) closes admission. Missing observation is closed from first use.
- 1,000,000 rows /20 GiB charged bytes; normal creation90%, deletion/cancellation100%; physical gate applies to both.
- Factor4 is conservative logical accounting, not physical-space proof. Preserve saved reservation headroom when increasing coefficients.
- Ordinary CRUD uses TypeORM. SQL reserved for DDL, DB introspection, offline table locks and aggregate accounting.
- No user Compose resources, merged migration edits, upstream managed-file edits, or CHANGELOG edits.

## Design choices

Existing agreed §6.2 fixes the behavior. The implementation choice is an externally supplied DB-host JSON file with pinned volume identity; application-host statfs and a process-local gate would misidentify remote storage or disagree across processes. The collector explicitly takes the DB data volume path; WAL/backup volumes require additional operator monitoring in #138/#139. A missing supplier stops writes, while read-only service remains available. Every process uses shared DB state; file timestamps, not reread time, establish freshness.

Coefficient changes require stopped services and a compiled formula-version change. Offline reconciliation conservatively scales saved aligned charges upward, retaining future nullable-field reservation and removed-body headroom; arbitrary formula changes/downgrades require a dedicated migration. Startup verifies version, per-row sums, limits and counters. No auto repair on normal startup.

## Review Focus

- Re-reading stale/future/wrong-volume data must never refresh admission.
- Deletion/cancellation and negative-net notification replacement still create durable state and must stop.
- An expired observation while waiting for locks must fail at reservation using current DB time.
- Cleanup and reads must continue with low physical space; saved amounts are used on release.
- Offline recalculation overflow/failure must rollback all per-row and aggregate changes.

### Task 1: Physical observation and transaction gates

**Files:** platform/database/work-capacity/*; post-work/schema.ts; migration-sources.ts; existing growth adapters; role-update.ts; test/unit/work-capacity.test.ts; test/integration/work-capacity.test.ts.
**Interfaces:** `parseVolumeObservation(input,volumeId,now)`; `physicalCapacityCondition`; `assertPhysicalCapacity(manager)`.
- [x] Write boundary/invalid observation tests and real transaction rollback tests; run and observe RED.
- [x] Add new internal migration with up/down and nullable monitoring columns; add pure observation validator and atomic SQL condition.
- [x] Gate six durable-growth adapters and authorized Role writes, preserving query/cleanup behavior.
- [x] Run focused unit/integration and schema check. Expected PASS.

### Task 2: Managed monitoring and offline accounting

**Files:** platform/work-capacity-monitor.ts; config; processes/lifecycle.ts; entrypoints/collect-volume.ts and reconcile-work-capacity.ts; platform/database/work-capacity/accounting.ts; tests.
**Interfaces:** monitor consumes `{file,volumeId}` and shared DB; `assertWorkCapacity(source)` startup; `reconcileWorkCapacity(source,target)` offline.
- [x] Add tests for stale rereads, supplier failure/recovery, startup mismatch and offline overflow/rollback; observe RED.
- [x] Implement bounded JSON-file reads, 60-second lifecycle timer and cleanup. Record DB/relation sizes with physical observation; do not reset last observation on read failure.
- [x] Add explicit DB-host collector and stopped-service reconciliation command. No business SQL in public modules.
- [x] Run build/typecheck and targeted integration/process checks. Expected PASS.

### Task 3: Validation, review and PR

- [x] Measure representative/maximum payload relation sizes against saved charges; document measured values and limits.
- [x] Run affected package tests, schema/migration, changed-file lint/SPDX/locale checks.
- [x] Obtain independent review, fix findings and repeat until converged.
- [x] Document configuration, stop/recovery/re-estimation steps and #138/#139 handoff.
- [ ] Commit/push/open PR closing #166, update parent progress. Keep #124 open; next is #169.

## Execution evidence

Worktree `/tmp/tiramiss-capacity-166`, branch `feat/backend-next-capacity-166`. Native execution plus independent review authorized by standing user instructions; no further design/PR confirmation required.

- Task 1: complete. Missing-observation integration test first failed because append fulfilled; unit validator initially absent. Added shared physical predicate, transaction-local locks and post-lock DB-time check. Create/delete/cancel, six growth adapters, existing-request reuse and authorized Role writes are gated; reads/flush/eligible cleanup remain available.
- Task 2: complete. Monitor/accounting regression tests cover stale/future/wrong-volume/oversized/missing input, 60-second schedule/close, low-space recovery, injected observation write failure, version/counter mismatch, >20 GiB startup rejection and offline overflow rollback. Empty-DB 4→16 self-charge/counter update succeeds atomically; current binary rejects future saved versions. DB-host collector measures an explicit path and atomically writes JSON.
- Task 3: validation/review complete, PR creation pending. Independent scope audit plus implementation review/re-review/final review completed without unresolved findings. Findings fixed: capacity-row self-charge update constraint, stale supplier log disagreement, unchanged-row-lock expiry; parent also added idempotent append admission regression. Unchanged-row-lock case observed fulfilled RED → rejected GREEN with DB sleep/lock injection.

Validation evidence:

| Check | Result |
| --- | --- |
| backend-next dependency build / typecheck | PASS |
| backend-next unit | PASS: 230 /27 files |
| backend-next integration | PASS: 338 /18 files, 102.71 seconds; schema drift0, migration up/down included |
| Role HTTP/acceptance | PASS: 63 /2 files |
| process | PASS: 22 /3 files; real normal HTTP uses low-capacity supplier, show200/update503 then healthy update204 |
| changed-file ESLint | PASS: 45 files |
| SPDX | PASS: 3017 files |
| locale safety / diff check | PASS |
| upstream sync / legacy backend API generation | SKIPPED: no upstream managed files or legacy API meta/paramDef/res changes |

Baseline note: first unit attempt before dependency build could not resolve backend-upstream exports; dependency build resolved setup and final full unit passed. Existing pg driver query-while-query-running deprecation warning remains in migration-backed suites; no failed checks remain.

Measurement (PostgreSQL18, dedicated tmpfs DB): 1,600 notification items across8 requests: saved11,851,776 bytes versus all10 charged relations2,138,112 bytes. Adding maximum2MiB non-compressible AP payload: saved20,254,720 versus actual4,349,952 bytes. Relation sizes include indexes/TOAST. This is an input-specific calibration, not a bloat/empty-relation/WAL/backup/global physical bound; README states limits. Coefficient4 retained.

Implementation choices made within the existing contract: trusted DB-host observation file with pinned volume ID, strict future timestamp rejection and4096-byte bound, shared DB admission facts, upward saved-charge scaling preserving reserved headroom. No deferred review findings. Future coefficient changes require matching producer/formula/schema changes; CLI does not change the current binary factor. Deployment supplier/scheduling/additional volumes remain #138/#139; worker hookup/retention remain #162/#164.

Dedicated validation environment: Compose `capacity-166`, PostgreSQL55166/Redis56166. Only disposable randomized databases; user `misskey-infra` untouched. Worktree and feature branch retained for PR review. Next #169 requires merged #166 and #168 (PR #205 already merged).
