# Meta 初期化と終了の限定証明 (#574)

固定本家 `8e07cf085adf7009583d234a208e30436f020e26`、実装基準 `fec2ca0f3c012a8d4491ec2327906b7d34a68b35`。親 #138 / 全体 #114 は未完了。#317 はマージ済みであり、棚卸し時の「現在のDB直読」は歴史的説明である。現在のactor・WebFinger・配送は #317 の `resources.meta.fetch()` を使う。一方で他の業務callerにはDB直読が残る。

既存の `readMeta`、cache、ResourceScope、process lifecycleを変更せず、実依存試験と本家ソース観測を追加する。Meta upsertの複製、cache所有権移動、初期化専用transaction、新しい起動ready保証は追加しない。過去のreceiptや期待値を再生成しない。

| 契約 | 固定本家の観測 | 新実装の証拠 |
| --- | --- | --- |
| 空DB・同時初期化・既存行維持 | GlobalModule `$meta` factoryのempty/concurrent/existing-preserved | 既存 `test/integration/meta.test.ts` の実PG 8並行・id=x一行・列既定・既存x維持 |
| 複数既存行のid降順 | factoryのdescending-id、#317 sourceのnewest-id | 同ファイルでa/singleton/bの先頭選択 |
| 更新後参照 | MetaService.updateのDB更新→metaUpdated before/after、およびGlobalModuleの通知反映 | #317 `test/integration/meta-cache.test.ts` の実Redis envelope→listening HTTP/配送/actor登録。今回は同じ既存試験を再実行する |
| 開始済み取得→DB/Redis解放 | GlobalModule.disposeのtracker待機→DB/Redis解放 | 新 `test/integration/meta-initialization.test.ts` の実PG table lock、pg_locksによる待機確認、close中のDB SELECT/Redis PING、解除またはpg_cancel_backend後の解放 |
| 初期化失敗 | factory reject・subscriber未登録 | 新結合試験の42P01反復reject・復旧後初期化、新process試験の明示startup consumer→startup.failed/exit1/no-ready・実接続消失 |

`source-probe.mjs`は固定GitオブジェクトからGlobalModuleのprovider/disposeとMetaService.updateを文字通り抽出する。Repository・transaction・pubsub・trackerはdouble。8観測は本家full serverや本家実PGの測定ではない。初期化の実競合は新実装の実PG試験が担う。管理更新のsource観測は `name` 更新に限定し、hiddenTagsの副作用は含まない。

本家GlobalModuleは起動時にMetaを確保する。新実装の通常HTTP/workerは遅延取得であり、Meta取得より前にreadyになりうる。新しいprocess fixtureは明示的にMetaを起動中に読む利用者を既存 `runChild` / `startManagedProcess` へ接続し、失敗をreadyに変換しない既存境界を検証する。通常entrypointのeager初期化互換を証明したものではなく、未承認の差異を承認済みとは扱わない。したがってboot責任14はpartialを維持する。

#317のcacheは温まった値をDB更新のみでは変更せず、通知の `body.after` を使用する。noCache/5分周期はDBを読む。既存のsource9観測と実PG/Redis/HTTP試験がこの差を示す。#574の新sourceは本家update producerのenvelopeを確認し、新しい管理APIは実装しない。admin/update-meta全体は #448、producer/他cacheは各担当に残る。boot責任35も管理更新全体の完成とはせずpartial、空Meta作成のinstance責任02だけをverifiedとする。

本家disposeのtracker待機と新runtimeのcache pending drainは異なる所有境界である。終了の順序を実依存で比較したのであって、あらゆるDB操作の追跡、全プロセスIPC、期限超過、管理API全体の完成は主張しない。既存 `children.test.ts` を同じ測定で再実行し、通常entrypointのready/依存障害/期限付き停止を別の根拠として保持する。

```sh
export PATH=/tmp/tiramiss-s1-node26/bin:$PATH
export BACKEND_NEXT_TEST_DB_PORT=55574 BACKEND_NEXT_TEST_REDIS_PORT=56574
docker compose -p backend-next-574 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-upstream build
pnpm --filter backend-next build
pnpm --filter backend-next typecheck
pnpm --filter backend-next test test/unit/meta-cache.test.ts
pnpm --filter backend-next test:integration test/integration/meta.test.ts test/integration/meta-cache.test.ts test/integration/meta-initialization.test.ts
pnpm --filter backend-next test:process test/processes/children.test.ts test/processes/meta-initialization.test.ts
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned/git-objects node docs/superpowers/compatibility/meta-initialization/source-probe.mjs
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned/git-objects node docs/superpowers/compatibility/meta-cache/source-probe.mjs
node --test scripts/meta-initialization-proof.test.mjs
node scripts/check-shipping.mjs --base fec2ca0f3c012a8d4491ec2327906b7d34a68b35
docker compose -p backend-next-574 -f packages/backend-next/compose.test.yml down
```

[evidence.json](evidence.json)へ今回の有限入力と実行logのhash・件数を記録する。入力はそのファイル単位で照合するが、inventoryは所有する3契約/3監査IDだけを検査する。他Issue行のlive hashを固定せず、過去receiptへのsuccessorや再投影を追加しない。#317の実測は[元の資料](../meta-cache/README.md)に保持する。

## R1 実測（2026-11-16）

Node26.4.0、専用Compose `backend-next-574`（PG55574/Redis56574）。製品コード変更なし、proof commit `3a13df3d7ce0bcbc7faeac3a8caeff5030c0b4b1` と23有限入力を測定前後で照合し、差分なし。upstream/next build・next typecheck、cache単体3件/1file、実PG/Redis/HTTP結合11件/3files、既存children+明示startup consumerのprocess14件/2files、本家source8観測と既存cache source9観測がPASS。全件0失敗/0skip。この範囲に全suiteや本家full serverの成功を含めない。

初期の開発測定では共有依存のNode ABI不一致・古いupstream build、試験fixtureのlock観測条件・閉鎖待機のpolling・port0設定・既存loggerのsanitized出力前提を修正した。成功R1へ過去の失敗を混ぜず、開発logは `/tmp/tiramiss-574-*-dev*.log` に保持する。製品の変更や新しいeager初期化保証で解消したものではない。既存pg query deprecation warningは残る。CodeRabbit CLIはprerequisiteから `~/.coderabbit/logs` への書込みがEROFSで実行不能だったため、review合否は本測定から主張しない。
