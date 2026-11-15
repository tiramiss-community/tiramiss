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

残範囲: admin/update-meta、全領域のMeta移行、他のinternal event/cache、#217/#176/#195/#114の完成。notes/createのpartial・postingComplete:falseを維持する。既存receiptの現在ソースへの投影検査は、今回のソース差分に対する限定successor整備が別途必要である。
