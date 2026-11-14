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

## 実測と現在の証跡

実装 `a5c08da37c` と終了待機テスト補強 `1bd9aac3bd` の後、#325 (`bb735037096259712fd381d910423ffc9927e0e1`) を通常 merge した **`906979d7695785cad8d6f2fd691bc5b96a7e4413`** を測定した。Node 26.4.0 / pnpm 12.9.1、2026-11-14 13:19:30–13:20:13 UTC。

| 実行 | 結果 |
| --- | --- |
| build / typecheck / upstream sync | 各 exit 0 |
| backend-next 全 unit | 4,197件 / 110ファイル成功 |
| 実 HTTP・PG・Redis・TLS と近傍 | 36件 / 3ファイル成功（今回26件） |
| 固定本家 callback probe | 59観測一致 |

[906979d の全 unit 実測 receipt](instance-admin-full-unit-evidence.json) は runtime/base/upstream SHA、開始終了、6コマンド、exit、実ログの保存先/SHA256、変更された product と source 入力16ファイルの実行前後 hash を記録する。16ファイルに drift はなかった。最初の merge 後 full unit は、無変更の `note/post-save.test.ts` の `idle waits for post-save work started while it is waiting` が timer 0 の判定で1回失敗した。対象14件と全4,197件の再実行は成功し、当該実装/テストは編集していない。最初のログは `/tmp/tiramiss-s1-362-20261114/unit-first-transient-failure.log` に保持した。PG の既存並行 query に関する deprecation warning は今回の修正対象にしていない。

[有限 reader](../../../../scripts/instance-admin-evidence.mjs) は[現在の receipt](instance-admin-current-evidence.json)と [9個の predecessor](instance-admin-predecessor.json) を固定 seal で検証し、16 current inputs と存在する実ログを確認してから、9パスだけを #325 完了時点の bytes へ投影する。#325 の14入力（今回変えた root・public export・root test を含む）はその reader を通して元の測定 bytes を検証し、以後 #324 → #323 → 以前の読取へ続く。元の receipt・seal・corpus・predecessor は変更していない。新しい reader は Node builtin のみを使い、Git subprocess・再帰的 manifest・祖先 reader 呼出しを持たない。

終了待機の検査は metadata を50ms保留して close が未完了であることを確認し、`scope.defer(instanceAdministration.close)` を一時的に除去した mutation で `closed === true` になって失敗することを観測した。登録を戻した同一テストと最終26件は成功した。mutation は commit に含めていない。

CHANGELOG 候補: `Feat: 新バックエンドに連合先の停止・管理メモ更新と metadata 強制取得 API を追加`。


CodeRabbit は commit 済み17ファイルを review し、実装本体の指摘はなかった。保留中の metadata を assertion 失敗時にも解放する `finally` がテストに必要という minor 1件を確認し、`82d47cc0bb6dd61a15b33ca0166157527a505683` で修正した。独立 reviewer もこの修正を確認する。CodeRabbit の再実行で指摘0件を確認したという意味ではない。

[現在の receipt](instance-admin-current-evidence.json) はそのテスト修正後、82d47cc0bb の同じ16入力を測定したもの。2026-11-14 13:25:34–13:25:46 UTC に、近傍 unit **60件 / 1ファイル**、実 HTTP/PG/Redis/TLS と近傍 **36件 / 3ファイル**、build/typecheck/source59/sync が成功した。906979d の全4,197件を、このテスト後始末だけの変更後にも再実行したとは扱わない。2つの実測の raw log はそれぞれ元の `*-measured.log` と `after-review-*-measured.log` を保存している。leaf は新しい現在の receipt を seal し、歴史上の全 unit receipt は元の記録として保持する。

ルート契約は修正前の metadata で481件成功し、現在の receipt へ更新した後に finite bridge の対象を再検証する。shipping の変更ファイル lint・SPDX・locale safety は最終差分で実行する。
