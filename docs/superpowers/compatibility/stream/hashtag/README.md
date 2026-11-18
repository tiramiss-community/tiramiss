# hashtag channel（#459）の固定本家比較

本家 `8e07cf085adf7009583d234a208e30436f020e26` の `HashtagChannel`・共通Channel判定・`NoteStreamingHidingService`・NoteEntityServiceの本文hideメソッドと純粋関数を実行する。`upstream-probe.mjs` はGit blobから読み込み、入力と出力を `source-cases.json` に保存する。Nest/transport/cache・反応照会はdoubleであり、本家のfull HTTP/PG/Redisサーバーを起動した比較ではない。

## 実装と比較範囲

- 匿名可・非共有の `hashtag` を標準registryへ登録する。既存 `notesStream` だけを受け、queryはOR of AND、queryの語をNFKC・小文字化し、投稿タグを小文字で照合する。
- `q` は文字列を1つ以上含む配列の配列。空の外側配列は有効で、何も配信しない。不正queryは生成時に拒否し、購読数を消費せず、`connected` を返さない。同一IDの古い購読は先に破棄する。
- 可視性、匿名の本人/直接reply/renoteのログイン要求、user/instance/channel mute、block、pure renote muteを維持する。snapshotの本文hideと受信者のrenote反応補完は既存stream契約を使い、Noteを再取得するUseCaseは呼ばない。routingのfollowing snapshotと本文hide用の現在following照会は区別する。
- 各購読はconnectionのpublication配送を使い、channel専用のRedis/EventEmitter listenerを追加しない。disconnect・同ID置換・connection disposeで配送先を除去し、反応照会が遅れて完了しても旧購読へ送らない。

40 source観測を新実装の単体へ直接入力し、匿名・AND/OR・正規化・不正query・可視性・mute/block・reply/renote/quote・本文hide・反応補完を比較する。別の単体で複数購読の独立性、非対象stream、disconnect後の非配送、処理中の切断、不正queryによる購読枠消費とID置換を検査する。

## 再実行

```sh
UPSTREAM_ROOT=/path/to/checkout-with-pinned-objects \
  node docs/superpowers/compatibility/stream/hashtag/upstream-probe.mjs
pnpm --filter backend-next test test/unit/stream
```

`OUTPUT_FILE` で比較出力先を変えられる。fixtureは新実装から期待値を計算しない。

```sh
BACKEND_NEXT_TEST_DB_PORT=55459 BACKEND_NEXT_TEST_REDIS_PORT=56459 \
  docker compose -p tiramiss-hashtag459 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=55459 BACKEND_NEXT_TEST_REDIS_PORT=56459 \
  pnpm --filter backend-next test:integration test/integration/hashtag-websocket.test.ts test/integration/streaming-lifecycle.test.ts
```

2026-11-18、base `c0123d10df` で専用Compose `tiramiss-hashtag459` とPG55459/Redis56459を使用した。新しい実HTTP投稿→既存producer→Redis→実WebSocketの1件で、guest/authの一致配送、非一致抑止、followersのguest抑止、不正queryのackなし、disconnect後の停止、別streamの抑止を確認した。既存lifecycle8件も成功。stream単体145件、build/typecheck・upstream sync・shipping検査も成功した。PostgreSQLのquery並列実行に関する既存deprecation warningが出るが失敗はない。

本件はhashtag購読の範囲であり、hashtag集計producer、他channel、#186/#189全体、#176/#127の投稿完成、切替#139の完了を意味しない。既存streamの1 MiB frame上限、常時clone、本文hideの現在following照会などの既知差異は親の[比較資料](../README.md)を引き継ぐ。
