# 投稿タイムラインproducer（#174 第1slice）

固定本家: `8e07cf085adf7009583d234a208e30436f020e26`。

`NoteCreateService.pushToTl` のhome/local/user/list/channel（files/replies派生を含む）を通常起動へ接続した。`FanoutTimelineService.push` のRedisキー・3分境界・末尾日時比較・10%trim、`checkHibernation` のsample/50日判定を維持する。`ChannelFollowing` は固定Gitオブジェクトから機械同期し、既存migrationは変更しない。

## 比較の根拠

`reference-timeline.mjs` は指定checkoutの固定Gitオブジェクトから `pushToTl` のメソッド本体をASTで取り出して実行し、新実装の純粋plannerと順序・名前・件数を照合する。公開範囲、local/remote、返信先、添付、channel、visible集合、self follower、list所有者を組み合わせた1,280ケース。

```sh
node docs/superpowers/compatibility/note/timeline/reference-timeline.mjs /path/to/checkout-with-fixed-objects
```

このprobeのRepository/Redis境界はdoubleであり、本家全体のHTTP・実DB・実Redisを新たに実測した結果ではない。本家の取得条件は固定ソースと新実装の実DBテストで照合する。

新実装の `test/integration/note-timelines.test.ts` は実HTTP handler、PostgreSQL、専用db/prefixのRedisで次を観測する。

- ローカル非休眠follower、list所有者、返信先、channel購読者への投入と、後から変わったFollow/Metaの反映。
- 無効設定、remote/休眠followerの除外、channelでは同じフィルターを足さないこと、機械同期後のschema差分0。
- 保存直後に削除されてもsnapshotのIDを後続で追加し、削除時のpurgeをしないこと。
- Redis WRONGTYPEと小数LTRIMの失敗後も他のkey/LPUSH結果とHTTP成功が残ること。
- 古いchannel IDの直接更新は後の購読者照会失敗でも残り、recentの未送信pipelineは残らないこと。
- 休眠候補は今回の投稿を受け、以後除外されること。50日ちょうどとNULLは対象外。

`test/unit/note/timeline-cache.test.ts` は3分ちょうど・末尾と同じ日時・10%ちょうど・小数上限・開始済み直接更新のdrainを固定入力で検証する。`test/unit/note/post-save.test.ts` は失敗時にもcount/poll/AP処理が進み終了が待たれること、`test/integration/resources.test.ts` と `test/processes/note-timelines.test.ts` は専用Redisの起動失敗・稼働中切断・接続解放・実HTTP子の終了待機を検証する。

## 後続と制約

#174全体は未完了。検索・antenna・hashtag・featured・role timeline等、閲覧API #185/#186、role関連 #181/#189、チャート #200、正本/再構築 #132/#133をこのsliceの完成へ含めない。WebSocket接続で活動時刻を更新して休眠解除する本家の経路は #189/#180。REST認証へ独自の解除処理を追加しない。

Metaは既存 `readMeta` を後続処理ごとに読み、#217のプロセス間変更通知に基づくメモリキャッシュは作らない。通常の失敗・部分更新を保持し、新しい永続依頼・自動retry・削除との強い順序保証を追加しない。実行結果は[作業記録](../../../plans/2026-11-07-note-timeline-174.md)にある。
