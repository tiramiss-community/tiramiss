# Shared ModerationLog appender (#194) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `moderation_log` one writer in backend-next, so later slices (#181 Role APIs, #194 admin, #188 Drive, #191 Page and others) call it instead of copying another insert.

**Architecture:** `modules/audit` owns the record type (`ModerationLogType`, `ModerationLogEntry`). `platform/database/moderation-log.ts` owns the only insert (`appendModerationLog(manager, entry, newId)`). It writes with the caller's `EntityManager`, so the caller decides whether the record joins a transaction. Each domain keeps its own narrow port and payload mapping. The queue, Role update and note delete writers now delegate to the shared insert.

**Tech Stack:** TypeORM, Vitest. No new dependency, schema, migration or setting.

**Spec:** [GOALS](../../backend-next/GOALS.md), [ROADMAP](../../backend-next/ROADMAP.md) (S2: #178 → ModerationLog appender → …), owner [#194](https://github.com/tiramiss-community/tiramiss/issues/194) and the shared-component table in [#128](https://github.com/tiramiss-community/tiramiss/issues/128). Upstream `8e07cf085adf7009583d234a208e30436f020e26`: `core/ModerationLogService.ts`, `types.ts` (`moderationLogTypes`, `ModerationLogPayloads`), `models/ModerationLog.ts`.

## Global Constraints

- Base `725355df63` (PR #245 merged). Branch `feat/backend-next-moderation-log-194`, worktree `.claude/worktrees/moderation-log-194`. Use `Refs #194`; this slice does not close #194.
- Keep every writer's observable behavior:
  - queue audit stays detached and outside a transaction;
  - Role update audit stays awaited inside the update transaction (approved difference, [role/README](../compatibility/role/README.md));
  - note delete audit stays detached post-delete work, written only for another user's note.
- Keep stored `info` byte-for-byte as before and the record id time at `occurredAtMs`.
- Do not touch the sha256-pinned consumer files listed in `docs/superpowers/compatibility/remote-user/runtime-evidence.json`.
- Out of this slice: the remaining upstream log types and their callers, `admin/show-moderation-logs` and `ModerationLogEntityService`. Those belong to the slices that implement those features.

## Upstream contract

- `ModerationLogService.log(moderator, type, info?)` inserts `{id: idService.gen(), userId: moderator.id, type, info: info ?? {}}` with the root repository.
- `info` is stored through TypeORM jsonb serialization, which is `JSON.stringify`: a Date becomes an ISO string and undefined keys are dropped.
- All 57 upstream calls are fire-and-forget and none joins a caller transaction. `id` uses the time of the `log` call.

## Kept differences

| Upstream | backend-next | Reason |
| --- | --- | --- |
| `id` time is the `log` call time | `id` time is the operation's `occurredAtMs` | Existing behavior of all three writers, pinned by `role-update.test.ts`. The difference is milliseconds after the main write. |
| Never joins the caller's transaction, never awaited | The caller chooses. Only `roles/update` awaits it inside its transaction | Role difference already approved in #120. Queue and note keep upstream's detached shape. |

## File Structure and Interfaces

- `src/modules/audit/public.ts`: adds `ModerationLogType` (the upstream types backend-next records) and `ModerationLogEntry {actorId, type, info?, occurredAtMs}`. A slice that records a new type adds it to the union.
- `src/platform/database/moderation-log.ts` (new): `appendModerationLog(manager, entry, newId)`. It writes `info ?? {}` as `CAST(:info AS jsonb)` from `JSON.stringify`.
- `src/platform/database/role-update-audit.ts` and `note-deleter.ts`: keep their payload mapping and delegate the insert.
- `src/platform/database/queue-admin.ts`: `appendQueueAudit` is removed. `composition/queue-http.ts` passes `QueueAudit` (structurally a `ModerationLogEntry` without `info`) to `appendModerationLog`.
- `test/integration/moderation-log.test.ts` (new) covers four cases with a real PostgreSQL:
  - an omitted `info` is stored as `{}`;
  - JSON serialization matches TypeORM;
  - the caller's rollback discards the record;
  - an insert failure reaches the caller.

## Tasks

- [x] Add the record type and the shared insert, and route the three writers through it.
- [x] Add the integration test. Rerun the writers' existing tests: `queue-admin`, `role-update`, `role-http`, `role-acceptance`, `note-delete`, `note-delete-integration`, `queue/source-compat`, `role/update-role` and `note/delete-note`.
- [x] Record the evidence in the backend inventory and add a ROADMAP summary. `implementationCommit` is `e03c4fbf2920c8dbec5e798df702265af986d579`.

## Verification record (2026-11-08)

Run in the isolated compose project `backend-next-mlog194`:

- Unit: 79 files / 2773 tests.
- Integration: 40 files / 779 tests, including the new `moderation-log.test.ts` (4).
- Acceptance: 65 tests (Role audit rollback).
- Process: `role-http` and `note-delete-integration`, 10 tests.
- `typecheck`: PASS.
- `check-shipping` (Lint, SPDX, Locale): PASS.

An independent review checked whether the three writers behave the same before and after the change. It found one defect: the empty-`info` test used a partial match. That test now uses an exact match.
