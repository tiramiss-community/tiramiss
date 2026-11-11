# Local Actor Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. User-selected execution: this sole writer implements inline, no nested agents; parent owns reviews/commits/PR.

**Goal:** Publish source-equivalent local actor icon/banner JSON from stored Drive rows through both existing callers.

**Architecture:** Composition acquires profile, plain file facts and bounded Meta/config; the renderer projects images after tags/key. A narrow pure Drive URL function is shared with existing Note packing.

**Tech Stack:** Existing Node 26.4.0, pnpm 12.9.1, TypeScript, TypeORM, Hono, Vitest, isolated PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-11-11-local-actor-images-design.md`

## Global Constraints

- Base: `62cdeb54289bdcf46ad57e7f8a28db8a4c5f2ee7` (PR #266). Source: `8e07cf085adf7009583d234a208e30436f020e26`.
- One cohesive implementation task, single writer, no child agents/Git mutations/install/auth/config/Docker/external sends.
- No Drive acquisition, media policy invention, lifecycle changes, schema/entities, SDK/API metadata, locales, CHANGELOG, inventory/audit/domain/ROADMAP or root evidence helpers.
- Historical probes/observations/evidence stay byte-for-byte unchanged. Additive probe/corpus/results only.
- #176/#127/#195 remain partial, `notes/create:partial`, `postingComplete:false`.
- All inputs stay frozen until the parent validation receipt; evidence describes its exact measurement time.

## Review Focus

- Null versus empty Meta/file URLs/comments: preserve nullish semantics and exact Image fields (unit oracle + HTTP/PG).
- Shared/dangling/cross-owner IDs: independent ID reads and missing-row fallbacks, never owner-filter (oracle + unit + PG).
- Competing failures: acquisition before tags/key; malformed proxy URI conversion after key (oracle + unit + PG Drive fault).
- Effective config defaults, port/case and proxy/link precedence: normalized production configuration and mode-less URLs (oracle + unit + PG + Note regression).
- Early non-AP/disabled/missing/remote/suspended branches: public/internal distinctions and no media work before eligibility (HTTP unit + real PG).

---

### Task 1: Publish acquired local actor images through both callers

**Files (all source/test paths below relative to `packages/backend-next/`):**
- Modify `src/platform/database/local-actors.ts`: retain IDs; `createActorFileReader(manager)` returns nullable plain `ActorFileFacts` by ID.
- Create `src/composition/local-actor-materials.ts`: `createLocalActorMaterialsReader(manager, config)` returns `(user: LocalActorFacts) => Promise<{profile: LocalActorProfileFacts; media: LocalActorMediaFacts}>`; start conditional file/profile reads together, project bounded Meta/config, propagate errors.
- Create `src/modules/drive/public-file-url.ts` and `src/modules/drive/public.ts`: `publicFileUrl(file: PublicFileFacts, proxyRemoteFiles: boolean, options: PublicFileUrlOptions): string`; extract existing mode-less algorithm unchanged.
- Modify `src/platform/database/note-files.ts`: consume/re-export pure Drive URL projection, leave Note packing behavior unchanged.
- Modify `src/modules/federation/local-actor.ts`, `src/modules/federation/public.ts`: export plain media contracts; add final required `media: LocalActorMediaFacts` renderer argument, nullable file IDs on actor facts, pure Image/fallback projection at construction.
- Modify `src/composition/actor-http.ts`, `src/http/activitypub-actor-api.ts`, `src/composition/remote-users.ts`: required `readMaterials(user)` replaces profile-only acquisition after existing early branches; preserve tag/key sequencing.
- Create `test/unit/federation/local-actor-images.test.ts`; extend `test/unit/federation/actor-api.test.ts`; adapt required materials arguments in `test/unit/federation/local-actor.test.ts`, `local-actor-profile.test.ts`, `local-actor-tags.test.ts` and any exact renderer/API callers found by `rg`.
- Extend `test/integration/activitypub-actor.test.ts`; closest unchanged Note coverage: `test/unit/note/files.test.ts`.
- Create `docs/superpowers/compatibility/remote-user/local-actor-images-source-probe.mjs`, `local-actor-images-corpus.json`, `local-actor-images-observations.json`, `local-actor-images-results.md`, `local-actor-images-runtime-evidence.json` (repo-relative).

**Interfaces:** `ActorFileFacts extends PublicFileFacts` adds `isSensitive:boolean; comment:string|null`. `LocalActorMediaFacts` contains `avatar/banner:ActorFileFacts|null`, `iconUrl/bannerUrl:string|null`, `proxyRemoteFiles:boolean`, and normalized `mediaProxy:string; externalMediaProxyEnabled:boolean`. Actor facts add `avatarId/bannerId:string|null`. Business rendering receives facts only; both callers await materials → tags → key → render.

- [ ] **Step 1: Add independent source oracle and behavioral RED.** Pin full source and method hashes; execute literal methods against explicit doubles, `--write` only new observations; `--check` reproduces exactly. New consumer assertions include ordinary mixed-case/port identicon, explicit null banner, system null/empty URLs, either/both/shared/dangling file IDs, sensitive/null/empty comment, external proxy versus link versus stored URL, empty/slash keys, local versus remote file facts, and source error priority. Example: missing ordinary `ALIce` at `https://local.test:8443` yields `{type:'Image',url:'https://local.test:8443/identicon/alice@local.test:8443',sensitive:false,name:null}` and `image:null`. Run `PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next test test/unit/federation/local-actor-images.test.ts`; record intended missing icon/image failures before product edits.
- [ ] **Step 2: Implement acquisition and projection contracts above.** Conditional independent ID reads plus required profile use `Promise.all`, before tags/key; no URL conversion in persistence. Preserve Note's current pure mode-less algorithm and early caller branches; use production normalized defaults without adding keys. Adapt existing callers/tests to the required materials contract; historical identity comparison explicitly excludes newly covered icon/image fields while retaining historical records unchanged.
- [ ] **Step 3: Add actual HTTP/PG consumer tests.** Seed isolated User/Profile/Key/Drive/Meta including cross-owner files and normalized/default configs with ports. Observe actual local internal document before passthrough validation and returned absence plan. Assert source JSON, preserved rows, both callers, public/internal suspended difference, remote redirect/rejection, early eligibility, dangling fallbacks and Drive/profile faults preventing tags/key; uncached HTTP failures.
- [ ] **Step 4: GREEN and freeze for parent runtime validation.** Run focused image/actor/profile/tag/API + Note/files + config unit tests locally. Publish `/tmp/tiramiss-s1-r9-validation-request-r1.json` with base, SHA256 of actual product/config/test/oracle inputs and commands for dependency-order build/typecheck, those units, actual activitypub-actor integration with `BACKEND_NEXT_TEST_DB_PORT=55512 BACKEND_NEXT_TEST_REDIS_PORT=56412`, and pinned source `--check`. Logs/artifacts use `/tmp/tiramiss-s1-r9-validation-r1-*`; distinguish environment failures. Parent executes `/tmp/tiramiss-s1-r9-validate.py`; freeze every input until receipt. Revise requests/logs under a fresh revision only if fixes are necessary.
- [ ] **Step 5: Bind evidence and handoff.** After actual PASS receipt, add results/runtime evidence with exact receipt/hash and measured input hashes; retain early RED/environment failure records distinctly. Read shipping skill, run only authorized scoped checks, report commands/results/limits in `/tmp/tiramiss-s1-r9-implementation.md` and changed-file hashes plus receipt in `/tmp/tiramiss-s1-r9-ready.json`. Parent performs shipping/root contracts/CodeRabbit/reviews/commit/PR; no commit step in this lane.

## Preflight self-consistency

| Tasks | Producer / consumer or internal check | Finding / ruling |
| --- | --- | --- |
| 1 / 1 | DB plain file facts → materials → renderer; Drive URL public contract → actor + Note | Same fields/signatures; URLs evaluated only after key; no entity leakage. |
| 1 | Source corpus → unit image/error assertions → actual PG/HTTP consumer assertions | Expectations independently execute pin; new outputs excluded only from historical projection, historical files untouched. |
| 1 | Filemap → RED/GREEN → validation receipt → additive evidence | One cohesive deliverable; no task pairs exist. Parent review/commit supersedes skill's worker/commit defaults per explicit user instruction. |
| 1 | Five review-focus conditions → Steps 1 and 3 | Each has concrete assertions; no unresolved spec gaps. |
