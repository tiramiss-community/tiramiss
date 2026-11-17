# #489 投票推薦の実装計画

基点: `7f64bd8f5996791f9cfe47b9aec124a988c3182d`。固定本家: `8e07cf085adf7009583d234a208e30436f020e26`。

1. `modules/poll-recommendation/recommend-polls.ts`（専用`public.ts`） に資格・凍結・read:account判定と入力検証を持つUseCaseを追加する。候補取得後にNoteを再取得し、その降順snapshotを既存read/renderへ渡す。空候補/空Noteはmaterial読取を省く。
2. `platform/database/poll-recommendation.ts` に本家同様のPoll条件・vote/mute subquery・offset/limit・Note再取得を実装する。HTTPは既存api-endpoint、compositionはnote-routesへ接続する。
3. 単体テストで資格先行・空結果・viewer付き描画・Note再取得順を固定し、実PG/listening HTTPで各除外条件・期限境界・pagination・保存不変を検証する。固定source callbackを抽出して同一PGへ実行しID順を直接比較する。
4. 近傍test、sync/build/typecheck、比較probe、contractsの対象行、shippingを確認する。失敗と修正はREADMEへ追記し、過去の証跡や共通基盤を変更しない。

レビュー焦点: strict expiry、filter-before-limit、channel既定false、Note再取得時削除、auth-before-input。投票更新と共通TL filterは対象外。D7の既存64/256予算は維持する。
