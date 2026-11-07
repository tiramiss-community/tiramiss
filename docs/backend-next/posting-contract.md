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

添付・投票・返信/Renote/引用・channel・指定宛先・MFM抽出を、固定本家の `notes/create` と `NoteCreateService` に合わせて接続する。基本text作成の501暫定制限は、未登録リモートユーザー宛てメンションを除いて撤去する。

- **判定順**: 入力検証 → 指定宛先の取得 → 添付 → Renote対象 → 返信先 → 投票期限（本家どおり、`expiredAfter` は要求開始の時刻から数え、期限は関連の取得を終えた時点の時刻と比べる。Dateの範囲外の値は期限切れとせず、保存時のDBエラーで500）→ channel → 返信先によるchannelの補正 → channel投稿の強制（public・宛先なし・localOnly）→ sensitiveWords/canPublicNote（channelなしのみ）→ 禁止語（trim前のcw・text・選択肢）→ Renote対象/返信先による公開範囲・localOnlyの補正 → textのtrim → MFM抽出（text・cw・選択肢）→ メンション解決 → 返信先作者・指定宛先の追加 → メンション数上限 → 保存。複数の誤りでは最初のエラーを返す。エラーのcode/id/messageは本家どおり。
- **存在・可視性・ブロックの確認**は保存と同じtransactionに入れない（本家も同じ）。確認後の削除・ブロックは検出しない。本家の `create()` 内でcacheによりブロックを再確認して500になる経路は、DBの確認と食い違う競合時だけに起きるため移植しない。
- **保存**: 投票ありはNoteとPollを、UseCaseが所有する1つのtransactionで保存する。投票なしはNoteの単純insert。非正規化列（threadId・replyUserId/Host・renoteUserId/Host・renoteChannelId・attachedFileTypes・mentionedRemoteUsers）も本家と同じ値で保存する。
- **保存後のcount**: user.notesCountに加え、返信先repliesCount、Renote対象renoteCount（他人の投稿・botでない投稿者のみ。引用も含む）、channelのnotesCount・lastNotedAt・usersCount（その投稿者のchannel内Noteが1件ならusersCount+1）を、保存後の原子的更新として行う。削除では返信先の `repliesCount` だけを1減らし、user・Renote・channelのcountは減らさない（#172）。作成応答の描画を終えてから開始し、応答の入れ子の返信先/Renote対象のcountを本家と同じく今回の加算前の値にする。
- **メンション**: ローカルユーザーと登録済みリモートユーザーをDBで解決する。見つからないローカルユーザーは本家どおり無視する。自ホスト判定とホスト正規化は[連合の共通土台](federation-base-contract.md)を使う。登録済みリモートユーザーは `lastFetchedAt` に関係なく再同期せず使う。DBにない（未登録の）リモートユーザー宛ては、メンション解決の位置で保存前に501 `NOT_IMPLEMENTED`で拒否する。どちらも#195で除去する暫定制限であり、完成版の意図的差異にしない。
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

本家の 10 queue のうち、他は未接続。

## 選択の理由

旧PG実行プロトコルを接続する案は初期目的に不要な保証と運用を増やす。先に全強化実装を消す案は未接続adapterの置換作業だけで機能実装を遅らせる。基本投稿を通しながら参照のない部分から撤去し、相互依存する残りを直後のPRでまとめて減らす。

## 投稿削除（#172）

`POST /api/notes/delete` は作者または現在のmoderatorに許可する。`write:notes`、停止状態、入力とエラーUUIDは固定本家に合わせ、移行済み作者も削除できる。productionではdelete専用の1秒間隔と1時間300回枠を、RoleのrateLimitFactorで調整する。moderator資格とfactorは現在のDB材料で評価する。

本家と同じく、返信先の `repliesCount` 減算を独立した文として先に確定し、必要なAP表現と配送を開始してから `id + userId` でNoteを削除する。後のDELETEが失敗しても、先の減算や開始済み配送をrollbackしたことにしない。同期の表現失敗（specifiedのpure Renote等）はDELETE前の失敗となる。moderatorの他人削除の監査はDELETE成功後に開始するbest effortで、監査失敗は削除の失敗へ変換しない。Note全列と作者情報を監査へ渡す。Poll/Vote/Reactionは既存FKで削除され、参照する返信/Renoteは残る。

ローカル作者かつ `localOnly=false` のとき、通常投稿・引用はDelete(Tombstone)、元投稿が残るpure RenoteはUndo(Announce)、元投稿消失時はDeleteへ戻す。作者鍵を使い、followers・accepted relay・concerned directを別々に投入する。非public削除もfollowers/relayを対象にし、followersとdirect間でsharedInboxを重複排除しない。concernedは保存済みremote mention URI・Renote作者と、削除対象へのremote返信/Renote作者。対象自身の列は削除前に保持し、参照する子Noteは削除後も照会できる。

開始済みの配送・監査は `notePostDelete` が終了期限まで待つ。失敗は `note-post-delete.failed` に記録し、producerの再実行・永続宛先台帳・強いCreate/Delete順序を追加しない。stream/通知は#173、TL/検索は#174、webhookは#175、チャートは#200、最後の連携確認は#176に残す。[実装と検証](../superpowers/plans/2026-11-07-note-delete-172.md)。


## 投稿通知とstream producer（#173 第1slice、2026-11-07）

reply/mention/quote/renote/noteの条件を`modules/note/notification-plan.ts`と通知の受信policyへ分離し、UseCaseでID・時刻を決めて既存PG通知へ直接保存する。購読通知とmanager通知は別枝で、設定・follow/list/muteは処理時、thread muteは各mention/replyの準備時に読む。ブロック・ワードミュートを保存前の条件として独自追加しない。保存後のnotifier検査でstreamだけ抑止される場合も本文は保持する。

通常投稿は本家のguest `skipHide`/reaction-pair付き`notesStream`とreply/renote、受信者別detailのmentionを発行する。通知は保存完了後、受信者別Note/UserLiteを含め`mainStream`へ発行する。Redis channelは公開URLのhost、論理channelとmessageを包む本家のJSON形式を使う。削除は返信数減算後、AP準備と物理DELETEの前に`noteStream`のdeletedを開始する。後段のDELETE失敗でも発行を取り消さない。

保存済みNoteと即時参照先の値は投稿処理のメモリ内で保持し、後続のcount更新や即削除による表現変更を避ける。Poll/Voteは描画時の現在値を読む。global/mention/thread準備の失敗ではmanager/APへ進まず、先行した購読通知は独立して終了する。通知保存・publishの失敗でHTTPの保存成功を取り消さず、開始済み処理をdrainし診断ログへ残す。

既存の投票終了workerも保存後の通知発行へ接続した。削除済み投票・現在の設定・重複ジョブの規則は#162を維持する。通知本文の保存済み状態とstreamの成功は別で、永続effect・容量・一度だけ成立の基盤は再導入しない。

検証は実HTTP/PG/Redis subscriberと通常poll worker、C10固定本家観測、source由来の受信条件・失敗境界を含む。[計画・実測](../superpowers/plans/2026-11-07-notification-stream-173.md)。WebSocket transport/auth/channelとクライアント受信は#189/#173/#176、広域fanout/cacheは#217、通知閲覧/既読/未読timer/push/移行は#177に残り、全stream/通知領域の完成とは扱わない。

投稿 user webhook (#175) は保存後のイベント処理で note/reply/renote/mention を選び、通常 `userWebhookDeliver` queue に URL・secret・payload を固定する。受信者別の条件、処理・保持と未完了範囲は[比較資料](../superpowers/compatibility/user-webhook/README.md)を参照。固定本家に削除 webhook はない。設定 API・他のイベントは #197、作成から削除の縦断は #176。

## 通常タイムラインproducer（#174 第1slice）

home/local/user/list/channel（files/replies派生を含む）の宛先規則を純粋plannerへ分離し、保存時のNoteと処理時のFollowing/list/channel/Metaを使ってRedisへ直接追加する。`redisForTimelines`（未指定は通常Redis）、`list:<name>`と既存prefix、channel上限 `perChannelMaxNoteCacheCount ?? 1000` とMeta上限を維持する。3分以内のstrict境界・10%trim、古いIDの末尾日時比較と非trimは固定本家に従う。小数の半上限も丸めない。

通常投稿の保存成功と独立して開始し、更新失敗でHTTP成功を取り消さず、他のcount/poll/通知/AP処理を省かない。古いchannel IDは購読者照会より先に直接追加が始まり、照会失敗でも開始済み処理を待つ。削除はfanoutリストのIDをpurgeしない。永続依頼・自動retry・Create/Delete順序保証は追加しない。

本家と同じ10%の休眠sample（最大1000、最終活動がstrictに50日より古い）を維持し、Userとその全Followingの旗を独立に更新する。今回の投稿を受けた後、次回の通常follower照会から除外される。WebSocket接続時の復帰は#189/#180に残る。Metaは#217の変更通知cacheに依存せず後続ごとにDBから読む。

固定メソッドを実行した1,280 routingケースと、新実装の実HTTP/PG/Redis、起動停止・切断を検証する。[比較範囲](../superpowers/compatibility/note/timeline/README.md)。検索・antenna・hashtag・featured・role timeline等は#174の後続、閲覧API #185/#186、role関連 #181/#189、チャート #200、再構築 #132/#133と区別し、#174全体を完了にしない。
