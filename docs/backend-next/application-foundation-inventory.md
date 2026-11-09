# Application foundation operational inventory


## 統合後の現在地（2026-11-09）

#251 の段階1（共通 lifetime・Role adapter・Role show/update composition）は統合済み。以下の worker 内の BLOCKED/PENDING は隔離環境での履歴であり、実 DB・HTTP・停止時の不足は親 worktree の検証で解消した。段階2 Note/Poll、段階3 mokuroku、残る platform-to-composition 依存の整理は未実施で、#251 全体の完了とはしない。正式な blocked-by は変更していない。

| 親 worktree の検証（Node 26.4.0 / pnpm 12.9.1） | 結果 |
| --- | --- |
| `pnpm --filter backend-next... build` / `typecheck` | PASS |
| `pnpm --filter backend-next test` | 83 files / 2,801 tests PASS |
| `test:integration test/integration/role-application.test.ts test/integration/http-app.test.ts test/integration/role-update.test.ts test/integration/transaction-runner.test.ts` | 4 files / 28 tests PASS |
| `test:integration` の note-create / notification / poll-ended-job / remote-user | 4 files / 127 tests PASS（Task 1 統合後。Task 2 はこれらを変更していない） |
| `pnpm --filter backend-next test:acceptance` | 2 files / 65 tests PASS |
| `test:process test/processes/role-http.test.ts` | 1 file / 2 tests PASS。接続中・切断済みの受理処理と終了を確認 |

最終レビュー: CodeRabbit は全14変更ファイルで指摘0件。独立した契約・網羅性のレビューも仕様 PASS / 品質 APPROVE、要修正の指摘なし。変更ファイル lint・SPDX（3,250ファイル）・locale safety・upstream sync 検査は PASS。

既存の pg query 並行利用に関する非推奨警告は変更前にも発生している。DB schema・外部 API・queue 保存形式・UseCase の境界は変えていない。

| 構造の比較 | 変更前 → 変更後 |
| --- | --- |
| Role adapter の runner 階層 | 2 → 1 |
| Role 固有の lifetime 状態管理 | 1 → 0（共通 runner に集約） |
| HTTP が直接使う Role reader / transaction / UseCase の組み立て関数 | 5 → 1（`createRoleApplication`） |
| 対象4製品ファイルの総行数（ヘッダー・空行込み） | 108 → 148（+40） |
| Role adapter 単体の行数 | 62 → 49 |

Role の依存入口と transaction の終了管理は揃ったが、総行数を削る変更ではない。次の適用は Note/Poll の既存境界と #178 の担当調整を確認して小さく判断する。全モジュールの一括移行や汎用フレームワーク化はこの結果から導かない。

Baseline: `5fe478de46039437f4f74a4be765c6670b6a645d`. Owner: #251 stage 1; Task 1 implements shared lifetime and Role adapter only. Created before production edits. Paths below are relative to `packages/backend-next/` unless prefixed with `docs/`. Caller line references describe this baseline.

Baseline sweep: two application ORM transaction-opening sites, four common-runner adapters, five business `.run()` callsites, 22 composition files, eight BullMQ constructor sites. Task 1 adds no composition file; Task 2 will add one. Existing business/application contracts are preserved.

## Transactions

| evidence/caller | owner | stage | old → new path | status | verification | re-evaluation condition |
| --- | --- | --- | --- | --- | --- | --- |
| `src/platform/database/transaction-runner.ts:8` | #251 / 1 | 1 / Task 1 | `source.transaction → bind(manager) → work` → `source.transaction → per-run lifetime → bind(manager, lifetime) → awaited work → expiry before COMMIT/rollback`. **In scope.** | implemented; unit verified; PG blocked | `test/unit/transaction-runner.test.ts:8,34`; `test/integration/transaction-runner.test.ts:22,45`. Existing tests lack lifetime coverage. | Rerun runner unit/PG tests for binder contract changes. |
| `src/platform/database/role-update.ts:19` → `modules/role/update-role.ts:25`; assembled by `composition/role-http.ts:24` | #251; existing #115, future #181 / 1 | 1 / Task 1 | Identity binder → second `run` → local `active/finally` becomes one common-runner binder returning `RoleUpdateScope`. **In scope.** | implemented; unit verified; PG blocked | Role DB/acceptance tests below. Re-evaluate expansion after this path proves useful, before additional update UseCases. | Evaluate usefulness before #181/#182 expansion; PG verification still required. |
| `src/platform/database/note-writer.ts:102` → `modules/note/create-note.ts:337`; assembled by `composition/note-routes.ts:32` | #251 / 2; #170/#176, coordination with #178 | 2 | Existing second `run` and local lifetime **unchanged**. No-poll path remains direct `writes.insertNote` at `create-note.ts:334`. | retained / deferred | `test/unit/note/create-note.test.ts:148,258,352,371`; `test/integration/note-create.test.ts:261,286`. Deferred until explicit stage 2 authorization and Note-gate coordination. | Explicit stage 2 authorization, with #176/#178 Note-gate coordination. |
| `src/platform/database/poll-ended.ts:42` → **both** `modules/note/created-events.ts:49` and `modules/notification/poll-ended.ts:60`; assembled at `composition/posting-notifications.ts:69` and `composition/poll-ended-job.ts:17` | #173/#162; remaining notification work #177 / outside 1 | owning slice | One-argument binder **unchanged**. `PostNotificationPersistence` already checks an active, unreleased transaction before advisory-lock SQL: `database/notification/persistence.ts:8`. `flush` has no production caller. | retained / deferred | `test/integration/notification.test.ts:44,71,97`; `poll-ended-job.test.ts:132,244`; `note-notifications.test.ts`. Re-evaluate guard adoption with the notification owner; not automatically part of stage 2. | Notification owner #177 expands guards with its own persistence/consumer tests. |
| `src/platform/database/remote-users.ts:42` → `modules/note/create-note.ts:260`; assembled at `composition/remote-users.ts:54` | #195/#215; #251 inventory / outside 1 | owning slice | Existing identity binder, second `run`, three guarded inserts and local `finally` **unchanged**. Actor creation stays separate from Note/Poll saving; refresh writes remain independently committed. | retained / deferred | `test/integration/remote-user.test.ts:186,198,209,270,370`. Re-evaluate with a coordinated remote-user slice, preserving race recovery and partial refresh failures. | Coordinated #195 actor slice, preserving race recovery and partial refresh behavior. |
| `src/platform/database/system-account.ts:55` ← `composition/federation-keys.ts:26` ← `composition/remote-users.ts:75` | #215; consumer #195 / retained exception | owning slice | Direct `dataSource.transaction` **unchanged**. This is the documented independent lazy-creation exception, not a missed common-runner caller. | retained / deferred | `test/integration/federation-keys.test.ts:71,113,147,176`; exception contract `docs/backend-next/federation-base-contract.md:30`. Re-evaluate only when that contract changes. | Only if the independent lazy-creation contract in federation-base-contract.md changes. |


## Composition

| evidence/caller | owner | stage | old → new path | status | verification | re-evaluation condition |
| --- | --- | --- | --- | --- | --- | --- |
| `composition/role-http.ts` → `composition/role.ts` | #251 / 1; #178 gate retained | 1 / Task 2 | Inline show/update assembly → `createRoleApplication` with explicit DB, IDs, clock and changes; HTTP delegates directly to its two operations | implemented; local checks PASS; DB/acceptance/process parent verification pending | Factory integration 5 cases and authenticated canonical-root regression added. HTTP retains codec, authentication, endpoints and logging; root/gate/queue unit 29 PASS. | Parent DB/acceptance/process verification before stage 1 completion; explicit authorization before stage 2. |
| `composition/create-runtime.ts:11` → `platform/connect-resources.ts:52`; `processes/lifecycle.ts:21` | #114 runtime; #251 later composition work | later / owning slice | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged.** Inversify currently supplies the logger. Platform still imports feature composition at `connect-resources.ts:1,9–17`; stage 1 does not claim this dependency inversion is fully resolved. Tests: `integration/resources.test.ts:37,95,135`. Re-evaluate when a feature assembly is actually moved. | When a feature assembly actually moves; retain platform-to-composition imports meanwhile. |
| `composition/http-app.ts:12`, `note-http.ts:5`, `note-routes.ts:23,49` | PR #249; Note #176/#178 / 2 | later / owning slice | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged.** Root prepares Note before Role; `note-http` is a compatibility re-export. Preserve construction/error ordering. Tests: `unit/composition/http-app.test.ts:29,63`. | Stage 2 Note composition/gate work; preserve Note-before-Role preparation. |
| `composition/remote-users.ts:15` | #195/#215 / outside 1 | later / owning slice | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged**, called by `note-routes.ts:31`; transaction details above. | Coordinated #195/#215 actor slice. |
| `composition/posting-notifications.ts:19`, `posting-role-timelines.ts:7` | #173/#174; #177/#181/#189 / 2 or owning slice | later / owning slice | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged**, assembled at `connect-resources.ts:284,286`. Tests: `integration/note-notifications.test.ts`, `note-role-timelines.test.ts`. Re-evaluate with Note composition authorization. | Explicit stage 2 or owning #177/#181/#189 slice. |
| `composition/posting-search.ts:13`, `posting-hashtags.ts:9`, `posting-featured.ts:9`, `posting-timelines.ts:10`, `posting-antennas.ts:8` | #174/#172; later #185/#186 / 2 | later / owning slice | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged**, assembled at `connect-resources.ts:280,319,324,328,333`. Tests: respective `integration/note-search-index`, `note-hashtags`, `note-featured`, `note-timelines`, `note-antennas` files. Preserve post-save start/drain boundaries. | Explicit Note/owning #172/#174/#185/#186 slice; preserve post-save start/drain. |
| `composition/federation-keys.ts:16`, `outbound-http.ts:14`, `ap-request.ts:11`, `actor-http.ts:11` | #215/#216/#160/#195 / outside 1 | later / owning slice | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged**. Callers: `connect-resources.ts:268,270`; `deliver-job.ts:20`; `http-app.ts:15`; worker webhook assembly at `queue-workers.ts:27`. Tests: `integration/federation-keys`, `ap-request`, `activitypub-actor`; outbound unit tests. Re-evaluate with their owning slice. | Owning #215/#216/#160/#195 federation/AP/actor slice. |
| `composition/queue-workers.ts:19`, `poll-ended-job.ts:13`, `deliver-job.ts:17` | PR #249; #162/#171/#175; #251 / 3 | 3 | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged static registry**, consumed at `processes/worker.ts:21`. Tests: `unit/composition/queue-workers.test.ts:10`, `unit/worker-startup.test.ts:90,112,168`. | Stage 3 fixed-artifact compatibility for dynamic names, results, BullMQ6, ready/failure/close/drain. |
| `composition/queue-http.ts:18`, `posting-websocket.ts:13` | #163/#189 / retained | later / owning slice | Existing assembly → unchanged in Task 1; retain existing callers and lifecycle | retained / deferred | **Unchanged**, opened by `processes/http.ts:117,127`. Tests: `integration/queue-admin`, `queue-stats`, `posting-websocket`. Re-evaluate only if their assembly/lifetime changes. | Only if queue administration or WebSocket assembly/lifetime changes. |


## Queues

| evidence/caller | owner | stage | old → new path | status | verification | re-evaluation condition |
| --- | --- | --- | --- | --- | --- | --- |
| Poll producer `job-queue/ended-poll-notification.ts:63`; Worker `:97` | #162 | 3 / owning slice | Existing BullMQ 6.3.11 path → unchanged | retained / deferred | Producer opened at `connect-resources.ts:238`, passed as `schedulePollEnded` at `:334`, invoked by `platform/note-post-save.ts:50`. Registry entry `queue-workers.ts:22` → `createPollEndedHandler`. Dynamic name = note ID; no explicit job ID/attempts/backoff. Tests: `integration/poll-ended-job.test.ts:132,187,266`. | Stage 3: preserve note-ID names, scheduling/options and ready/failure/close/drain. |
| Deliver producer `job-queue/deliver.ts:112`; Worker `:154` | #171/#160 | 3 / owning slice | Existing BullMQ 6.3.11 path → unchanged | retained / deferred | Opened at `connect-resources.ts:248`; relay `deliverOne` at `:277`, create/delete `deliverMany` at `:340,352`. Registry `queue-workers.ts:38` → `createDeliverJobHandler`. Dynamic destination name, custom backoff, default 12 attempts, string success result. Tests: `integration/deliver-queue`, `deliver-processor`. | Stage 3: preserve destination names, 12 attempts, custom backoff, string results and lifecycle. |
| Webhook producer `job-queue/user-webhook.ts:29`; Worker `:96` | #175; extensions #197 | 3 / owning slice | Existing BullMQ 6.3.11 path → unchanged | retained / deferred | Opened at `connect-resources.ts:259`, connected through `openUserWebhooks` at `:262`; registry `queue-workers.ts:25`. Dynamic webhook-ID name, snapshot payload, four attempts, `"Success"` result; stop then processor `idle`. Tests: `integration/user-webhook`; `unit/worker-startup.test.ts:168`. | Stage 3 or #197: preserve snapshot, webhook-ID names, 4 attempts, Success and stop-before-idle. |
| Administration `job-queue/administration.ts:34,36`; QueueEvents `platform/queue-stats.ts:102` | #163/#164 | 3 / owning slice | Existing BullMQ 6.3.11 path → unchanged | retained / deferred | Administration opens **10 Queue handles**; QueueStats opens events only for deliver/inbox. Neither registers business workers. Tests: `integration/queue-admin`, `queue-retention`, `queue-stats`. | Stage 3 or #163/#164: retain ten management handles distinct from workers; deliver/inbox events. |
| `job-queue/handoff.ts:124,132`; `handoff-policy.ts:46` | #165/#139 | 3 / owning slice | Existing BullMQ 6.3.11 path → unchanged | retained / deferred | Raw Redis inspection, not registration. Preserves the three supported handlers and rejects unsupported unfinished/failed work and schedulers. Tests: `integration/queue-handoff`, `test/processes/queue-handoff`. | Stage 3 or #165/#139: saved dynamic names/results/options, unsupported-job/scheduler rejection. |

All rows remain on BullMQ in stage 1; mokuroku is deferred to stage 3.
The remaining seven names are declared at `modules/queue/contracts.ts:5`: system (#199/#200), postScheduledNote (#183), inbox (#195), db (#199), relationship (#182), objectStorage (#188/#199), systemWebhookDeliver (#198). Their handlers and nine system schedulers remain deferred to their owners; ownership evidence is `docs/backend-next/posting-contract.md:200,214–224`.
Stage 3 re-evaluation requires the issue’s compatibility gates—saved dynamic names, success results, BullMQ 6, ready/failure/close/drain behavior. No queue migration is proposed here.

## Separate transaction-like mechanisms

- Migration execution: `src/platform/database/migrate.ts:13,24`; modes `migration-sources.ts:30,38`. Retained; schema/migration owner, outside application transaction adoption.
- Redis MULTI: `platform/featured-ranking.ts:20`, `hashtag-ranking.ts:44`; pipelines `hashtag-ranking.ts:45`, `timeline-cache.ts:20`, `database/note-reader.ts:40`. Retained; independent Redis feature owners, reconsider only with those features.
- Poll notification persistence guards its active QueryRunner; `flush` has no production caller. Common-runner one-argument binding does not automatically expand operation guards.
- System-account transaction is the documented independent lazy-creation exception (`docs/backend-next/federation-base-contract.md:30`).

## Measurements and verification

Task 1 implemented: Role local lifetime owners **1 → 0**, adapter `run` layers **2 → 1**, with one shared per-invocation owner in the runner. Note/remote-user wrappers remain. Platform-to-composition imports remain; no elimination claim. Queue startup stays `processes/worker.ts:20`, producers open at `platform/connect-resources.ts:237`.

Awaited operations stay active until callback settlement. Escaped new calls must reject before DB/helper access; already-started promises are neither cancelled nor collected. Source rejection is preserved without retry or claiming rollback of an uncertain COMMIT.

Task 1 commands use Node 26.4.0 / pnpm 12.9.1, `PATH=/tmp/tiramiss-251-node/node-v26.4.0-linux-x64/bin:$PATH`, `BACKEND_NEXT_TEST_DB_PORT=55441`, `BACKEND_NEXT_TEST_REDIS_PORT=56388`, and `pnpm_config_verify_deps_before_run=false` (borrowed dependencies; automatic install disabled after an initial unintended pnpm install attempt was interrupted).

| verification | measured result |
| --- | --- |
| `pnpm --filter backend-upstream build` | PASS in this worktree, before tests; local dependency link consumes this build. |
| Baseline `pnpm --filter backend-next test test/unit/transaction-runner.test.ts test/unit/role/update-role.test.ts test/unit/role/show-role.test.ts test/unit/composition/http-app.test.ts test/unit/http/api-endpoint.test.ts` | PASS: 51 tests / 5 files. |
| RED `pnpm --filter backend-next test test/unit/transaction-runner.test.ts` | 6 failed / 3 passed: missing lifetime. GREEN after runner change: 9 passed. |
| RED `pnpm --filter backend-next test test/unit/role/role-update-transactions.test.ts` | 8 failed: old adapter guard diagnostic, covering each operation after success/rejection. GREEN after flattening: 8 passed. |
| `pnpm --filter backend-next test test/unit/transaction-runner.test.ts test/unit/role/role-update-transactions.test.ts test/unit/role/update-role.test.ts test/unit/role/show-role.test.ts` | PASS: 38 tests / 4 files. |
| `pnpm --filter backend-next test:integration test/integration/transaction-runner.test.ts test/integration/role-update.test.ts` | BLOCKED: EPERM connecting to 127.0.0.1:55441; no real-DB success claim. New RED/GREEN integration invocations separately hit the same pre-test block. |
| `pnpm --filter backend-next test:integration test/integration/note-create.test.ts test/integration/notification.test.ts test/integration/poll-ended-job.test.ts test/integration/remote-user.test.ts` | BLOCKED: same EPERM; 127 skipped / 4 failed suites. |
| Baseline Role acceptance / role-http process | BLOCKED before tests: same EPERM (65 / 2 tests skipped). Parent pre-change results are separate evidence, not current-worktree passes. |

Final `pnpm --filter backend-next... build` and `pnpm --filter backend-next... typecheck`: PASS. `node scripts/check-shipping.mjs --base HEAD`: PASS (6 changed TypeScript files linted, SPDX 3,248 files OK, locale safety PASS). `pnpm --filter backend-upstream sync:check` is blocked here by `spawnSync git EPERM`; the parent pre-change sync check passed. The broader unit run also encounters restricted child-process/HTTP tests; see the handoff evidence for failed names and limits. No composition, modules/application, schema, migration, locale, compatibility expectations or queue behavior changed. Stage 1 overall remains incomplete pending Task 2 and real-DB verification.


## Task 2 local result and handoff (2026-11-09)

Production path: `processes/http.ts` → `composition/http-app.ts` → `composition/role-http.ts` → **`composition/role.ts`** → existing Role UseCases/adapters. Previously `role-http.ts` assembled show/update inline; that duplicate responsibility is removed. The factory returns exactly show/update, borrows the DataSource, and owns no connection or cleanup. HTTP still supplies the configured codec ID functions and `Date.now`. Note preparation still precedes Role construction; lifecycle, disconnect/drain behavior and publisher override fixtures are unchanged.

The operation path is easier to trace through one explicit Role dependency boundary, with one extra factory hop and no generic registry. This supports discussing stage 2 after production-path verification, rather than authorizing it. Platform-to-composition imports in `connect-resources.ts` remain; full resource extraction, Note/Poll and mokuroku remain deferred.

All Task 2 pnpm commands use the Task 1 environment documented above, including `pnpm_config_verify_deps_before_run=false`. Dependencies are borrowed through individual links in physical node_modules directories, with copied .bin wrappers and local caches/state; backend-upstream resolves to this worktree's build.

| Task 2 verification | local result |
| --- | --- |
| `pnpm --filter backend-upstream build` | PASS before factory tests; initial setup attempt rejected a symlinked pnpm task-state directory, corrected to a physical directory. |
| RED `pnpm --filter backend-next test:integration test/integration/role-application.test.ts` | Expected missing `src/composition/role.js` import; factory absent before implementation. |
| `pnpm --filter backend-next test:integration test/integration/role-application.test.ts test/integration/http-app.test.ts` | BLOCKED by `connect EPERM 127.0.0.1:55441`; 2 failed suites / 7 skipped tests. Import now resolves; no DB GREEN claim. Parent verification pending. |
| `pnpm --filter backend-next test test/unit/composition/http-app.test.ts test/unit/http/api-endpoint.test.ts test/unit/composition/queue-workers.test.ts` | PASS: 29 tests / 3 files, including Note-before-Role and missing-authorization gate regressions. |
| `pnpm --filter backend-next... build` / `pnpm --filter backend-next... typecheck` | PASS; unchanged direct HTTP callers remain assignable. |
| Built factory construction smoke (`node --input-type=module`) | PASS: exactly show/update functions; no transaction, initialize or destroy; real uninitialized DataSource remains uninitialized. |
| Role acceptance / `test/processes/role-http.test.ts` | PENDING parent verification; not retried after confirmed sandbox DB EPERM. |

Local handoff text for #114/#251 (not sent): Stage 1 Task 2 extracts narrow Role composition and adds factory/authenticated-root coverage; local build/typecheck and 29 root/gate/queue unit checks pass. See `docs/backend-next/application-foundation-inventory.md`. Stage 1 final completion still requires parent DB/acceptance/process checks. Task 1 is consumed unchanged and was not retested here. Stage 2/3 remain deferred. Remaining platform-to-composition imports require a separately scoped resource extraction; reconsider Note/Poll only after real verification and coordination with #176/#178, and mokuroku only after its fixed-artifact compatibility gates. No global blocked-by/order change is proposed.

Task 2 final repository checks: `node scripts/check-shipping.mjs --base 5fe478de46039437f4f74a4be765c6670b6a645d` PASS (10 changed TypeScript files linted, SPDX 3,250 files OK, locale safety PASS); initial run found five test-formatting errors, corrected before the final pass. `git diff --check` PASS. No schema, API contract, modules/application, queue or compatibility expectation changes. Task 1 rows/results above are preserved as its original worker record; parent later reported realDB 21 PASS and shared-consumers 127 PASS, not rerun as Task 2 verification.
