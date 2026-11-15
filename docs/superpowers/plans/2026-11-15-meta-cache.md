# Meta cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete #317 Meta cache synchronization and its existing federation consumers.
**Architecture:** A process-owned platform cache uses the existing internal receiver and existing DB reader; composition passes its fetch contract to consumers.
**Tech Stack:** TypeScript, Vitest, TypeORM, PostgreSQL, Redis, Hono.
**Spec:** `docs/superpowers/specs/2026-11-15-meta-cache-design.md`

## Global Constraints

- Fixed source `8e07cf085adf7009583d234a208e30436f020e26`; no old backend changes or managed source edits.
- No admin/update-meta, new degradation contract, CHANGELOG changes or parent-completion claims.
- Dedicated Compose project `backend-next-meta-317`, PG55437/Redis56397/pubsub56398.

## Review Focus

- Notification racing a DB fetch preserves measured source behavior.
- A rejected timer read is observed and does not erase a warm value.
- Stop unregisters, cancels future reload and drains accepted reads.
- Multiple Meta rows select the largest ID; concurrent empty initialization yields x.
- Warm actor/WebFinger/registration/delivery behavior responds to after payloads.

### Task 1: Fixed source and cache

Files: compatibility/meta-cache/source-probe.mjs + observations.json, platform/meta-cache.ts, test/unit/meta-cache.test.ts.
Interface: `createMetaCache({read,events,onError,periodic?})` returns `fetch(noCache?:boolean)` and `close()`.
- [x] Extract and execute fixed-source methods with repository/event/timer doubles, recording hit/noCache/after/race/failure/stop.
- [x] Write consumer tests against observations; run and observe missing-module failure.
- [x] Implement cache and run targeted unit tests.

### Task 2: Runtime consumers and real dependencies

Files: connect-resources.ts, federation composition users, meta DB converters, integration/meta-cache.test.ts and affected existing federation tests.
- [x] Add real PG/Redis/HTTP cache transition tests and observe stale/direct-reader failures.
- [x] Connect one cache to existing transport and pass its reads into federation consumers.
- [x] Execute real PG/Redis/HTTP and nearby regression suites; fix only affected fixtures.

### Task 3: Evidence and shipping

Files: compatibility/meta-cache/README.md, owned inventory rows and report.
- [x] Run build/typecheck, changed-file lint, source reproduction, root inventory, SPDX and locale checks.
- [x] Record commands/results/limits; preserve historical evidence.
- [ ] Commit scoped implementation after shipping skill and coordinator review.

Ruling: note-instance-counts keeps its existing DB reader because migrating it expands the #317 federation caller scope; changing that callback broke an unrelated direct-DB fixture. The actor-registration and delivery callbacks use the new cache.
