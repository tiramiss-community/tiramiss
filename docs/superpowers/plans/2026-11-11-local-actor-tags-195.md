# Local Actor Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. No subagents or Git mutation (parent instruction).

**Goal:** Publish source-compatible local actor emoji/hashtag tags through both existing callers.

**Architecture:** Plain tag renderers share the existing Note shapes; one TypeORM local emoji reader supplies facts to Note and actor. Composition acquires and renders actor tags before keys, and HTTP retains its early checks.

**Tech Stack:** Existing TypeScript/ESM, Hono, TypeORM, Vitest, Node24.20.0/pnpm12.9.1.

**Spec:** [Local actor tags design](../specs/2026-11-11-local-actor-tags-design.md).

## Global Constraints

- Node24.20.0 and pnpm12.9.1; fixed lockfile, no installation.
- Sole writer; no child agents, external sends, Docker, Git mutation, secrets/auth/settings/.config/.env/security reads.
- No old backend/frontend edits, upstream-managed hand edits, dependency/Entity/migration/API schema changes or CHANGELOG edits.
- Parent owns infrastructure, validation broker, CodeRabbit/reviews, Git and PR. Do not commit.
- Wait for `/tmp/tiramiss-s1-r6-plan-go` after plan-ready; continue through implementation and measured handoff after GO.
- Preserve all older corpora/receipts; append current bindings without rewriting historical results. Keep #176/#127/#195 incomplete, notes/create partial and postingComplete false; formal order and adjacent owners unchanged.

## Review Focus

1. Duplicate null-date emojis and slow key: separate clock samples happen before key wait (Task1 source trace and unit key-gate test).
2. Remote emoji sharing local name and unordered DB rows: local rows only, input order/duplicates (Task1 actual PG+HTTP and acquireActor tests).
3. Cache/query/render failures: error propagates before key; HTML/disabled/missing/redirect never query (Task1 source failures and HTTP boundary tests).
4. Empty strings, null dates/MIME/license and Unicode/malformed hashtags: preserve source fallback and encoding errors (Task1 independent corpus and direct consumer).
5. Shared Note path: preserve hashtag→mention→emoji and fixed fallback time (Task1 existing Note source unit and PG regression).

---

### Task 1: Publish local actor tags, including independent oracle and both actual callers

**Files:**
- Create `docs/superpowers/compatibility/remote-user/local-actor-tags-source-probe.mjs`, `local-actor-tags-observations.json`, `local-actor-tags-results.md` (same directory).
- Create `packages/backend-next/src/modules/federation/ap-tags.ts`, `src/platform/database/local-emojis.ts`, `src/composition/local-actor-tags.ts`.
- Modify `packages/backend-next/src/modules/federation/{local-actor,public,note-activity}.ts`, `src/platform/database/{local-actors,note-activity}.ts`, `src/http/activitypub-actor-api.ts`, `src/composition/{actor-http,remote-users}.ts`.
- Create `packages/backend-next/test/unit/federation/local-actor-tags.test.ts`; modify existing `actor-api.test.ts`, `local-actor.test.ts`, `local-actor-profile.test.ts` for required interfaces/historical projection, and `test/integration/activitypub-actor.test.ts` for actual HTTP/DB and local acquireActor.
- Add narrow root validator `scripts/local-actor-tags-contract.test.mjs`; append links/current applicability in compatibility remote-user README/results as necessary. Own inventory rows only after parent pin, no fake implementationCommit.

**Interfaces:**
- Consume existing `ApEmojiFacts` fields and `LocalActorProfileFacts` unchanged, existing EntityManager and `MiEmoji` public entity.
- Produce `renderApEmoji(emoji: ApEmojiFacts, selfUrl: string, now: number)`, `renderApHashtag(name: string, selfUrl: string)` and `LocalActorTag` return union in `ap-tags.ts`, exported through federation `public.ts`.
- Produce `createLocalEmojiReader(manager: EntityManager): (names: readonly string[]) => Promise<ApEmojiFacts[]>` (ordered plain facts, local only).
- Produce `createLocalActorTagReader(manager: EntityManager, selfUrl: string, now: () => number = Date.now): (user: Pick<LocalActorFacts, 'emojis' | 'tags'>) => Promise<LocalActorTag[]>`.
- Add required LocalActorFacts `emojis: readonly string[]; tags: readonly string[]`, required renderer fifth argument `tag: readonly LocalActorTag[]` and HTTP port `readTags(user: LocalActorFacts): Promise<LocalActorTag[]>`.

- [x] **Step 1: Record independent source observations.** New probe executes all four literal methods with pinned byte guards, declares doubles and excludes full server/cache TTL. Cases: empty/no names, unresolved names, out-of-order Map, duplicates, localOnly, null/empty MIME and URLs/license, stored/null dates, advancing clock, key delay, Unicode/duplicate/raw/invalid-surrogate hashtags, required Profile/cache/render/key failures. Assert projected `{tag}` and event order or error; never compute expected from product code. `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-actor-tags-source-probe.mjs --write` then `--check` must reproduce byte-for-byte.
- [x] **Step 2: Write behavioral RED.** Source-consuming unit invokes actual HTTP adapter with acquired facts/readTags double for boundary orchestration and direct pure tag render consumer for literal projection; real DB reader covered by integration. Assert `tag: []`, order `['Emoji','Emoji','Hashtag']`, null times differ under advancing clock, no key before tag completion or after tag failure. Query/render errors yield 500 without cache headers; early statuses do not read tags. Actual PG tests seed local/remote collisions and assert HTTP and acquired material use local URLs/names/hashtags, duplicate/order and subsequent DB-failure rejection. Preserve historical identity projection by explicitly excluding newly covered `tag`, without altering any historical fixture.
- [x] **Step 3: Run RED.** Focus `pnpm --filter backend-next test test/unit/federation/local-actor-tags.test.ts --reporter=json --outputFile=/tmp/tiramiss-s1-r6-red-unit.json`; record behavioral failure in addition to missing interface diagnostics. If blocked by sandbox network once, write broker-request rather than retrying.
- [x] **Step 4: Implement GREEN.** Move facts/render shapes and existing local DB lookup into the exact interfaces above; Note uses helpers with existing options.now/order. Actor facts include names/tags. Wire both callers Profile→tags→key→actor; clock per visible undated emoji, errors unmodified. No extra queries for empty names, no normalization/cache/Drive duplication.
- [x] **Step 5: Focused verification.** Run source replay and unit files `local-actor-tags`, `local-actor`, `local-actor-profile`, `actor-api`, `note-activity`; reports named `/tmp/tiramiss-s1-r6-green-unit.json` and logs recorded. Inspect complete results. Run scoped `eslint --quiet` from package root and `git diff --check` before freezing.
- [x] **Step 6: Freeze and request parent validation.** `/tmp/tiramiss-s1-r6-validation-request.json` status `FROZEN_READY`, revision1, runtime source/test/dependency sha256s and commands `{id,command,artifact,log}`. Use ports PG55509/Redis56409/Meili57809. Parent runs dependency-order build/typecheck, real `activitypub-actor` and `note-activity` integration (JSON report), source replay; full-unit only if shared-composition risk justifies. No process new lifecycle. Wait <=30-second polls for receipt; preserve revisions/failures if runtime changes.
- [x] **Step 7: Record evidence and hand off.** Read shipping and verification skills; write source/runtime distinction, actual counts/timestamps/hashes/logs/limits, append current bindings while preserving history. Write root-request for new validator, relevant remote-user/note posting contracts, inventory check and shipping; parent executes and pins inventory after a real commit. Write `/tmp/tiramiss-s1-r6-implementation.md`, SDD task report, and ready.json status DONE with all public paths+sha256, commands/results/limits. No commit; parent reviews/integrates.

## Self-review

The one task owns oracle, plain facts/rendering, adapter, actual callers and five review-focus tests. No unowned interface or speculative implementation; all source/render/query failures and early branches have a named check. Existing historical projection tests gain required inputs without rewriting their expected corpora. Runtime revisions and parent receipts remain distinct from independent upstream observations.

## Implementation result

Task1 implementation complete; actual parent runtime revision1PASS: focused127/5, integration145/2, fullunit3021/93, source12, build/typecheck0. [Results](../compatibility/remote-user/local-actor-tags-results.md) record hashes/timestamps/limits. Root/inventory pin/shipping/review/CodeRabbit/Git/PR remain parent-owned gates, requested separately; no pass is inferred for them.
