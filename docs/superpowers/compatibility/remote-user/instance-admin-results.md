# Instance 管理 API #362 — 2026-11-14

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `admin/federation/update-instance` と `admin/federation/refresh-remote-instance-metadata` を通常 HTTP root に接続する。#362 の有限範囲であり、instance 照会 #361、inbox、#195/#176/#127 は未完了。`notes/create:partial`・`postingComplete:false`、D7 と PG 通知保存を維持する。

## 振る舞い

既存 token 認証と共通 gate を使い、凍結→moderator→`write:admin:federation` scope の判定を入力検証・instance 取得より先に行う。native moderator/administrator/root と scope 付き token を受け付け、Bearer が本文 token に優先する。

host は本家 `toPuny` と同じ小文字化・IDN 変換だけを行い、DB を直接照会する。未登録 host は `instance not found` の内部エラーで、登録・metadata 取得を開始しない。末尾ドットを除去したり port を補正したりしない。

停止の更新は `suspensionState !== 'none'` という boolean の変更で判断する。すでに停止中に `true` を送っても automatic/gone/manual の元状態を維持し、`false` は `none` へ戻す。メモは省略時に保持、空文字は保存する。更新後に停止変更とメモ変更の監査をそれぞれ開始する。同じメモの明示更新は保存成功・監査なし。host だけ、または停止 boolean も実効値と同じでメモも省略した入力は、本家と同じ TypeORM 空更新エラーになる。

DB 更新・whole-row cache 更新の開始後に HTTP を完了する。admin caller だけが cache 書込を背景処理として追跡し、Redis の保留・失敗で確定済み DB 更新や HTTP 成功を取り消さない。既存 ledger の他 caller は従来の await 契約を維持する。監査も背景処理として開始し、失敗は記録する。UseCase が更新と監査の境界を所有し、監査を同時確定する transaction は追加しない。

強制 metadata 更新は既存 `createInstanceMetadata(instance, true)` をそのまま使う。停止中・24時間以内の timestamp・既存 mutex があっても開始し、取得完了を HTTP 応答の条件にしない。既存取得・解析・部分失敗・mutex 解放を再実装しない。開始した cache・監査・metadata は runtime resource の終了時に接続解放より先に待つ。

## 比較と限界

[Source probe](instance-admin-source-probe.mjs) は固定 Git object から2 endpoint の `super(..., async (ps, me) => ...)` と `UtilityService.toPuny` を AST 抽出してそのまま実行する。[59観測](instance-admin-observations.json)は4停止状態×3 boolean 入力×4メモ入力、IDN/末尾ドット/port/欠損/DB失敗、4停止状態のrefreshと欠損を含む。repository・監査・metadata は明示的 double。空更新検査は本家 checkout に install された TypeORM 1.1.1 の QueryBuilder で実行し、PG 接続は開かない。source full HTTP・認証・実 PG/Redis・背景処理の完了を実測した証拠ではない。

新実装の source consumer は59観測の保存状態・監査・強制取得・正規化された lookup・例外を照合し、別1ケースが probe bytes と固定 SHA を束縛する。実 HTTP/PG/Redis/TLS の26ケースは gate 拒否順と保存/外部取得不在、IDN、全停止状態、空更新、DB拒否、背景 cache 保留/拒否、監査拒否、force 成功/remote失敗、resource close の待機を確認する。resource close は `connectResources.close()` を実行して metadata 待機中の DB/Redis 保持と完了後解放を確認する。新しい OS process/Supervisor の停止試験は追加していない。

全エラーの `info.e` 診断文字列・クラスの一致は証明しない。例えば直接照会後の同時削除では、既存 ledger は `INSTANCE_NOT_FOUND` を返し、本家の未定義 row 参照とは診断が異なる。通常の未登録 host のエラーは比較済み。cross-process memory cache 鮮度や1時間の停止 host 一覧 cache の即時無効化を新たに保証しない。

## 実行

専用 Compose `backend-next-parallel-362`、PostgreSQL 56562 / Redis 57562 を用いる。ユーザーの `misskey-infra` は使用しない。

```sh
PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next... build
PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next... typecheck
PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next test
PATH=/tmp/tiramiss-s1-node26/bin:$PATH BACKEND_NEXT_TEST_DB_PORT=56562 BACKEND_NEXT_TEST_REDIS_PORT=57562 pnpm --filter backend-next test:integration test/integration/instance-admin.test.ts test/integration/instance-metadata.test.ts test/integration/http-app.test.ts
PATH=/tmp/tiramiss-s1-node26/bin:$PATH UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/instance-admin-source-probe.mjs --check
```

Source probe の `--write` は意図的に観測を再取得するときだけ使い、変更を review する。本家 checkout の固定 Git object・既存 TypeORM と、この worktree の TypeScript/pg が必要。CI は記録済み観測を通常 unit suite で検査する。
