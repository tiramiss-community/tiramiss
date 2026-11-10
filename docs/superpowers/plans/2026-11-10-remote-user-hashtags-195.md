# Remote User Hashtags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Controller selected a sole writer within authorized Ultracode; parent performs task-scoped and final independent review. No subagents, reviewer dispatch or commits in this session. Read the implementer-prompt template for self-review/reporting only.

**Goal:** Connect remote actor creation/refresh to source-compatible attached hashtag persistence, ranking and shutdown drain.

**Architecture:** Carry an immutable URI-entry tag snapshot to the actor save boundary. Start a small tracked composition operation directly from successful creation/duplicate or refresh Profile, with ordered atomic DB writes and independently started existing Redis ranking.

**Tech Stack:** TypeScript, TypeORM, PostgreSQL, ioredis, Vitest, Node source-method probes.

**Spec:** [remote-user-hashtags design](../specs/2026-11-10-remote-user-hashtags-design.md)

## Global Constraints

- Fixed source `8e07cf085adf7009583d234a208e30436f020e26`, base `cb1feb3e713c00c992f0d5ad2705edc24b439d33`; preserve historical corpora/seals/receipts.
- Sole writer; no helpers/reviewers, Git mutations, external sends, Docker, secret/settings/.config/.env reads or product oldbackend/frontend/upstream-managed edits.
- QueryBuilder first; no generic allusers service, no-op ports, whole-sequence transaction, retry or normalized deduplication.
- Keep #176/#127/#195 incomplete, `notes/create:partial`, `postingComplete:false`, GOALS unchanged and five other actor gaps explicit.
- Write plan-ready marker and wait for `/tmp/tiramiss-s1-next-plan-go` before implementation. Parent owns commit/shipping/Git/infra/final integration validation.

## Review Focus

1. Duplicate canonical User has different old tags: leave User.tags unchanged but update attached rows from fetched actor tags.
2. WebFinger races with stored tags: take a fresh canonical-URI entry snapshot, then preserve it across subsequent acquisition/writes.
3. Deleted/User/Key/Profile failures versus Following failure: launch only after Profile; later failure cannot cancel launched work.
4. Normalization collisions and hidden/sensitive tags: preserve raw membership/order and all DB changes while Redis alone is filtered.
5. Pending/failed DB or Redis work and SIGTERM: DB failure stops later tags, ranking never blocks DB, actor settles while pending, runtime drains before resource release.

---

### Task 1: Ship the connected remote actor user hashtag effect

**Files (repo-root paths; focused additions follow existing layering):**

- Create: `docs/superpowers/compatibility/remote-user/user-hashtags-source-probe.mjs`, `user-hashtags-observations.json`, and `user-hashtags-runtime-evidence.json` in that directory (new corpus/actual evidence).
- Create: `packages/backend-next/src/modules/federation/user-hashtags.ts` (operation plan), `src/platform/database/user-hashtags.ts` (attached atomics), `src/composition/user-hashtags.ts` (tracked launch/drain), each under backend-next.
- Modify: `packages/backend-next/src/modules/federation/{remote-user,remote-actor,public}.ts`, `src/modules/note/create-note.ts`, `src/platform/database/remote-users.ts`, `src/composition/remote-users.ts`, `src/platform/connect-resources.ts` (snapshot, callers, real assembly).
- Create: `packages/backend-next/test/unit/federation/user-hashtags.test.ts` (profile oracle plus failure/drain behavior).
- Modify tests: `packages/backend-next/test/unit/federation/{remote-actor,remote-user,acquisition-policy}.test.ts`, `test/unit/note/create-note.test.ts`, `test/unit/composition/http-app.test.ts`, `test/integration/{remote-user,note-hashtags}.test.ts`, `test/processes/remote-mentions.test.ts`; adjust typed fixtures only where the required connected port/snapshot changes.
- Modify evidence/docs: `docs/superpowers/compatibility/remote-user/{README,runtime-results}.md`, `runtime-evidence.json` additively; `scripts/remote-user-contract.test.mjs` for actual new receipts/current consumer hashes; note hashtag validator/evidence only if actual consumer identity requires renewal; `docs/backend-next/ROADMAP.md` small summary.

**Interfaces:**

- `UserHashtagSnapshot = { id: string; host: string | null; tags: readonly string[] }`; `UserHashtagChange = { tag: string; userId: string; userHost: string | null; attached: boolean }`.
- `planUserHashtags(user: UserHashtagSnapshot, tags: readonly string[]): UserHashtagChange[]`, exported via federation public contract. Use the import-free `modules/hashtag/public.ts` normalization contract shared with note; use existing note ranking capability.
- `RemoteUserFacts.tags: readonly string[]`; `RemoteActorPlan.hashtagUser: UserHashtagSnapshot`; `RemoteUserPorts.startUserHashtags(user: UserHashtagSnapshot, tags: readonly string[]): void`.
- `createActorRefresher(writes: RemoteActorUpdates, startUserHashtags: RemoteUserPorts['startUserHashtags'])`; call between Profile and Following with plan snapshot/new tags.
- `createUserHashtagWriter(manager: EntityManager, newId: () => string): { change(input: UserHashtagChange): Promise<void> }`.
- `createUserHashtags(ports: { change(input: UserHashtagChange): Promise<void>; ranking: { update(input: HashtagMention, settings: HashtagRankingSettings): Promise<void> }; readSettings(): Promise<HashtagRankingSettings> }, logger: Logger): { start(user: UserHashtagSnapshot, tags: readonly string[]): void; idle(): Promise<void>; close(): Promise<void> }`.
- `createRemoteUsers` consumes required `userHashtags: { start(...) }`; repository/refresher receives its bound start. `connectResources` owns construction and close registration before connection release.

- [x] **Step 1: Establish source acceptance without changing historical fixtures.** Reuse profile five cases from `note/hashtag/reference-hashtag.mjs` observations. New source probe evaluates pinned actor methods with explicit boundary doubles and pending hashtag promises. Record create/duplicate (old `old`, new normalized `a,a`), refresh-entry old tags, deleted and User/Key/Profile/Following failure, and actor settlement before gate release. Regenerate then check new corpus; do not derive expected data from new production code.
- [x] **Step 2: Write and observe RED before product edits.** Add an actual actor refresher test expecting `['User','Key','Profile','hashtags','Following']`, with a pending hashtag DB gate; assert actor returns before release. Run `pnpm --filter backend-next test test/unit/federation/remote-actor.test.ts`; capture expected missing `hashtags` assertion failure. Add remaining tests before their implementation cycles: profile five exact source outcomes; duplicate leaves stored tags but attaches new/deletes old; WebFinger changes old snapshot; each write failure/deleted guard; pending/failed settings/Redis cannot gate DB; DB failure retains started ranking; close waits for work launched while draining. Source expectations/literal outcomes are independent of the product planner.
- [x] **Step 3: Implement minimal connected behavior to pass.** Add snapshot and required ports/callers, ordered plan, real attached writer, tracked composition and runtime cleanup. Use QueryBuilder insert conflict/update expressions where expressible, otherwise narrowly justify the PostgreSQL upsert; removals use QueryBuilder. Copy input arrays at launch so later mutation cannot change work. Preserve mentioned columns and empty rows. Re-run focused units after each cycle.
- [x] **Step 4: Prove real adapters and process lifetime.** Extend existing integration suites with concurrent/repeated attachment/removal and local/remote membership counts, mentioned preservation, normalized collisions, hidden/sensitive DB-only changes, duplicate/refresh, later Note failure, ranking sharing, and injected DB/Redis failures. Extend native remote-mentions process test: actor HTTP completes, hold attached DB operation with a real PG lock, request SIGTERM, observe child still alive, release gate, assert persisted attached row and clean stop. Run isolated commands below once; on network EPERM diagnose and write broker request with exact commands/file hashes to `/tmp/tiramiss-s1-next-validation-request.json`, then await verified receipt without repeated denied attempts.
- [x] **Step 5: Verify and report actual evidence.** Run source check, focused units/build/typecheck/contracts and changed-file quiet lint/SPDX/locale. Preserve historical receipt identities; add current measurements only after their actual commands pass (including all consumers needed by validators), bind current hashes, add a new actor corpus validator. Parent may run full unit once at end. Record result/limitations, remaining five gaps and small roadmap link. Self-review against spec and all five review classes. Write `/tmp/tiramiss-s1-next-implementation.md` and implementation-ready JSON with changed paths/SHA256. No commit; parent owns review/publication.

**Commands / PASS means zero exit and the named assertions executed:**

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream UPSTREAM_SOURCE_MODE=verified-files node docs/superpowers/compatibility/remote-user/user-hashtags-source-probe.mjs --write
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream UPSTREAM_SOURCE_MODE=verified-files node docs/superpowers/compatibility/remote-user/user-hashtags-source-probe.mjs --check
pnpm --filter backend-next test test/unit/federation/user-hashtags.test.ts test/unit/federation/remote-actor.test.ts test/unit/federation/remote-user.test.ts test/unit/note/create-note.test.ts test/unit/note/hashtags.test.ts
pnpm --filter backend-next... build
BACKEND_NEXT_TEST_DB_PORT=55494 BACKEND_NEXT_TEST_REDIS_PORT=56394 BACKEND_NEXT_TEST_MEILI_PORT=57794 pnpm --filter backend-next test:integration test/integration/remote-user.test.ts test/integration/note-hashtags.test.ts
BACKEND_NEXT_TEST_DB_PORT=55494 BACKEND_NEXT_TEST_REDIS_PORT=56394 BACKEND_NEXT_TEST_MEILI_PORT=57794 pnpm --filter backend-next test:process test/processes/remote-mentions.test.ts
pnpm --filter backend-next... typecheck
node --test scripts/remote-user-contract.test.mjs scripts/note-contract-posting.test.mjs scripts/backend-contract-inventory.test.mjs
node scripts/check-shipping.mjs --base cb1feb3e713c00c992f0d5ad2705edc24b439d33
```

Exact receipt renewal commands will include the historical receipt's complete consumer file group (not a hash-only replacement). Missing/failed broker receipts remain explicitly unverified, never PASS.

Execution note: parent preflight passed before product edits. Profile oracle clock was supplied explicitly after diagnosing runtime clock capture; this was a test harness correction, not an oracle/product change. Required-port fixture adaptation also included `test/unit/composition/http-app.test.ts` after the full unit run exposed its untyped runtime fixture. Actual final broker receipts report unit310, integration101, process4 and full-unit2,855 PASS; failed earlier attempts remain in the additive evidence. Parent retains task/final review, commit and publication ownership.

Fix round 1: task review found duplicate hashtag normalization. The note public contract now exposes the shared normalization used by note planning, ranking and actor hashtag planning. After the fix, focused units passed 73 tests; parent receipt r5 records 310 remote units, 101 integration, 4 process and 2,855 full units passing on the changed source. CodeRabbit's prior zero-finding run covered the 29-file pre-fix snapshot only.

Fix round 2: normalization resides in the import-free `modules/hashtag/public.ts` contract, consumed directly by note and federation to avoid a public-contract cycle.
