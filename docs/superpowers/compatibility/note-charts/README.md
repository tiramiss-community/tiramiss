# notes / per-user-notes の実投稿接続（#274）

固定本家 `8e07cf085adf7009583d234a208e30436f020e26`、実装基準 `c0123d10df`（#273 マージ後）。`notes/create` の保存後処理と `notes/delete` の削除前処理を、notes / perUserNotes のメモリ buffer、既存4テーブル、`charts/notes` / `charts/user/notes` の GET / POST へ接続する。通常起動した各HTTP/worker子が20分周期と終了時にflushする。

## 実装した契約

- local/remote別のtotal/inc/dec/normal/reply/renote/withFile。replyとrenoteは同時に加算でき、添付数は1件以上なら1。本家のsilent作成は両系列を更新し、quiet削除は両系列を抑止する。今回接続した通常HTTPはsilent=false / quiet=false相当。
- 作成時のperUserNotesはspecifiedを除外し、remoteはMetaの`enableChartsForRemoteUser`で制御する。削除時は本家どおりspecifiedも減算する。localOnlyではchartを抑止しない。
- 既存hour/day行へ加減算し、初回だけRedis lock下で行を作成する。直近行のtotalを引き継ぎ、他指標を0で開始する。notesはinteger、perUserNotesのtotal以外はsmallint。加減算はbigintへ拡幅して列の上下限へ丸める。
- bufferはnotes→perUserNotesの順に各系列の保存開始直前に切り離す。先行notes保存中に来たper-user差分は同回へ含まれ、同じ到着のglobal差分は次回へ回る。失敗分の再投入・永続buffer・復元保証を追加しない。両spanをclaimできてから更新を開始し、一方のclaim失敗では他方も加算しない。UPDATEは別文なので片方だけ確定する可能性を残す。開始済みDB処理は終了待機のため最後まで待つ。lock解放失敗は診断へ分離し、claim成功済みの差分更新を妨げない。
- 集計先はflush時刻（UTC）。境界前に受けたbufferを次の時間へ集計する本家の既知挙動を維持する。API読取りはbufferをflushせず保存済み行だけを見る。
- 最新順、1–500件（既定30）、hour/day、offsetの既定nullと0の扱い、epoch投影で本家dateUTCが投げる負offsetの500、totalだけの欠損補間。存在しないuserIdも空系列を返し、利用者を照会しない。GETの数値JSONキャスト、匿名GETの1時間cache、認証失敗を既存共通契約へ接続する。
- 自動DDLを追加しない。4 EntitySchemaを通常DataSourceと読取り専用`check-schema`へ登録する。既存migration/schemaの差分0を確認する。

## 比較と実測

`source-probe.mjs` は固定Gitオブジェクトから本家の2 producer `update`メソッドとChartクラスを読み、TypeScriptをtranspileして実行する。32 update（local/remote・加減算・normal/reply/renote/both）と24 read（hour/day・件数・境界/中間/過去/未来/epoch異常offset）の出力と入力SHA-256を`source-observations.json`へ固定する。readはRepository doubleと明示clockを使う。通常unitはGit不要でこのfixtureと新実装を照合する。schemaは#273の固定manifestに4定義とも一致することをunitで確認する。

実PostgreSQL 18 / Redis 8のintegrationは、実HTTPルータで作成→buffer→flush→chart GET→削除→flushを通す。specified作成除外/削除減算、別接続からの同時初回作成、既存履歴の持越しと欠損、integer/smallint clamp、片側UPDATE失敗の先行確定とbuffer破棄、unlock失敗/未応答時の両span更新と失敗診断、保存済みnoteHost/現在authorHostの分離、day claim失敗時のhour非加算とbuffer破棄、受理済み投稿の終了待機と最終flush、全登録schemaの差分0を確認する。timerはfake clockで20分周期・失敗診断・再周期・終了時の待機を試す。既存削除integrationも回帰確認する。

既存create-noteはレスポンス描画後にafterSavedを開始するため、描画待ちがflush境界をまたぐと本家setImmediate起点との差により計上窓が変わり得る。この起点差の解消・縦断比較は残件として保持する。

2026-11-18の最終検証: 近傍unit 75件（chart・通常HTTP root・削除・保存後処理）、実PG/Redis integration 22件（chart 10件と既存削除12件）、build/typecheck、source32 update/24 read、変更ファイルlint・SPDX・localeがPASS。DB schema比較はintegrationに含む。初回検証で見つけたperUserNotesのsmallint型不一致を修正して再測定した。

これは本家full server/PGとの同時比較、実ネットワークlistening/Supervisor停止試験ではない。固定本家method比較と新実装の実PG/Redis・HTTPルータ検証を区別する。

## 残作業と扱い

**#274 はRefsとして継続する。** 実装済みの通常ローカル投稿/削除は利用できるが、remote作成の通常入口、silent作成、quiet削除の入口は既存移植側にない。remote設定・visibilityの業務分岐はunit/storeで確認したが、実remote投稿callerからの縦断比較は未完了。これらの入口が#176 / #195側で揃ってから#274で残るcaller比較を行う。通常削除はquiet=false相当であり、quiet=trueを実装済みと扱わない。

Redis lock timeout・本家full serverとのAPIエラー本文比較・Supervisor signal停止は未検証。system scheduler登録、tick/resync/cleanは#478、他10系列は#200の各子が所有する。Chart / ChartManagement全体の完了ではない。既存のnotes/create partial・postingComplete:falseと親#176/#127/#195の未完了を維持する。

## 再実行

```sh
pnpm --filter backend-upstream build
pnpm --filter backend-next typecheck
pnpm --filter backend-next build
node docs/superpowers/compatibility/note-charts/source-probe.mjs --check
pnpm --filter backend-next test test/unit/chart test/unit/note/delete-note.test.ts test/unit/note/post-save.test.ts
BACKEND_NEXT_TEST_DB_PORT=55474 BACKEND_NEXT_TEST_REDIS_PORT=56474 docker compose -p tiramiss-note274 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=55474 BACKEND_NEXT_TEST_REDIS_PORT=56474 pnpm --filter backend-next test:integration test/integration/note-charts.test.ts test/integration/note-delete.test.ts
BACKEND_NEXT_TEST_DB_PORT=55474 BACKEND_NEXT_TEST_REDIS_PORT=56474 docker compose -p tiramiss-note274 -f packages/backend-next/compose.test.yml down
node scripts/check-shipping.mjs --base c0123d10df
```

並行セッションでは専用Compose名・未使用portを使う。fixture更新はsource入力と観測差分をレビューしてから`--write`で明示実行する。

## 既存比較記録の参照更新（PR #628 のCI修正）

`773ba79f2fadc7eee8a61fb40975518e283eb446` の実コードで全unit 5032件成功・既存skip 1件（145 files）、投稿/削除/chart/通常HTTPの実PG/Redis結合86件（4 files）、Meta初期化の結合3件とプロセス5件を測定した。`compatibility-predecessor.json` はこの実測のログhash・現行23入力hashと、#274で変更した既存9ファイルから基準`c0123d10df`へ戻る有限なbyte patchを保持する。旧証跡の件数・receipt・runtimeRevisionを新しい測定へ書き換えない。

既存のnotes pagination・actor/Meta・posting証跡を読む際だけ、この9ファイルの**正確に一致する現在hash**を基準のbyteへ投影し、それより古い各既存guardを通す。一致しない入力は変換せず既存guardへ渡して拒否させる。post-save idleの単独検証leafはbuiltins限定を維持し、chart dispatch追加の2箇所だけを固定hashとanchorで戻す。32 producer / 24 cursorのcase件数・一意な入力組・epoch異常4件も固定し、観測JSON・source probe・#273 schema manifestのhashを実測へ結び付ける。現在コードの検証は新しい`note-charts-contract.test.mjs`が独立して担当し、全23入力のdrift・新規記録seal・存在する実ログの改変を拒否する。Gitや過去checkoutがなくてもCIから検証できる。

```sh
node --test scripts/note-charts-contract.test.mjs
node --test scripts/*-contract*.test.mjs
node scripts/backend-contract-inventory.mjs --check
```

契約全体の初回失敗ログは`/tmp/tiramiss-274-contract-tests.log`、再検証ログは`/tmp/tiramiss-274-contract-tests-r4.log`。実測ログは新規JSONの`runs`に列挙する。host上のログがないCIでは、commitされた記録と固定hashで検証し、存在するログはhashを照合する。これによって未実装のremote/silent/quiet callerや本家full-server比較を完了扱いにはしない。

契約全体R4は791件中790成功・既存skip 1件・失敗0（約187秒）。その後の観測corpus改変検知追加は新規contract3件で再検証し、空配列・1件欠落の両方を拒否した。
