# 投稿hashtag producerの固定本家比較

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。`reference-hashtag.mjs` はGit blobからTypeScript ASTで実メソッドを抽出して実行し、87件の観測を `source-observations.json` に保存する。期待値の生成にbackend-nextの実装は使わない。TypeScript・MFM・RE2の実行依存はworkspaceから解決する。MFM 0.27.0とRE2 1.27.0は固定本家backendの指定と同じであり、実際に使用したversionもJSONへ記録する。

## 再実行

repo rootから実行する。`UPSTREAM_ROOT` は固定SHAを参照できるGit repositoryを指定する。作業ツリーの内容は読まず、`git show <SHA>:<path>` で取得する。

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream \
OUTPUT_DIR=/tmp/tiramiss-hashtag-reference \
node docs/superpowers/compatibility/note/hashtag/reference-hashtag.mjs
cmp /tmp/tiramiss-hashtag-reference/source-observations.json \
  docs/superpowers/compatibility/note/hashtag/source-observations.json
```

2026-11-07実行: 87件成功。外側の `TZ=Asia/Tokyo` でも再生成し、JSONの一致を確認した。既定の時刻環境をUTCへ固定し、`input.timezone` がある3観測だけ指定のtimezoneで実行する。固定blob識別子はJSONの `sources` に記録する。

実行するsourceは、`HashtagService` の更新・private SQLメソッド・ランキング、`FeaturedService` のhashtag更新・window計算、`NoteCreateService` の完全な `create`・`insertNote`・`postNoteCreated` と `NotificationManager`、`NoteDeleteService.delete`、`UtilityService.isKeyWordIncluded`、`extractHashtags`・`normalizeForSearch`・配列helperとtext保存上限である。`create` の一部分をコピーした抽出関数ではない。

DB/Redis接続・repository・無関係なService・ID生成・時刻・postのscheduleはdoubleである。SQLは実メソッドが生成した全文と引数を記録するが、DB結果はそのSQLのmembership処理を模したモデルである。Redisのscore/set/HLL/TTLもモデルであり、`hllMembers` は正確な集合を記録する。実RedisのHLL概数や実PostgreSQLの同時実行を測った証拠ではない。本家full server/実DB/実Redisを動かした比較とも区別する。createのsetImmediateは即時resolveするdoubleなので、その観測を作成応答の非同期待機の証拠にはしない。後述の直接post/Hashtag呼出の保留Promiseによるlifetime観測を根拠にする。

## source契約と行根拠

以下は固定SHAの `packages/backend/src/` 内。

- `core/NoteCreateService.ts:573–609`、`misc/extract-hashtags.ts:9–13`: textの保存上限処理・trim後、text→CW→poll choicesの順にMFMから抽出し、raw表記で重複を落とす。`apHashtags` は空配列も含めて優先する。raw tagのUnicode code point数が128以下のものを残して先頭32件にする。
- `core/NoteCreateService.ts:645–732`、`misc/normalize-for-search.ts:6–10`: 保存時にNFKC→小文字化し、正規化後には重複排除しない。`#Ａ #a #A` は3個の `a` を保存する。正規化はtrimしない。raw長の検査より後にNFKCがあるため、128個の `㍿` が512文字のNote INSERT候補tagになることもある。`models/Note.ts:192–196` のtags列はvarchar(128)[]、`models/Hashtag.ts:15–19` の名前列もvarchar(128)であり、doubleは両方の長さ制約を評価しない。JSONの `savedTags` はこの観測ではdoubleへ渡された候補値を示し、実DBへの保存成功を意味しない。実PGではNote INSERTで失敗してpost開始へ進まない入力であり、新実装の実PG検証と区別する。
- `core/NoteCreateService.ts:634–641,771–774`: Noteを先に保存し、abort可能なsetImmediateでpostをscheduleしてNoteを返す。postは **data.visibility** がpublic/homeのときだけ `updateHashtags(user,tags)` を開始する。保存Note側のvisibilityを直接見る分岐ではない。silentの分岐とpackより前なので、silentや後段pack失敗でも更新は始まる。bot・remote author・localOnly・reply・channelの有無やsensitive channelによる追加除外はない。
- `core/HashtagService.ts:56–60,74–101`: tagを1個ずつawaitして更新する。各tagを再び正規化し、DB更新より先にランキングをawaitせず開始する。SQL失敗は後続tagを止めるが、そのtagのランキングは独立して進み得る。tag表全体のtransaction、再試行、永続依頼はない。
- 同 `103–137`、`core/entities/UserEntityService.ts:62–63`: master QueryRunnerで一つの `INSERT … ON CONFLICT(name) DO UPDATE` を実行する。mentionedのtotalとlocal/remoteの各配列にIDがまだない場合だけ、対応する配列へ追加してcountを+1する。local判定は `host == null`。同じuserの複数Note・重複tagはpost数ではなくunique userのmembershipになる。totalとlocal/remoteは別々の既存配列で判定する。既存の不整合なcountを配列長から再計算しない。attached列は変更しない。query・finally内のreleaseをawaitする。
- 同 `169–203`: 設定hiddenTagsを正規化した完全一致と、正規化済みhashtagに対するsensitiveWords一致はRedisランキングだけを除外する。DB更新は残る。sensitiveWords自体を追加で正規化しない。`core/UtilityService.ts:84–108` のraw空白区切りAND部分文字列、RE2正規表現、不正regexのfalseをそのまま使う。
- 同 `175–202`: 10分chart windowは、処理開始時にlocal `setMinutes` で切り下げてからUTCの `YYYYMMDDHHmm` にする。`SISMEMBER hashtagUsers:<tag> userId` が数値1ならranking・HLL・set更新をすべて省略する。未登録なら独立したfeatured +1を開始し、pipelineで `PFADD hashtagUsers:<tag>:<window> userId` / `EXPIRE 259200 NX`、`SADD hashtagUsers:<tag> userId` / `EXPIRE 3600 NX` を送る。pipeline.execはawaitしない。KathmanduなどUTC offsetが10分の倍数でないtimezoneではUTC基準の10分境界とずれる。
- `core/FeaturedService.ts:15–17,27–45,111–114`: epoch `2023-01-01T00:00:00Z` から1時間単位のfloor windowを作る。通常Redisの別MULTIで `ZINCRBY featuredHashtagsRanking:<window> 1 <tag>` と `EXPIRE 10800 NX`。chart windowはSISMEMBER前、featured windowはその後に時刻を読むため、SISMEMBERをまたいで時刻が進むと古いchartと新しいhour rankingへ分かれる。
- `core/HashtagService.ts:180–202`: shared users setの1時間expiryは初回writeに固定され、ユーザー単位やslidingの期限ではない。後から加わったuserもset全体の期限で消える。hourやchartの境界を超えて同一userの加点が省略されることもある。SISMEMBER→SADDは原子的ではなく、同じuserの同時呼出は両方通過してscore+2になり得る。DBのunique membershipとHLL/setの重複排除は別であり、ここへonce-only保証を追加しない。
- 同 `74–101,180–202`、`core/FeaturedService.ts:34–45`: SQL rejectでも先に開始したRedis更新は残り得る。SISMEMBER、featured exec、chart execのrejectはsourceではdetachedであり、SQLの成功を取り消さない。execが返すcommand error配列は検査しない。queryとreleaseが両方rejectした場合はfinally内releaseのerrorが残る。
- `core/NoteDeleteService.ts:63–128`: quiet/通常・DELETE成功/失敗のいずれにもhashtagの減算・membership削除・Redis purgeがない。削除後に遅れて開始済みの作成更新が適用され得る。sourceのdetached処理を、新実装で既存の期限までdrainして診断することは[投稿の最小契約](../../../../backend-next/posting-contract.md)に従う。未処理rejectionを再現する要求にはしない。

HashtagService自体にmembership cacheはない。注入されたmetaをランキングの呼出ごとに読む。`server/api/endpoints/hashtags/trend.ts:17` の60秒response cache、Featuredの2-window reader、`HashtagService.getChart/getCharts` のchart読出しは閲覧#186の範囲であり、このproducer sliceに追加しない。

## corpusと新実装への接続

JSONの `observations[].input` が入力、`calls` が実sourceのコマンドとSQL、`state` がdoubleの状態である。Redisの `zincrby` / `pfadd` / `sadd` / `expire` は `args` 配列、SISMEMBERは `key` / `member` / `result`、queryは `sql` / `params` を記録する。`state.dbRows`・`scores`・`sets`・`hllMembers`・`ttl` はそれぞれ名前やRedis keyで引く。TTLにはseconds/setAtMs/expiresAtMsを残す。正確なSQL文字列や生成IDを新実装の実装方法として要求しない。

| kind / 件数 | 観測するもの |
| --- | --- |
| `update` 29 | local/remote・NFKCと衝突・空tag/trimなし・hidden/sensitive・10分/hour/day/epoch境界前後・timezone3種・独立membershipとattached保持 |
| `post` 14 | public/home/followers/specified・silent・remote/bot/localOnly/reply/channel・空tag・pack失敗・data/Note visibilityの分岐元 |
| `create` 12 | 完全なcreate/insertNoteによるtext/CW/poll順序、重複、MFM、AP override、128codepoint・32件・NFKC拡張、text上限。`savedTags` と `rawPostTags` を記録 |
| `sequence` 7 | repeat・別user・NX・shared expiry・hourまたぎ抑制・local/remote・meta再読込 |
| `failure` 8 | query/release/両方失敗、SISMEMBER/featured/chart reject、MULTI/pipelineのcommand error配列 |
| `lifetime` 6 | 4つのdetached早期settlementと2つのawaited negative control |
| `race` 2 | 同一userのSISMEMBER同時通過と、chart/featuredの時刻読取境界 |
| `delete` 4 | quiet×DB失敗の全組合せでmembership/ranking cleanupなし |
| `profile` 5 | attachedとmentionedの分離、profile add/removeと除去時の正加点開始。後続callerの境界資料 |

`lifetime-*` は実際にdependency Promiseを保留し、解放前のentry settlementを測る。updateのSISMEMBER/featured exec/chart exec保留とpostのSQL保留はsettled=true、同じgateを直接awaitするupdate(SQL)・featured(exec)のnegative controlはfalseをassertする。すべてfinallyでgateを解放し、entry終了と後続microtaskを待つ。単にsourceを読んでdetachedと記録したケースではない。`race-concurrent-same-user-admits-twice` も2個のSISMEMBERが0で保留されたことをassertしてから解放する。

通常の成功`update`は入力 `user,tags,nowMs,meta?` とコマンド/stateを、新実装のpolicy/adapterへ直接照合できる。`sql-independent-membership-and-preserved-attached` だけ初期行 `input.initial` を持つ。timezone観測は `input.timezone` も適用する。`post`には `user,note,data,silent,tags,nowMs,mode` があり、`post-pack-fails-after-start` 以外13件は通常成功のrouting比較に使える。`create`は既存の抽出/保存機能への比較資料であり、このsliceで新たな抽出経路を作る要求ではない。failure/lifetime/race/profile/deleteを含む87件すべてが新実装へ直接一致したという意味ではない。新実装が実際に参照する観測件数と、実PG/Redis/HTTP/processで別に検証する範囲は実装計画・テストに記録する。

## profile・管理・閲覧と残る範囲

`HashtagService.updateUsertags:62–71` は新しいprofile tagをすべてattachedへ追加し、以前のraw tagのうち新配列にないものを減算する。減算も先にランキング更新を正方向で開始する。`139–167` は該当IDがある配列/countだけを減らし、行を消さない。local `i/update.ts:506–530` はdescriptionから抽出・正規化して先頭32件とし、user保存前にdetachedで呼ぶ。remote `ApPersonService.ts:324,460,521,630` も同じcallerを持つ。これらのAPI/受信を接続したという証拠にはしない（#180/#195）。raw旧tagと新tagの正規化collisionは追加後に減算され得ることもboundary corpusに残す。

`MetaService.ts:132–144` は新たなhiddenTagsをnextTickでランキングから除く。`FeaturedService.ts:80–88,141–144` はcurrent/previousの2windowから削除する。producerのhidden除外と管理更新時cleanupは別のcallerであり、今回後者の運用経路まで追加しない。

閲覧・検索API/トレンドcacheとchart readerは#186、profile/remote callerは#180/#195、admin metaは該当管理領域、antenna等の#174残範囲、最終削除連携#172と投稿縦断#176は別に残る。再構築#132/#133では、現在のNote/Userだけからshared setへの過去の参加順・初回expiry・処理時刻window・失敗/同時通過によるscoreを厳密に復元できない。現存Noteからmentioned membershipを近似することと、過去のunique-user履歴を再現することは区別する。attached membershipはprofile由来であり、Noteから再構築しない。独自のreplay、永続履歴、Create/Delete順序保証をこの資料のために追加しない。
