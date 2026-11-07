# 投稿の通常更新責任と #174 の完了判定

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。基準は PR #236 マージ後の `f81f99450f45507667d0d19fab7fdea98a11c878` と、続く antenna producer の実装。2026-11-07 に #174/#132/#133/#195/#200/#215 の現行本文、固定本家の `NoteCreateService` と `NoteDeleteService` 全体、および直接呼ぶ TL・Role・antenna・hashtag・featured・検索更新を照合した。過去 slice の「等」「全体未完了」を残作業の根拠として繰り返さず、以下の責任ごとに判定する。

**実装・検証後の判定:** 全 source 照合で見つけた channel 集計の失敗境界と remote `Instance.notesCount` の通常加算・減算・終了時 flush を本 PR で接続した。antenna を含む実依存検証も下記の範囲で成功している。#174 に別の未所有・未接続の通常 producer は見つからず、最終レビューと出す前の共通検査が通れば `Closes #174` を使える。remote counter を #200 へ移して解消した扱いにはしない。閲覧 API・antenna 管理 API・WS channel・再構築実装そのものを #174 の追加 blocker にはしない。

## 更新責任の照合

source の `C` は `packages/backend/src/core/NoteCreateService.ts`、`D` は `NoteDeleteService.ts`。行は上記固定コミット。新実装の `src/` と `test/` は `packages/backend-next/` からの相対パス。

| 対象・所有者 | source の保存・開始点 | 通常経路、作成・削除・失敗後の状態 | 実装・比較根拠と判定 |
| --- | --- | --- | --- |
| Note・非正規化列・Note+Poll 保存 / #169/#170 | C 645–732 | Note と Poll は必要時だけ同一 transaction。保存失敗では後続を開始しない。削除で Poll/Vote/Reaction は既存 FK に従う | `src/modules/note/create-note.ts`、`src/platform/database/note-writer.ts`。`test/integration/note-create.test.ts:255` の Poll trigger 拒否、`:103` からの固定 C fixture。通常派生更新とは別の保存責任 |
| text/CW/poll からの tags・mentions・emojis / #170 | C 573–631 | trim、抽出、raw tag 制限の後に Note.tags を正規化保存。profile tags は別 caller。削除時に抽出の逆操作はしない | `src/modules/note/extract-contents.ts`、create-note の固定 C8 比較、`test/integration/note-hashtags.test.ts:82,103,231`。AP の apHashtags/apMentions 入力 caller は #195 |
| user.notesCount/updatedAt / #169/#170 | C 776–777,1040–1047 | 保存後に直接原子加算。削除 D 63–128 に減算なし。独立失敗で他 producer を止めず、再実行しない | `src/platform/database/note-post-save-counts.ts:27`。`test/integration/note-create.test.ts:171` の同時加算、post-save unit。履歴 count を現在 Note 件数と無条件に同一視しない |
| reply.repliesCount / #170/#172 | C 786–788,1017–1018; D 66–68 | 作成は独立 +1。削除は DELETE より前に await で -1。後の DELETE 失敗でも戻さない | counts adapter、`src/modules/note/delete-note.ts:76`。`test/integration/note-create.test.ts:142`、`test/integration/note-delete.test.ts:109`。後者は実 trigger と早期減算・配送残存を確認 |
| renote.renoteCount / #170 | C 815–817,967–973 | 他人対象・nonbot の quote/pure Renote に +1。ランキングと独立。削除減算なし | counts adapter、create-note の C6、`test/integration/note-featured.test.ts:151`。DB count 拒否でも ranking は残る |
| channel.notesCount/lastNotedAt/usersCount / #170 と #174 の失敗照合 | C 927–942 | pack/mention 等の準備に成功してから、+1・処理時計の timestamp・保存後 author/channel 件数が1なら usersCount+1 を独立開始。削除で減算なし。同時初投稿の取りこぼし・削除後再投稿の重複 count を強化しない | `src/platform/database/note-post-save-counts.ts:34` に channel 専用3文を分離し、`src/modules/note/created-events.ts:113` から準備成功後・index前に独立開始。C8 の実 DB 比較 `test/integration/note-create.test.ts:149`、削除非減算 `test/integration/note-delete.test.ts:92`、`test/unit/note/created-events.test.ts:274,281` の準備失敗・開始順、`test/integration/note-antennas.test.ts:261` の列別 trigger 拒否2件で修正を確認。source5ケースは下記 |
| home/local/user/list/channel TL と files/replies 派生 / #174 | C 779,1068–1199 | Meta fanout gate、現在 follow/list/channel 購読を使う。channel の最初の2系統は購読照会前。recent は pipeline、old は直接更新。削除 purge なし・遅延 snapshot も投入し得る | `src/composition/posting-timelines.ts:16`、`src/modules/note/timeline-plan.ts:21`、`src/platform/timeline-cache.ts:19`。[固定1,280 routing比較](../timeline/README.md)。`test/integration/note-timelines.test.ts:79,100,114,126,134,152,186,203` と通常 HTTP 子 process |
| follower の hibernation / #174、活動解除 #173/#180/#189 | C 1192–1236 | 非channel の10% sample、最大1000、lastActive が strict50日超なら User と全 Following を独立更新。今回投稿は受け取り次投稿から除外。削除で解除しない | `src/platform/database/note-timelines.ts:36`、timeline integration `:159,176`。WS活動/解除は既存 stream slice。新しい REST 活動解除や全 account API を完成条件に足さない |
| Role TL と packed publication / #174 | C 844; RoleService 652–662 | pack 成功後、現在 Role/assignment/conditional で選ぶ。定義順・conditional 重複を保ち max1000。visibility/channel/role公開/fanout を producer gate にしない。削除 purge なし | `src/composition/posting-role-timelines.ts:13`、`src/platform/database/role-timelines.ts`。[固定229観測/直接16件と既存材料cacheとの差異](../role-timeline/README.md)。integration `note-role-timelines.test.ts:90,109,134,166,185`、process。閲覧/WS は #181/#185/#189 |
| antenna TL と raw publication / #174 | C 781–784; AntennaService 47–220 | 保存 snapshot の作者・補正後 channel。lazy active 一覧と internal created/updated/deleted、followers cache、現在 list membership、source 順の条件照合。全照合成功後だけ max200/publish。削除 purge なし | `src/composition/posting-antennas.ts:14`、`src/modules/note/antenna-plan.ts`、`src/platform/database/note-antennas.ts:13`。本 PR の実 PG/Redis/HTTP handler integration24件は、固定 source の実 PG raw payload5件との直接比較、cache/条件/失敗/直後削除とchannel修正を含む。通常 HTTP 子で開始済みlist照会・Redis・raw publicationのSIGTERM待機も確認した。source corpus と新実装の実依存検証の区別は [antenna資料](../antenna/README.md) を参照。管理/閲覧 #185、WS #189、import/export/clean #199、account move caller #195/#199 は別責任 |
| hashtag の historical mentioned 作者配列/件数 / #174 | C 771–774; HashtagService 56–60,74–137 | public/home の tags ごとに local/remote と total 作者を原子追加。重複作者は加算しない。DB 失敗は後の tag を止め、開始済み Redis は残る。削除で減算なし | `src/composition/posting-hashtags.ts:14`、`src/platform/database/note-hashtags.ts`。[固定 source 比較](../hashtag/README.md)。`test/integration/note-hashtags.test.ts:129,193,241,267`。profile attached の追加/解除は #180/#195 |
| hashtag unique/HLL/featured +1 / #174 | HashtagService 169–203; FeaturedService 34–45,112–113 | hidden/sensitive は Redis だけ除外。1h unique admission、10分 HLL、1h score。NX期限・非原子的競合・独立 clock を維持。DB/Redis の片側失敗が他方を取消さず、削除減算なし | `src/platform/hashtag-ranking.ts`、integration `note-hashtags.test.ts:117,143,168,210,279`。管理 hiddenTags 更新時の removeFromRanking は MetaService 132–144 の別 caller（管理領域）、trend/chart reader は #186 |
| Renote featured +5 / #174 | C 815–817,975–987; FeaturedService 34–45,92–108 | nonbot・他人対象・sample<0.3・対象 strict3日以内。対象 channel非reply または public/local非reply に加点。global/channel3日、user7日 window。削除 purge/減点なし | `src/composition/posting-featured.ts:15`、`src/platform/featured-ranking.ts`。[固定50観測/直接39件](../featured/README.md)。integration `note-featured.test.ts:80,101,114,125,137,151,168`、process。reaction +1 は #184、gallery は #187、reader は #185/#187 |
| Meili settings・index/unindex / #174/#172 | C 945–946,1033–1036; D 111; SearchService 103–177 | enabled provider の settings、scope と public/home/content gate、1document登録。準備成功後に add、DELETE前に解除。解除は content/scope を gate にしない。task受付後の engine 適用を投稿/終了の成功条件にしない。遅延 add による再出現を強化しない | `src/composition/posting-search.ts:13`、`src/platform/search-index.ts`。[固定256+8比較と現在設定からの復元材料](../search/README.md)。integration `note-search-index.test.ts:65,83,102,117,145,158`、process。SQL/PGroonga index は DB 保守、検索閲覧は #186 |
| follower notify:normal と mention/reply/quote/renote 通知 / #173/#177 | C 790–813,848–887; NotificationManager 63–158 | 購読通知は pack 前に独立開始。manager は準備後に重複/優先/可視性/自己抑止して PG 保存。失敗後に自動的に投稿を再実行しない。Note 削除時の通知削除 callback は D にない | `src/modules/note/created-events.ts:51`、`notification-plan.ts`、`test/integration/note-notifications.test.ts`。通知 API/既読/未読/push/移行は #177。TL 関連集計に含めて二重実装しない |
| poll 終了 job と通知 / #162/#173 | C 819–833 | Note+Poll 保存とは別。保存後の現在時計から delay、試行1回、完了7日30件/失敗7日100件。実行時に現在 Note/Poll を読み、削除済みなら通知しない | `src/platform/job-queue/ended-poll-notification.ts`、`test/integration/poll-ended-job.test.ts`、`test/processes/poll-ended.test.ts`。投票/votes更新そのものは #184 等の担当であり、#174 の欠落 producer ではない |
| notes/main/deleted stream・user webhook / #173/#175 | C 842,846,865–866,882–883,1008–1009; D 70–73 | notes/role/webhook は pack 後。mention は受信者別 pack。削除 publication は DELETE前で失敗時も残る。source に note削除 webhook はない | `src/platform/posting-stream.ts`、`created-events.ts`、`test/integration/posting-websocket.test.ts`、[webhook比較](../../user-webhook/README.md)。WS 他channel #189 と webhook 管理 #197 は別 |
| AP Create/Announce/Delete/Undo・relay / #171/#172 | C 889–923; D 75–92,170–177 | local/nonlocalOnly の表現・宛先、通常 queue/retry。削除は配送開始後 DELETE、失敗で既開始配送を取り消さない。強い create/delete 順序は追加しない | federation producer/queue/worker、`test/integration/note-delete.test.ts:109` と [AP引継ぎ](../../../../backend-next/ap-delivery-handoff.md)。#174 のために追加 queue を作らない |
| 物理削除・moderator audit / #172 | D 113–126 | reply 減算、publication、AP表現/開始、検索解除開始、DELETE、成功後に他人削除 audit。DELETE失敗で audit は開始しない | `src/modules/note/delete-note.ts:76`、`src/platform/database/note-deleter.ts:45`、delete integration。#176 は全副作用の縦断統合を引き続き担当 |
| notes/per-user/active-users/instance chart / #200 | C 754–757,764–765,837; D 94–97,103–104 | 設定・publicity/locality・quiet に従う履歴系列。未接続。source にある chart trigger を未実装と明記し、#200 の series/flush と一緒に接続する | #174現行本文は履歴チャートの全完成を条件にしない。`responsibility:queue-daemons-charts:33` と #200 を保持し、通常 TL 更新の完了で chart 完了を主張しない |
| remote Instance.notesCount / #174、#127/#215/#195 と連携 | C 760–768,273,1258–1270; D 99–108 | enableStatsForFederatedInstances 時、snapshotのremote作者 host の fetchOrRegister 後に +1 を初回enqueueから5分で集約し、終了で flush。削除は quiet=false の既存APIから -1を直接開始し、後のDELETE失敗でも残す。chart flag は count 自体の gate ではない。失敗batchのretryやcache書換えを追加しない | `src/platform/note-instance-counts.ts:7`、`src/platform/connect-resources.ts:299,314,351`。既存 instance 台帳を使い、MiInstance を直接原子更新するproducerを追加。unit11件（source6件のID/column/delta直接照合を含む）、`test/integration/note-instance-counts.test.ts` 4件、managed子の終了flushを確認。remoteHTTP受信は #195 に残る。所有曖昧性を残した移譲でなく本PRで通常集計を実装 |

「registry の投稿連動更新」や「新規投稿で note subscription を作成する」という追加処理は、固定した両サービス全体に存在しない。C 790–813 は既存 Following.notify の取得と通知であり、subscription 行の作成ではない。Poll 保存・終了 job、chart、counter は上の別行で列挙した。予約投稿/受信/管理の追加入口が同じ producer を呼ぶことと、その入口自体の移植は別責任である。

直接 Redis/DB/Meili 更新には source が持たない通常 retry を追加しない。開始済みの失敗は構造化診断と終了待機へ集める。本家の detached unhandled rejection を製品へ再現する要求にはしない。BullMQ が source にある poll/AP/webhook は、それぞれの通常 retry/保持契約に従う。

## channel の独立した固定 source 5 ケース

[`reference-channel.cjs`](reference-channel.cjs) は Git の固定 blob から **完全な** `postNoteCreated`/`index` と `NotificationManager` を抽出・transpileして実行する。新実装から期待値を生成しない。Repository/packer/他Service は double。実 HTTP/PG/Redis・本家サーバー全体の比較とは区別する。

| mode | sourceで始まるchannel仕事 | 検出する差異 |
| --- | --- | --- |
| success | notesCount+1、lastNotedAt、countBy→usersCount+1。indexも開始 | 集計を pack/mention 準備の後、検索登録の前に開始 |
| pack-reject | なし。user count は先行して残る | channelを早期 count に一括すると誤更新 |
| mention-reject | なし。user count は先行して残る | global pack 成功だけでは channel 開始条件を満たさない |
| notes-reject | timestamp、usersCount と index は残る | notesCount と timestamp を同一 SQL にすると部分失敗が変わる |
| timestamp-reject | notesCount、usersCount と index は残る | timestamp 拒否で count を取り消さない |

再生は repo root から行う。`UPSTREAM_ROOT` は上記固定 commit を保持する Git checkout、`OUTPUT_DIR` は比較用一時ディレクトリ。省略時は新しい一時ディレクトリを作る。`REPOSITORY_ROOT` は別配置から TypeScript を解決するときだけ指定する。

```sh
UPSTREAM_ROOT=/path/to/fixed-upstream OUTPUT_DIR=/tmp/channel-reference \
  node docs/superpowers/compatibility/note/derived-updates/reference-channel.cjs
cmp docs/superpowers/compatibility/note/derived-updates/channel-observations.json \
  /tmp/channel-reference/channel-observations.json
```

`channel-observations.json` には固定commit、Git blob ID、raw UTF-8 source の SHA-256、5ケースの実呼出順を保存する。NoteCreate blob は `05e98541844d7f14e91263a78a03c9ec0139a89d`、SHA-256 は `cbae284975c937d89c0030b5f3cf47de373555c1ce34b65de81bcf495e93f4fe`。NoteDelete blob は `1b945277b7590bf89fcdaaf5c56ec16513a59d6a`、SHA-256 は `f27dfc26664f39f9ade3366f46411ffe6ff5c189e5d97fb371dda5c3bf7d240c`。後者は削除責任を照合した source の識別子であり、この5ケースで delete を新たに実行したという意味ではない。

## #132/#133 への正本・保持・復元材料

この表が #174 からの入力一覧であり、再構築コマンドの実装完了を意味しない。#132 は必要対象の選定、#133 は選ばれた最初の専用処理を担当する。通常投稿の再実行で代用せず、停止下を選べる具体手順で対象だけを書き換え、通知/AP/webhook/stream publication を再送しない。

| 対象・保存先/保持 | 正本と現在状態から作れるもの | 現在のDBだけでは再現できないもの・注意 |
| --- | --- | --- |
| 通常TL: 専用 timeline Redis `list:homeTimeline*`、`localTimeline*`、`userTimeline*`、`userListTimeline*`、`channelTimeline:*` | Note の ID時刻/作者host/visibility/visibleUserIds/reply作者/channel/fileIds、現在 Following（reply/hibernate含む）・list membership/owner・ChannelFollowing、Meta上限とfanout設定、channel設定上限。plannerは `timeline-plan.ts:21` | 過去のfollow/list/channel/休眠・設定・処理順、削除済みID、3分判定時刻/末尾、10%trim乱数。recentだけ確率trimなので上限は常時hard capではない。user/home/listは設定値、files半分、local1000/files500/replies300/replyTo30、channel設定値。期限なし。現在関係での近似 backfill と過去一覧再現を区別 |
| Role TL: 同Redis `list:roleTimeline:<roleId>`、max1000/確率trim、期限なし | 現存 Note と現在 User事実/Role定義/assignment/期限を再評価した現在所属 | 過去のassignment・conditional一致・期限・User cache、実行時のnotesCount競合、削除残留・trim履歴。所属重複による同一ID複数投入もsourceどおり。再構築で role publication は再送しない |
| antenna TL: 同Redis `list:antennaTimeline:<antennaId>`、max200/確率trim、期限なし | 現存 Note と現在作者/Channel/定義、現在 follow/list 条件から現在一致候補 | 過去定義・bot/username/channel sensitivity snapshot、resident active cacheと内部event、following二層cache、関係・処理順・削除残留・trim。現在 active 行だけで過去resident一覧を再現できない。raw publication を再送しない |
| Meili `${index}---notes`、保持/適用はengine | 現在 Note.id+ID方式からcreatedAt、text/cw/visibility/userHost と現在scopeで候補、userId/channelId/tagsからdocument。source settings | 過去scope・削除Note・detached失敗/逆転による過去engine状態。settings/task受付と適用完了は別。通常 SQL/PGroonga index の再索引はDB保守であり、このアプリdocument再構築とは分ける |
| featured: 通常Redis `featuredGlobalNotesRanking:<window>` / `featuredInChannelNotesRanking:<channel>:<window>` / `featuredPerUserNotesRanking:<user>:<window>` | 現在Noteの候補と現状rankingの引継ぎ。epoch2023-01-01、global/channel3日window・9日NX期限、user7日window・21日NX期限 | sample<0.3、処理時計、各windowへ実際に入った+5、reaction等の別producer、削除Renote/target、初回expiry・失敗履歴。現在renoteCount×5は厳密scoreではない。2-windowの平均 reader も独立責任 |
| hashtag PostgreSQL mentioned total/local/remote作者配列とcount、期限なし | 現存public/home Note.tags と User.host から現在のmentioned作者集合を近似。行は正規化tag名でunique | 削除Noteのhistorical作者は既存表に残る。Note削除と同時に減らす再構築は現在材料の近似であり、元の履歴集計再現ではない。profile由来attached配列はNoteから作らず、既存値を保持 |
| hashtag Redis: `hashtagUsers:<tag>` SET/1h NX、`hashtagUsers:<tag>:<UTC10min>` HLL/3日NX、`featuredHashtagsRanking:<1hWindow>` +1/3h NX | 現状keyの保全、現在tag/hidden/sensitive設定からの候補 | 過去参加順、1h SET admission、local時計切下げとUTC表現、別時点featured clock、非原子的競合、初回expiry、設定/失敗。現在Noteからscore/HLL時系列を厳密復元できない。通常unique SETを再投入してランキングを偶発的に加算しない |
| user/reply/renote/channel関連countとlastNotedAt | 現在DB値を引き継ぐ。replyは現存参照関係を照合候補にできる | user/renote/channelは削除で減らさず、channel usersCountは初回判定・同時投稿・削除再投稿に依存。lastNotedAtは実行時計。単なるCOUNT(Note)で本家の歴史値へ戻せるとは扱わない。失敗修復と現在状態への再集計の意味を #132 で選ぶ |
| remote Instance.notesCount と chart | Instance現状値/チャート保存値と設定。通常counterは上記の実装で引き継ぎ、chart系列は #200 | +1遅延/集約、quiet削除、remote投稿削除・失敗と停止flushで値が変わる。chart期間は現在Noteから全部復元できない。counter実装責任と #200 の履歴seriesを区別 |

従来の timeline 資料は保持/失敗/削除を記録していたが、再構築入力と復元不能な関係履歴を一か所に列挙していなかった。この表で通常TLを含む全対象を引き継ぐ。検索・Role・featured・hashtagの個別資料は、比較 corpus と詳細制約の証拠として維持する。再構築未実装だけを理由に通常producerのIssueを開き続けない。監査で見つけたcounter欠落は本PRの通常producer接続で解消し、再構築へ先送りしていない。


## Instance.notesCount の source 17 ケースと実装境界

[`reference-instance-counter.cjs`](reference-instance-counter.cjs) は完全な `postNoteCreated`/`index`、constructor の queue 初期化本体、`collapseNotesCount`/`performUpdateNotesCount`/`dispose`、`NotificationManager`、`NoteDeleteService.delete`、`CollapsedQueue` を固定 Git blob から抽出・実行する。timer・Repository・registration・packer は double。新実装・実 HTTP/DB/Redisの同時比較ではない。`instance-counter-observations.json` に3 source の blob/SHA-256と17件の呼出順を記録する。

```sh
UPSTREAM_ROOT=/path/to/fixed-upstream OUTPUT_DIR=/tmp/instance-counter-reference \
  node docs/superpowers/compatibility/note/derived-updates/reference-instance-counter.cjs
cmp docs/superpowers/compatibility/note/derived-updates/instance-counter-observations.json \
  /tmp/instance-counter-reference/instance-counter-observations.json
```

| sourceケース | 観測・製品に必要な契約 |
| --- | --- |
| create local / stats無効 | registration、timer、count更新なし |
| create remote / pack失敗 | registration後に+1を予約。後のpack失敗でも予約を残す |
| create registration失敗 | count予約なし。他の準備とindexは継続 |
| delete remote / quiet / stats無効 | 通常remoteだけregistration後に直接-1。quiet/無効時は省く |
| delete DB拒否 / decrement拒否 / registration拒否 | DELETE拒否でも先行-1は開始済み。count/registration拒否でもunindex/DELETEを省かない |
| first deadline / per-instance deadline | 同じIDの値を合算し、初回から300000msで実行。後続enqueueで期限を延ばさず、別IDは独立 |
| timer処理中の次enqueue | queueから消してからDB更新するため、同じIDでも次のbatchを作る |
| timer更新拒否 | batchは既に失われ、自動retryしない |
| shutdown flush更新拒否 | queued分をsnapshot/clearしtimerを取消、全件実行してallSettled。失敗を再予約しない |
| source shutdown中の既発火更新 | source disposeは既発火Promiseを保持せず待たない。新実装の既存資源寿命に従うdiagnostic/drainとの差異を記録する |
| source NODE_ENV=test | constructorが0msを選ぶ。通常は300000ms |

sourceの直接counter更新は federatedInstance cacheを書き直さない。既存 `src/platform/instance-ledger.ts:122` の fetchOrRegister を狭い入口として使い、MiInstanceの原子的increment/decrementを別adapterで行える。新schema、外部HTTP、新しい汎用queue基盤は不要。Redis cacheに残る古いnotesCountを修正するために状態更新用 `updateInstance` を呼ぶとsourceと違うため行わない。

現在のtoken HTTP作成はlocal作者だけを受け付け、remote受信入口は #195 に残る。これは、既存 `NotePostSaveInput` へremote snapshotを渡して通常producer自体を実DB/Redisで確認することを妨げない。管理者による保存済みremote NoteのHTTP削除は既存入口を使って実測できる。remote+1をテスト用HTTP経路だけで実行してAP受信まで完成したとは扱わない。

終了順は受付停止、post-save/post-deleteの開始済みregistration/予約をdrain、未実行batchのflushと既発火DB更新のdrain、DB/Redis解放。batch closeを先に実行して遅れたpost-saveの予約を失わない。5分timerを投稿HTTP完了待ちに含めず、終了時に取消/flushする。counter失敗で確定済み投稿やDELETEの結果を巻き戻さず、失敗したbatchの自動再実行も追加しない。

監査で発見したchannel/counterの実装と下記の実依存検証により、上表と再構築入力表に挙げた #174 の通常更新に未所有・未接続の責任は残っていない。最終レビューと共通検査が成功すれば #174 をclose可能と判断できる。#176の投稿全体縦断、#200のchart、#195のremote受信、#185/#186の閲覧、#132/#133の専用保守を同時に完了させる要求はない。最終結果と実装commitは当該実装計画に記録する。source probeの成功を製品成功へ読み替えない。


## この監査後に確認した製品検証

2026-11-07、同じ作業ブランチの実装と実行ログを照合した。source probe は channel5件・counter17件を別出力先へ再生してJSONのbyte一致を確認。counter unit11件のうち6件はsource fixtureの実Instance ID/列名/増減量を直接比較する。17件すべてを製品へ直接fixture照合したという意味ではない。

| 製品検証 | 確認した結果・範囲 |
| --- | --- |
| `test/integration/note-antennas.test.ts` + `note-create.test.ts` | 2 files /84 PASS（antenna24、既存create60）。antenna24には固定source実PG payload5件の保存・Redis full body直接照合、channel列別trigger拒否2件、pre-pack独立開始・失敗・遅延snapshotが含まれる |
| `test/unit/note/instance-counts.test.ts` | 11 PASS。初回期限、別ID、新batch、既発火holdの終了待機、失敗drop/no retry、0ms test設定、source6件直接比較 |
| `test/integration/note-instance-counts.test.ts` | 4 PASS。実PG/Redisでremote snapshot2件を5分batchへ予約してclose時+2、cacheは古い0のまま維持。既存admin HTTP remote削除とDELETE trigger拒否で先行-1、snapshot host・pack材料取得失敗でも+1、無効設定、increment trigger拒否後のdrop/no retry |
| `test/processes/note-antennas.test.ts` | 2 PASS。通常HTTP子のblocked list照会・TL/raw publicationをSIGTERMでdrain。もう1件はmanaged fixture子が本番300000ms batchを保持し、SIGTERMで+1をflushしてDB解放・exit0。後者はremote HTTP/API受信の実装証拠ではない |
| channel prepared-events unit | `test/unit/note/created-events.test.ts:274,281` はpack/mention失敗では集計なし、AP準備後/index前の開始、非同期集計失敗でもindex継続とdrainを確認。実SQL部分失敗は上記integrationで別確認 |

`src/platform/connect-resources.ts:312,344,360` のcleanup登録によりLIFOでpost-delete/post-saveの受付済み処理を待ってからbatchをflushし、その後にDB/Redisを解放する。`note-instance-counts.ts:47` は未発火timerを取消し、既発火のDB書込も待つ。後者はsource disposeとの差異であり、source17件の観測と区別して単体・processで検証する。Metaはsourceの注入cacheと異なり既存readMetaから読むが、local作者は先に除外する。既存instance registration競合の差異は既存台帳の契約を維持する。

この結果は通常更新producerとその資源寿命の比較であり、remote AP受信、antenna WS client受信、全閲覧API、履歴chart、再構築コマンド、#176全体の完了を示さない。最終レビュー・lint/build/typecheck/SPDX/locale等の共通検査は実装計画の最終記録を正とする。
