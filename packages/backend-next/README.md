# backend-next

Misskeyバックエンド再設計の最小基盤。HTTP・ワーカーの起動枠までを提供する。
現在のHTTP応答は404で、Role API・認証・業務ジョブは後続の実装範囲。

## ビルドと起動

リポジトリが指定するNode.jsとpnpmを用いる。

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-upstream sync:check
pnpm --filter backend-next... build
```

本家形式の`.config/default.yml`を読み込む。`NODE_ENV=test`では`test.yml`、
`MISSKEY_CONFIG_YML`では`.config/`基準のファイル名または絶対パスを指定できる。
旧backendの設定コンパイルやビルドは不要。

```yaml
backendNext:
  workerCount: 1
  startupTimeoutMs: 30000
  shutdownTimeoutMs: 30000
```

サービスを完全停止した状態で、先にマイグレーションを適用する。
既存MisskeyのDB・データは事前にバックアップし、稼働中の旧backendへ接続して適用しない。

```sh
pnpm --filter backend-next migrate
pnpm --filter backend-next check-migrations
pnpm --filter backend-next start
```

`migrate`は本家の`public.migrations`を引き継ぎ、全履歴の未適用分を実行した後、
`backend_internal`とその独立した履歴テーブルを初期化する。内部の業務用テーブルはまだない。
本家の`MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY=1`指定も引き継ぐ。
起動時は適用状況を確認するだけで、履歴やschemaを自動作成しない。

SupervisorはHTTP×1、worker×指定数を起動し、全子のreadyを待つ。
子の予期しない終了時は兄弟も停止して異常終了し、自動再起動しない。
`SIGTERM`/`SIGINT`では受付を止め、処理・接続の終了を期限まで待つ。
期限超過は異常終了する。HTTP接続切断を業務取消として扱わない。

プロセスを外部管理する場合は`start:http`、`start:worker`を使う。
各子は独自のDB・Redis接続を持つ。Redisなしの縮退運転はしない。
ログはstdoutへのJSON行で、設定全体や認証情報を出力しない。

## 検証

テスト専用のPostgreSQL・Redisを使う。既存の`misskey-infra`とは別のComposeプロジェクトであり、
コンテナ名・ネットワーク・ポートを共有しない。データはtmpfsに置く。

```sh
docker compose -p backend-next-test -f packages/backend-next/compose.test.yml up -d --wait
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next... lint
pnpm --filter backend-next test
pnpm --filter backend-next test:integration
pnpm --filter backend-next test:process
docker compose -p backend-next-test -f packages/backend-next/compose.test.yml down
```

既定ポートはPostgreSQL `55432`、Redis `56379`。
`BACKEND_NEXT_TEST_DB_PORT` / `BACKEND_NEXT_TEST_REDIS_PORT`で変更できる。
結合・プロセステストは専用DBに接続し、`backend_next_<ランダムID>`のDBだけを作成・削除する。
本番設定は読み込まない。

`check-schema`は検証用DBで使う。同期したEntityの対象に限って定義差分を検出し、DDLは実行しない。
本家の未同期Entityに対応するテーブルを削除対象として扱わない。

本家のコピーを更新する場合は`backend-upstream/README.md`を参照。
アーキテクチャと後続のRole実装範囲は`docs/superpowers/specs/`に記載する。
