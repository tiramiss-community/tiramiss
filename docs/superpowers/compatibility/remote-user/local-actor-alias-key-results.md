# Actor alias / public key #323 — worker results, 2026-11-14

Implementation is present; live acceptance and final integration approval are **not complete**. This worker started at `f4bb7803a814a112b18286d4ca1b0cfb71e5787e` in `/tmp/ultracode-wt-LhJyfU`. No commit, push, external mutation, migration, dependency manifest/lockfile change, inventory promotion or historical evidence rewrite was performed. Parent/CI/review success is not claimed.

## Implemented scope

- AP-selected `GET /@:acct`: one leading acct `@` removed, split at most twice, username lowercased, only self host normalized to null; remote host predicate retained exactly. Non-suspended saved rows only. Local actor uses the existing pure renderer; remote rows use saved URI without resolving or saving remote actors.
- `GET /users/:user/publickey`: exact local ID lookup including suspended users, no profile/tag/media reads, saved public key converted to SPKI, default `/publickey` suffix and AP context. Pure renderer also supplies the unchanged actor `#main-key` object; explicit empty postfix is retained.
- HTTP owns CORS, Accept selection/fallback, Vary, cache, errors and redirects. Alias redirect policy reads actual Meta and composition supplies actual `NODE_ENV === 'production'`; bare LD JSON bypass, same-host exception and http-to-https nonproduction comparison match fixed source. Existing `/users/:id` handler behavior remains unchanged.
- Explicit 403/404/500 responses remain empty. Unexpected errors retain JSON error classification, not an empty body. Framework diagnostic message text is excluded from comparison. Source cache ordering is preserved: alias render failures retain max-age=180; missing key acquisition has no cache; invalid key conversion after acquisition retains cache. This source behavior is not a new caching guarantee.

No HTML, key generation changes, remote resolution, collection/follow changes or new guarantees. #176/#127 remain OPEN, `notes/create:partial`, `postingComplete:false`, D7 64-depth/256-Note, approved PG notification storage and deferred strong ordering remain unchanged. Meta/cache freshness remains #217's responsibility.

## Source truth and finite comparison

`local-actor-alias-key-source-probe.mjs` reads only `git show 8e07cf085adf7009583d234a208e30436f020e26:<path>`, records six blob IDs/SHA256s and dependency versions, and extracts literal acct, host, renderer/context, route methods and the ServerService redirect guard. `local-actor-alias-key-corpus.json` supplies **58 route cases**; observations also contain **7 acct inputs and 3 key postfix cases**. `local-actor-alias-key-key.json` contains a public key only, in PKCS1/SPKI forms.

Real Fastify inject and accepts run with explicit repository, key acquisition and Person doubles. Predicates are observed separately from returned rows (some deliberately inconsistent rows); these source-method doubles do not prove real repository filtering. Actor body comparison is context/type/id/publicKey projection; product tests separately compare alias with existing ID actor output. Full upstream HTTP/PG, HTML, generic fallback diagnostics, exact exception messages, cache lifecycle equivalence and all global server hooks are outside this finite comparison. The product unit and prepared live tests read the observation JSON directly.

Probe dependency defaults are the supplied `/tmp/tiramiss-s1-r13-probe/package.json` and `/tmp/tiramiss-relay171-upstream/packages/backend/package.json`; `PROBE_HARNESS` and `UPSTREAM_ROOT` override dependency locations only. Source stays pinned Git objects.

## Worker commands and measurements

Logs: `/tmp/tiramiss-s1-323-20261114/writer-*.log`. Node executable throughout: `/tmp/tiramiss-s1-node26/bin/node` (26.4.0). Direct installed-tool invocations were used after pnpm's automatic dependency verification attempted installation. Commands below run from repo root unless `cd` is specified.

| Command | Worker result | Log suffix |
| --- | --- | --- |
| `cd packages/backend-next; node node_modules/vitest/vitest.mjs run --config vitest.config.ts test/unit/federation/actor-alias-key.test.ts` before production edits | RED: **6 failed**, missing routes returned 404 | `red.log` |
| Same initial focused file plus `test/unit/federation/actor-api.test.ts` after implementation | GREEN: **15 passed** | `green-initial.log` |
| Source-consumer expansion of first file | RED: **6 failed / 59 passed**, identifying malformed-path Content-Type, LD profile negotiation and invalid-key cache ordering; subsequently corrected | `source-product-red.log` |
| `cd packages/backend-next; node node_modules/vitest/vitest.mjs run --config vitest.config.ts test/unit/federation/actor-alias-key.test.ts test/unit/federation/actor-api.test.ts test/unit/federation/local-actor.test.ts test/unit/federation/local-actor-images.test.ts test/unit/federation/local-actor-fields.test.ts test/unit/federation/local-actor-profile.test.ts test/unit/federation/local-actor-tags.test.ts test/unit/composition/http-app.test.ts` | GREEN: **217 passed, 8 files**, including production/Meta composition checks | `unit.log` |
| `node packages/backend-upstream/node_modules/typescript/bin/tsc6 -p packages/backend-upstream/tsconfig.json` and `node packages/backend-upstream/node_modules/tsc-alias/dist/bin/index.js -p packages/backend-upstream/tsconfig.json` | PASS | `build-upstream.log` |
| `cd packages/backend-next; node node_modules/typescript/bin/tsc6 -p tsconfig.json` | PASS build, production typecheck | `build.log` |
| `cd packages/backend-next; node node_modules/typescript/bin/tsc6 -p tsconfig.test.json --noEmit` | PASS final test typecheck | `typecheck.log` |
| `node docs/superpowers/compatibility/remote-user/local-actor-alias-key-source-probe.mjs --check` | PASS **58 + 7 + 3** | `source-check.log` |
| `node scripts/local-actor-alias-key-contract.test.mjs` | PASS **4** | `contract.log` |
| `node scripts/backend-contract-inventory.test.mjs` | PASS **10** (validator unit tests only) | `inventory-tests.log` |
| `node scripts/package-imports-contract.test.mjs` | PASS **8** | `structural.log` |
| `cd packages/backend-next; BACKEND_NEXT_TEST_DB_PORT=56473 BACKEND_NEXT_TEST_REDIS_PORT=57473 node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts test/integration/actor-alias-key.test.ts test/integration/activitypub-actor.test.ts` | **BLOCKED**: setup `connect EPERM 127.0.0.1:56473`; 2 failed suites, **110 skipped**, no live assertion executed | `integration.log` |
| `node scripts/local-actor-fields-contract.test.mjs` | **7 passed / 21 failed**, expected frozen-consumer drift described below | `historical-contract.log` |
| `node scripts/backend-contract-inventory.mjs --check` | **BLOCKED**: `spawnSync git EPERM` after resolving local TypeScript dependency | `inventory.log` |
| `node scripts/check-shipping.mjs --base HEAD` | **NOT COMPLETE**: pnpm exec started automatic install and hit restricted DNS; stopped. Individual checks run directly | `shipping.log` |
| Changed-file `eslint --quiet` from package root (explicit ten paths below) | PASS after formatting fixes | `eslint.log` |
| `node scripts/check-spdx.mjs` | PASS: **SPDX: OK**, 3352 files | `spdx.log` |
| HEAD diff + untracked locale path check | PASS: no locale changes | `locale.log` |

Lint paths relative to `packages/backend-next`: `src/composition/actor-http.ts`, `src/http/activitypub-actor-api.ts`, `src/modules/federation/acct.ts`, `src/modules/federation/local-key.ts`, `src/modules/federation/local-actor.ts`, `src/modules/federation/public.ts`, `src/platform/database/local-actors.ts`, `test/unit/federation/actor-alias-key.test.ts`, `test/unit/composition/http-app.test.ts`, `test/integration/actor-alias-key.test.ts`.

Other encountered setup failures: pnpm rejects root/task-state symlinks; Vite could not write through package node_modules into the readonly parent; replaced these directory links with local ignored directories containing dependency links. `bin/tsc` is absent in the installed TypeScript6 package; used its declared `bin/tsc6`. Root dependencies initially disappeared during pnpm automatic install attempts and were relinked from prepared parent dependencies. Initial lint/shipping imports (`globals`/`execa`) therefore failed before relinking. Probe dependency package-version discovery needed filesystem resolution for TypeORM/TypeScript exports; probe `--check` initially rejected VM realm prototypes, corrected by comparing JSON-normalized observations. No source expectations were changed to accommodate product failures. No network escalation or live PG retry was used; services were not stopped.

The final live file has **43 authored tests** (41 at the blocked invocation, plus two stored missing/invalid-key tests added and typechecked afterward). It covers source results, real predicates, suspended asymmetry, DB DML capture plus before/after state, outbound calls/queue key stability, modern-key Redis fill, completion of non-awaited legacy upgrade followed by warm-cache repeat, and missing Meta upsert. **None of these live checks is measured as passing here.** In particular, unconditional write freedom is not claimed. Existing key migration/Redis cache writes and Meta initialization remain intact. The supplied parent actor69 baseline is not a result for this edited worktree.

Fresh reviewer dispatch failed with `invalid thread-store request: no rollout found`; only author self-review was possible. No CodeRabbit ran. No independent approval or CI pass is claimed.

## Parent-only metadata / dated successor binding

Do not promote HTTP coverage until the live tests can execute successfully. After a real implementation commit exists, the exact four inventory targets are:

1. `ap-render:renderKey` — audit-items row; implementation `modules/federation/local-key.ts` and existing `keys.ts`; verification new unit/source fixture.
2. `responsibility:misc-utils:36` — audit-items row; implementation `modules/federation/acct.ts`; verification new unit/source fixture.
3. `http:packages/backend/src/server/ActivityPubServerService.ts:737` — domains override; implementation HTTP adapter, local key owner reader and composition; verification unit/source plus successful future live result.
4. `http:packages/backend/src/server/ActivityPubServerService.ts:785` — domains override; implementation HTTP adapter, acct reader and composition; verification unit/source plus successful future live result.

Parent regenerates `contracts.json/md` after recording a real `implementationCommit`; worker leaves domains, audit-items, generated contracts and backlog catalogs unchanged. Status must reflect actual measured scope, not parent baseline success.

`local-actor-fields-contract.test.mjs` calls `validateLocalActorImagesEvidence` (`scripts/local-actor-images-evidence.mjs:59`, `renewal measured input drift`) and `validateLocalActorFieldsEvidence` (`scripts/local-actor-fields-evidence.mjs:57`, `fields current input drift`). The required narrow dated successor is an alias-key #323 binding from the current pre-worker identities to successfully measured successor bytes, only for these six existing consumers: `src/composition/actor-http.ts`, `src/http/activitypub-actor-api.ts`, `src/modules/federation/local-actor.ts`, `src/modules/federation/public.ts`, `src/platform/database/local-actors.ts`, `test/unit/composition/http-app.test.ts` (all under backend-next). It must compose with the current fields/images/featured/follow-collections chain while preserving historical projections, corpora, receipts and seals. New alias/key files have no predecessor identity. A missing successful live measurement cannot be repaired by blessing hashes; parent must measure before binding. No validator was weakened here.

CHANGELOG candidate (not edited): 新バックエンドで acct 別名による ActivityPub actor とローカル公開鍵の取得に対応。

## Patch and index limitation

Normal `git add -N` could not create the linked worktree index lock under `/home/osamu/develop/tiramiss/.git/worktrees/ultracode-wt-LhJyfU/` (readonly filesystem). A private copy of the existing index at `/tmp/tiramiss-s1-323-20261114/writer.index` and private object directory `writer-objects` (the original object database is readonly too) are used with `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY` / readonly alternates for explicit-path `git add -N` and `git diff --binary HEAD`. Thus the complete patch includes new files without writing the parent Git directory. At the final check, ordinary `git diff --name-only HEAD` also reported all 17 paths and `git diff --cached --stat` was empty. The final patch was regenerated with ordinary `git diff --binary HEAD`; no file content was staged or committed. Patch: `/tmp/tiramiss-s1-323-20261114/writer.patch`.

## Exact changed files

- `docs/superpowers/compatibility/remote-user/local-actor-alias-key-corpus.json`
- `docs/superpowers/compatibility/remote-user/local-actor-alias-key-key.json`
- `docs/superpowers/compatibility/remote-user/local-actor-alias-key-observations.json`
- `docs/superpowers/compatibility/remote-user/local-actor-alias-key-results.md`
- `docs/superpowers/compatibility/remote-user/local-actor-alias-key-source-probe.mjs`
- `docs/superpowers/plans/2026-11-14-actor-alias-key-323.md`
- `packages/backend-next/src/composition/actor-http.ts`
- `packages/backend-next/src/http/activitypub-actor-api.ts`
- `packages/backend-next/src/modules/federation/acct.ts`
- `packages/backend-next/src/modules/federation/local-actor.ts`
- `packages/backend-next/src/modules/federation/local-key.ts`
- `packages/backend-next/src/modules/federation/public.ts`
- `packages/backend-next/src/platform/database/local-actors.ts`
- `packages/backend-next/test/integration/actor-alias-key.test.ts`
- `packages/backend-next/test/unit/composition/http-app.test.ts`
- `packages/backend-next/test/unit/federation/actor-alias-key.test.ts`
- `scripts/local-actor-alias-key-contract.test.mjs`
