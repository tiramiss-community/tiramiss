# DB timeout・int8・nullish WHERE の限定比較（#567）

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `packages/backend/src/postgres.ts` に合わせ、通常の DataSource に statement timeout 10秒、`db.extra.statement_timeout` の上書き、scalar int8 の `Number` 変換、null/undefined WHERE 条件の無視を接続した。`0` は timeout 無効として維持する。scalar の安全整数外での丸めと、int8 配列が文字列配列のままである点も本家と一致する。

既存の起動期限による `connectionTimeoutMillis` の設定は維持する。通常起動の schema 同期・dropSchema・自動 migration は追加しない。replica・query cache・低速 query 診断は本 slice の対象外で、#567 は未完了。#138/#114 や全バックエンドの完成を意味しない。

## 独立した source と通常経路

[test fixture](../../../../packages/backend-next/test/fixtures/database-options/postgres.ts.txt) は固定本家ファイル全体のバイト複製で、SHA-256 は `c6879b6b23c5fb1e7518ff0eaa02397791470732389954648f42ab13c0eaaa74`。[source helper](../../../../packages/backend-next/test/helpers/pinned-database-source.ts) は hash を確認し、本家の factory と parser 登録文を抽出して実行する。factory のロジックを期待値から作り直さない。

外部 binding は実 TypeORM 1.1.1・pg 8.23.1（ともに固定本家と同版）、同期済み Entity の登録済み subset、非 test の env、SQL logging 無効を与える。本家 factory の `db.disableCache: true` を指定し、本家 test 専用の schema drop と比較対象外の Redis query cache を起動しない。プロセス全体の `NODE_ENV` は変更しない。本家 full server・MetaService・HTTP と新旧比較した記録ではない。

両 factory は専用 PostgreSQL 18.6 のランダム名 DB に接続し、実 SQL の次を同じ literal 期待値と照合する。

- 既定10秒の query cancellation（SQLSTATE `57014`）と直後の接続再利用。
- `db.extra` の timeout `0` / 25ms と `application_name` の実効値。
- int8 の上下限・安全整数外・配列・`count(*)`、通常 `readMeta` の bigint フィールド。
- null/undefined 条件の読取と ID で限定した更新、明示的 `IsNull()`。
- transaction 内 INSERT 後の timeout が成功値を返さず、行を rollback し、次 transaction が成功すること。
- 誤 password による接続失敗（`28P01`）が未初期化のままであること。

新実装については通常の YAML `db.extra` → `loadConfig` → `connectResources` を通し、既定と250ms上書き、共有 Meta cache の初回 DB 読取からの数値を確認する。既存の transaction・Meta・通常 listening HTTP URL preview テストも同じ専用依存先で実行した。schema 準備は新実装の通常 migration 入口を使う。COMMIT 応答断や新たな再試行保証は検証・追加していない。

## 実測と再実行

[実測 receipt](runtime-results.json) は入力と実ログの hash を記録する。実装前の近傍単体は3件とも期待した理由（各設定の欠落）で失敗し、変更後は成功した。

- build / typecheck: PASS。
- 新規単体3件を含む全単体: **5,077 PASS / 1 SKIP、147 files**。skip は既存 Page source の外部本家 checkout 未指定によるもの。
- 実 PostgreSQL・Redis: **30 PASS / 4 files**。新規比較18件、既存 transaction 5件、Meta 5件、HTTP URL preview 2件。
- 変更ファイル lint・SPDX・locale safety: PASS。

実 DB 検証中に pg の既存同時 query deprecation warning が出る。失敗・skip はない。広域 unit では既存の失敗注入に伴う WebFinger 診断も出る。

```sh
pnpm install --offline --frozen-lockfile --filter backend-next...
BACKEND_NEXT_TEST_DB_PORT=55675 BACKEND_NEXT_TEST_REDIS_PORT=57675 \
  docker compose -p backend-next-db567 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test
BACKEND_NEXT_TEST_DB_PORT=55675 BACKEND_NEXT_TEST_REDIS_PORT=57675 \
  pnpm --filter backend-next test:integration test/integration/database-options.test.ts test/integration/transaction-runner.test.ts test/integration/meta.test.ts test/integration/url-preview.test.ts
node scripts/check-shipping.mjs --base fe1a8106c3
BACKEND_NEXT_TEST_DB_PORT=55675 BACKEND_NEXT_TEST_REDIS_PORT=57675 \
  docker compose -p backend-next-db567 -f packages/backend-next/compose.test.yml down
```

`--offline` は依存がローカル store に存在する場合に使う。並行実行時は project 名と両ポートを空いているものへ変える。固定 source fixture は Git や別の本家 checkout を必要とせず実行できる。再取得する場合は固定本家 `git show <commit>:packages/backend/src/postgres.ts` と上記 hash を照合する。過去の他機能の実測を今回の30件へ合算しない。

Changelog 候補: DB の既定 query timeout、bigint の数値変換、null/undefined 条件の扱いを本家に合わせる。
