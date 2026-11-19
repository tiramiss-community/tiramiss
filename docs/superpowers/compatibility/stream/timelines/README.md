# local / hybrid / global timeline channel（#456）

本家 `8e07cf085adf7009583d234a208e30436f020e26` の3 channel、共通Channelの判定、`NoteStreamingHidingService` とNoteEntityServiceのliteral hideメソッドを `upstream-probe.mjs` で実行し、148入力・出力とGit blob IDを `source-cases.json` に保存する。新実装から期待値を作らない。本家側のNest、Role取得、reaction照会、transport/cacheはdoubleであり、本家full serverのPG/Redis/WebSocket比較ではない。

## 実装と範囲

- 標準registryに3 channelを登録する。local/globalは匿名可、hybridはcredentialと`read:account`が必要。すべて非共有。
- 接続ごとに既存Roleの評価契約を使い、local/hybridは`ltlAvailable`、globalは`gtlAvailable`を取得する。本家同様、Roleポリシー拒否時は`pong: true`の要求だけ`connected`を返し、noteは購読しない。匿名hybridはRole評価前の資格確認で拒否し、`pong: true`でもackしない。既存購読は権限変更だけで再判定せず、再接続・同一ID置換で再取得する。
- localはローカルの公開・非channel投稿、globalは公開・非channel投稿、hybridは本人・following・公開local・following channelを選ぶ。可視性・mute/block・返信・pure renote・withFiles・withRenotes・withRepliesと匿名のログイン要求を本家と比較する。オプションは本家のnullish既定値とtruthinessを保ち、boolean型に限定しない。
- 配信は既存投稿producerの`notesStream`を使う。snapshotの本文hideと現在following確認、閲覧者別のrenote `myReaction`を維持し、Note再取得UseCaseを呼ばない。
- channelごとのRedis/EventEmitter listenerを追加しない。disconnect・ID置換・connection disposeで中央の配送先を除去する。非同期の権限取得が解除・置換・connection disposeの適用後に完了しても旧channelを復活・ackしない。通常WebSocketのフレーム処理は本家と同じ直列順序を保つため、権限取得中に受信した後続disconnect/置換フレームは先行connectの完了後に適用され、その前に旧connectのackが届く。ソケットcloseは直ちにdisposeする。

## 検証

`test/unit/stream/timelines.test.ts` は148 source観測を直接比較し、別の3件でRole再取得、非同期init中の切断・置換・dispose、不正params、匿名hybrid拒否を確認する。

`test/integration/timeline-source-websocket.test.ts` は同じ148入力を実Redisの既存producerから新サーバーの実WebSocketへ流し、wire JSONをsource観測と比較する。認証・関係facts・Role・反応照会は固定した入力のdouble。テストだけのpass-through wrapperで実connection.publishの完了を観測し、その後に同じWebSocketのping/pongで先行する送信が受信済みになるまで待つ。UGC-noneも固定時間待機を使わず処理完了後に非配信を確認する。UGC-noneの破棄条件だけを一時的に除去した回帰注入ではこの比較が失敗し、実装を復元すると成功した。

`test/integration/timeline-websocket.test.ts` の4件は実HTTPのnotes/create→既存producer→実Redis→WebSocketと、実PGからの認証・Role・関係factsを使う。

- 本人・匿名・following・非followingへのpublic/followers配信、不正params、匿名hybrid拒否、disconnect後の停止。
- Metaの拒否、Role上書き・期限切れ、接続済みchannelと再接続の違い。
- user mute・相手からのblock・renote mute、本人/匿名と異なる閲覧者のmyReaction。reaction APIは範囲外なのでreaction行・count/cacheをテスト準備としてPGへ保存する。
- 返信・pure renote・quoteの実投稿、独立したfiles/replies/renotesオプション。remote authorと添付ファイルのsnapshotは既存producerへ直接渡す。remote ingest・Drive uploadの完成を主張しない。

`streaming-lifecycle.test.ts` の10件で共有subscriber・timer・socket解放、1 MiB上限、heartbeat、pending処理の終了待機も再検証する。追加した実WS2件では権限取得を保留し、後続のdisconnect/同ID置換は旧connectのack後に適用され、その後のnoteを配信しない本家相当の順序を確認する。2026-11-19、base `5fdc1702d2568c2df9dc2f33411fd11ecc35db04`、専用Compose `tiramiss-timeline456`（PG55456/Redis56456）で実行した。全stream単体296件、上記結合15件、build/typecheck・upstream sync・shippingはPASS。PGの既存query並列実行deprecation warningが出る。

## 再実行

```sh
UPSTREAM_ROOT=/path/to/checkout-with-pinned-objects \
  node docs/superpowers/compatibility/stream/timelines/upstream-probe.mjs
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/stream
BACKEND_NEXT_TEST_DB_PORT=55456 BACKEND_NEXT_TEST_REDIS_PORT=56456 \
  docker compose -p tiramiss-timeline456 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=55456 BACKEND_NEXT_TEST_REDIS_PORT=56456 \
  pnpm --filter backend-next test:integration test/integration/timeline-source-websocket.test.ts test/integration/timeline-websocket.test.ts test/integration/streaming-lifecycle.test.ts
```

probeの`OUTPUT_FILE`で再測定先を変えられる。本件は#456の3 channelの範囲。HTTP timeline、他channel、#185/#189全体、#176/#127の投稿完成、切替#139は未完了。[既存stream比較資料](../README.md)の常時clone・frame上限・本文hide用following照会などの既知差異を引き継ぐ。CHANGELOG候補: 新バックエンドでlocal・hybrid・globalタイムラインのストリーミング購読に対応。
