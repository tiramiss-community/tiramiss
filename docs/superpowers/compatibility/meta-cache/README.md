# Meta cache (#317)

固定本家: `8e07cf085adf7009583d234a208e30436f020e26`。親#217、先行#290。本資料はMeta consumerと既存の連合callerだけを扱い、admin/update-metaやイベントproducerの完成を示さない。過去のactor/WebFinger等のreceiptは当時の測定として保持する。

`source-probe.mjs`は固定GitオブジェクトのMetaService constructor/fetch/onMessage/dispose本文を抽出する。Repository・transaction・Redis・timerはdoubleであり、本家full server/実PGの実測ではない。入力sourceのSHA256を`observations.json`へ保持し、最新ID、hit、noCache、body.after（rootUser:null）、無関係なイベント、取得/通知競合、取得失敗、300000ms周期、空DB初期化の9観測と停止を記録する。

```sh
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned/git-objects node docs/superpowers/compatibility/meta-cache/source-probe.mjs
pnpm --filter backend-next test test/unit/meta-cache.test.ts
BACKEND_NEXT_TEST_DB_PORT=55437 BACKEND_NEXT_TEST_REDIS_PORT=56397 pnpm --filter backend-next test:integration test/integration/meta-cache.test.ts test/integration/meta.test.ts test/integration/webfinger.test.ts test/integration/activitypub-actor.test.ts
```

実PG/Redisと通常のlistening HTTPでは、温まった値がDB変更だけでは変わらず、実際のinternal envelopeのafterでactor/WebFingerが200→403→200へ切り替わる。system actorのiconも通知の値を使う。配送callerは同じ通知で送信をskip/許可し、stats無効ではinstanceを登録しない。actor登録はstats通知に従ってusersCountを更新する。production-modeで作った別runtimeのHTTPは、通知を送らないDB変更を5分周期後に反映する。テストではintervalの時刻だけを進め、DB/Redis/HTTPは実際に動かす。

| 要求/対象inventory行 | 根拠 |
| --- | --- |
| boot-logging-config-telemetry:15 / instance-moderation:03 | shared receiver経由のafterで実HTTP/配送/登録callerが切り替わる。全領域のMeta読取り移行は主張しない |
| instance-moderation:01 | source9観測、unitのhit/noCache/競合/失敗、実DBの最新ID・空DB・同時初期化 |
| InternalEvent.metaUpdated | consumerのenvelope処理のみ。producer/update APIは対象外 |
| MetaService.ts:35 timer | production-mode runtime→周期→実HTTP応答、DB失敗の診断、resources.close後の停止 |

DB障害では温まったHTTPは値を使い、冷たいHTTPと明示noCacheは失敗する。既存HTTPテストのDB更新はfixture準備で明示再取得し、warm-cache DB障害が500になるという旧DB直読前提を修正した。これらの準備操作とは別に、上記の新規実HTTP試験が通知・周期による反映を確認する。

取得中の通知を後から古いDB結果が上書きする本家の挙動は維持する。周期の失敗だけはloggerへ報告し、明示取得はrejectする。停止はtimer解除・consumer解除に加えて開始済み読取りを待つ。後二者は既存の新runtimeの終了/診断方針へ接続した実装判断であり、承認済みの本家差異とは呼ばない。[UF-012/013](../../../backend-next/upstream-findings/packages/backend/src/core/MetaService.md)を参照。

追加child-process試験は作っていない。今回変更したcacheのtimer/解除と通常runtimeのcloseは実依存の同一プロセスで観測し、保留したDB読取りをcloseが待つ点はunitで検証する。Supervisorや子プロセスIPCの仕様は変更していない。

残範囲: admin/update-meta、全領域のMeta移行、他のinternal event/cache、#217/#176/#195/#114の完成。notes/createのpartial・postingComplete:falseを維持する。既存receiptは以下の限定successorを通じて当時の入力へ投影し、当時の実測と今回の実測を区別する。

## 今回の測定と履歴投影

[current-evidence.json](current-evidence.json)はruntimeの実装commit `1a7ff81026441b262d37c8171d381d39c45deddf`と、テストの空白だけを整えた測定commit `529ff21ba56e6cbd6e0c58aad980b2f854cd550f`を区別する。変更した旧27入力、新しいcache・unit・integration・source probe/observations、および既存Meta DB試験の計33入力を測定前後で照合した。単体41ファイル2182件、選択した実依存11ファイル564件、固定source9観測、build/typecheck/syncの成功logを個別SHA256へ結び付ける。以前の562成功/2失敗のrunは成功に書き換えず、今回の一括564成功は別runとして保持する。

[predecessor.json](predecessor.json)は基準`1adb04b0cf4d6efdb2537891df4ca2261359f1f6`から変わった、過去の測定に現れる27入力だけを一か所に保持する。新しいhelperはsealed receipt/predecessorと今回の33入力すべてを独立したgate開始時に検証し、その呼出し内のreaderも取得対象の現在のbytesを再照合してから新しいBufferで旧入力を返す。次のgateへ検証結果をキャッシュしない。JSONのparse cacheだけを使う。これは過去のreceiptやsource結果を更新・再実測した意味ではない。

既存のinternal-events・folders・pubsub・URL preview・instance-admin readerは、この限定した末端readerを通じる。既存readerの返す歴史mapのキーを増やさず、Git・subprocess・祖先readerへの逆依存は作らない。旧測定の未移植範囲や投稿partialは維持する。

inventoryは#317の5行だけを更新し、全領域の起動時Meta責任とproducerを含むイベント行をpartialに保つ。残る3行のverifiedは記載したcache取得・consumer・timerの証拠を指し、親#217や更新API全体の完成を表さない。

## CI fixture の追補（#597）

CIで旧fixtureの依存口と準備不足を検出した。workerのruntime mockは従来のMeta DB検索から`meta.fetch()`へ同じ材料を移し、配送前に例外で止まっていた3件と、その失敗の後続影響1件を解消した。終了順・保留した書込み・cleanup失敗の既存assertionは変更していない。

actor alias/key・配送queue・instance metadata・remote userの4結合テストは、直接DBへ書くMeta fixtureを操作前に明示再取得する。missing-Meta試験は独立したcold runtimeの実HTTPから初期化させ、403・1行・INSERTという検証を保持する。これらは通知のE2E証拠ではなく、前節の専用試験が通知/周期反映を担う。

[ci-fixtures-current-evidence.json](ci-fixtures-current-evidence.json)は、この5ファイルだけのNode26.4.0追補を持つ。worker11件、単体全119ファイル4371件、近傍結合4ファイル271件、結合全56ファイル1611件、型検査が成功した。各変更は適用対象のrunへ結び付け、unitはworker fixture、integrationは4結合fixtureを検証したと区別する。5入力は元の33入力へ追加せず、元のreceipt・27-file predecessor・source結果を保持したまま、[ci-fixtures-predecessor.json](ci-fixtures-predecessor.json)で基準`0081b37c6eec96225f25ca6502b25cdbc199c0db`の5旧入力へ別途投影する。

追補readerは5現在入力・sealed receipt/predecessor・存在する各logを照合し、取得対象も返却直前に再確認する。次回呼出しの検証を省略するcacheや祖先へのimportを作らない。履歴への投影は新しい実測への置換や、本家full server・親領域の完了を意味しない。
