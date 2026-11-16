# 接続事前確認 #577

親 #138 / 全体 #114。基準 develop `8c3f6d51e17a2a2f73c2f2156a384c2519ca21c5`。
`responsibility:critic-r2-002` だけを対象とする。

`check:connect` は通常の設定読取と既存 `createDataSource` を使う独立した管理入口である。
DB と base/pubsub/jobQueue/TL/reaction Redis を並行確認し、省略された用途別設定は base へ戻して同じオブジェクトを一度だけ検査する。
明示的な別オブジェクトは同じアドレスでも別検査となる。HTTP healthz / Meilisearch / migration は対象外。

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `packages/backend/scripts/check_connect.js` は `Set` による同一オブジェクトの重複除外と Redis error/connect の競合を使う。
[source-probe.mjs](source-probe.mjs) は固定 Git オブジェクトとの byte 一致を確認し、import だけを除いたスクリプト本文を実 Redis/PG への明示的な binding で実行する。
[source-observations.json](source-observations.json) の8条件は全成功、DB と Redis 5 用途それぞれの認証失敗、省略時1接続を観測する。
DB binding は空 Entity 集合・無 schema 同期の実 TypeORM 接続であり、本家 config loader・Entity graph・query cache・full server の実行ではない。

本家は `Promise.all` が最初の失敗を返す。新入口はすべての検査を結果へ変換してから待ち、受理した全接続の解放まで完了させる。
診断は固定用途名と真偽だけで、driver 例外本文を出さない。この終了・診断差は #577 の全接続解放と機密非出力条件に従う。
DataSource builder の replica や数値変換等の残互換性は #567、用途別 Redis の通常利用全体は #569、ready は #576 に残る。

実 CLI process 試験は専用 DB に `migrations` と業務用 sentinel を作り、検査前後のテーブル集合・履歴・行・Redis sentinel の同一性を確認する。
各接続の認証失敗と接続拒否を個別に起こし、他の接続が成功すること、終了コード・自然終了・PG セッションと名前付き Redis 接続の解放を検査する。
省略時の重複除外は Redis MONITOR の当該接続名だけを数える（Compose healthcheck の接続は数えない）。jobQueue は別 Redis ポートを使う。
秘密 marker・DB 名を stdout/stderr に出さないことと、不正設定の固定診断も確認する。

```sh
BACKEND_NEXT_TEST_DB_PORT=55577 BACKEND_NEXT_TEST_REDIS_PORT=56577 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56578 docker compose -p backend-next-connect-577 -f packages/backend-next/compose.test.yml up -d --wait postgres redis redis-pubsub
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
BACKEND_NEXT_TEST_DB_PORT=55577 BACKEND_NEXT_TEST_REDIS_PORT=56577 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56578 pnpm --filter backend-next test:process test/processes/connect-check.test.ts test/processes/cli.test.ts
BACKEND_NEXT_TEST_DB_PORT=55577 BACKEND_NEXT_TEST_REDIS_PORT=56577 node docs/superpowers/compatibility/connect-check/source-probe.mjs /path/to/fixed-upstream
node --test scripts/connect-check-package-evidence.test.mjs scripts/video-ingest-contract.test.mjs scripts/cli-package-evidence.test.mjs
```

package 変更は依存や lockfile を変更しない。sealed [package-predecessor.json](package-predecessor.json) と `scripts/connect-check-package-evidence.mjs` は新 script の正確な1行だけを除去し、既存 video → CLI → image 証跡の package 入力へ戻す。
raw current SHA と復元後 SHA の両方を毎回検証し、proof drift と読取後の drift も拒否する。lockfile と他入力は通過する。既存 receipt・proof・実測 log は変更しない。
