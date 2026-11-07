# 投稿からの antenna producer (#174)

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の Git blob から実際のクラス・メソッドを抽出して実行する。[reference-antenna.mjs](reference-antenna.mjs) が再実行用 probe、[source-observations.json](source-observations.json) が184件の観測結果。各入力ソースの Git blob hash と、PG probe が使用する TypeORM 1.1.1 の対象ファイルの SHA-256 を保存する。

実行対象は AntennaService のクラス全体（constructor、subscriber listener、lazy cache、disposeを含む）、実際の bindThis、Acct、UtilityService のアカウント変換、FanoutTimelineService.push、GlobalEventService の publish、完全な postNoteCreated/NotificationManager と NoteDeleteService.delete。DB/Redis・時刻・random・他機能は double。末尾5件だけは、本家の MiNote/MiChannel の実際の decorator・constructor、insertNote と TypeORM/PostgreSQL を使う。User/DriveFile は関係先の ID だけを持つ probe Entity に置き換える。本家 full server、HTTP、実 Redis、WebSocket を実行した比較ではない。

```sh
SOURCE_PG_URL='postgres://postgres:foundation-test-only@127.0.0.1:55483/backend_next_test' \
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream \
OUTPUT_DIR=/tmp/antenna-source \
node docs/superpowers/compatibility/note/antenna/reference-antenna.mjs
```

`UPSTREAM_ROOT` は固定コミットを保持する Git repository。ソースの抽出には Git オブジェクトを使い、作業ツリーのソースは読まない。一方、PG probe は `UPSTREAM_ROOT/packages/backend/package.json` を基点に、作業ツリーの `node_modules` から `typeorm` と `pg` を解決する。保存済みの184件を再生成する場合は、固定コミットをcheckoutし、`pnpm install --frozen-lockfile` で依存をインストールしておく必要がある。インストール済みTypeORMの版が固定コミットの定義と一致することを検査し、その実装ファイルのSHA-256も記録する。

`SOURCE_PG_URL` は専用テスト PostgreSQL の管理接続で、probe 自身が一意の DB を作成し、終了時にその DB だけを削除する。共有・本番 DB を指定しない。PG URL を省略した場合は DB を伴わない179件だけを実行し、`databaseEvidence.executed=false` と未実行理由を出力する。保存済みの184件を再生成するには PG URL が必要。PostgreSQL の版は観測値なので、別の版を使う場合はその差も記録する。

新実装の unit が保存済み `source-observations.json` を読むだけなら PostgreSQL・本家 checkout とも不要。PG 接続が必要なのは本家側5件の保存 payload を再計測する場合だけで、通常の fixture 照合の前提にはしない。

## 本家の境界

`NoteCreateService.ts:634–641` は保存成功後に setImmediate で後続を開始して保存結果を返す。`postNoteCreated:779–784` は通常 TL の開始直後に `{...note, channel:data.channel??null}` と作成時の作者を antenna へ渡す。`!silent`（836行）と pack（840行）より前なので、silent、pack 失敗、localOnly、remote、public/home/followers/specified を producer 開始の共通拒否条件にしない。純 Renote も元投稿ではなく新しい Renote 本体を判定する。

`AntennaService.ts:116–208` の順序付き判定は以下のとおり。先の拒否条件で戻る場合、後段の following/list 読み取りも行わない。

| 判定 | 拒否条件 |
| --- | --- |
| sensitive channel | `excludeNotesInSensitiveChannel && note.channel?.isSensitive`。channelId だけでは判定しない |
| bot / local | excludeBots と作者 isBot、localOnly と作者 host != null。Note.localOnly とは別 |
| reply | !withReplies と replyId != null |
| specified | 作者自身でも明示 audience の owner でもない |
| followers | 作者自身でも owner の following でもない。自身の場合も following fetch は先に実行 |
| src | all/home は追加条件なし。list は listId と現在の membership が必要。users は一致必須、users_blacklist は一致で拒否 |
| include | 空文字を除いたグループがある場合、text/cw が両方 null または一致グループなし |
| exclude | 空文字を除いたグループがある場合、text/cw が両方 null または一致グループあり |
| file | withFile と fileIds が存在し length=0。fileIds 未設定は通る |

keywords はグループ間 OR、グループ内 AND の部分文字列一致。`text + '\n' + cw` を検索し、caseSensitive=false のときだけ両側を lowercase にする。空白の trim、正規表現、MFM/投票/添付/元投稿の検索はない。include/exclude の空グループを除いた結果が空なら条件なし。expression は未評価。src=home の following 条件は TODO のままなので追加しない。アカウントは `Acct.parse` → `getFullApAccount` → lowercase。ローカル省略、明示自ホスト、IDNA を実関数で比較する。

`AntennaService.ts:99–110` は全定義の判定を Promise.all で待ち、すべて成功してから pipeline を作る。1件の matcher reject は全書き込みを止める。空一致でも空 pipeline を exec する。一致した順に `antennaTimeline:<id>`、最大200を Fanout.push へ渡し、raw note を `antennaStream:<id>` の note イベントへ publication して、最後に exec。publication は exec より前で、Redis command 完了を待たない。

`FanoutTimelineService.ts:53–69` は ID の時刻が処理時刻の3分前より新しければ `LPUSH list:antennaTimeline:<id>`、random<0.1 で `LTRIM 0 199`。3分前と同時または古い投稿は非同期の LINDEX で末尾を調べ、末尾なし・末尾より新しいときだけ直接 LPUSH する。古い経路には trim がなく、キャッシュ対象にならない投稿でも publication は行う。重複排除・TTL はない。

定義取得と matcher は addNoteToAntennas が待つが、postNoteCreated はその Promise を待たない。pipeline.exec、publication の Redis Promise、古い ID の LINDEX/LPUSH も待たない。失敗を未処理 rejection として観測する場合は harness listener へ記録する。新実装で未処理 rejection を残す要求ではなく、保存済み Note を失敗に戻さず後続を止める範囲の証拠とする。source の同期 publication throw は後続 antenna と exec を止めるが、すでに開始した publication/古い投稿の直接 push を戻さない。

`NoteDeleteService.ts:63–128` は quiet/通常・DB DELETE 成否のいずれにも antenna cleanup を持たない。検索解除と note deleted stream は別で、antenna の ID を削除したり antenna 削除イベントを足したりしない。

## cache と設定変更の入口

最初の getAntennas だけが `isActive:true` を取得する。TTL、single-flight、定期再取得はない。初回失敗なら次回再取得する。cold fetch の前/途中のイベントは取得結果で上書きされ得る。初期取得後の DB 変更だけでは反映しない。

constructor が登録する Redis message listener は transport channel 引数を使わず、JSON 内の `channel==='internal'` を見る。Created は active 判定や重複排除をせず append、Updated は最初の同 ID を置換または追加、Deleted は同 ID をすべて除去。lastUsedAt を Date に戻し、user/userList は null にする。dispose は listener を外す。

後続の設定書き込み側は次の source 通知を使う。producer の接続だけで、これらの API/ジョブを完成扱いしない。

| source の書き込み側 | 通知・反映 |
| --- | --- |
| antennas/create.ts:122–140 | 保存後 Created |
| antennas/update.ts:121–138 | active=true、lastUsedAt 更新後の全 Entity を Updated |
| antennas/delete.ts:55–57 | 削除後 Deleted |
| antennas/notes.ts:89–98 | 非activeからの利用再開時だけ Updated |
| ImportAntennasProcessorService.ts:85–103 | 保存後 Created |
| AntennaService.onMoveAccount:224–254 | 移転先アカウントを追記後 Updated |
| CleanProcessorService.ts:50–56 | DB の inactive 更新だけ。warm cache を更新する通知はない |

## raw publication の保存結果

`payload-actual-pg-*` の5件は basic/remote mention/reply/renote/channel。実際の TypeORM insert は RETURNING で default 列を元の MiNote に反映する。カウンター4列=0、reactions={}、mentions=[]、reactionAndUserPairCache=[]、mentionedRemoteUsers='[]' などが入る。一方、新しい Note の未指定 name/uri/url は undefined のまま publication の JSON から消え、DB から再取得した related Note では null になる。新しい Note を再読して送信すると source と形が変わる。

mentionedRemoteUsers は配列ではなく JSON 文字列。reply/renote は作成前に渡された raw related Note をそのまま含み、channel は最終的な data.channel の全 raw Entity を含む。channel の isSensitive だけを読む判定と、publication の全 payload を区別する。PG probe の `saved`、`reloaded`、`publication` をそれぞれ比較できるよう保存する。poll の transaction 保存や関連 Note の全取得経路・可視性隠蔽をこの5件で網羅したとは扱わない。

## 観測集合と残る範囲

| prefix | 件数 | 観測内容 |
| --- | --- | --- |
| match- | 87 | 各 gate、visibility/self/audience/follow、5 src、local/IDNA、keywords、file、expression |
| producer- | 28 | age/tail/random の24境界、空、重複、matcher 全体失敗、定義順 |
| post- | 38 | visibility/remote/silent/pack失敗32件、後続失敗/保留4件、mention失敗、channel snapshot |
| lifetime- | 14 | 取得/判定保留、exec/publication/old lookup保留、reject、同期 throw、command error配列 |
| cache- | 7 | 初期active、DBのみの変更、イベント更新/重複/削除、cold上書き2件、並行取得、初期失敗後再取得、dispose |
| delete- | 4 | quiet × DB DELETE失敗 |
| global- | 1 | Redis publication の envelope |
| payload- | 5 | 実 TypeORM/PostgreSQL 保存からの raw publication |

表の prefix 件数は source の観測集合であり、全件の新旧直接照合を意味しない。新実装テストで直接消費した集合、実依存 integration/process で別に検証した集合を分けて記録する。

アンテナ管理・閲覧は #185、WS antenna channel の所有確認、body.id による再pack・可視性/ミュート/ブロック/隠蔽は #189、import/clean は #199、アカウント移転は #195、広域 cache は #217 に残る。このsource観測単独では#174/#172/#176全体の完成を示さない。#174の現在の通常更新責任とchannel/remote counterを含む完了判定は[全責任監査](../derived-updates/README.md)にまとめた。現在の Note と antenna 定義だけでは過去の定義・following/list membership・イベント競合・random trim の履歴を再現できず、#132/#133 では候補再構築と厳密な履歴再現を分ける。今回独自の replay や永続履歴は加えない。


## 新実装の直接比較と実依存検証（2026-11-07）

`packages/backend-next/test/unit/note/antennas.test.ts`はJSONのmatch87件を結果と条件付き照会traceまで直接比較し、producerのage/tail/random24件をtimeline commandとpublication開始順まで比較する。raw bodyは別途`test/integration/note-antennas.test.ts`でpayload-actual-pg5件を新実装の実PostgreSQL insert直後snapshotから実Redis publication全列へ直接比較する。全184観測を直接一致させたとの主張ではない。

最終単体は66ファイル2,401件、関連結合は5ファイル104件。うち新しいantenna結合24件は通常認証HTTP、実PG、分離timeline Redis、host-topic subscriberで、visibility/follow/list、inactive内部更新、botと補正後sensitive channelの保存snapshot、file/CW/reply/renote、WRONGTYPE、全match中断、pack失敗、削除後遅延追加とraw bodyを確認する。実Redis ACLでsubscribeを拒否し、起動失敗後のnamed接続除去と通常closeも観測する。counter結合4件とchannel失敗2件は[派生更新監査](../derived-updates/README.md)の別責任として扱う。

`test/processes/note-antennas.test.ts`の通常HTTP子はlist照会をDB lockで保留したまま投稿応答後SIGTERMし、解放まで終了しないこと、最後のtimeline/raw publicationと終了0を確認する。同ファイルのmanaged remote snapshot子はproduction5分counterを終了時flushして退出する。2件のprocess試験と、held old-ID/publication/matcher/follow DELのunit drainを区別する。

sourceのcold-loadイベント上書き・並行cold取得・DBだけの変更残留・reconnectでのresident保持・follow中のin-flight read競合は維持する。新実装は開始済み照会・publication/pipeline・直接old-ID更新・cache DELをdrainして診断へ接続し、不正JSONを無視し、memory GC timerをunrefしてcloseで解除する。この資源寿命の差異にretryやgeneration refreshを追加しない。アンテナ管理/閲覧/WS/移転/import/cleanの発行元は本producerの実依存検証で完成したとは扱わない。
