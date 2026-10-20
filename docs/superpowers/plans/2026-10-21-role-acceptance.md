# Role Acceptance Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user authorized implementation, PR creation, and independent review until findings converge.

**Goal:** #121のRole受け入れ条件を再実行可能なテストと専用CIへ揃える。

**Architecture:** 既存の評価・更新・HTTP・キャッシュの境界を維持する。実トークンのTCP HTTPから保存・監査・DB材料を使う次操作の評価へ接続する。停止注入はテスト子プロセス、時計制御は材料の既存注入口に限定する。

**Tech Stack:** TypeScript, Vitest, PostgreSQL 18, Redis 8, Hono, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-17-role-compatibility-contract.md`, Role詳細設計§4、全体設計§14.1。

## Global Constraints

- 本家比較元 `8e07cf085adf7009583d234a208e30436f020e26` を固定。旧backend・managed Entity/migrationを変更しない。
- 確認専用API、永続通知ジョブ、Redis障害時のDB縮退を追加しない。
- 認可はtx内DB、監査は更新と同時確定。commit結果不明を自動再実行しない。
- 専用Compose `role-121-test`（55121/56121）。本家再実行も専用 `role-116-reference` の固定ポートを事前確認し分離する。
- 通常CIは固定期待値を使用し、本家サーバーを毎回起動しない。

## Review Focus

- HTTP updateが確定しても温まった別接続の材料が古いままになる: 次操作の評価で通知反映を確認。
- 操作内メモへリモート通知が過剰に侵入する: 既存境界の結果は維持、新境界は新材料を使用。
- commit直後の停止で通知を失う: 実子を通知前に停止し、保存維持とTTL期限ちょうどの回復を確認。
- API応答だけ成功して監査・認可が接続されない: 実CHECK失敗のrollbackと自己昇格拒否をHTTPから確認。
- 共通期待値だけの変更がCIを通らない: workflow pathに比較資料を含め、意図的差異をJSONから両endpointへ接続。

### Task 1: HTTPからポリシー評価までの受け入れ検証

**Files:** `test/helpers/role-evaluation.ts`, `test/integration/role-acceptance.test.ts`, `docs/superpowers/compatibility/role/policy-flow-cases.json`, `reference-role.e2e.ts`, `test/integration/role-http.test.ts`。

- [x] 共通の順次更新期待値を作り、HTTP更新後のローカル/別接続の新操作、継続中メモ、保存済み監査をassertする。
- [x] HTTP監査保存失敗と自己昇格拒否を追加。既存の実DB競合・COMMIT不明検証は対応表で接続する。
- [x] 固定本家probeへ同じ順次更新期待値とDB材料からの本家ポリシー計算を接続して再実行する。
- [x] intentional-http-cases.jsonをshow/update両方のテストから読む。

### Task 2: 通知前停止と実材料の寿命

**Files:** `test/fixtures/role-before-publish.mjs`, `test/integration/role-acceptance.test.ts`。

- [x] HTTP更新のcommit後にpublishをIPCゲートで止めるテスト子を起動する。
- [x] 親がゲートを観測してSIGKILLし、role/auditが残り、通知なしで古い材料を参照できることを確認する。
- [x] 同じ操作のメモと新操作の期限跨ぎを分け、TTL直前は旧値、期限ちょうどは新値。割り当て期限等号の失効と保存行維持も実DB材料で確認する。

### Task 3: CI、受け入れ記録、独立レビューとPR

**Files:** `.github/workflows/test-backend-next.yml`, `packages/backend-next/{package.json,vitest.acceptance.config.ts,README.md}`, 比較README。

- [x] acceptanceを専用コマンド/CI stepにし、integrationの二重実行を避ける。同期・migration・processの既存項目を維持。
- [x] fixture-only変更でもworkflowが起動するpathを追加。
- [x] 本家比較/意図的差異/注入の限界/各条件とテストの対応を記録。
- [x] build/typecheck、単体、結合、acceptance、process、shippingを実行。
- [x] 別エージェントレビュー、指摘修正と再レビューを未解消指摘がなくなるまで実施。
- [ ] commit/pushして#121を閉じるPRを作成（mergeは行わない）。

## Execution record

- cleanなdevelop `e2e3257213095559279b39c4c4934e514df7a8ae` から専用ブランチで作業。別worktreeは増やさず現在のcheckoutを使用。
- Task 1/2: 製品の変更なしで5つの新規受け入れテストがPASS。入力fixtureを本家HTTP probeへも接続し34件PASS。新機能の実装ではなく既存保証への接続テストなので、製品コードを故意に変えてREDを作っていない。
- Task 3: acceptanceを専用コマンドへ分離。既存integration globから2ファイルだけ除外し、CIに必須step追加。fixture-only変更も起動対象。
- source1328ファイルの本家SHA照合、本家全migration・既存unit47・追加unit36・HTTP34・probe lintはPASS。
- 新実装sync/test（upstream3）、build/typecheck、unit158、integration38、acceptance63、process20、shippingはPASS。証跡と注入の範囲は比較READMEへ記録。
- 独立レビュー初回: Minor1件。本家probe末尾のpadded-blocks違反で実際のlintが失敗していたため空行を削除。固定本家HTTP34件とprobe lintを再実行してexit0、新実装acceptance63件とshippingも再実行PASS。本家flowの初期状態も前のtestに依存しないよう自身でreset/assignment投入し、両実装で更新前false/55をassertした。
- 再レビュー: 未解消Critical/Important/Minor 0件。レビュアー独立実行でもacceptance63件と本家probe lintはPASS、共有fixture/probeの複製一致を確認。
