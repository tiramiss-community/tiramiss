# 投稿保存・後続処理の最小契約

判断基準は[GOALS](GOALS.md)。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。#124/#127/#169 の旧同時確定・容量・復旧条件より本書を優先する。

## 保存と応答

認証 → 通常レート制限 → 停止/移行/scope → 入力検証 → 業務判断 → Note保存 → 取得済み資料から出力（描画） → 後続処理開始。応答の入れ子の返信先/Renote対象のcountを本家と同じく今回の加算前の値にするため、描画を終えてから後続処理を始める。描画に失敗しても保存済みなので後続処理は始め、500のログに保存済みNoteのIDを残す。本家の基本text投稿は単純insertであり、Noteと独自requestの同時保存を必要としない。投票など複数の業務データが一体となる処理は、その機能でtransactionを使う。COMMIT応答不明やクライアント切断を理由に投稿操作を自動再実行しない。

HTTP成功は保存とレスポンス生成の成功。AP配送や通知の完了を待たない。後続処理失敗で保存済みNoteを巻き戻したと扱わず、エラーを記録する。本家同様、user.notesCount/updatedAtは保存後の処理で原子的加算する。通常終了では開始済み処理を既存の終了期限まで待つ。

業務コードへHTTP/ORM/queue/DI型を渡さない。保存窓口と副作用開始を分け、レスポンスは既存のNote資料取得とpure rendererで作る。show UseCaseをcreate UseCaseから呼ばない。

## 非同期処理と通知

基本text保存のためだけのjobは作らない。AP送信・投票終了・webhookなど、本家がqueueを使う仕事を実装するときにBullMQの通常add/addBulk/Workerを接続し、本家相当のretry/backoff/limiter/履歴/管理を移植する。PG正本、二重claim、世代token、内部Lua差替え、全損再構築は初期経路に入れない。全副作用を万能dispatcherへ集めない。

通知実体は承認済みのPostgreSQL保存を維持する。#173/#177では、通知条件を判断したUseCaseから直接保存する小さい窓口へ変え、work_request/claim/通知effect/容量課金への依存を外す。通常の受信者別保持・既読・配信・既存Redis通知移行は残る。今回、通知機能を接続済みとは扱わない。保存先の差異は取り消さず、強い一度だけ成立は初期必須から外す。

## 最初の実装PR

- 通常起動に `POST /api/notes/create` の基本text作成を接続する。text 1–3000、空白のみ禁止、trim、CW null/1–100、公開範囲・localOnly・reactionAcceptanceを扱う。
- native/Bearer/MiAuth/App permission、productionの1時間300/factor制限、入力より先の制限/資格判定、sensitiveWords/禁止語/Roleによるpublic→homeを比較する。キーワード正規表現は本家と同じRE2。
- N0のC1/C2/C3基本入力/C4のHTTP・DB・count・showを検証する。C1のAP観測まで一致したとは報告しない。
- 添付・poll・reply/Renote・channel・指定宛先・MFM抽出は#170（下記「関連入力」）。#169の時点では、未実装の入力/抽出対象を黙って捨てず、501 `NOT_IMPLEMENTED`で保存前に拒否していた。
- 通常起動に利用者がない独自BullMQ transport、Redis世代復旧、専用テスト、README手順を撤去する。残るdispatch/claim/AP/通知adapterは互いに依存しているため、直後の削減PRでPG通知の依存分離と併せて撤去する。未使用のまま全機能完成まで保持しない。
- 本家schemaと適用済みmigrationは変更しない。残存データ/ジョブの扱いを検査する新migrationで不要内部テーブルを廃止する。今回DBの内容は削除しない。

## 関連入力（#170）

添付・投票・返信/Renote/引用・channel・指定宛先・MFM抽出を、固定本家の `notes/create` と `NoteCreateService` に合わせて接続する。基本text作成の501暫定制限は撤去済み。未登録remote mentionも下記#195の限定経路で取得する。

- **判定順**: 入力検証 → 指定宛先の取得 → 添付 → Renote対象 → 返信先 → 投票期限（本家どおり、`expiredAfter` は要求開始の時刻から数え、期限は関連の取得を終えた時点の時刻と比べる。Dateの範囲外の値は期限切れとせず、保存時のDBエラーで500）→ channel → 返信先によるchannelの補正 → channel投稿の強制（public・宛先なし・localOnly）→ sensitiveWords/canPublicNote（channelなしのみ）→ 禁止語（trim前のcw・text・選択肢）→ Renote対象/返信先による公開範囲・localOnlyの補正 → textのtrim → MFM抽出（text・cw・選択肢）→ メンション解決 → 返信先作者・指定宛先の追加 → メンション数上限 → 保存。複数の誤りでは最初のエラーを返す。エラーのcode/id/messageは本家どおり。
- **存在・可視性・ブロックの確認**は保存と同じtransactionに入れない（本家も同じ）。確認後の削除・ブロックは検出しない。本家の `create()` 内でcacheによりブロックを再確認して500になる経路は、DBの確認と食い違う競合時だけに起きるため移植しない。
- **保存**: 投票ありはNoteとPollを、UseCaseが所有する1つのtransactionで保存する。投票なしはNoteの単純insert。非正規化列（threadId・replyUserId/Host・renoteUserId/Host・renoteChannelId・attachedFileTypes・mentionedRemoteUsers）も本家と同じ値で保存する。
- **保存後のcount**: user.notesCountに加え、返信先repliesCount、Renote対象renoteCount（他人の投稿・botでない投稿者のみ。引用も含む）、channelのnotesCount・lastNotedAt・usersCount（その投稿者のchannel内Noteが1件ならusersCount+1）を、保存後の原子的更新として行う。削除では返信先の `repliesCount` だけを1減らし、user・Renote・channelのcountは減らさない（#172）。作成応答の描画を終えてから開始し、応答の入れ子の返信先/Renote対象のcountを本家と同じく今回の加算前の値にする。
- **メンション**: 各出現を独立に解決し、成功したIDを出現順で重複排除する。自ホスト/IDN正規化・WebFingerの最初の大文字小文字非依存self・未登録actor取得/呼出元所有transactionでのcore保存を接続した。登録済みremoteは24時間ちょうどまでfresh、超過/null時刻は先にattempt時刻と必要なURI補正を保存してrefreshする。失敗した出現は本文/CW/pollを保持して省略し、先行する時刻/URI/User/Key等の確定済み書込を巻き戻さない。後のlookupは新しくfreshとなった行を使える。登録済みのfresh lookupは取得を行わない。未登録remoteの保存前501とstale refresh省略は現行core経路から除去済み。media/emoji・attached user hashtag・instance/chart・cache等の残りは[測定範囲と所有者](../superpowers/compatibility/remote-user/runtime-results.md)を参照し、#195全体の完成とはしない。
- **指定宛先とMFM抽出**: 指定宛先は本家と同じく順序を付けずに取得し、存在しないIDは黙って除く（保存順は入力順を保証しない）。ハッシュタグの長さの上限は本家どおり正規化前の値で判定するため、NFKCで128文字を超えるタグは保存時のDBエラーで500になる。mediaSilencedによる絵文字の除外はリモート投稿にだけ効くため、ローカル投稿の経路には入れない。
- **後続Issueの材料**: 投票終了のjob登録と通知は、保存済みの `poll.expiresAt` を材料に #162 の最初の PR で接続した（下記「通常ジョブ（#162）」）。#170では空のjobを作らない。通知・stream（#173）、hashtag表・ランキング・検索索引・TL・antenna（#174）、webhook（#175）、AP配送（#171）、チャートは本Issueで実装しない。いずれも保存済みのNote列（mentions・mentionedRemoteUsers・tags・reply/renote/channel）から判断できる。

## 通常ジョブ（#162）

2026-11-03 のユーザー決定で、通常 worker へ最初に接続する実ジョブは本家の投票終了（`endedPollNotification`）とした。本家との比較は[比較資料](../superpowers/compatibility/poll-ended/README.md)を参照する。

- **投入**: 期限のある投票を持つ投稿だけ、作成応答を描画した後の後続処理で投入する。Noteと同じtransactionには入れない。名前と `data.noteId` は投稿の ID、遅延は後続処理の開始時刻から期限まで（負ならすぐに実行）。`removeOnComplete`・`removeOnFail` は本家と同じく 7 日・30 件／7 日・100 件で、試行は 1 回。投入の失敗は投稿の ID と期限を記録し、HTTP の応答は失敗にしない。
- **実行**: worker 子が投稿と投票を読み直し、作者とローカルの投票者へ `pollEnded` の通知を PG に保存する。受信設定は `never` だけを見る。1 人分の保存の失敗は記録して他の受信者へ進み、プロフィールがなければジョブを失敗させる（本家と同じ）。
- **接続と停止**: HTTP 子・worker 子とも、`redisForJobQueue` へ BullMQ の通常の Queue/Worker で接続する。本家と違い再接続せず、稼働中の切断は子の異常終了にする。worker の停止は取得の停止→実行中のジョブの完了→接続の解放で、既存の停止期限を超えたら異常終了する。
- **後続へ渡すもの**: 配信（stream・未読・push）は #173/#177/#189。
- **AP 配送（#171）**: #171 の最初の PR で、同じ接続の上に本家の `deliver` queue を足した。投稿の後続処理の 3 つ目の仕事として、HTTP 子が保存済みの投稿を読み直し、表現と宛先を決めて `addBulk` で投入する。ローカルの作者で localOnly でない投稿だけが対象（channel の投稿は #170 で localOnly になる）。宛先が空でも本家どおり `addBulk([])` を呼ぶ。表現・宛先・投入の失敗は投稿の ID とともに `note-post-save.failed` に記録し、HTTP の応答は失敗にしない。worker 子は投票終了と同じ子で deliver の Worker も動かし、どちらかの接続を失えば子を異常終了にする。relay への配送は #171 の 2 番目の PR（[引き継ぎ](ap-delivery-handoff.md#171-の最初の-pr-で入れたもの)）。

#163–#165 へ渡す実 queue の情報:

| 項目 | `endedPollNotification`（#162） | `deliver`（#171） |
| --- | --- | --- |
| 定義 | `src/platform/job-queue/ended-poll-notification.ts` の `ENDED_POLL_NOTIFICATION` | `src/platform/job-queue/deliver.ts` の `DELIVER` |
| prefix | `<redisForJobQueue.prefix>:queue:<queue名>`（本家 `queue/const.ts` と同じ式。`src/platform/job-queue/connection.ts` の `baseQueueOptions`）。ioredis の `keyPrefix` は外す | 同左 |
| job | 名前は投稿の ID、`data` は `{ noteId }`。`jobId`・`attempts`・`backoff` なし | 名前は `to.replace('https://', '').replace('/inbox', '')`（最初の一致だけ）。`data` は `{ user: { id }, content, digest, to, isSharedInbox }`。`content` は activity の JSON 文字列で、`content`・`digest` は全 job で同じ。`attempts: deliverJobMaxAttempts ?? 12`、`backoff: { type: 'custom' }`。`jobId` なし |
| 保持 | 投入時の `removeOnComplete: { age: 604800, count: 30 }`・`removeOnFail: { age: 604800, count: 100 }`。Worker 側の清掃はない | 同左 |
| Worker | `metrics: { maxDataPoints: 10080 }`、concurrency 1、limiter なし、`autorun: false` | `metrics` 同左、`concurrency: deliverJobConcurrency ?? 128`、`limiter: { max: deliverJobPerSec ?? 128, duration: 1000 }`、`settings.backoffStrategy` は本家の `httpRelatedBackoff`、`autorun: false` |
| 結果 | なし | `'Success'`・`'skip (blocked)'`・`'skip (suspended)'`・`'skip (software suspended)'`。止める失敗は `UnrecoverableError`、再試行する失敗は分類した例外 |

#175で`userWebhookDeliver`も通常producer/Workerへ接続済み。名前はwebhook ID、dataは`{ type, content, webhookId, userId, to, secret, createdAt, eventId }`の投入時snapshotで、`attempts: 4`・`backoff: { type: 'custom' }`とする。投入時の保持設定は成功`{ age: 604800, count: 30 }`・失敗`{ age: 604800, count: 100 }`で、Workerの周期清掃は追加しない。Workerはmetrics 10080・concurrency 64・limiter 64/1000msと本家HTTP backoffを使う。[webhook比較と実依存検証](../superpowers/compatibility/user-webhook/README.md)。

業務workerはこの3種であり、残り7種の仕事は未接続。下記#163の管理handleは全10名を照会/制御するが、新たな業務workerを登録しない。

## 選択の理由

旧PG実行プロトコルを接続する案は初期目的に不要な保証と運用を増やす。先に全強化実装を消す案は未接続adapterの置換作業だけで機能実装を遅らせる。基本投稿を通しながら参照のない部分から撤去し、相互依存する残りを直後のPRでまとめて減らす。

## 投稿削除（#172）

`POST /api/notes/delete` は作者または現在のmoderatorに許可する。`write:notes`、停止状態、入力とエラーUUIDは固定本家に合わせ、移行済み作者も削除できる。productionではdelete専用の1秒間隔と1時間300回枠を、RoleのrateLimitFactorで調整する。moderator資格とfactorは現在のDB材料で評価する。

本家と同じく、返信先の `repliesCount` 減算を独立した文として先に確定し、必要なAP表現と配送を開始してから `id + userId` でNoteを削除する。後のDELETEが失敗しても、先の減算や開始済み配送をrollbackしたことにしない。同期の表現失敗（specifiedのpure Renote等）はDELETE前の失敗となる。moderatorの他人削除の監査はDELETE成功後に開始するbest effortで、監査失敗は削除の失敗へ変換しない。Note全列と作者情報を監査へ渡す。Poll/Vote/Reactionは既存FKで削除され、参照する返信/Renoteは残る。

ローカル作者かつ `localOnly=false` のとき、通常投稿・引用はDelete(Tombstone)、元投稿が残るpure RenoteはUndo(Announce)、元投稿消失時はDeleteへ戻す。作者鍵を使い、followers・accepted relay・concerned directを別々に投入する。非public削除もfollowers/relayを対象にし、followersとdirect間でsharedInboxを重複排除しない。concernedは保存済みremote mention URI・Renote作者と、削除対象へのremote返信/Renote作者。対象自身の列は削除前に保持し、参照する子Noteは削除後も照会できる。

開始済みの配送・監査は `notePostDelete` が終了期限まで待つ。失敗は `note-post-delete.failed` に記録し、producerの再実行・永続宛先台帳・強いCreate/Delete順序を追加しない。投稿/削除/通知streamは下記#173受信sliceまで接続した。検索登録/解除は下記の検索producerへ接続済み。antenna・hashtag・featured等は#174、チャートは#200、投稿全体の連携確認は#176に残す。固定本家に削除webhookはない。[実装と検証](../superpowers/plans/2026-11-07-note-delete-172.md)。


## 投稿通知とstream producer（#173 第1slice、2026-11-07）

reply/mention/quote/renote/noteの条件を`modules/note/notification-plan.ts`と通知の受信policyへ分離し、UseCaseでID・時刻を決めて既存PG通知へ直接保存する。購読通知とmanager通知は別枝で、設定・follow/list/muteは処理時、thread muteは各mention/replyの準備時に読む。ブロック・ワードミュートを保存前の条件として独自追加しない。保存後のnotifier検査でstreamだけ抑止される場合も本文は保持する。

通常投稿は本家のguest `skipHide`/reaction-pair付き`notesStream`とreply/renote、受信者別detailのmentionを発行する。通知は保存完了後、受信者別Note/UserLiteを含め`mainStream`へ発行する。Redis channelは公開URLのhost、論理channelとmessageを包む本家のJSON形式を使う。削除は返信数減算後、AP準備と物理DELETEの前に`noteStream`のdeletedを開始する。後段のDELETE失敗でも発行を取り消さない。

保存済みNoteと即時参照先の値は投稿処理のメモリ内で保持し、後続のcount更新や即削除による表現変更を避ける。Poll/Voteは描画時の現在値を読む。global/mention/thread準備の失敗ではmanager/APへ進まず、先行した購読通知は独立して終了する。通知保存・publishの失敗でHTTPの保存成功を取り消さず、開始済み処理をdrainし診断ログへ残す。

既存の投票終了workerも保存後の通知発行へ接続した。削除済み投票・現在の設定・重複ジョブの規則は#162を維持する。通知本文の保存済み状態とstreamの成功は別で、永続effect・容量・一度だけ成立の基盤は再導入しない。

検証は実HTTP/PG/Redis subscriberと通常poll worker、C10固定本家観測、source由来の受信条件・失敗境界を含む。[計画・実測](../superpowers/plans/2026-11-07-notification-stream-173.md)。投稿のWebSocket transport/auth/main/homeTimeline・note購読は下記受信sliceで接続した。他WS機能#189、投稿全体の縦断#176、広域fanout/cache#217、通知閲覧/既読/未読timer/push/移行#177は未完了で、全stream/通知領域の完成とは扱わない。

投稿 user webhook (#175) は保存後のイベント処理で note/reply/renote/mention を選び、通常 `userWebhookDeliver` queue に URL・secret・payload を固定する。受信者別の条件、処理・保持と未完了範囲は[比較資料](../superpowers/compatibility/user-webhook/README.md)を参照。固定本家に削除 webhook はない。設定 API・他のイベントは #197、作成から削除の縦断は #176。

## 通常タイムラインproducer（#174 第1slice）

home/local/user/list/channel（files/replies派生を含む）の宛先規則を純粋plannerへ分離し、保存時のNoteと処理時のFollowing/list/channel/Metaを使ってRedisへ直接追加する。`redisForTimelines`（未指定は通常Redis）、`list:<name>`と既存prefix、channel上限 `perChannelMaxNoteCacheCount ?? 1000` とMeta上限を維持する。3分以内のstrict境界・10%trim、古いIDの末尾日時比較と非trimは固定本家に従う。小数の半上限も丸めない。

通常投稿の保存成功と独立して開始し、更新失敗でHTTP成功を取り消さず、他のcount/poll/通知/AP処理を省かない。古いchannel IDは購読者照会より先に直接追加が始まり、照会失敗でも開始済み処理を待つ。削除はfanoutリストのIDをpurgeしない。永続依頼・自動retry・Create/Delete順序保証は追加しない。

本家と同じ10%の休眠sample（最大1000、最終活動がstrictに50日より古い）を維持し、Userとその全Followingの旗を独立に更新する。今回の投稿を受けた後、次回の通常follower照会から除外される。WebSocket接続時/5分周期の活動更新とUser/Following休眠解除は#173受信sliceで接続した。account API全体と他WS機能は#180/#189に残る。Metaは#217の変更通知cacheに依存せず後続ごとにDBから読む。

固定メソッドを実行した1,280 routingケースと、新実装の実HTTP/PG/Redis、起動停止・切断を検証する。[比較範囲](../superpowers/compatibility/note/timeline/README.md)。検索は下記のproducerへ接続済み。antenna・hashtag・featured等は#174の後続、閲覧API #185/#186、role関連 #181/#189、チャート #200、再構築 #132/#133と区別し、#174全体を完了にしない。

## 投稿WebSocket受信（#173）

通常HTTPへmain/homeTimelineとnote購読を接続し、native/app/miauth・guest、Bearer優先/read:account/凍結、受信者別filter・hidden再pack・snapshotのhide/myReaction、別名と購読上限を扱う。関係factsは初回/10秒、活動日時と休眠解除は接続時/5分、heartbeatは1分pingと最終pongから2分超の切断で更新する。停止時はupgrade/WS/timer/subscriberを閉じ、開始済み認証・描画・facts・activity照会を待ってからDB/Redisを解放する。

実HTTP作成→home/main通知、通常poll worker→pollEndedのPG保存とWS受信、実HTTP削除→subNoteのnoteUpdated/deletedと再接続・接続中SIGTERMを検証し、#173の残る実受信とstream側削除連携を満たす。[固定source64ケース・新実装の実依存検証・差異](../superpowers/compatibility/stream/README.md)を参照。本家full server/DB/workerの同時比較を示すものではない。queueStatsは下記#163で接続済み。他16channel・readNotification・queueStats以外のchannel/ch書込等#189、通知API/未読/既読/push/移行#177、広域cache#217、antenna・hashtag・featured等#174と最終削除連携#172、投稿全体の#176は未完了。

## 通常検索producer（#174/#172）

SDKを公開しない`modules/search/public.ts`の`SearchNote`/`SearchDocument`、`searchDocument`/`shouldUnindex`が登録可否とdocumentを決める。platformの`createSearchIndex`はSDK 0.62.0、compositionの`createPostingSearch`はsnapshot/DB読み取りと設定を所有する。UseCase間呼び出し・新規queue・永続状態は追加しない。

- `fulltextSearch.provider === meilisearch`だけで`${index}---notes`を更新。既定SQLLike/SQLPgroongaは外部へ通信しない。
- 登録はpublic/home、text/cwの少なくとも片方が非null（空文字も含む）。scope既定local、global、host配列で、local authorは配列でも対象。localOnlyを除外しない。documentはid/ID由来createdAt/userId/userHost/channelId/cw/text/tagsのみ。
- pack/mention準備失敗は検索開始を抑止する。開始済みstream/webhook/APの非同期失敗は抑止しない。既存created-eventsの準備成功末尾で登録要求を始める。
- 削除解除はpublic/homeのみで、scope/contentを追加条件にしない。既存`NoteDeleteWork`の`search`をDB DELETE直前に開始し、DELETE失敗後も開始済み要求を取り消さない。
- 要求失敗は操作名/noteIdと安全なerrorを記録し、post-save/deleteの既存集約/drainも維持する。settingsは起動成功条件にせず失敗を捕捉する。開始済みSDK HTTP要求は既存終了期限まで待つが、engine taskの適用完了・自動retryは追加しない。

作成snapshotは直後の削除後も材料になるため、本家と同じく遅れたaddがdelete後に適用され得る。強い順序・tombstone・replayは追加しない。[独立固定source256+8ケースと実依存検証](../superpowers/compatibility/note/search/README.md)。検索API #186、再構築 #132/#133、antenna/hashtag/featured、#174/#172/#176全体は未完了。


## 通常Roleタイムラインproducer（#174）

通常の投稿イベントは匿名の `skipHide: true, withReactionAndUserPairCache: true` 描画成功後、notesStream開始直後・webhook開始前に、同じpacked noteでRole producerを開始する。描画失敗時は開始しない。Role取得やRedisの非同期失敗はwebhook・通知・AP配送・検索の準備を止めず、既存post-saveが診断と終了待機を所有する。HTTP応答は保存・レスポンス生成の成功で返す。新たなsilent入力は追加しない。

Role定義と割り当ては既存材料cacheから取得し、この段階の明示時刻と、conditional定義がある場合だけ取得する現在のUser事実で公開selectorを評価する。割り当て期限は `expiresAt > now`、定義取得順のassignedにconditional一致を連結し、assigned conditionalが一致したときは同じRoleを二度処理する。roleの公開/探索可否、note visibility、channel、localOnly、Metaのfanout無効でproducerを除外しない。

各Roleで既存timeline専用Redisの `list:roleTimeline:<id>` へmax1000のpushを準備し、既存pubsub接続のinstance hostへ `{ channel: "roleTimelineStream:<id>", message: { type: "note", body: packed } }` を開始して、最後にpipelineを送る。既存の3分境界・古いIDの直接更新・10%trimを使い、常時1000件のhard capは追加しない。非同期の部分失敗でも他Roleの投入/publicationを開始する。本家同様に同期準備例外では後続Roleと未送信pipelineを止めるが、開始済み処理は待つ。

本家はconditional Userを5分cacheし、notesCountの加算もdetachedで始める。新実装は既存#119契約に従いUser事実をこの段階でDBから読む。加算→Role評価の順序は強化しないため、作成した1件をconditional notesCountが必ず含むとは保証しない。[固定source229ケース・新実装との直接比較16ケース・実PG/Redis/process検証と差異](../superpowers/compatibility/note/role-timeline/README.md)。

削除はRole cacheをpurgeせず、保存snapshotからの遅延投入も残す。#132/#133の再構築では現在のNote＋User＋Role/assignmentだけから過去の所属・期限・条件一致を復元できない。現在材料からの近似と履歴再現を区別し、再構築でpublicationは再送しない。Role閲覧API #181/#185とRole WS channel #189、antenna/hashtag/featured等の#174、最終連携#172/#176は残る。


## Renote の featured 加点（#174）

通常投稿の `renotedNoteId` と `createdSnapshot.renote` を使い、他人への nonbot Renote（quoteを含む）から元Noteへ +5 する。投稿自体の visibility/localOnly/channel/silent を新しい除外条件にしない。`random < 0.3` と実行時刻−元ID日時 `< 259200000` を満たす場合が対象で、未来IDも許す。sample不成立では時刻・ID解析を行わない。元Noteがchannel内なら非replyだけをchannelへ、channel外ならpublic/local/非replyだけをglobalと作者別へ加点する。

通常Redisへkeyごとの別MULTIで `ZINCRBY 5` と `EXPIRE NX` を送る。epochは2023-01-01 UTC、global/channelは3日window・9日TTL、作者別は7日window・21日TTL。age用clockと各keyのwindow用clockはそれぞれ実行時に取得する。countの完了・失敗に加点を従属させず、global失敗でも作者別を開始する。開始済み処理は既存post-saveのidle/closeへ含め、個別command失敗も安全な診断へ残す。保存済みNoteのHTTP成功は変えない。

固定本家は加点Promiseをdetachedで開始し、EXEC結果配列のcommand errorを検査しない。新実装は終了待機と診断へ集約する。合成portが同期例外を投げた場合も独立portを開始するが、本家の同期wrapper例外では後続portへ進まないため、この防御的な差異を本家同一とは呼ばない。実製品Redis writerはasyncであり同期準備の失敗もrejectになる。対象snapshot欠落はDB再読込で補わず診断し、通常HTTP経路がsnapshotを渡すことを実依存テストで確認する。

Renote削除や元Note削除による減算・purgeはなく、削除後の遅延snapshot加点も成立し得る。`featuredGlobalNotesRanking:<window>`、`featuredInChannelNotesRanking:<channelId>:<window>`、`featuredPerUserNotesRanking:<userId>:<window>` の値は確率と過去の実行windowに依存する。現存Note/renoteCountだけから厳密復元できないため、#132/#133で現在材料による近似と履歴再現を区別する。[固定source比較と再実行](../superpowers/compatibility/note/featured/README.md)。reaction +1 (#184)、2-windowを読む閲覧API (#185/#187)、gallery/hashtag、antennaと#174/#172/#176全体は残る。


## 通常投稿のhashtag producer（#174）

保存時snapshotのtags/作者/host/visibilityを使い、public/homeの投稿だけを処理する。bot・channel・localOnly・silent相当による除外は加えない。抽出済みtagsの順序と正規化衝突を維持し、Noteを再取得しない。`MiHashtag`は固定SHAから機械同期し、既存の本家migrationが作るhashtag表へ登録した。

DBはtagごとに一つの原子的INSERT ON CONFLICTで、historical mentionedUserIdsとlocal/remote配列・件数を更新する。同一作者は加算せず、同時の別作者も失わない。attached列は触らない。TypeORM 1.1.1の公開orUpdateは条件付き配列追加と件数式を表せないため、このadapterに限定してparameterized SQLを使う。

hiddenTagsのNFKC/lowercase完全一致とsensitiveWordsの既存RE2判定は通常Redisだけを除外する。`hashtagUsers:<tag>`のSISMEMBERが1なら全Redis書込を省き、DBは続ける。missならfeaturedの1時間windowへ+1/10800秒NX、10分HLLへPFADD/259200秒NX、作者SETへSADD/3600秒NXを独立して開始する。HLLはSISMEMBER前のlocal Date.setMinutes切下げからUTC成分でkeyを作り、featuredはその後の実行時計を読む。unique判定とSADDの間の競合を強化せず、同じ作者の同時投稿が二重加点され得ることを維持する。

本家の注入Metaと異なり、対象producer呼び出しごとに既存readMetaからhiddenTags/sensitiveWordsを読む（広域cache同期は#217）。設定読取を先に開始し、その完了や失敗をDBループの条件にしない。各ranking仕事だけが設定を待ち、読取失敗時はfilter不明のためrankingを行わず診断する。DB失敗は後のtagを止め、Redis失敗はDB進行や後のtagを止めない。featured MULTI失敗でもHLL/SET pipelineを開始する。開始済みの全仕事をsettleしてから既存post-save診断へ渡し、idle/closeで待つ。HTTP保存成功後の失敗をHTTPへ返さず、EXEC内command errorも診断する。この診断・drainは本家のdetached処理との差異である。

削除はhashtag表・unique/HLL/featuredを減算・purgeせず、削除後の遅延snapshotも処理する。表には削除済み投稿の過去作者が残り、Redisは過去の設定・処理時計・初回expiry・競合に依存する。現存Noteからの近似再構築と厳密な履歴再現を#132/#133で区別する。raw128文字の正規化後伸長は再切詰めせず、本家同様Note.tags varchar(128)[]へのINSERTで拒否される場合がある。

[固定source比較と実依存検証の境界](../superpowers/compatibility/note/hashtag/README.md)。profile attached/解除・hashtag API/packer/stream・chart読取、antennaと#174/#172/#176全体は未完了。上の過去sliceでhashtagを残作業とした記述は当時の状態を示す。


## 通常投稿のantenna producerと派生集計（#174）

通常post-saveは、保存時の作者 `{id,username,host,isBot}` と返信による補正後channelを保持し、通常TLの直後・packed描画を含む配送の前にantennaを独立開始する。Note・作者・channelを後から再取得しない。保存時のinsertオブジェクトへTypeORMがRETURNINGの既定列を反映した直後にplain snapshotを取り、reply/renoteの取得時raw snapshotとchannel全列を添える。`mentionedRemoteUsers`はJSON文字列で、未指定の新Noteのname/uri/urlは省略され、取得済み関連Noteではnullになる。packed Noteや作成後の再読込で代用しない。

最初の一覧取得だけ`isActive=true`を読む。TTL/single-flight/再接続refreshは加えず、本家のcold fetch完了による上書き・並行取得競合を維持する。instance hostのinternal `antennaCreated`はinactiveでも追加、`antennaUpdated`は最初の同IDを置換または追加、`antennaDeleted`は同IDを全除去する。CRUD/import/clean/reactivation等の発行元自体は今回追加しない。通常Redisのfollowing cacheは`kvcache:userFollowings:<ownerId>`へ全followeeの`{withReplies}`をJSONで保存し、Redis30分・memory1分。memoryのread境界はage>60000、3分GCも維持する。internal `follow`で両層を消し、`unfollow`は本家どおり無視する。Redis障害でDBへ縮退しない。

照合はsensitive channel、bot、local作者、reply、specified宛先、followers照会、src/list/account、include/exclude keyword、fileの順。followersでは自己所有でも先にcacheを読み、listは現在membershipを照会する。homeの追加following制限、expression評価、空白trimやアカウントの追加正規化は加えない。keywordsはtext+'\n'+cwへのOR-of-AND部分文字列で、exact-emptyだけ除く。exclude-onlyでもtext/cw双方nullは拒否する。

全定義の照合を並行開始し、一つでも失敗すれば全宛先の出力を止め、開始済み照会はsettleする。成功時は定義順に専用timeline Redisの`list:antennaTimeline:<id>`へ既存writerのmax200を渡し、host-topicへ`{channel:'antennaStream:<id>',message:{type:'note',body:rawNote}}`を開始してからpipelineを送る。3分境界、10%trim、古いIDの末尾判定・直接pushを既存writerから再利用する。非同期publication失敗でも後続宛先とpipelineを開始する。同期準備失敗では未送信pipelineを送らず、既開始publicationと古いID更新をdrainする。診断・終了待機・不正JSONの無視は本家detached処理からの運用上の差異。削除purgeや遅延snapshotの取消はしない。

channel集計は早期user/reply/renote countと分離する。packed/global・mention/thread準備成功後、AP開始の後・検索indexの前にnotesCount、lastNotedAt、初投稿usersCountをそれぞれ独立開始する。pack/mention準備失敗では開始せず、一つのSQL拒否で残りやindexを省かない。

remote作者の`Instance.notesCount`はstats有効時に既存台帳のfetchOrRegisterを使い、instance IDごとに+1を合算する。最初のenqueueから5分の期限を延ばさず、sourceと同じNODE_ENV=testのみ0ms。発火前にbatchを消し、更新中の同IDへのenqueueは次batchになる。通常remote削除は検索/DELETE前に-1を直接開始し、DELETE失敗でも取り消さない。設定は既存readMetaから操作ごとに読み、instance cacheのnotesCountを書き直さず、負値clamp・retryを加えない。終了はpost-save/post-deleteのregistrationを待ち、queued batchをflushし既発火更新も待ってから接続を閉じる。失敗は診断しbatchを再予約しない。source disposeが待たない既発火更新のdrainは資源寿命上の差異である。

[antenna固定source比較](../superpowers/compatibility/note/antenna/README.md)と[全通常更新の責任監査・channel/counter固定source](../superpowers/compatibility/note/derived-updates/README.md)を参照。source側は抽出実行と明記した実PG payload観測、新実装側は実HTTP handler/PG/Redisと通常子プロセスで検証する。通常token HTTPはlocal作者だけで、remote受信入口#195は未実装のままremote snapshot producerを直接検証する。antenna管理/閲覧#185、WS antenna#189、import/clean#199、account move#195、chart#200、広域cache#217、投稿全体の#176と再構築#132/#133は別責任。過去slice末尾の#174残作業は当時の状態であり、現在の完了判定は責任監査表による。

再構築は現存Note・現在の定義/所属から作る候補と、過去の定義・cache・membership・trim乱数・削除残留を含む履歴再現を区別する。remote instance countも遅延batch、削除と失敗履歴に依存し、現在Note数と必ず一致しない。対象ごとの保持・正本・復元不能材料を責任監査表から#132/#133へ引き継ぎ、再構築でraw publication・通知・APを再送しない。


## Queue管理と公開QueueStats（#163）

通常HTTPに本家14管理API、HTTP専用に全10 queue名のBullMQ handleを接続した。管理UseCaseは現在moderator（administrator/rootを含む）とread/writeの`admin:queue` scopeを検査する。公開queueStatsはguest・自己credential・`read:account` appが購読でき、queue scope/moderatorは要求しない。appの既存upgrade gateは維持する。

通常listはinclusive 0..100の101件、truthy searchは0..1000をpack後にAND検索/slice100とする。2 webhook queueのtop-level secretだけを秘匿し、本文・完全URL・userId・logsまで隠さない。pause/resumeは制御を待つが、clear/promote/retry/removeと該当監査は本家の非待機204を維持する。診断と開始済み処理の終了待機を追加し、Redis/PG監査間の原子性やrollbackを保証しない。

単一HTTP observerがsourceのXev連携を置き換え、deliver/inboxのactiveイベント・現在active/waiting/delayedを即時/10000ms周期で発行する。最新先頭200件のメモリ履歴は再起動で失われる。停止時にinterval/listener/QueueEventsを解放し、開始済みread/control/監査を接続解放前に待つ。既存のRedis無再接続方針は管理接続にも適用する。

[固定97観測・95公開投影の直接比較と新実装の実HTTP/PG/Redis/WS/process検証](../superpowers/compatibility/queue-admin/README.md)により#163の全14 API・QueueStats・実制御/認可/寿命条件を確認した。本家full server全体の比較ではない。通常保持/清掃#164は下記の実依存検証で確認した。実payload互換/残仕事引継ぎ#165は下記の停止専用検査へ接続し、#176の残る縦断確認へ渡す。#124全体、他stream#189・他管理#194や全10業務workerの完成は含めない。


## 通常queue履歴の保持と清掃（#164）

`deliver` / `endedPollNotification` / `userWebhookDeliver` の3 producerは成功`{ age: 604800, count: 30 }`・失敗`{ age: 604800, count: 100 }`を各jobへ渡す。保持は同じqueue・同じ終端状態への遷移時に働くlazy清掃で、静かなqueueの履歴が7日後に必ず消えるTTLではない。job名を跨ぐ終端集合に適用し、成功の清掃はfailedを、失敗の清掃はcompletedを削除しない。Queue既定値やWorker fallbackはなく、無設定legacy jobも後続のpolicy付きjobの清掃から保護されるとは限らない。

固定本家の24観測（8 source・32 QueueService producerメソッド）と新実装の直接比較28件、3実producer/WorkerのRedis保持8件、全10管理selectorの終端履歴・clear追加10件を記録した。近傍を含む最終単体は4 files / 97 tests、結合は2 files / 49 testsが成功し、製品コードは変更していない。実Workerのhandler callbackは結果を制御するためのdoubleであり、本家full server比較や通知/AP/webhookの業務全体の証明にはしない。[再実行・検証範囲と所有者](../superpowers/compatibility/queue-retention/README.md)。

自動保持と終端限定clearはwaiting/paused/prioritized/delayed/locked activeを残す。管理者が明示する非終端状態や`*`のclearは本家どおり破棄操作である。消えたjobは一覧/logsから消え、`show-job`は既存のmissing-job500、累積metricsは残る。非待機204と認可・監査は#163の契約を維持する。

全10名の管理と現在3業務queueの保持を確認して#164の現行範囲を満たす。他7業務queueのproducer/handlerは未接続で、system保守#199/chart等#200、予約投稿#183、inbox#195、db#199、relationship#182、objectStorage#188（remote保守#199）、systemWebhook#198へ残る。system定期jobはage-onlyで、導入時に古いscheduler定義の整理も移植する。通知本体の保持は#177、他webhookイベントは#197、既存payload/schedulerの引継ぎは下記#165、完全停止切替は#139が所有する。#124/#176全体の完成とはしない。


## 停止下の既存queue/payload引継ぎ（#165）

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` と新実装はともに BullMQ `6.3.11` を使う。現在の3業務queueは、同じRedis DB・prefix上の元jobを保持して引き継ぐ。job ID・name・data・opts・試行数・delayed score・paused状態・終端履歴をexport/replayや再投入で作り直さず、queue形式を変換しない。note/webhook/draft IDを使うjob名とBullMQ job IDは別であり、同名jobを重複排除しない。

[全10 queueの固定source台帳・実引数fixture・検証範囲](../superpowers/compatibility/queue-handoff/README.md)と[実装計画](../superpowers/plans/2026-11-08-queue-handoff-165.md)を参照する。17 fixture・全10名・9 scheduler・11 source guardのsource抽出/double観測と、実Redis/業務handlerの検証を区別する。通常CIは記録済みsource引数へ明示したテストbindingを適用し、現在の同版BullMQで保存する。別確認は固定sourceの呼出し前にbindingを渡して再実行し、本家installed BullMQで保存する。後者で3業務handler・7 webhookの実HTTP/PG結果と、旧Workerが残した60秒retryの同ID継続を確認した。本家full serverの実行比較ではない。

| queue | 保持・停止前の扱い | 未対応の所有者 |
| --- | --- | --- |
| `deliver` | 対応payload/optionsのwait/paused/prioritized/delayedを元jobのまま保持。failedはfailedのままで自動retryしない | AP配送の既存handler |
| `endedPollNotification` | 同じnoteId・ID・nameと遅延時刻を保持し、既存handlerでPG通知へ進む | 通知保存差異・移行は#177 |
| `userWebhookDeliver` | 投稿4種とfollow/unfollow/followedの7種の投入時snapshotをそのまま送る。reactionは未対応 | 他イベントproducer/APIは#197 |
| `system` | completed履歴は保持可能。未完了・failed・scheduler定義/次回instanceは切替を拒否する | 保守・announcementは#199、chart等は#200 |
| `postScheduledNote` | completed履歴以外の未完了・failedを拒否する | #183 |
| `inbox` | 同上 | #195 |
| `db` | 同上 | #199 |
| `relationship` | delayed unfollowを含め、同上 | #182 |
| `objectStorage` | 同上 | #188、remote保守は#199 |
| `systemWebhookDeliver` | 同上 | #198 |

全queueでactive・lock・stalled・waiting-children/dependency・repeat/scheduler・孤立/不明な記録を拒否する。lock期限切れや結果不明の仕事を失敗・安全な再実行とみなさない。未対応の仕事は旧実装で通常完了させて再停止するか、担当機能の実装まで切替を待つ。未対応7 queueのfailedも、処理結果とretry方針を判断できないため拒否する。clear・scheduler削除・無断retry/promoteで条件を作らない。

固定本家はsystemへ9定期schedulerを登録し、古い定義を整理する。waiting=0でも定義と未来の仕事が残り、現在は#199/#200待ちの実際のblockerとなる。`archiveAnnouncement`もdbではなくsystemの遅延jobで、明示jobIdを持つ。予約投稿はdraft.idをjob名にし、通常の自動job IDと`{noteDraftId}`を持つ。いずれも管理用handleの存在を業務実装済みの根拠にしない。

### #139へ渡す停止・backup・rollback

1. 旧release/新candidate・設定を固定し、PG、各Redisのendpoint/DB/prefix、専用`redisForJobQueue`、過去の独自adapterで選んだprefix、暗号/署名鍵、storage、外部検索を棚卸しする。旧新のHTTP・worker・scheduler・scanner・補助producerをすべて停止し、終了期限とactiveの結果を確認する。
2. 停止したPG・job Redisを含む必要なRedis・storage等の外部状態を、同じ復旧点へ戻せるcoordinated backupとして取得し、隔離した復元先へ戻す。バックアップやpayloadには秘密が含まれるため、保管先は安全に管理しリポジトリや検査出力へ含めない。
3. 復元先を向く正確なcandidate設定で[停止専用checker](../../packages/backend-next/README.md#停止下のqueue引継ぎ確認165)を実行する。blockerは旧実装/担当機能で解決して完全停止・backup・復元・再検査を繰り返すか、切替を延期する。
4. 必要な停止下migration・`check-migrations`・検証用DBの`check-schema`を確認してから、隔離先で新実プロセスを起動する。外部効果、通常delayed retry、停止と再開を確認する。checker成功だけで#135の未対応確認・#138の配布・#177の通知移行・#139の最終切替を完了扱いしない。

検査だけを行い、新consumerの消費やmigration前であれば、元の停止済み依存先を変更せず旧binary/configへ戻せる。消費またはmigration後は新プロセスを停止し、PGとRedisのcoordinated backup、必要な外部状態の復旧を揃えてから旧binary/configを起動する。migrationのdownだけでは廃止済みjobを再現できず、PG通知保存先の差異もbinaryだけでは戻らない。

AP/webhook送信成功はbackup復元で取り消せず、復元したjobのretryで重複送信し得る。結果不明の外部効果も照合が必要で、通常BullMQ以上のexactly-once保証や独自台帳は追加しない。#165の検査・実payload互換の完了と、#124/#176の全体完成を区別する。

## N7の限定検証と残る互換差分（2026-11-08）

[現在のN7台帳・実測・再現手順](../superpowers/compatibility/note/n7/README.md)に、C1–C10の全観測、F1–F8の現在の適用範囲と、notes94行/AP outbound10行の元ID・statusを保持した照合を記録した。固定本家HTTP観測、source-method比較、新実装の実process、制限回帰を分け、fixtureの存在だけで一致としない。通常HTTP保存→show→worker→通知/WS/AP/webhook/TL/検索→停止再開・自然retry→削除と、認可/保存失敗を既存harnessで検証した。実測は統合214件、processは別々の3実行で8＋5＋7件。これは本番切替の判定ではない。

#195の限定core runtime `33e67182e3dea5a39bd2b7c251ba9ee9ec4e0f45` は、未登録remote取得・stale refresh・失敗出現の省略から署名配送までを[固定source95件の消費と実測](../superpowers/compatibility/remote-user/runtime-results.md)で確認した。旧501/省略blockerは[N7](../superpowers/compatibility/note/n7/README.md)で履歴を固定し、証明したcoreだけをsupersedeする。rich actor効果、N7 C2 whole rate DB-delta/C10 audit-streamの比較ギャップを残し、`api:notes/create`はpartial、`postingComplete`はfalse。#195/#176/#127は未完了で、未移植機能を承認済み差異や保留強化にしない。

#124はN7独立条件監査時に現行全必須条件PASS（runtime `28e670721e6bd6e6ec117ddc67036d1951cd59a3`）。監査時のOPENと当時のclosure referencesは履歴として保持する。現在は#242がマージ済みで#124はCLOSED。旧e133a0fでのscoped reviewはTask2 Spec PASS / Quality APPROVEであり、local URI parser修正後の全branch承認やCodeRabbit差分確認を意味しない。未対応7handler・system9schedulerと切替#139は上記引継ぎ契約を維持する。
