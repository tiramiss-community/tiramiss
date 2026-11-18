# users chart (#319)

固定本家 `8e07cf085adf7009583d234a208e30436f020e26`、実装基準 `63854ab4c0`。既存 users の hour/day テーブルを利用し、local/remote の total/inc/dec、`charts/users` GET/POST、20分周期・停止時のflushと実User件数によるresyncを追加する。

通常 `notes/create` の公開remote actor初回取得を実callerとして接続した。本家 `ApPersonService.createPerson` と同じく、actor保存またはcanonical重複復帰後、instance登録開始→users chart→hashtag開始の順でbufferへ加算する。既存のfresh lookup・stale refresh・保存失敗では加算しない。canonical重複復帰はUser行を増やさずにchartを増やす本家の挙動を保持し、resyncで現在値へ補正できる。chartはMetaのremote-userチャート設定では抑止しない。

保存と補間は既存note chartと同じstoreを利用する。totalはinteger、inc/decはsmallintで上下限へ丸め、初回行は直近totalを継承する。flush時刻のUTC periodへ計上し、bufferを切り離してから保存する。片方のUPDATEだけ確定する可能性と失敗bufferの破棄を維持し、新たな再投入保証を追加しない。共有timerは両chartの保存完了を待ち、一方の失敗でも他方を保存する。

resyncはhostがnullかどうかだけで実User行を数え、削除済み・凍結・systemアカウントも数える。現在hour/dayのtotalだけを上書きし、inc/dec・過去行・未flush bufferを変更しない。bufferが残っていれば次のflushがその現在値へ加算される。resyncは実体のある公開モジュール操作として提供し、system scheduler・管理jobへの接続は#478に残す。

GET/POSTのspan・limit・offset、匿名GETの1時間cache、任意credential認証、GET数値JSON castを既存chart HTTP adapterで共有する。offset=0は本家同様に現在窓を参照し、未知userの検索は行わない。

`source-probe.mjs` は固定Git blobからUsersChartのupdate/tickMajorとChartの読取をTypeScript transpileして実行する。4 update、2実件数tickMajor、24 cursor観測とsource SHA-256をfixtureへ保存し、新実装のunitと照合する。Repository doubleを使うmethod観測で、本家full HTTP server/PGの測定ではない。

実依存検証は専用Compose `backend-next-b319`、PostgreSQL 18/Redis 8、ports 55539/56439を使用。通常listening HTTPでremote actor取得→buffer→flush→charts/users、fresh/stale・canonical重複復帰・Profile保存失敗とresyncを確認する。別の実PG試験ではhour/day境界・既存履歴/欠損補間・同時初回claim・型上限・片側UPDATE失敗・停止flush・schema差分0を確認する。

local signupとdeleteAccountの実callerは未移植であり、それぞれの業務側とproducer proof (#583) に残す。active-users/PV、system scheduler、全chart、NodeInfoやstats全体の完成を含まない。既存のnotes/create partial・postingComplete:falseと#176/#127/#195/#114の未完了を維持する。

再実行:

```sh
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
node docs/superpowers/compatibility/users-charts/source-probe.mjs
pnpm --filter backend-next test test/unit/chart test/unit/federation test/unit/note/create-note.test.ts test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=55539 BACKEND_NEXT_TEST_REDIS_PORT=56439 docker compose -p backend-next-b319 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=55539 BACKEND_NEXT_TEST_REDIS_PORT=56439 pnpm --filter backend-next test:integration test/integration/users-charts.test.ts test/integration/remote-user.test.ts test/integration/note-charts.test.ts
node scripts/check-shipping.mjs --base 63854ab4c0
```

2026-11-19 R4検証: unit **5510成功・既存skip 1件 / 159 files**、実PG/Redis・通常listening HTTPと既存note chartの結合 **124成功 / 3 files**。build/typecheck、source 4 update・2 resync・24 read、変更ファイルlint・SPDX・locale safetyを実行する。個々の実ログと入力hashはcurrent-evidenceへ記録し、旧note chartやremote actorの過去receiptを書き換えない。比較記録の互換投影は正確に一致した入力だけを基準のbyteへ戻し、未知の追加変更を同じ測定結果として扱わない。
