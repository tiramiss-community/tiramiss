# migration の履歴と CONCURRENTLY の限定検証（#568）

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。既存の migration 入口・全349件の複製・適用済み migration を変更せず、追加テストで比較と失敗時の観測を補う。#138・#114、本番切替は未完了。

## 実行

Node・pnpm は repository の指定版を使い、repo root で実行する。既存の開発DBや `misskey-infra` は使わない。

```sh
export BACKEND_NEXT_TEST_DB_PORT=55568
export BACKEND_NEXT_TEST_REDIS_PORT=56568
export BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56569
docker compose -p backend-next-568 -f packages/backend-next/compose.test.yml up -d --wait postgres
pnpm --filter backend-next... build
pnpm --filter backend-next test:integration test/integration/migrations.test.ts test/integration/migration-proof.test.ts
node --test scripts/migration-proof-contract.test.mjs
# 固定本家の Git object と349件を再照合する場合:
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream node --test scripts/migration-proof-contract.test.mjs
docker compose -p backend-next-568 -f packages/backend-next/compose.test.yml down
```

新しい結合テストはビルド済み入口を使うため、事前 build が必要。`MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY` は child の開始環境で `0` / `1` に固定する。migration module は初回評価で設定を保持するため、同一プロセス内の環境変数変更だけでは比較しない。`MIGRATION_PROOF_OBSERVATIONS=/absolute/path/to/new.jsonl` を結合テストへ渡すと、追加7ケースの観測JSONをそのファイルへ追記する。新しい空の出力先を使い、既存receiptは上書きしない。

## 比較の範囲

[source.json](source.json) は、固定 Git object からの349ファイル全件の byte 比較を集約した manifest digest と、`ormconfig.js` の source literal を記録する。対象ファイル名・クラス・timestamp・SQLは変更しない。本家の ORM 設定は source 比較であり、本家 full server を起動した比較ではない。

既存 `migrations.test.ts` の6ケースは、空DBの非変更検査、349件適用、再適用なし、独自履歴の分離、登録Entityのschema差分、履歴欠落、独自領域だけの初期化、上流失敗後の独自領域未作成を扱う。この既存証拠と追加ケースを区別する。

追加ケースは実 PostgreSQL と TypeORM を使用し、次を検査する。

- 本家349件のうち348件を適用したDBを既存状態として作り、実 `migrate` CLIで残る1件→独自8件を適用する。fixture の独自履歴 trigger は上流349件が揃う前の insert を拒否する。既存348行の `id` / `timestamp` / `name` と再実行後の全349行を保持する。
- 実 `check-migrations` CLIの `MIGRATION_HISTORY_MISSING` / `PENDING_MIGRATIONS` と、実 `check-schema` CLIの `SCHEMA_DRIFT` を別々に検査する。前者は履歴の識別情報を検査し、後者は登録済みEntityの定義範囲を検査する。全上流Entityやデータ整合性を検査する機能ではない。
- `CompositeNoteIndex1745378064470` と `NoteIdIndexForPinAndFavorite1780059833698` の実 instance は `all` で `transaction: undefined`、`each` で `false`。`false` の実 migration を強制 `all` で実行すると TypeORM が `ForbiddenTransactionModeOverrideError` で拒否し、indexも履歴行も追加しない。`each` の実適用成功は PostgreSQL が transaction 内の `CREATE INDEX CONCURRENTLY` を許可しない条件でも確認する。
- favorite/pin の2つ目の `noteId` 列を fixture で rename して42703を発生させる。先行342件の履歴を保持し、対象と後続7件は未適用、独自schemaも不在。`all` ではこの migration の1つ目のindexも rollback、`each` では有効な1つ目が残る。列を復元して再実行すると349件＋独自8件が揃い、`each` の残存indexのOIDを再利用する。その後、対象の履歴行だけをfixtureで除いて再実行し、両方の有効indexのOID・定義・有効性を保持する。
- 失敗した `CREATE UNIQUE INDEX CONCURRENTLY`（重複fixture、23505）で PostgreSQL 自身が残す invalid index を準備する。実 concurrent migration が composite・favorite・pin の invalid index を置換し、有効・非unique・期待する列順/降順の定義へ戻す。これは障害注入用の unique DDL であり、製品の非unique migration の cancel を実測した意味ではない。composite の有効な再実行ではOIDを保持し、旧userId単独indexを除く。全履歴適用後のcomposite名は後続 `MigrationCleanup1752509043847` が `IDX_a6f649630f55af3888e5a42919` へ変更する。

これは有限のDB fixture。無条件rollback・自動修復・任意の途中失敗からの無検査retryを保証しない。再開前には停止状態、実際の履歴・index有効性・定義・失敗したDDLの原因を確認する。ここでの再実行条件は意図的にrenameした列の復元と、有効な先行indexの保持、またはinvalid indexを置換できる concurrent 分岐に限定する。既存データの値変換、全障害、権限不足、通信断によるCOMMIT結果不明、旧版への復元や本番切替は証明していない。
