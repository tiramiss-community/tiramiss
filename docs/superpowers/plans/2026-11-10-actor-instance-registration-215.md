# Actor instance registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Sole writer; parent owns review and Git.

**Goal:** Public remote actor creation and canonical duplicate recovery start nonwaiting instance usersCount registration.

**Architecture:** The notes/create caller owns post-commit launch; a focused composition controller owns async settings, ledger/increment, diagnostics and drain. Existing platform ledger and direct Repository.increment retain cache semantics.

**Tech Stack:** TypeScript, Hono, TypeORM, PostgreSQL, Redis, Vitest; Node24.20.0, pnpm12.9.1.

**Spec:** `docs/superpowers/specs/2026-11-10-actor-instance-registration-design.md`

## Global Constraints

- Node24.20.0 and pnpm12.9.1; fixed lockfile, no installation.
- Sole writer, no subagents/reviewers, external sends, Git mutations, Docker, settings/secrets/.config/.env/security reads, old backend/frontend/upstream managed edits.
- No Entity/migration or public API/schema change; no metadata/chart placeholders, retry or exactly-once framework.
- Preserve first-register orIgnore, async Meta boundary, direct increment without cache update.
- Parent owns infrastructure, shipping, final integration/process/full-unit/root Node26 validation and reviews; freeze product/tests after hash-bound request, revise on changes. No commit.
- Keep five gaps incomplete, #176/#127/#195/#215 open, notes/create:partial, postingComplete:false; retain historical source95 bindings, ROADMAP small summary/link only.

## Review Focus

1. Alias origin authority differs from account/canonical host: register original URI host even after duplicate recovery.
2. Async Meta fails or remains pending: no actor/posting failure; diagnose and drain held work.
3. Register and increment are independently pending/rejected: posting remains nonwaiting, close awaits each without retry.
4. Stats disabled during normal/duplicate paths, local/fresh/refresh, rollback/missing canonical: no unintended increment.
5. Concurrent initial registration and raw increments leave valid DB effects and intentionally stale cache; SIGTERM must drain after HTTP response.

---

### Task 1: Source-bound caller, controller and public acceptance

**Files:**
- Create `docs/superpowers/compatibility/remote-user/actor-instance-registration-source-probe.mjs`, `actor-instance-registration-observations.json`, `actor-instance-registration-results.md`.
- Create `packages/backend-next/src/composition/actor-instance-registration.ts` and `packages/backend-next/test/unit/federation/actor-instance-registration.test.ts`.
- Modify `packages/backend-next/src/modules/federation/remote-user.ts`, `src/modules/note/create-note.ts`, `src/composition/remote-users.ts`, `src/platform/connect-resources.ts` (all under packages/backend-next).
- Modify `packages/backend-next/test/unit/note/create-note.test.ts`, `test/integration/remote-user.test.ts`, `test/processes/remote-mentions.test.ts` and affected typed fixtures only.
- Modify `docs/backend-next/federation-base-contract.md`, `docs/backend-next/ROADMAP.md`, remote-user README with small current projection links.

**Interfaces:**
- Consumes existing `punyHost(uri: string): string`, `InstanceLedger.fetchOrRegisterInstance(host: string): Promise<InstanceFacts>`, `readMeta(manager)`, direct `MiInstance` repository increment.
- Produces `RemoteUserPorts.startActorInstanceRegistration(host: string): void`.
- Produces `createActorInstanceRegistration(ports: {enabled(): Promise<boolean>; fetchOrRegister(host: string): Promise<{id: string}>; increment(id: string): Promise<void>}, logger: Logger)` returning `{start(host: string): void; idle(): Promise<void>; close(): Promise<void>}`.

- [x] Step 1: Execute new pinned source probe (full-file/method literal hashes verified) with new/duplicate stats true/false, input-origin host, separate register/increment gates, failed User/Profile/Key and missing canonical. Assert register launch follows commit/canonical and precedes hashtags; actor settles while either gate remains held. Write only new observations; source metadata/chart/cache/media are explicit doubles.
- [x] Step 2: Write caller tests using real create-note path and controller units. Assert instance launch before hashtag; duplicate origin host; no launch on exclusions; held Meta/register/increment cannot hold note, failures log and close drains; enabled false makes zero ledger writes. Add Review Focus 1–4 coverage with literal outcomes.
- [x] Step 3: Run `pnpm --filter backend-next test test/unit/note/create-note.test.ts test/unit/federation/actor-instance-registration.test.ts`. Expected RED: missing registration event/side effect assertions (first exercise existing caller before adding new controller import).
- [x] Step 4: Add the exact narrow port, two caller launches with punyHost(uri), controller and production assembly; raw repository increment only, register close in resource scope. Patch typed fixtures without weakening assertions.
- [x] Step 5: Re-run focused units and source probe --check. Expected PASS with no unhandled rejected work. Verify async Meta is explicitly distinguished from source synchronous launch.
- [x] Step 6: Add real HTTP integration cases with fresh host/cache baselines, atomic concurrent increments and canonical duplicate barrier, disabled/fresh/refresh exclusions, actor rollback, post-save failure and diagnostic increment failure. Assert User/Profile/key + instance usersCount + Redis cached row effects. Add built process cases with PG locks and event-driven pg_stat_activity/shutdown observations for pending registration/increment only; test real HTTP response then SIGTERM drain. Cover settings pending/failure/drain at the controller unit boundary, not in a built process. Source synchronous Meta versus asynchronous DB Meta timing and concurrent settings-change equivalence remain unproven. Cover Review Focus 5.
- [x] Step 7: Run source probe, focused units, dependency build/typecheck and changed-file quiet ESLint/format checks. Expected PASS; on network/subprocess EPERM diagnose once then request parent broker, never use no-isolation workaround.
- [x] Step 8: Update new results/current contract links, self-review five focus items, write revisioned `/tmp/tiramiss-s1-r3-validation-request.json` with exact commands/artifact names/all product+test input SHA256, then freeze those bytes. Request parent real integration/process/full-unit and precise root contract scripts under Node26. Poll receipt no longer than45s per wait. Expected verified matching hashes and passing actual tests; changes require new revision.
- [x] Step 9: Read shipping/verification skills, record exact receipt counts, command evidence and limits in `/tmp/tiramiss-s1-r3-implementation.md` and parent task report; create `/tmp/tiramiss-s1-r3-ready.json` status DONE with changedPaths and all public file SHA256. No commit. Parent task review, fixes/scoped review, whole-branch review and CodeRabbit remain parent-owned.
