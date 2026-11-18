# test/reset-db #390

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `api/endpoints/test.ts` と `reset-db.ts` を `packages/backend-next/test/fixtures/test-controls/` へそのまま保存した。`pinned-test-controls.ts` は SHA-256 を検査し、実ソースの入力 schema と reset callback を抽出して有限比較する。callback の DB・Redis・Meta・event は制御した binding であり、旧サーバー全体の実行ではない。

通常の HTTP composition に両 API を登録する。`test` は `required` boolean、string、alphanumeric ID、default/nullableDefault、未知のフィールドを本家と同じ Ajv 設定で検証し、既定値を含む入力を返す。reset は POST 成功で空の 204、通常環境では本家同様に INTERNAL_ERROR。GET は共通 gate の 405 になる。

## reset を有効にする条件

`NODE_ENV=test` だけでは reset できない。使い捨て PostgreSQL・Redis を専用に準備し、通常と同じ設定へ向けた上で、起動環境の `BACKEND_NEXT_TEST_RESET_TARGET` に以下の JSON を設定する。これは操作者による使い捨て先の明示であり、endpoint がストレージの由来を判別するものではない。

```json
{"database":{"host":"127.0.0.1","port":55690,"database":"backend_next_example"},"redis":{"host":"127.0.0.1","port":56390,"db":0},"pubsub":{"host":"127.0.0.1","port":56390,"db":0,"topic":"example.test"}}
```

DB、primary Redis、pubsub Redis と URL host による通知 topic の全項目が設定と一致するときだけ実行する。JSON は HTTP 入力から受け取らない。replica、DB extra の接続先上書き、Redis socket/sentinel/Connector、TLS の接続先上書きは拒否する。DB0 も専用 Redis なら指定できる。Redis prefix は分離境界ではなく、**primary Redis の選択 DB 全体を FLUSHDB** する。別 Redis role の DB は flush しない。pubsub は既存の専用 publisher で送る。

reset の実行中は他のテスト要求・worker・scheduler・producer を停止し、未完了の業務処理を残さない。多プロセスでの並行 reset や分散排他は保証しない。共有または既存の開発・本番ストレージを指定しない。

## 順序、保存対象、失敗後

1. primary Redis の選択 DB を FLUSHDB。
2. PostgreSQL transaction 内で `public` と `backend_internal` の通常テーブルを一括 TRUNCATE。両 schema の `migrations` と `typeorm_metadata` は残す。`ONLY` と schema 修飾により他 schema の継承先へ波及させず、CASCADE は使わない。
3. Meta を再取得して既定行を作り、当該プロセスの Meta cache と `metaUpdated` 通知を更新。
4. 本家同様 1 秒待って 204。

本家の全 schema を名前だけで DELETE・最大3回 retryする処理から、上記の限定 schema・atomic TRUNCATE・履歴保持へ変更している。schema 同期、migration 実行、外部ファイル・検索 index の削除は行わない。partitioned parent は対象に含めず、範囲内の physical leaf を ONLY で対象にする。外部 schema/partitioned parent の FK がこれを妨げる場合は失敗させる。

Redis が失敗すれば DB は未変更。COMMIT 前の DB 処理が失敗して rollback が成立した場合、Redis は既に空でも DB データは残る。COMMIT の応答喪失などで結果が不明な場合は DB の確定状態を確認し、再実行を判断する。Meta 作成失敗では Redis/DB の reset が確定した後に 500 になる場合があり、500 は全体 rollback を意味しない。確定後の通知失敗は固定の診断だけを記録して 204 を維持する。診断 sink の失敗も確定済み reset の応答を変えない。Redis と PostgreSQL 間の atomicity や自動 retry は追加しない。Meta 以外の既存メモリ cache は本家同様、この endpoint では再作成しないため、独立したテスト群の境界ではプロセスを再起動する。

## 検証

```sh
BACKEND_NEXT_TEST_DB_PORT=55690 docker compose -p backend-next-390 -f packages/backend-next/compose.test.yml up -d --wait postgres
pnpm --filter backend-next test test/unit/test-controls test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=55690 pnpm --filter backend-next test:integration test/integration/test-controls.test.ts
docker compose -p backend-next-390 -f packages/backend-next/compose.test.yml down
```

結合検証は使い捨て DB と、spec 自身が起動・削除する一意な名前の `redis:8` 専用コンテナに対して通常の listening HTTP から実行する。Docker が必要で、公開ポートは動的に割り当てる。共通テスト Redis の DB/prefix は flush せず、上記 Redis 環境変数もこの spec の flush 先には使わない。production の拒否、target 未指定/不一致、両 schema の削除、migration 履歴、他 schema・継承先・別 Redis DB の保持、Meta 再取得、次操作、DB FK 失敗時の atomicity、Redis 失敗時の DB 保持、通知失敗時の 204を確認する。固定 source 比較は入力と呼び出し順の有限比較に限定する。親 #178/#114 全体や全 API の互換性を示すものではない。
