# 本人の Renote 解除（#488）

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `notes/unrenote` を通常 HTTP へ接続する。親 #184 と全体 #114 は未完了。既存の `notes/create:partial`、削除以外の chart #200、他の交流操作の担当は変更しない。

## 契約

- `write:notes` が必要。停止アカウントは拒否し、移行済みアカウントは許可する。削除と共通の認証・制限・入力検証を使う。
- `noteId` は英数字の空でない ID。対象不存在の UUID は `efd4a259-2442-496b-8dd7-b255aa1a160f`。対象 Note の可視性は検査しない。
- `userId = 本人 AND renoteId = 対象` の全件を選ぶ。純粋 Renote に加え、本文・返信付きの引用も削除する。他人の Renote、元 Note、無関係な本人投稿は保持する。
- 対象があり本人分がゼロなら 204。複数件を開始し、削除・副作用の完了を待たず 204 を返す。制限は `notes/unrenote` 専用の 1時間300件・最短1秒。
- 認可済み snapshot に対する削除操作を `notes/delete` と共有する。返信数減算、deleted stream、AP Undo/Announce または Delete、chart 開始、索引解除、物理削除の境界を保つ。`renoteCount` と作者の `notesCount` は減らさない。本家に削除 webhook はない。
- 非待機処理の失敗はログへ残し、既存の終了時 drain が物理削除とそこから開始した副作用を待つ。永続依頼、独自 retry、counter の厳密な一度だけ更新は追加しない。DELETE 失敗後の再試行で返信数が再度減る本家の境界を維持する。

## 比較と再実行

`source-probe.mjs` は固定 Git オブジェクトから endpoint callback、`NoteDeleteService.delete`、Renote/quote 判定を文字通り抽出する。`source-observations.json` に3入力ソースの SHA-256 と schema/meta を保持する。通常モードで同一性を検査し、`--pg` はテストから渡された隔離 DB で選択・返信数減算・DELETE を実行し、結果取得後に rollback する。実装の SQL を期待値として再利用しない。

`test/integration/unrenote.test.ts` の第一試験は、同じ PG fixture に対する4操作（不存在、本人分なし、本人の純粋/引用2件、再試行）を固定 callback と listening HTTP の間で比較する。HTTP status/error UUID、選択 ID、最終 Note 行・返信数・Renote 数、副作用開始の種類と ID が一致する。新実装ではさらに実 Redis の deleted 配信、実 BullMQ の Undo/Announce・Delete、実 Meilisearch の引用索引解除、監査なしを確認する。

残る試験は、PG 行ロック中の非待機 HTTP 204 と drain、実 DELETE trigger 失敗と通常再試行、移行済み actor、認証/停止/scope/入力、独立した制限 key を確認する。既存 `note-delete.test.ts` と `delete-note.test.ts` が共有操作の失敗境界と監査を引き続き検証する。

```sh
node docs/superpowers/compatibility/unrenote/source-probe.mjs
pnpm --filter backend-next test test/unit/note/unrenote.test.ts test/unit/note/delete-note.test.ts test/unit/note/post-delete.test.ts
pnpm --filter backend-next test:integration test/integration/unrenote.test.ts test/integration/note-delete.test.ts
pnpm --filter backend-next typecheck
```

専用依存は `packages/backend-next/README.md` の手順に従う。並行時は `BACKEND_NEXT_TEST_DB_PORT`・`BACKEND_NEXT_TEST_REDIS_PORT`・`BACKEND_NEXT_TEST_MEILI_PORT` を分ける。固定オブジェクトが別 clone にある場合は `BACKEND_NEXT_UPSTREAM_PATH` を指定できる。

## 証明範囲と限界

これは固定 endpoint/deletion method と新実装の有限比較で、本家 full server、認証 gate、AP renderer、chart/search/stream の本家実物を同時起動した比較ではない。本家側の後者は doubles、新実装側は実依存または既存 post-delete 呼出しの観測である。source は非待機性を deferred Promise で、新実装は実 PG lock で確認する。新実装では snapshot 取得時の本人を一度取得し、以後に本人が並行削除される競合や全配送先・chart 全体の同等性は主張しない。chart 更新や通常削除の既存部分完了を、この endpoint 接続だけで完成へ変更しない。

2026-11-19 の検証は base `c25f3ee979` からの本変更を対象とする。実行結果は PR/引き継ぎへ記録し、過去の広域 receipt や snapshot の identity を書き換えない。
