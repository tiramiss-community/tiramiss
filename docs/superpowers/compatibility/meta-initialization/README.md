# Meta 初期化と終了の限定証明 (#574)

固定本家 `8e07cf085adf7009583d234a208e30436f020e26`、実装基準 `fec2ca0f3c012a8d4491ec2327906b7d34a68b35`。親 #138 / 全体 #114 は未完了。#317 はマージ済みであり、棚卸し時の「現在のDB直読」は歴史的説明である。現在のactor・WebFinger・配送は #317 の `resources.meta.fetch()` を使う。一方で他の業務callerにはDB直読が残る。

既存の `readMeta`、cache、ResourceScopeを再利用し、通常HTTP/workerの共通process lifecycleでmigration履歴検査の後・役割開始の前にMeta取得を待つ。Meta upsertの複製、cache所有権移動、初期化専用transactionは追加しない。直接の `connectResources` と軽量CLIは従来どおりで、過去のreceiptや期待値を再生成しない。

| 契約 | 固定本家の観測 | 新実装の証拠 |
| --- | --- | --- |
| 空DB・同時初期化・既存行維持 | GlobalModule `$meta` factoryのempty/concurrent/existing-preserved | 既存 `test/integration/meta.test.ts` の実PG 8並行・id=x一行・列既定・既存x維持 |
| 複数既存行のid降順 | factoryのdescending-id、#317 sourceのnewest-id | 同ファイルでa/singleton/bの先頭選択 |
| 更新後参照 | MetaService.updateのDB更新→metaUpdated before/after、およびGlobalModuleの通知反映 | #317 `test/integration/meta-cache.test.ts` の実Redis envelope→listening HTTP/配送/actor登録。今回は同じ既存試験を再実行する |
| 開始済み取得→DB/Redis解放 | GlobalModule.disposeのtracker待機→DB/Redis解放 | 新 `test/integration/meta-initialization.test.ts` の実PG table lock、pg_locksによる待機確認、close中のDB SELECT/Redis PING、解除またはpg_cancel_backend後の解放 |
| 初期化失敗 | factory reject・subscriber未登録 | 新結合試験の42P01反復reject・復旧後初期化、新process試験の通常HTTP/worker entrypoint→startup.failed/exit1/no-ready・実接続消失、同時起動のempty/existing/multiple成功 |

`source-probe.mjs`は固定GitオブジェクトからGlobalModuleのprovider/disposeとMetaService.updateを文字通り抽出する。Repository・transaction・pubsub・trackerはdouble。8観測は本家full serverや本家実PGの測定ではない。初期化の実競合は新実装の実PG試験が担う。管理更新のsource観測は `name` 更新に限定し、hiddenTagsの副作用は含まない。

本家GlobalModuleは起動時にMetaを確保する。R2では通常HTTP/workerも既存migration guardの後にMetaを取得し、成功前に役割開始・ready通知へ進まない。失敗時は既に登録したresources cleanupへ戻る。通常のstartup timeoutとrunChildを通し、初期化中の独自transactionや特別なready経路は追加しない。通常2役割の実PG同時起動で空DBのid=x一行と既存行不変、欠損Meta表で両役割のexit1/no-ready・実PG/Redis接続消失を確認する。R1の人工fixtureは削除し、当時のfixture-only測定と未達条件は `evidence-r1.json` に原本のまま保持する。boot責任14は、この起動時確保とレース安全な既存upsertの範囲でverifiedとする。

#317のcacheは温まった値をDB更新のみでは変更せず、通知の `body.after` を使用する。noCache/5分周期はDBを読む。既存のsource9観測と実PG/Redis/HTTP試験がこの差を示す。#574の新sourceは本家update producerのenvelopeを確認し、新しい管理APIは実装しない。admin/update-meta全体は #448、producer/他cacheは各担当に残る。boot責任35も管理更新全体の完成とはせずpartial、空Meta作成のinstance責任02だけをverifiedとする。

本家disposeのtracker待機と新runtimeのcache pending drainは異なる所有境界である。終了の順序を実依存で比較したのであって、あらゆるDB操作の追跡、全プロセスIPC、期限超過、管理API全体の完成は主張しない。既存 `children.test.ts` を同じ測定で再実行し、通常entrypointのready/依存障害/期限付き停止を別の根拠として保持する。

```sh
export PATH=/tmp/tiramiss-s1-node26/bin:$PATH
export BACKEND_NEXT_TEST_DB_PORT=55574 BACKEND_NEXT_TEST_REDIS_PORT=56574
docker compose -p backend-next-574 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-upstream build
pnpm --filter backend-next build
pnpm --filter backend-next typecheck
pnpm --filter backend-next test test/unit/meta-cache.test.ts test/unit/lifecycle.test.ts test/unit/worker-startup.test.ts
pnpm --filter backend-next test:integration test/integration/meta.test.ts test/integration/meta-cache.test.ts test/integration/meta-initialization.test.ts
pnpm --filter backend-next test:process test/processes/children.test.ts test/processes/meta-initialization.test.ts
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned/git-objects node docs/superpowers/compatibility/meta-initialization/source-probe.mjs
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned/git-objects node docs/superpowers/compatibility/meta-cache/source-probe.mjs
node --test scripts/meta-initialization-proof.test.mjs
node scripts/check-shipping.mjs --base fec2ca0f3c012a8d4491ec2327906b7d34a68b35
docker compose -p backend-next-574 -f packages/backend-next/compose.test.yml down
```

[evidence.json](evidence.json)へ今回の有限入力と実行logのhash・件数を記録する。入力はそのファイル単位で照合するが、inventoryは所有する3契約/3監査IDだけを検査する。他Issue行のlive hashを固定しない。R2のruntime変更で影響する旧receiptには `lifecycle-predecessor.json` の1pathだけを新しい末端readerから投影する。既存emoji leafの非所有path fallbackだけへ接続し、lifecycle以外は通常のlive readを返す。固定した有限入力・旧bytesを検査し、599のraw provenanceと同一scope内JSON再検査を維持する。旧receiptのhash/件数/測定成功を変更しない。#317の実測は[元の資料](../meta-cache/README.md)に保持する。

## R1 実測（2026-11-16、履歴）

Node26.4.0、専用Compose `backend-next-574`（PG55574/Redis56574）。製品コード変更なし、proof commit `3a13df3d7ce0bcbc7faeac3a8caeff5030c0b4b1` と23有限入力を測定前後で照合し、差分なし。upstream/next build・next typecheck、cache単体3件/1file、実PG/Redis/HTTP結合11件/3files、既存children+明示startup consumerのprocess14件/2files、本家source8観測と既存cache source9観測がPASS。全件0失敗/0skip。この範囲に全suiteや本家full serverの成功を含めない。

初期の開発測定では共有依存のNode ABI不一致・古いupstream build、試験fixtureのlock観測条件・閉鎖待機のpolling・port0設定・既存loggerのsanitized出力前提を修正した。成功R1へ過去の失敗を混ぜず、開発logは `/tmp/tiramiss-574-*-dev*.log` に保持する。製品の変更や新しいeager初期化保証で解消したものではない。既存pg query deprecation warningは残る。CodeRabbit CLIはprerequisiteから `~/.coderabbit/logs` への書込みがEROFSで実行不能だったため、review合否は本測定から主張しない。

## R2 通常起動の修正と実測（2026-11-16）

独立レビューP2で、R1のfixture-only試験が通常起動の完了条件を満たしていないと確認した。通常のbuilt HTTP/workerへ置換したREDでは両役割がMeta欠損のままreadyを返し、空DBの同時起動もMeta未作成で失敗した（3失敗/2成功、`/tmp/tiramiss-574-r2-red-process.log`）。共通lifecycleのmigration guard直後へ既存Meta取得のawaitを1行追加し、role開始前の失敗を既存cleanupへ接続した。人工fixtureを削除し、直接connectResources・軽量CLIの契約は維持する。

製品commit `1346a975b1a9121359191e32998d5db0969b55e5` のR2ではbuild/typecheck、単体20件/3files、実依存11件/3files、通常process18件/2files、固定source8+9観測がPASS、0失敗/0skip。測定前後の27有限入力に差分なし。`r2-inputs.json` は24入力を固定し、自身のsealを持つleafを含めない。後続のcurrent proof integrityは24入力にleaf/binding/predecessorの3ファイルを加えた27入力を検査する。leafのsealは測定前に確定し、測定後に書き換えていない。独立に進む #556 との合成を許すため、既存emoji readerの全ファイルhashは固定せず、lifecycleだけのfallback接続をレビュー対象とする。

R1原本receiptを `evidence-r1.json` に保持する。R2の成功でR1の失敗条件・fixture-only範囲や旧receiptを上書きしない。管理API #448、全backendの配布・起動責任 #138 と親 #114 は未完了。ユーザー影響候補: 通常HTTP/workerはMeta初期化に失敗した場合にreadyを通知せず起動を終了する。

R2の有限proof・既存emoji/599 scope・影響するprofile/WebFinger/follow-collectionsの対象root検査は7files/149件がPASS。変更4ファイルのquiet lint・SPDX・locale safetyとinventory生成整合もPASS。これらの後続proof検査を製品runtimeの実測件数へ加算しない。
