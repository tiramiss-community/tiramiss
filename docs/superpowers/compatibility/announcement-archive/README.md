# お知らせ期限アーカイブ (#449 / #450)

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `AnnouncementService.onModuleInit/archiveAnnouncement`、`QueueService.scheduleAnnouncementArchive` と `ArchiveAnnouncementProcessorService.process` を対象とする。

通常の各HTTP/worker子でmigration履歴とMetaの初期化を確認した後に、activeかつ日時があるお知らせのID/日時だけを取得し、system queueへ予約を復元する。workerは `archiveAnnouncement` の名前だけを登録する。ID、active、保存済み日時との一致、期限到達の4条件を一つのUPDATEで照合し、成立時だけisActiveとupdatedAtを更新する。日時変更前のジョブ、削除済み、無効化済み、重複実行は更新しない。

予約IDは本家と同じ `archiveAnnouncement-${announcementId}-${autoArchiveAt.getTime()}`。待機/遅延/実行中の同じ予約は保持し、completed/failedの同じIDは削除して投入し直す。attemptsは本家と同じく追加しない（既定1試行）。保存済みジョブのattempts指定と管理経由のretryはBullMQが扱う。成功7日/30件、失敗7日/100件の保持も同じ。system workerは本家と同じ既定concurrency=1、limiterなし。

## 比較と検証

[今回の実測・入力hash・失敗記録](runtime-evidence.json)は実装revisionへ固定する。共有比較記録の移行前チェック失敗を、製品テスト成功と区別する。

- [corpus.json](corpus.json) / [observations.json](observations.json): 固定時刻の実PostgreSQLで9ケース（期限前/境界/期限後、日時変更、無効化、日時取消、別ID、削除、重複）を比較。更新結果とupdatedAtを保存する。
- [source-probe.mjs](source-probe.mjs): 固定本家の元メソッドをASTからそのまま抽出し、実DB/Redisへ接続。起動予約復元・重複抑止・job ID/日時/遅延/保持を観測し、本家processorを実BullMQ workerで実行してcompleted/failedからの再投入を確認する。NestのDI・loggerの組み立ては置換する。新実装から期待値を作らない。
- 新実装のintegrationは同じ9ケースと予約観測を照合し、組み立てた資源とstartQueueWorkersで期限遅延、日時変更/取消/削除、重複、並行UPDATE、DB失敗後の明示retry、completed/failed再投入、RedisのEVAL/EVALSHA拒否による投入失敗と次回起動の復元を確認する。
- process試験は通常 `built/entrypoints/worker.js` の起動、保存済み期限、停止、予約喪失後の再起動復元を確認する。HTTP/workerに未適用migrationがあると予約を投入せず終了し、DBで復元SELECTが停止しても既存の子起動期限内で終了する。既存queue-runtimeとSupervisorの停止/障害試験も実行する。

再実行はREADMEの専用Composeを使い、並行実行では `BACKEND_NEXT_TEST_DB_PORT` / `BACKEND_NEXT_TEST_REDIS_PORT` を分ける。

```sh
pnpm --filter backend-next... build
node docs/superpowers/compatibility/announcement-archive/source-probe.mjs
pnpm --filter backend-next test test/unit/announcement-archive.test.ts
pnpm --filter backend-next test:integration test/integration/announcement-archive.test.ts
pnpm --filter backend-next test:process test/processes/announcement-archive.test.ts
```

観測JSONの更新はsource-probeへ出力先を明示する。CIは保存済み観測を使うので本家Git objectを必要としない。source-probeの再実行には固定本家のGit objectが必要。

## 境界と残責任

本家のフルNest起動/e2e全体は測定していない。sourceは元メソッド＋実PG/Redis/BullMQ worker、新実装は通常資源起動/worker entrypointの検証である。共有DBテーブル・migrationは変更しない。全Redisデータの再構築保証は追加しない。

保存済みの本家numeric timestamp payloadを受理する。不正payloadは新実装の `INVALID_JOB_PAYLOAD` 診断で失敗ジョブとして保持する。本家のORM/日時変換由来の診断文まで同一とはしない。

systemの未移植名はデフォルトhandlerで処理しない。通常workerは本家同様に未知名を失敗として保持するため、未移植jobを含む共有Redisで起動してよい意味ではない。停止下引継ぎ検査は引き続きsystem queueを保守的に拒否し、他system handler・9 scheduler・正式なpayload引継ぎは #199/#200/#526 に残す。切替前の検査を迂回しない。

存在確認と状態確認の間に予約が削除された場合の`unknown`判定も本家を維持する。次回復元まで予約がなくなる競合は [UF-016](../../../backend-next/upstream-findings/packages/backend/src/core/QueueService.md) に記録した。

管理CRUDと変更取消への接続は #194、未読API等の既存比較は [announcements](../announcements/README.md) に残す。#193/#199/#114全体の完成や本番切替を意味しない。
