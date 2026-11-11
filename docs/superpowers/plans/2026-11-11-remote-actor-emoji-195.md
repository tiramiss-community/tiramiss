# Remote Actor Emoji Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. User-selected execution here is a sole Ultracode subprocess writer with parent-owned review/broker; do not spawn agents or commit.

**Goal:** Persist actor emoji and names through the real public remote-mention caller while preserving source failure boundaries.

**Architecture:** Federation owns extraction over plain ports; Repository adapter owns MiEmoji I/O. Composition connects clock/ID and tracks complete tag operations for shutdown while caller retains early rejection. Create/refresh acquire names at their distinct source positions.

**Tech Stack:** TypeScript, TypeORM Repository, existing MiEmoji, Vitest, Node AST/vm source probe.

**Spec:** [remote actor emoji design](../specs/2026-11-11-remote-actor-emoji-design.md).

## Global Constraints

- Node24.20.0 and pnpm12.9.1; fixed lockfile, no installation.
- Sole writer; no agents, external sends, Docker, Git mutation, secrets/auth/settings/.config/.env/security reads.
- No old backend/frontend edits, upstream-managed hand edits, Entity/migration/API schema changes or CHANGELOG edits.
- Parent owns infrastructure, validation broker, final reviews, Git and PR. Do not commit.
- Wait for `/tmp/tiramiss-s1-r5-plan-go` after plan-ready; implement through final evidence after GO.
- Fixed source `8e07cf085adf7009583d234a208e30436f020e26`; keep historical corpora/receipts unchanged, snapshot query and per-tag Promise.all; no dedup/upsert/retry.
- Keep #176/#127/#195 open, `notes/create: partial`, `postingComplete:false`; no formal reorder or cache-freshness claim.

## Review Focus

1. A rejected tag leaves another operation running after response: Task 1 controller gate and built HTTP DB-lock/SIGTERM tests prove early response plus drain.
2. Refresh extraction precedes malformed attachments/collections/URL, whereas create preflight prevents emoji writes: Task 1 source-boundary and acquisition-order tests pin both.
3. Duplicate snapshot names and INSERT-success/refetch-failure leave partial writes with empty User names: Task 1 source/operation and real DB tests pin state without assumed winner.
4. Undefined versus null URI, license-only changes and malformed icon/name must preserve source behavior: Task 1 adversarial extraction corpus comparisons pin values/errors.
5. Canonical recovery and later actor/Note failure must retain independent emoji writes and existing canonical names: Task 1 public HTTP tests inspect both User and emoji rows.

---

### Task 1: Connect source-compatible actor emoji ingestion end to end

**Files:**
- Create `src/modules/federation/remote-emojis.ts`, `src/platform/database/remote-emojis.ts`, `src/composition/remote-emojis.ts` under `packages/backend-next/`.
- Modify `src/modules/federation/{public,remote-actor}.ts`, `src/composition/remote-users.ts`, `src/platform/connect-resources.ts` under that package.
- Create `test/unit/federation/remote-emojis.test.ts`; extend `test/unit/federation/remote-actor.test.ts` and relevant acquisition tests only for changed contracts.
- Extend `test/integration/remote-user.test.ts`, `test/processes/remote-mentions.test.ts`.
- Create `docs/superpowers/compatibility/remote-user/remote-emojis-{source-probe.mjs,observations.json,results.md,runtime-evidence.json}`; add a concise receipt contract test/binding following existing conventions.
- Add only necessary current bindings to affected old corpus consumers, small evidence links to compatibility README/ROADMAP and necessary inventory entries. Do not replace old receipts or duplicate input maps.

**Interfaces:**
- Consumes existing actor `validateActor`, `prepareActor`, insert/refresher ports, `RemoteUserFacts`, ID codec and runtime cleanup scope.
- Produces `RemoteEmoji`, `RemoteEmojiPatch`, `RemoteEmojiInsert`, `RemoteEmojiPorts`, `extractRemoteEmojis(tags: unknown, host: string, ports: RemoteEmojiPorts): Promise<RemoteEmoji[]>` exactly as defined in the spec.
- DB `createRemoteEmojiRepository(manager)` implements `find/update/findOne/insert`; composition `createRemoteEmojis(repository, { now, newId })` exposes `extract(tags: unknown, host: string): Promise<RemoteEmoji[]>`, `idle(): Promise<void>`, `close(): Promise<void>`.
- `RemoteActorMaterial.emojis?: string[]`; `validateActorProfileUrl(material: RemoteActorMaterial, refresh: boolean): void`. Runtime `createRemoteUsers` consumes required `remoteEmojis.extract`; old direct planner calls default names to `[]`.

- [x] **Step 1: Read GO taskbrief/SDD ledger and TDD/writing-good-tests instructions.** Record task and RED/GREEN report paths in the ledger. Do not begin production code before behavioral RED.
- [x] **Step 2: Build the independent new source probe and freeze observations.** Guard literal full-file/method hashes, execute real extraction/insertOne and real create/update with actual predicates. Cases: new/unchanged/four updates/three no-updates, malformed tag/type-array/icon/name/license, null/undefined URI, empty query, IDN/port, duplicate tags, query/write/refetch failures; actor create/refresh URL/attachment/tag failure, transaction rollback/canonical/deleted skip. Separate gates prove simultaneous start, ordered results and residual work after rejection. Run `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream UPSTREAM_SOURCE_MODE=verified-files node docs/superpowers/compatibility/remote-user/remote-emojis-source-probe.mjs --write`, then `--check`; source-only assertions must pass before using observations.
- [x] **Step 3: Write a behavioral failing test against an existing public acquisition/planner path.** Assert a valid actor Emoji tag yields `User.emojis=['wave']` and starts extraction before refresh collection handling, with create after URL validation. Run the exact focused Vitest file and save `/tmp/tiramiss-s1-r5-red.log`; expect an assertion failure demonstrating the missing behavior, not module/import failure.
- [x] **Step 4: Implement the plain operation and Repository adapter.** One initial find even for empty input; map every tag concurrently over the snapshot; preserve source predicates/update rules and undefined URI; refetch updates by host/name and inserts by INSERT identifiers. Pass `now/newId` at operation points. Add no new migration/default/validation/retry.
- [x] **Step 5: Implement composition and caller ordering.** Track each full tag promise through settlement and drain dynamic pending work; retain Promise.all early rejection. Register cleanup before DB release. Refresh extracts immediately after validation using entry host; create preflight completes before extraction; take actor time/ID afterward. Catch extraction/name mapping to empty names; retain canonical User and independent writes.
- [x] **Step 6: Bind focused units to frozen source observations.** Compare resulting rows/names/errors and externally visible repository attempts with explicit doubles. Add named gate tests for all five Review Focus entries; keep actor/source95 old expectations and add current identity evidence for changed consumers.
- [x] **Step 7: Extend real public HTTP tests.** Cover create/fresh/stale/canonical, emoji duplicate and partial-write failures, actor/Note rollback, create versus refresh URL failure. Independently inspect MiEmoji/User/defaults and read a fixture remote-author Note to assert packed `user.emojis.wave` equals persisted URL.
- [x] **Step 8: Extend built-process tests.** Observe DB locks and waiting query/owner before assertions; successful extraction gates response. In a separate two-tag failure case, response settles while one DB operation is held; SIGTERM waits for that operation and exits successfully after release, with its row persisted.
- [x] **Step 9: Run focused GREEN, probe and local checks.** Save exact commands/results/logs for focused unit/probe, changed-file quiet ESLint from package root, formatting and `git diff --check`. Diagnose network EPERM once; request `/tmp/tiramiss-s1-r5-broker-request.json` rather than repeated network attempts.
- [x] **Step 10: Freeze and request runtime validation.** Write `/tmp/tiramiss-s1-r5-validation-request.json` status `FROZEN_READY`, revision 1, commands `{id,command,artifact,log}[]`, SHA256 map of actual source/test/dependency inputs excluding mutable evidence/docs. Request build/typecheck, focused real integration/process and full unit from parent. Wait in polls at most 30 seconds for actual receipt; preserve failed history and increment revision after any product/test fix.
- [x] **Step 11: Write truthful additive results and root request.** Use receipt command/count/log facts, source-method limitations, direct-DB cache gap and remaining owners; no baseline pass substitution. Write `/tmp/tiramiss-s1-r5-root-request.json` for parent Node26 contracts/inventory/shipping. Inventory immutable pin waits for parent's normal implementation commit; never invent an existing pin.
- [x] **Step 12: Read shipping skill and hand off without commit.** Complete `/tmp/tiramiss-s1-r5-implementation.md` and SDD report with RED/GREEN/limitations. Write `/tmp/tiramiss-s1-r5-ready.json` status `DONE` with paths and SHA256 of all public changed files, then concise final return to parent.

Self-review: the single task owns every spec requirement and each Review Focus test; no helper-only deliverable, unowned interface, source sanitizer or stronger persistence guarantee is introduced.
