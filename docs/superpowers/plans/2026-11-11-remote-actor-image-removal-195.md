# Remote Actor Image Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Clear removed remote actor images after creation and canonical recovery without losing mentions on image-write failure.

**Architecture:** The Note caller owns the common post-create continuation and caught image-write boundary. Narrow federation ports bind the TypeORM update and logger; actor preparation classifies absence.

**Tech Stack:** TypeScript, TypeORM, Hono, Vitest, PostgreSQL; existing Node 26.4.0 and pnpm 12.9.1.

**Spec:** `docs/superpowers/specs/2026-11-11-remote-actor-image-removal-design.md`

## Global Constraints

- Work only in the assigned worktree at base `6a4cc93bde543a7456467414611518c29f549ee6`; no git mutations, external sends, install, Docker, auth or config changes; no agents.
- Preserve historical observations/probes/evidence byte-for-byte; new evidence is additive.
- No CHANGELOG, locales, schema/entity, lifecycle, inventory/audit/domain/ROADMAP changes.
- Keep #176/#127/#195 partial, `notes/create:partial` and `postingComplete:false`.
- Source pin: `8e07cf085adf7009583d234a208e30436f020e26`; no Drive acquisition or mixed-image policy implementation.

## Review Focus

- Canonical duplicate with old media: update resolved ID and preserve current canonical hashtag snapshot.
- Pending hashtags and image update: hashtags must not block, image write must delay mention completion.
- Image update rejects: diagnose once and persist canonical mention while preserving old media.
- Mixed/empty-string/string images: no new clear operation outside both-absent classification.
- Deleted canonical actor and retained relations: update by ID without isDeleted filtering; retain Profile/key/tags/Drive rows.

---

### Task 1: Complete the both-absent post-create continuation

**Files:** Modify only these production files under `packages/backend-next/src/`:
- `modules/federation/remote-actor.ts`
- `modules/federation/remote-user.ts`
- `modules/note/create-note.ts`
- `platform/database/remote-users.ts`
- `composition/remote-users.ts`

Test: `packages/backend-next/test/unit/federation/{remote-actor,remote-user}.test.ts`, `packages/backend-next/test/unit/note/create-note.test.ts`, `packages/backend-next/test/integration/{remote-user,note-application}.test.ts`.
Create additive `docs/superpowers/compatibility/remote-user/actor-image-removal-{source-probe.mjs,corpus.json,observations.json,results.md}` (runtime evidence if useful).

**Interfaces:** Produce `RemoteActorPlan.bothImagesAbsent: boolean`, `RemoteUserPorts.clearActorImages(id: string): Promise<void>`, `reportActorImageFailure(id: string, error: unknown): void`. Repository implements six-null update by ID. Composition binds logging. No shared signature/lifetime changes outside these ports.

- [x] After parent plan approval, read TDD/writing-good-tests; add behavioral unit tests described in Spec and Review Focus and run focused unit command to record actual RED before production edits.
- [x] Add the five-file implementation: classify both absent; common continuation preserves distinct hashtag snapshots; await/catch clear on resolved ID only. Update mandatory fixtures.
- [x] Run GREEN: `pnpm --filter backend-next test test/unit/federation/remote-actor.test.ts test/unit/federation/remote-user.test.ts test/unit/note/create-note.test.ts`.
- [x] Add HTTP/PG normal-create, canonical old-media repair, public author before/after, targeted BEFORE UPDATE fault and mixed exclusion tests; assert every persisted field and retained relation from Spec. Run `pnpm --filter backend-next test:integration test/integration/remote-user.test.ts test/integration/note-application.test.ts` against dedicated DB55511/Redis56411/Meili57811.
- [x] Add finite source corpus and literal pinned source-method probe, verify Git source, generate independent observations then run additive probe `--check`; map exact cases and policy boundaries in results.
- [x] Run `pnpm --filter backend-next... build` and `pnpm --filter backend-next... typecheck`; no process/full suites unless actual shared lifetime changes justify them.
- [x] Freeze all production TS/config and relevant test/oracle/probe inputs in `/tmp/tiramiss-s1-r8-validation-request.json` with SHA256 and revisioned command/log/artifact paths. Await parent receipt before further input edits. If failures require fixes, issue a new revision; preserve previous requests/logs/receipts.
- [x] Read shipping skill, report actual commands/results, source-vs-runtime limits, failures and residual gaps in additive results and `/tmp/tiramiss-s1-r8-implementation.md`; create ready JSON with changed hashes and receipt hash. Parent handles checks/review/CodeRabbit/commit; do not commit.
