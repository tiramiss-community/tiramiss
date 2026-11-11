# Remote Profile Source Parity Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. The coordinator assigns a sole writer, no child agents, no Git mutations; parent owns review/integration. Do not implement before /tmp/tiramiss-s1-r7-plan-go.

**Goal:** Compare actual remote profile HTML conversion and fix attachment failure priority at the existing public caller.

**Architecture:** Keep existing conversion and acquisition interfaces. Add immutable-source observations consumed directly by real conversion/acquisition and HTTP/PG tests; change only attachment selection from interleaved flatMap to two-phase filter/map.

**Tech Stack:** TypeScript, Vitest, TypeORM/PostgreSQL, node-html-parser 9.0.4, Node 24.20.0/pnpm 12.9.1 runtime; Node 26.4.0 root contracts.

**Spec:** docs/superpowers/specs/2026-11-11-remote-profile-design.md (selection: /tmp/tiramiss-s1-r7-selection.md).

## Global Constraints

- Worktree /home/osamu/develop/tiramiss/.claude/worktrees/s1-federation-next6; branch feat/backend-next-s1-federation-next6; base 91d60a82106e46a692d48ff620a38c80a8542c2e.
- Source /tmp/tiramiss-relay171-upstream, immutable 8e07cf085adf7009583d234a208e30436f020e26, read only.
- No child agents, Git mutation, external sends, install/Docker, auth/settings/.config/.env/security reads, old backend/frontend/upstream managed edits, changelog.
- Preserve ALL old corpora and receipts. Add evidence; do not repin unrerun historical measurements.
- #176/#127/#195 unfinished; notes/create:partial; postingComplete:false; preserve formal order and other owners.
- Parent executes actual final runtime/build/typecheck/integration/source checks against frozen inputs and owns Git/PR/review/inventory immutable pin.
- Dedicated PG55510 / Redis56410 / Meili57810; no unrelated infrastructure access.

## Review Focus

- Mixed malformed attachments: later null outranks earlier invalid URL; no actor writes, refresh attempt timestamp is separate.
- UTF-16 versus Unicode truncation and incomplete HTML at 2048: source helper is authoritative, no post-conversion cap.
- Summary hashtag recognition versus fields: only summary receives tag names, including NFKC and case normalization.
- Empty/missing summary and _misskey_summary: preserve source truthiness, invalid types and deferred profile failure.
- Refresh partial writes versus create rollback/canonical fallback: actual PG tests distinguish these from source trace doubles.

## Task 1: Remote Profile finite source parity and actual caller priority

**Files:**
- Modify packages/backend-next/src/composition/remote-users.ts (attachment line only unless independent mismatch proves another fix).
- Create packages/backend-next/test/unit/federation/remote-profile.test.ts.
- Modify packages/backend-next/test/integration/remote-user.test.ts (add real profile fixture consumers and failure boundaries).
- Create docs/superpowers/compatibility/remote-user/remote-profile-source-probe.mjs, remote-profile-observations.json, remote-profile-results.md, remote-profile-runtime-evidence.json.
- Create scripts/remote-profile-contract.test.mjs and scripts/remote-profile-evidence.mjs; modify scripts/local-actor-tags-evidence.mjs with one measured identity hop (automatic existing CI contract glob).
- Modify docs/superpowers/compatibility/remote-user/README.md additively. Preserve all old corpora/receipts.
- Save approved design/plan under docs/superpowers/specs/2026-11-11-remote-profile-design.md and docs/superpowers/plans/2026-11-11-remote-profile-195.md after GO.
- Only necessary current own inventory rows identified for parent's immutable pin; root-request lists exact contracts and shipping work.

**Interfaces:**
- Consumes createRemoteUsers(parts, config): RemoteUserPorts; acquireActor(uri: string, existing: RemoteUserFacts | null, currentTime: () => number, newId: (now: number) => string): Promise<RemoteActorPlan> (existing exported interface; no change).
- Consumes htmlToMfm(html: string, hashtagNames?: string[]): string and truncate existing public helpers.
- Produces finite observations with source commit, file/method SHA256, named doubles, explicit case inputs and source outputs/errors/write traces; no generic extra JSON maps.
- Probe CLI UPSTREAM_ROOT=... [UPSTREAM_SOURCE_MODE=verified-files] node .../remote-profile-source-probe.mjs --write|--check, deterministic corpus output.
- Root contract validates corpus case uniqueness, source fingerprints, hashes and actual consumer identities; no CI workflow edit needed when glob already covers file.

- [x] Step 1: After GO/SDD brief, save design/plan, read execution/TDD rules, inspect source AST and practical existing harness reuse. Extract actual converter/adapter, attachment/type/tag/normalize/truncate methods from fixed source and execute real transformations; keep finite explicit dependency doubles.
- [x] Step 2: Write actual acquisition regression: [{type:'PropertyValue',name:'site',value:'<a href="not-a-url">@a</a>'}, null] rejects TypeError from type selection for create and refresh, rather than Invalid URL; validate emoji/collection boundary and absence of actor plan.
- [x] Step 3: Run focused regression with Vitest JSON reporter, retain RED artifact/log showing actual Invalid URL priority. This proves reverting two-phase selection breaks behavior, not source text.
- [x] Step 4: Change attachment processing to filter all isPropertyValue-equivalent predicates before map conversion, retaining existing name/value checks and null failure. Run regression GREEN and retain artifact.
- [x] Step 5: Build finite immutable-source corpus and consumer tests: formatting, ruby fallback, pre/code, quote, entities, malformed HTML, mention host/rel/empty link; summary/override precedence, 2048/2049 and Unicode/incomplete markup; tags singleton/array/unknown/NFKC; fields array-only/string guard/input order/no hashtag names; attachment/summary errors. Exact observed outputs are generated only by source methods and checked by backend-next tests.
- [x] Step 6: Extend public notes/create tests with source corpus outputs in actual Profile on create and stale refresh; malformed attachment create/refresh preserves actor/Profile/Key/Following boundaries and refresh attempt time. Bind existing summary failure/Profile save/canonical tests where sufficient; add missing create summary rollback test. Assert omitted mention and retained Note text, without claiming HTTP difference from the priority fix.
- [x] Step 7: Run focused unit/source checks locally. On first network EPERM send /tmp/tiramiss-s1-r7-broker-request.json and wait for parent broker; no broad retries. Add root corpus/source/consumer contract and scoped lint/diff check.
- [x] Step 8: Freeze relevant source/test/dependency/oracle inputs excluding mutable evidence/docs/inventory JSON. Write /tmp/tiramiss-s1-r7-validation-request.json status FROZEN_READY revision 1, sha256 map/productSha256 and commands {id,command,artifact,log}. Parent runs build/typecheck/focused unit/necessary integration/source probe with dedicated ports and JSON reporters; no full unit/process without shared/lifecycle justification.
- [x] Step 9: Wait with <=30-second polls for actual validation receipt. If inputs change preserve failed revision and issue revision 2; never reuse stale evidence. Record actual counts/failures/limits and current consumer identities additively.
- [x] Step 10: Request parent necessary root contracts/inventory/shipping via /tmp/tiramiss-s1-r7-root-request.json, no inventory implementation pin before immutable implementation commit. Self-review spec/quality and report SDD task completion to parent; parent owns independent/CodeRabbit review.
- [x] Step 11: After receipts write /tmp/tiramiss-s1-r7-implementation.md, SDD task report and /tmp/tiramiss-s1-r7-ready.json status DONE with public paths and SHA256 of all changes. Do not commit. Include actual counts, limits and uncompleted owners. No changelog edit.

Validation commands (final exact artifact paths in freeze request): pnpm --filter backend-next... build; pnpm --filter backend-next... typecheck; pnpm --filter backend-next test test/unit/federation/remote-profile.test.ts test/unit/federation/remote-emojis.test.ts test/unit/federation/remote-actor.test.ts --reporter=json --outputFile=/tmp/tiramiss-s1-r7-unit.json; BACKEND_NEXT_TEST_DB_PORT=55510 BACKEND_NEXT_TEST_REDIS_PORT=56410 BACKEND_NEXT_TEST_MEILI_PORT=57810 pnpm --filter backend-next test:integration test/integration/remote-user.test.ts --reporter=json --outputFile=/tmp/tiramiss-s1-r7-integration.json; UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/remote-profile-source-probe.mjs --check; node --test scripts/remote-profile-contract.test.mjs and necessary existing affected contracts; node scripts/check-shipping.mjs --base 91d60a82106e46a692d48ff620a38c80a8542c2e.

Self-review: one cohesive task; source and product behavior distinguished; five review concerns have tests; unchanged public interfaces and dependency graph; exact source/ports/parent responsibilities preserved.

Execution note: 2026-11-11 frozen revision 1 passed build/typecheck, focused unit195/3, integration100/1, source68. Source converter outputs 2049/2401 exceed the unchanged pinned varchar(2048) schema; real HTTP/PG tests correctly assert omission/create rollback versus refresh Profile retention. Initial parent preflight96 PASS/4 FAIL preserved. Root contract176/176 and shipping/diff checks PASS (Node26.4.0); independent review/immutable own inventory pin belong to coordinator. No Git mutation.
