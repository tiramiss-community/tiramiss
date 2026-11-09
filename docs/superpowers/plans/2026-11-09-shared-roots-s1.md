# S1 Shared Roots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #176 に先立ち HTTP、既存 worker、CI の共有 root を動作を変えず整理する。

**Architecture:** HTTP は Note 準備と root 組み立てを分け、旧入口を一方向の互換 re-export にする。既存 3 worker は遅延・逐次開始の静的型付き表にし、CI は同じ contract glob を実行と両 trigger に使う。

**Tech Stack:** TypeScript、Hono、BullMQ、Vitest、GitHub Actions、Node.js 26.4.0。

**Spec:** `docs/superpowers/specs/2026-11-09-shared-roots-s1-design.md`

## Global Constraints

- 基準は `5d6aafe9e0305be1b1effa004c7cc10d451cff76`。現在の通常動作と失敗・停止時の振る舞いを維持する。
- 履歴として封印された source snapshot や比較証跡は書き換えない。
- 新 handler、scheduler、DI、runtime discovery、重複登録を拒否する runtime 契約、queue options の変更は追加しない。
- 管理対象 10 queue と handoff 判定は worker 登録表から導出しない。
- S2–S5 の領域実装や #176 の完了条件を変更せず、機能完成を主張しない。
- 既存の動作を確認する characterization は変更前に成功することを確認し、意図的に失敗させない。

## Review Focus

- Note 準備が失敗した場合、Role や route の生成前に同じエラーを返す（Step 1）。
- 任意 queue を省略した場合、queue route は存在せず他の route と 404 は維持される（Step 1）。
- 2 番目・3 番目の worker 起動が失敗した場合、開始済み全 worker を待ち元のエラーを返す（Step 2）。
- close が失敗した場合、他の停止を待ちつつ、その worker の idle は呼ばない（Step 2）。
- 新しい contract test の追加・変更は両 trigger と実行の対象となり、無関係な test は除外される（Step 4）。

---

### Task 1: 共有 root を一つの前提変更として整理する

**Files:**
- Create: `packages/backend-next/src/composition/http-app.ts`, `packages/backend-next/src/composition/note-routes.ts`, `packages/backend-next/src/composition/queue-workers.ts`
- Modify: `packages/backend-next/src/composition/note-http.ts`, `packages/backend-next/src/processes/http.ts`, `packages/backend-next/src/processes/worker.ts`, `.github/workflows/test-backend-next.yml`
- Test: `packages/backend-next/test/unit/composition/http-app.test.ts`, `packages/backend-next/test/integration/http-app.test.ts`, `packages/backend-next/test/unit/composition/queue-workers.test.ts`, `packages/backend-next/test/unit/worker-startup.test.ts`

**Interfaces:**
- Consumes: `createBackendHttpApp(resources: RuntimeResources, config: RuntimeConfig, queueApi?: Hono)`、既存 worker starter と `QueueName`。
- Produces: 同じ signature の `createBackendHttpApp` を `http-app.ts` と旧 `note-http.ts` から公開。`queue-workers.ts` は `type WorkerStop = () => Promise<void>` と `type WorkerStarter = { readonly name: QueueName; readonly start: () => Promise<WorkerStop> }` を使う静的 readonly 3 要素の表を作る。Note 準備・登録および lifecycle helper の具体的 signature は既存依存を狭く受け渡すものとする。

- [x] **Step 1: HTTP の現状を固定し root を抽出する。** 新 root の観測テストで Role・Actor・Note delete/show/create の到達、queue あり／なし、未知 route 404、代表的な認証エラー・preflight・headers を確認する。準備 failure を注入し同じエラーが Role 生成前に出ること、準備→Role→Actor→delete→show→create→queue の順序を記録して確認する。既存入口で先に実行可能な characterization を書き、現状で PASS させる。次に Note 準備と route 登録を `note-routes.ts`、root を `http-app.ts` に移し、`note-http.ts` は root の再 export のみ、process は新入口を import する。新 root を同じテストで検証し、Role の Hono をそのまま使う。

- [x] **Step 2: worker lifecycle を固定し静的表へ抽出する。** fake starter と stop で、呼び出し前に生成されないこと、`endedPollNotification`→`userWebhookDeliver`→`deliver` の逐次開始、2 番目と 3 番目の起動失敗、cleanup 自体が失敗しても元エラーを返すことを確認する。通常停止で全 stop が並行開始され全結果を待つこと、webhook・deliver の close 成功後のみ idle が呼ばれることも確認する。現状で観測できる characterization を先に PASS させ、既存の生成処理を遅延 `start` に移す。`Promise.allSettled`、cleanup logging、既存 handler/options/handoff は維持する。

- [x] **Step 3: CI の一覧を揃える。** `.github/workflows/test-backend-next.yml` の両 paths で個別 test 指定を `scripts/*-contract*.test.mjs` に置換し、`scripts/backend-contract-inventory*.mjs` は残す。inventory test の個別実行を削除し、`node scripts/backend-contract-inventory.mjs --check` を独立して残す。残る contract test コマンドを `node --test scripts/*-contract*.test.mjs` にする。

- [x] **Step 4: glob と trigger の境界を検証する。** Node 26.4.0 の shell で `printf '%s\n' scripts/*-contract*.test.mjs` が `backend-contract-inventory`、`note-contract-fixtures`、`note-contract-posting`、`note-contract-review`、`remote-user-contract` の各 `.test.mjs` を各 1 回だけ出すことを確認する。`bash -c '[[ scripts/future-contract-extra.test.mjs == scripts/*-contract*.test.mjs && scripts/check-dts.test.mjs != scripts/*-contract*.test.mjs ]]'` が exit 0 で、両 paths が同一 glob を持つことを確認する。続けて `node --test scripts/*-contract*.test.mjs` と `node scripts/backend-contract-inventory.mjs --check` が成功すること。

- [x] **Step 5: 近傍と終了条件を検証する。** repo root から `pnpm --filter backend-next... build`、`pnpm --filter backend-next... typecheck`、`pnpm --filter backend-next test test/unit/composition/http-app.test.ts test/unit/composition/queue-workers.test.ts test/unit/worker-startup.test.ts test/unit/job-queue/retention.test.ts test/unit/job-queue/handoff.test.ts test/unit/job-queue/deliver.test.ts test/unit/job-queue/ended-poll-notification.test.ts test/unit/job-queue/user-webhook.test.ts` を実行し成功を確認する。専用分離 DB・Redis 等が利用可能なら README に従い `test:integration` の新 HTTP root・note-create/show/delete・activitypub-actor・queue-admin/retention/handoff、`test:acceptance` の role-http、build 後の `test:process` の children・role-http・queue-handoff・poll-ended を実行する。利用できなければ未実行と理由を記録する。変更対象の package root で ESLint `--quiet`、`node scripts/check-spdx.mjs`、locale safety を確認し、PASS / FAIL / SKIPPED として報告する。対象外変更を混ぜず、CHANGELOG は編集しない。


## 子 worker 実装時の検証記録（履歴・2026-11-09）

- Step 1: 旧入口の characterization 2 件と旧 worker の 5 件を抽出前に PASS。抽出後の最終近傍 unit は 8 files / 147 tests PASS。新 root は旧入口との関数同一性、登録順、Note 準備失敗前後、Role エラー、各 route・queue 有無を確認した。
- Step 2: 実 handler/starter/lifecycle を通す worker test 9 件で逐次開始、2/3 番目の失敗、cleanup エラー、全停止待機、障害通知、webhook/deliver の close→idle と close 失敗時の非待機を確認。static table の無起動生成も別 unit で PASS。
- Step 3: 両 trigger の同じ glob、単一実行、inventory generator trigger と独立 --check の維持を確認。
- Step 4 は未完了: shell glob の現行 5 ファイル各 1 回、将来命名例・対象外境界は PASS。root contract は 3 files PASS / 2 files FAIL（子プロセス EPERM）、inventory --check も spawnSync git EPERM。契約や履歴 snapshot は変更していない。
- Step 5 は未完了: build/typecheck、変更 TS 10 ファイルの quiet ESLint、tracked SPDX CI 3240 ファイルと task-owned 新規 TS 7 ファイル、locale safety、diff --check は PASS。通常 SPDX/shipping は user untracked の内容を読むため未実行。実依存 integration は指定ポートへの connect EPERM で検証不能となり中断。acceptance/process は controller に残す。実行 Node は 24.20.0、指定 26.4.0 は未確認。
- 詳細な実行・制約・判断は `/tmp/tiramiss-s1-implementation.md` に記録。独立レビューおよび controller 検証の成功は主張しない。#176 の機能完成を意味しない。

### Fixture 修正時点の controller 記録（履歴・2026-11-09）

- 親環境 Node 24.20.0: root contract 5 files / 95 tests PASS、build/typecheck PASS、full unit 82 files / 2786 tests PASS、Role acceptance 1 file / 60 tests PASS、native process 4 files / 24 tests PASS。glob・両 trigger・inventory 設定の assertions PASS。
- 親の実依存 integration 8 files / 201 tests は 200 PASS / 1 FAIL。新 HTTP fixture の MiMeta は既定 federation `none` のため Actor は 403 を返し、期待 301 と不一致。単独診断でも再現した。fixture に `all` を明示し、期待値と policy は維持した。修正後の 8 files 再検証は controller 待ち。子環境の socket/subprocess EPERM はこの実際の失敗と別。
- 親の公式 Node 26.4.0 実行ログでは root contract 95 PASS、inventory --check OK。Step 4 の残る Node 26 shell 境界確認は記録待ちのため未完了とする。Step 5 も修正後の integration と最終検証待ち。既存 pg concurrent-query deprecation warning は残る。
- 静的な明示登録は新 worker の自動発見や登録漏れの実行時検知を保証しない。


## Controller 最終検証（2026-11-09）

- Step 4 PASS: 公式 SHA256 と照合した Node 26.4.0 で契約 5 files / 95 tests、inventory `--check` が成功。Node 26 を PATH に置いた shell でも現行 5 ファイルが各 1 回、将来の契約名を対象・check-dts を対象外と確認した。両 trigger と実行コマンドの一致は YAML を読み込んで検査した。
- Step 5 PASS: Node 24.20.0 / pnpm 12.9.1 で全 unit 82 files / 2786 tests、修正後 integration 8 files / 201 tests（41.88 秒）、Role acceptance 1 file / 60 tests、native process 4 files / 24 tests（103.74 秒）が成功。build/typecheck、変更 TS 10 ファイルの quiet lint、通常 SPDX 3247 ファイル、locale safety、diff 検査も成功した。製品ファイル 6 件は fixture 修正前後で同一であり、unit・acceptance・process の実測対象と一致する。
- 独立した全差分レビューと修正差分レビューのコード品質判定はともに APPROVE。レビュー時点で保留だった Node 26 の検査と修正後 integration は上記の実行で解消した。CodeRabbit の最終結果は PR 説明へ記録する。
- 子の EPERM と、親で見つけた fixture の 403/301 不一致は上記履歴に保持する。成功結果へ読み替えていない。既存の pg concurrent-query deprecation warning も観測した。runtime 全体を Node 26 で測定したという主張ではない。
- `/tmp` の実行ログはこのセッションの一時資料で、公開・永続保存された証拠ではない。再実行対象は本計画とコミットするテストを参照する。#176 の完了判定は今回の対象に含めない。
