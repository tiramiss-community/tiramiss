# PostgreSQL replica routing の限定比較（#567）

基準 develop `1613804464` には PR #630 の timeout・int8・nullish WHERE 対応が既に含まれる。[当時の実測](README.md)と receipt は変更しない。今回の有限 slice は `dbReplications` / `dbSlaves` の通常接続と解放を追加する。query cache・disableCache・低速 query 診断は #567 に残り、#567/#138/#114 全体の完了を意味しない。

## 本家 source と通常入口

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `packages/backend/src/postgres.ts` の factory（278–296行）が、`db` を master、`dbSlaves` を slaves とする TypeORM replication を構築する。`config.ts` 318–319行は YAML の `dbReplications` / `dbSlaves` をそのまま渡す。既存の完全バイト fixture と SHA-256 検証つき [source helper](../../../../packages/backend-next/test/helpers/pinned-database-source.ts) を再利用し、今回その入力に replica を渡す。抽出した本家 factory 自体は変更しない。factory は実 TypeORM 1.1.1 / pg 8.23.1・同期済み Entity subset と明示 external binding で実行し、full upstream server や HTTP を起動した比較とは区別する。

新実装は YAML → `loadConfig` → `database.replicas` → 通常の `connectResources` → `createDataSource` を通す。主系の `db.extra` は TypeORM の両プールへ適用され、既存の起動接続期限も維持する。replica 接続情報はそれぞれの `host` / `port` / `db` / `user` / `pass` を使い、主系の認証情報や環境変数で補わない。無効時は `dbSlaves` を無視し、空の有効リストは本家 TypeORM と同じく primary へ戻る。既存設定検証に合わせ、有効な replica の不正な構造・値は起動時に `INVALID_CONFIG` とする（本家 factory の未検査値による遅い例外とは診断タイミングが異なる）。migration/check の共通 options は replica 設定を除外し、本家 CLI ormconfig と同じく primary だけを使う。

## 実 PostgreSQL での観測

[専用 Compose overlay](../../../../packages/backend-next/compose.replication.test.yml) は専用 primary から `pg_basebackup -R -X stream` した read-only standby を起動する。別々の通常 DB を replica の代用にしない。試験は primary の WAL flush LSN と standby の replay LSN を照合してから保存内容を読む。これによってテストの準備待ちを制御するだけで、製品に synchronous replication や強い read-after-write 保証は追加しない。

両 factory とも、実 QueryBuilder の `pg_is_in_recovery()` で読取先を確認し、Repository の書込成功と実 replay 後の読取、共通 transaction lifetime 内の主系読取と自身の更新、timeout（SQLSTATE 57014）の rollback、誤 replica password の初期化失敗、空の slave list の fallback を確認する。通常 YAML 入口では runtime と transaction、両 migration source の接続先を確認し、close 後の主系・standby の `pg_stat_activity` に該当 runtime の接続が残らないことも検査する。

未検証: 複数 slave の乱択分布、稼働中の replica 切断・遅延・昇格、failover、Supervisor/worker の process 試験、本家 full HTTP、query cache と低速診断。自動 retry や fallback を独自追加しない。通常起動での schema 同期・dropSchema・自動 migration は追加しない。

## 再実行と実測

Node 26.4.0 を使い、native module も同じ ABI で用意する。専用 project と空いている3ポートを選ぶ。

```sh
pnpm install --offline --frozen-lockfile --filter backend-next...
export BACKEND_NEXT_TEST_DB_PORT=62532
export BACKEND_NEXT_TEST_REDIS_PORT=62579
export BACKEND_NEXT_TEST_REPLICA_DB_PORT=62533
docker compose -p sol-db567-replica -f packages/backend-next/compose.test.yml -f packages/backend-next/compose.replication.test.yml up -d --wait postgres postgres-replica redis
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test
pnpm --filter backend-next exec vitest run --config vitest.replication.config.ts
pnpm --filter backend-next test:integration test/integration/database-options.test.ts test/integration/transaction-runner.test.ts test/integration/meta.test.ts
node scripts/check-shipping.mjs --base 1613804464
docker compose -p sol-db567-replica -f packages/backend-next/compose.test.yml -f packages/backend-next/compose.replication.test.yml down
```

専用 CI workflow `test-backend-next-replication.yml` で Compose / `vitest.replication.config.ts` / always cleanup を実行する。通常 `test:integration` に replica 依存を紛れ込ませない。

[初回の receipt](replication-results.json) は commit `70c55ad56d` の入力と実ログの hash を保持する。CI 導入の修正後は [追補 receipt](replication-ci-followup.json) に記録する。初回 unit は未実装により7件が期待どおり失敗した。初回 standby は専用 HBA の replication 許可が無く接続失敗し、専用 fixture へ追加した。初回実依存試験では QueryBuilder の FROM alias を欠いたテスト fixture により9件が失敗したため、TypeORM の `fromDummy()` に修正した。製品 routing の失敗として扱わない。Node24 での preliminary 成功と最終 Node26 の測定は分けて記録する。Node26 native re2 は同版1.27.0の既存 ABI147 binary をこの worktree にだけ配置した。実依存試験では pg の既存 concurrent query deprecation warning が出る。

Changelog 候補: DB replica 設定を通常接続に反映し、読取と書込・transaction の接続先を本家に合わせる。

PR 初回 CI の contracts lane は、専用 package script 追加による既存の sealed `package.json` 入力 drift で失敗した。不要な script 追加を取り除き、既存の `pnpm exec vitest` で専用 config を実行する。既存の比較証跡や checker は変更しない。

既存 CI workflow も複数の歴史的比較入力として封印されているため、replica 試験は専用 workflow へ分け、既存 workflow のバイトと四つの検証 lane は維持する。

既存 `config.test.ts` の追記も古い actor 比較の固定入力だったため、新規 replica 設定の検証を専用 `database-replication-config.test.ts` へ移し、既存のテストバイトを復元した。runtime adapter 一つだけは新しい実測済み SHA を確認して PR #630 後の正確なバイトへ戻す限定 predecessor を追加する。既存の測定結果・封印・期待 hash は変更せず、未知の差分は元の検査へ渡す。
