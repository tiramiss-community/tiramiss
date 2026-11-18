# 低速 query 診断と未使用 query cache の限定比較（#567）

PR #635 マージ後の `706f82eb2086c7364001d770ffde73000911bd07` を基準に、通常 DB 接続へ固定本家と同じ **300ms 超**の低速 query 検出を接続した。既存の process logger に `db.query-slow`、`durationMs`、QueryRunner が存在する場合の `replicationMode` を渡す。通常の `connectResources` と直接の runtime DataSource 作成の両方が対象。migration の設定・transaction・timeout・replica routing は変更しない。診断 sink の例外で完了済み query の結果を失敗へ変えない。

## 固定 source と診断内容の差

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。[postgres fixture](../../../../packages/backend-next/test/fixtures/database-options/postgres.ts.txt) は既存の全バイト複製（SHA-256 `c6879b6b23c5fb1e7518ff0eaa02397791470732389954648f42ab13c0eaaa74`）。[新しい source helper](../../../../packages/backend-next/test/helpers/pinned-database-diagnostics.ts) は hash を検査し、factory と SQL logger の literal source を TypeScript transpile で実行する。外部 binding は同版 TypeORM 1.1.1、同期済み Entity subset、明示した環境名、SQL sink、装飾子の no-op binding。環境名は factory の外部 process binding へ渡し、本家の test 用 schema drop を実行しない。full server・本家の MisskeyLogger 自体を比較した記録ではない。

- 非 production の本家 custom logger は通常 query とエラー SQL も出力し、SQL は既定100文字、bind 値は `logging.sql.enableQueryParamLogging` の有効時だけ、replica 設定時は接続 mode prefix を含む。
- **production でも本家の低速 SQL は出力される。** factory は `logging: false` と logger 未指定だが、TypeORM 1.1.1 の既定 logger は slow query を常時有効にし、SQL 全文、bind 値、実行時間を console へ出す。実 PG の350ms query と明示的なテスト値で観測した。既存監査の「production では一切出力されない」は通常 SQL debug の説明であり、slow query の実測には適用できない。
- 新実装はすべての環境で既存の構造化 logger を使い、SQL 本文、bind 値、driver のメッセージを渡さない。共有 logger は SQL 文字列中の値を除去できないため、今回これらを新規出力する実装は採らなかった。通常 SQL debug とその設定は追加していない。**診断内容には差があり、本家と同じ全文診断や利用者による差異承認を証明したものではない。** SQL を識別する診断が必要かと、その扱いは #567 の残る判断事項にする。

## query cache の実利用者と残条件

[stats fixture](../../../../packages/backend-next/test/fixtures/database-options/stats.ts.txt) は固定本家 `packages/backend/src/server/api/endpoints/stats.ts` の全バイト複製（SHA-256 `be92712b4bc18caf4571ec198d995fca330103aac7a0ae1d970e8923603210e1`）。reaction と instance の `count({ cache: 3600000 })` が query cache の具体的利用者である。新実装 `src/` を `.cache(` と ORM の `cache:` 指定で確認した範囲には query result cache の利用者がなく、stats は #480 の未実装範囲。Meta や Role 等の既存アプリケーション cache は別の契約である。

本家 factory の有効条件は `!db.disableCache && NODE_ENV !== 'test'`、Redis は通常 `config.redis`、prefix は `${redis.prefix}:query:`。専用 PG/Redis の source factory で、明示的に cache した count が行追加後も前の値を返し、非 cache count は現在値、Redis TTL は1時間相当、DataSource の destroy 後は追加した Redis client が解放されることを確認した。count の probe には登録済み Meta Entity を使い、stats endpoint の実行や反応/instance の業務互換を証明しない。

新実装には未使用の TypeORM query cache 接続や `disableCache` 設定を追加しない。**#480 の利用者導入時に、query cache・disableCache・prefix・期限・終了時解放・取得失敗を通常 endpoint とともに接続して比較する必要がある。** 今回の source 単独観測を新実装の cache 対応済みへ読み替えない。#567 は未完了、#138/#114 の完了条件・正式な移植順・既存の承認済み差異を変更しない。

## 実測と再実行

[receipt](diagnostics-results.json) に入力とログの hash を記録する。Node 26.4.0 / pnpm 12.9.1 / pg 8.23.1 / TypeORM 1.1.1 / PostgreSQL 18.6 / Redis 8。build・typecheck・同期確認は PASS。全単体 **5,339 PASS / 既存1 SKIP、156 files**（外部本家 checkout 未指定の既存 Page source test）。新規11件を含む実 PG/Redis の DB・transaction **36 PASS / 3 files**。通常 startup logger の接続と解放、production/development、短い query、slow query、query エラー、sink 失敗後の保存結果を含む。root contract は **815 PASS / 既存1 SKIP**、inventory と shipping は PASS。独立レビューでテストの終了処理を修正し、DB解放の成否と独立に console/環境変数を復元する。修正後に全単体5,339件・実依存36件を再実行して成功した。続く環境別 probe の修正では factory 構築前に環境名を設定し、afterEach で構築/解放の成否と独立に global 状態を復元する。最新 probe の実依存11件と shipping を再実行して成功した（36件の run とは別に記録）。実 standby の遅延・分散は再測定しておらず、#635 の実測を維持する。

初回の新規単体3件は閾値と診断が未実装で失敗した。最初の実依存試験は本家 production の出力先を `console.warn` と誤って捕捉して1件失敗した。TypeORM `PlatformTools.logWarn` が `console.log` へ書くことを確認し、観測先だけを修正した。成功ログと初回失敗を分けて保存する。既存 pg の同時 query deprecation warning、全単体の既存 WebFinger 失敗注入診断が出る。最初の2つの PostgreSQL 公開 port は Docker forwarding が拒否し、専用の空き port へ変更した。

```sh
# 指定 Node と同じ ABI の native module を用意する。
pnpm install --offline --frozen-lockfile --filter backend-next...
BACKEND_NEXT_TEST_DB_PORT=59675 BACKEND_NEXT_TEST_REDIS_PORT=57867 \
  docker compose -p backend-next-db-diagnostics-567 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-upstream sync:check
pnpm --filter backend-next test
BACKEND_NEXT_TEST_DB_PORT=59675 BACKEND_NEXT_TEST_REDIS_PORT=57867 \
  pnpm --filter backend-next test:integration test/integration/database-diagnostics.test.ts test/integration/database-options.test.ts test/integration/transaction-runner.test.ts
node --test scripts/*-contract*.test.mjs
node scripts/check-shipping.mjs --base 706f82eb2086c7364001d770ffde73000911bd07
BACKEND_NEXT_TEST_DB_PORT=59675 BACKEND_NEXT_TEST_REDIS_PORT=57867 \
  docker compose -p backend-next-db-diagnostics-567 -f packages/backend-next/compose.test.yml down
```

既存の比較 receipt と hash は書き換えず、測定した `data-source.ts` と logger 引数1か所だけを [有限 predecessor](diagnostics-predecessor.json) で元の入力へ対応させる。別の byte 変更を受け入れない。今回の診断・source 比較を過去の HTTP/全バックエンドの再測定として扱わない。

Changelog 候補: DB の300msを超える query を、SQLや値を含めず構造化ログに記録する。
