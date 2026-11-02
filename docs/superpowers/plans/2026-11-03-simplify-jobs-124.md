# 独自PGジョブ基盤の削減 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** PG通知本体を保持し、通常起動に未接続の独自ジョブ/AP実行プロトコルを撤去する。

**Architecture:** 通知は業務側で決定したplain recordをcaller-owned transactionで保存する小さい窓口にする。旧migrationは保持し、新migrationで未解決の仕事を検査して不要内部状態を廃止する。実ジョブが必要になるまで代替dispatcherや未使用のBullMQ handlerを作らない。

**Tech Stack:** TypeORM / PostgreSQL、既存Hono / InversifyJS / BullMQ。

**Spec:** [最小契約](../../backend-next/posting-contract.md)、[GOALS](../../backend-next/GOALS.md)、[ROADMAP](../../backend-next/ROADMAP.md)。#124 / #127 の直後削減工程。

## Global Constraints

- PG通知保存の承認を維持。通常保持・既読・配信・Redis既存通知移行は #173/#177 へ残す。
- public schema・本家同期対象・マージ済みmigrationを編集しない。稼働DBへ実行しない。
- 未完了/結果不明/失敗の仕事を無条件破棄しない。完全停止・バックアップ・専用Redis queue確認を手順にする。
- 保存adapterだけで通知機能、worker lifecycleだけでジョブ移植を完了扱いしない。

## Review Focus

- 旧通知の全業務列とpublicデータがup/downで維持されること。
- expiredやfailedの仕事を完了扱いせず、拒否時にDDL/履歴変更を残さないこと。
- 並行通知の保持とflushが受信者単位で整合し、別受信者を削除しないこと。
- rollbackはschemaを戻すだけで削除済みprotocol履歴を復元しないことを説明すること。
- 宛先選定の本家規則を旧snapshotの追加保証と取り違えず後続へ残すこと。

## Task 1: 通知保存の独立と旧実行コードの撤去

**Files:** `modules/notification/public.ts`、`platform/database/notification/{schema,persistence}.ts`、`platform/database/{data-source,migration-sources}.ts`、旧 `modules/post-work` / `platform/jobs` / `platform/database/{post-work,ap}`、専用tests/helper、package.json/lockの未使用BullMQ依存。

**Interfaces:** `PostNotification` plain record（id/recipientId/type/notifierId/noteId/targetNoteId/createdAtMs）、`PostNotificationPersistence.save(manager, notification): Promise<void>`、`flush(manager, recipientId): Promise<void>`。認可・通知条件・ID/時刻決定は呼出側。

- [x] 実DBで5種類のbody、transaction rollback、並行保持/flush、同時刻の順序、受信者分離を新interfaceで検証。旧interfaceに対しREDを確認。
- [x] claim/effect/容量なしでinsert/保持/flushを実装。受信者lockは保持の競合調停に限定。
- [x] 独自request/dispatch/local claim/AP snapshot/page/hostのコードと専用テストを削除。歴史migration6個は元のパス/内容で維持。
- [x] AP条件/recipe/重複排除は固定本家ソースと既存N0 fixtureを参照する引継ぎを残す。未接続の選定関数を先に実装しない。

## Task 2: 検査付きschema廃止と引き継ぎ

**Files:** 新 `platform/database/retire-durable-work-migration.ts`、登録先、`test/integration/retire-durable-work.test.ts` / `migrations.test.ts`、README/ROADMAP。

**Interfaces:** 新migration `up(QueryRunner)` / `down(QueryRunner)`。upはlock→未解決state件数検査→9表と通知課金列の削除。downは歴史DDLで空の旧schemaを再作成し、既存通知の課金を再見積りする。

- [x] 旧6migrationのDBから通知/完了済履歴をseedし、通常migrateでbody保存・不要表削除・public不変・2回目適用なしを検証。未実装の削除に対してREDを確認。
- [x] request非settled、item非成功/抑止/取消、未解放dispatch、control予約/復旧中、host ownership、非完了recipientを拒否。期限切れも拒否し、失敗時の全データ/履歴維持を実DBで検証。
- [x] down/upを検証。元protocolデータの復元にはバックアップが必要と明記。旧schema再生成で通常通知bodyを失わない。
- [x] READMEから撤去済手順を除き、残ジョブの診断と手動確認・旧専用Redis namespaceの扱いを書く。
- [x] build/typecheck/unit、全integration、Role acceptance、process、migrate/check-migrations/check-schema、shippingを実行。
- [ ] 独立レビューを受け指摘を修正し再レビューで収束。PR作成・#114/#124/#127/#177の現在欄更新。次は #170。

## 判断と検証記録

- 方針は既承認の最小契約の具体化。新しいユーザー判断を要する保存先変更はない。
- 比較案: 旧protocolを保持すると初期目的に不要な相互依存が残る。通常workerを先に作ると未使用jobが増えるため、通知を直接保存へ切り離し、実jobは必要機能と一緒に導入する。

- 基準: develop `9af50d3274e24f36be1e7626e43c5eaaa2577540`（PR #212マージ済み）。ブランチ `refactor/backend-next-simplify-jobs-124`。
- RED: 新通知interfaceの11テストがsave未実装で失敗、削減21テストが表の残存/拒否なしで失敗。GREEN: migration/通知/既存履歴の3ファイル43件成功。
- PASS: build/typecheck、unit208、integration136、Role受け入れ63、process23、固定fixture8。専用Compose `simplify-jobs-124`（PG55124/Redis56124）でCLI migrate/check-migrations/check-schema成功、schema差分0。
- PASS: 変更9ファイルlint、SPDX2986、locale/diff、変更Markdown4ファイルのローカルリンク。既存pg concurrent-query deprecation警告は残る。
- 独立scope監査でAP direct欠落/relay別payloadを確認し引継ぎに反映。新contextの全差分レビューでは具体的不具合なし。CodeRabbitは別途実行中。
- 判断: 通知schema変更と旧Entity削除は新migrationと同じcommitへまとめ、動作しない中間版を作らない。通常worker/AP/通知機能は未接続のままであり、完了とみなさない。
- 旧backendのmeta/paramDef/resと自動生成型は変更なし。misskey-js生成は対象外。本家同期対象と歴史6migrationは差分なし。新パッケージのschema/migration検証を実施し、旧backendの検査を代用しない。
- 次の作業: 削減PRマージ後に #170。#124は署名HTTP/通常worker/retry・管理等の実接続が残るためcloseしない。#177の閲覧/既読/既存Redis移行も残す。#206は保留。
