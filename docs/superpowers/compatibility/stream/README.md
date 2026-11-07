# 投稿WebSocket受信の固定本家比較

対象は本家 `8e07cf085adf7009583d234a208e30436f020e26` の `StreamingApiServerService`、`Connection`、`channel`、`main`、`home-timeline`、`NoteStreamingHidingService` と依存する純粋関数。#173の投稿・削除・通知を、#189のmain/homeTimelineとnote購読でクライアントへ届ける。

## 実装範囲

- native/app/miauth、case-sensitive Bearer優先query `i`、read:account、invalid401+challenge、suspended403、guest接続。
- connect/disconnect、main共有、homeTimelineのwithFiles/withRenotes、following.withReplies・followed channel・可視性・mute/block/renote/channel filter。mainはnotification/mentionだけをfilterし、reply/renoteへ同じfilterを追加しない。
- subNote/s/sr、unsubNote/un、参照count・1536件LRU、32channel上限、同ID置換、任意connected ack。削除購読はfollowersにmention/reply例外を加えず、認可metadataを外してnoteUpdatedを送る。
- TLはpublished snapshotを維持し、renote chainと各replyを個別にhideする。hiddenを含むpureRenoteはskipする。受信者ごとにcloneし、pureRenote先のmyReactionをcache/2秒/DB規則で取得する。mainはhidden noteだけ既存note公開read/render契約から再packし、show UseCaseを呼ばない。
- 10秒の関係snapshot、接続時/5分のactivityと休眠解除、1分ping・最後のpongからstrictに2分超でterminate。停止時はupgrade/WS/timer/subscriberと開始済み認証・facts・activity・renderを所有してdrainする。並列DB処理は一件が失敗しても他の開始済みqueryを待つ。

channelのrouting関係は10秒snapshot、本家NoteEntityServiceのfollowers本文hideは別のfollowing cacheである。新実装は後者を必要なfollowers本文に限定して現在DBから取得する。既存本家cacheの全invalidations/TTLを再実装した主張ではない。mute関係は本家cache fetcherと同様、期限切れrowをその場で除外しない。広域cache同期は#217。

同じpublication内の複数home購読は本文hide用のfollowing取得Promiseを共有する。取得は必要になるまで開始せず、次のpublicationでは再取得する。失敗は各購読のcatchで集約し、後続publicationの処理は継続する。

クライアントからの受信メッセージはguest/認証済みとも1 MiBまでとし、超過時は`ws`がclose code 1009で切断する。上限はfragmentの合計バイト数にも適用する。固定本家のWebSocketServerは`maxPayload`未指定で、今回使用する`ws` 8.22.0の既定値100 MiBより小さい上限を選んだ意図的差異である。connect/subNote等の制御メッセージに対して既定値の大きなbufferを許可しないためで、設定追加や送信イベントサイズの制限は行わない。

常にcloneすること、JSON `null` frameを安全に無視することは本家実装との小さい差異。本家はhide不要時に元参照を返し、null frameのdestructureでTypeErrorになる。未実装channelとchannel/ch書込・readNotificationは無視し、利用可能とは広告しない。publisher/DB間の永続retry・exactly once・Create/Delete順序を追加しない。

## 比較の再現

`upstream-probe.mjs` は指定checkoutの固定Git blob17件を取得し、実メソッドを実行する。Nest/cache/transportとpack/myReactionは狭いdoubleであり、本家サーバー全体や本家DB/Redis/workerを起動した比較ではない。全191観測には次slice候補のlocal/global/hybridも含み、今回の実装済み主張へ含めない。

```sh
UPSTREAM_ROOT=/path/to/upstream-checkout \
  OUTPUT_FILE=/tmp/backend-next-stream-source-observations.json \
  node docs/superpowers/compatibility/stream/upstream-probe.mjs
pnpm --filter backend-next test test/unit/stream/source-compat.test.ts
```

`source-cases.json` は上記出力からmain/homeTimeline、nested hiding、noteUpdated、対象接続を選んだ64ケース。固定sourceの入力と観測出力をそのまま保存し、CIでは同じ入力を新実装へ渡して一致を検査する。fixtureは期待値を新実装から計算しない。独立作業者はfull probe191観測と、immutable/alias/LRUを含む80比較で差分0件を確認した。

比較中に発見し修正した契約は、poll/replyを含むquoteをpureRenoteと扱わないこと、10秒routingと現在followers hideの分離、複数home購読の一件のreaction失敗が他購読を止めないこと。別のruntimeレビューではpending upgradeのTCP resetによる未処理ECONNRESETと、並列queryの早期rejectによるdrain漏れを再現し、それぞれ回帰テストを追加した。

最終reviewでは、hiddenなmain通知/mentionのrootがpublication後に削除されるとnull payloadを送る差異を実メソッド比較で発見した。現在はroot欠落で本家同様にrejectし、そのイベントを送らず、同じWSの後続イベントを継続する。actual readerを使う通知/mention単体2件と実PG/Redis/WSのキュー継続でRED→GREENを確認した。

## 実依存とプロセス検証

`test/integration/posting-websocket.test.ts` は実token/HTTP/PG/Redis/WSで作成→home/main mention+notification→購読削除、guest/他main漏洩抑止、受信者ごとのsnapshot/hide/myReaction、休眠解除とmute変更の10秒refreshを確認する。`streaming-lifecycle.test.ts` は実Redis/WSと明示clockでheartbeat/activity/停止時のpending auth/renderを確認する。

`test/processes/posting-websocket.test.ts` は通常HTTP子と通常workerを起動し、実HTTP作成→main/home受信→pollEnded通知WS受信とPG保存→実HTTP削除→noteUpdated、再接続、接続中SIGTERMを測定する。別子でpending認証中のTCP resetを再現し、未処理例外がないことを確認する。本家full processの同時比較とは区別する。

#189は他17channel・channel書込・chat/game/admin等、#177は通知API/既読/未読/push/移行、#174は検索等、#172は検索等の削除連携、#176は投稿全体の縦断が残る。今回の完了条件をこれらの完了に換算しない。
