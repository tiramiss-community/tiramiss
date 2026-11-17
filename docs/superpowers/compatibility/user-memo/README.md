# ユーザーメモ #294

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`、作業基点は `7f64bd8f5996791f9cfe47b9aec124a988c3182d`。通常の `POST /api/users/update-memo` を共通認証・認可・エラー変換へ接続する。親#180・全体#114とUserDetailed全体は未完了である。

業務moduleが現在の実行者を確認し、認可後に入力検証・対象存在確認を行う。メモの所有者には認証された実行者を使い、対象との組だけを更新する。null/空文字は削除、空白は保存、上書き時は既存IDを保持する。本家同様に対象の存在確認は削除より先で、未知userは `NO_SUCH_USER` / `6fef56f3-e765-4957-88e5-c6f65329b8a5`。初回の同時保存は本家と同じunique制約に従い、独自upsertやtransaction保証は足さない。

公開する読取契約は `UserMemoReader.read(viewerId, targetUserId)` という内部材料に限る。呼出ごとに閲覧者を明示し、その人のメモだけを読む。匿名はDBに触れずnull。メモを公開する新HTTP読取APIやUserDetailedの仮実装は追加していない。後続の詳細user readerがこの狭い材料をcompositionで組み立てて利用できる。

## 比較と検証範囲

`source-probe.mjs` は固定Git objectからendpointのcallback/schema/metaとUserEntityServiceのmemo読取blockを抽出する。`corpus.json` の19入力について保存行・エラーと閲覧者alice/bob/匿名の読取を `observations.json` へ記録し、新moduleの単体テストおよび通常listening HTTP/実PGで照合する。Getter・repository・IDは明示したdoubleで、本家full HTTP/PGやUserDetailed packer全体の実行ではない。isDetailed=falseでnullになるsource分岐もprobeで確認する。

実HTTP/PG17件は有効/未知user、insert/update/空/null/削除対象なし、空白、自己宛て、別著者のメモとの共存、閲覧者切替、不正入力、資格/scope/凍結順序、204空応答、varchar2048境界・2049時500、DB障害、unique/FKと両CASCADEを検証する。schema/migration6件は別の既存検査である。診断の乱数UUIDや本家内部DB例外文言の完全一致は主張しない。

`UserMemo` はmanifestから機械同期した固定本家のEntityで、旧backendとmigrationは編集しない。新しいexport/Entity登録・読込は `sync:check`、同期テスト、依存順build/typecheck、package-imports、実HTTP/PG、migration履歴/schema検査で現在の入力を確認する。同期の成功だけを業務移植の根拠にしない。

## 実行

指定Node26.4.0・pnpm12.9.1、独立node_modulesを使う。今回のNodeは `/tmp/tiramiss-s1-node26/bin`。専用Composeは `sol-memo294`、PG60432、Redis60379、HTTPは動的port。起動と設定は `packages/backend-next/README.md` に従う。

```sh
PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm install --frozen-lockfile --filter backend-next...
BACKEND_NEXT_TEST_DB_PORT=60432 BACKEND_NEXT_TEST_REDIS_PORT=60379 docker compose -p sol-memo294 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test
BACKEND_NEXT_TEST_DB_PORT=60432 BACKEND_NEXT_TEST_REDIS_PORT=60379 pnpm --filter backend-next test:integration test/integration/user-memo.test.ts test/integration/migrations.test.ts
node docs/superpowers/compatibility/user-memo/source-probe.mjs --check
node --test scripts/*contract*.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 7f64bd8f5996791f9cfe47b9aec124a988c3182d
```

上記install後も全コマンドで指定NodeをPATHの先頭に維持する。GLIBC不一致の既成re2バイナリは自worktreeの依存内で指定Nodeによりsource rebuildした。共有node_modulesやユーザー用misskey-infraには触れない。

## 証跡の保守と履歴

全ログは `/tmp/sol-delivery-20261117/memo294/`。製品は `9760605f1716d4ce4a07d923a46ed09068fc3df6`、既存negative testへの診断互換の追補は `8d0c72c61835143b447a957b503bbb233e3956e5`。両者の間にruntime変更はない。指定Node26では全単体4,964/134files・実HTTP/PG/schema23/2files・source19・同期5・build/typecheck・inventory・shippingを検証した。最終rootは32入力の前後hash一致を確認し765 PASS / 0 FAIL / 1 optional SKIP（既存migration-proofの任意upstream checkout照合）。近傍root22件もPASS。測定入力・ログhashと適用範囲は `current-evidence.json` に記録する。Node24の先行結果は履歴として区別し、新しい入力の測定に付け替えない。

共有proofでは今回のcomposition2ファイルと同期関連4ファイルの追加だけを、厳密anchor・既知current hash・最終歴史hashで元のbytesへ戻す。元receipt/seal/測定値、cacheと検証上限は不変。共有testの認証ループは#489が所有し、#294は独立したroute1行だけを追加する。既知combined SHA `cdcc4eb0be344bbafde0b45f85072cd570d17850f81e275908836290ca8589d2` からmemo追加だけを除去し、poll-only SHA `fe2cd18f8f899620e6a9830a2b6639348cde7a501f72808072db44698aa4fa6e` になるsyntheticケースも検証する。実合成headの確認は取りまとめ担当が所有する。

意図したHTTP404のRED以外の修正は12種類として記録する。テスト構文（2実行）、probeのlexical this、16文字token fixture、型のnarrowing、既存route一覧、brace-style、composition predecessor、Entity predecessor、negative testの呼出元診断prefix、Node26/re2再build、inventory生成引数、Git共有metadataのsandbox権限である。個別ログと経緯は実装計画のExecution recordを参照する。root途中結果やNode26初回のnative-load失敗を成功へ数えない。

CHANGELOG候補: backend-nextで閲覧者ごとのユーザーメモの保存・更新・削除を実装。
