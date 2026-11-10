# 停止下の残 job 引継ぎ資料（#165）

固定本家 `misskey-dev/misskey@8e07cf085adf7009583d234a208e30436f020e26` の実 producer 引数を保存する。[通常保持の比較](../queue-retention/README.md) の全32 QueueService producer・全10 Queue/Worker 設定を再採取する資料ではなく、payload を含む引継ぎの入力である。旧 fork の独自形式は対象に含めない。

## 再現方法と証拠の範囲

```sh
node docs/superpowers/compatibility/queue-handoff/reference-queue-handoff.cjs /path/to/pinned-upstream --check
```

[observations.json](observations.json) は17 fixture・全10名・9 scheduler template と11 source の blob/SHA-256 を保持する。固定 Git オブジェクトを `git show` で読み、作業ファイルを使わない。通常の `--check` は期待値を書き換えない。更新候補は `OUTPUT=/tmp/queue-handoff.actual.json` を指定して採取し、diff と理由を確認する。`EXPECTED` は negative control 用の別期待値、`REPOSITORY_ROOT` は TypeScript を解決する repository の指定に使える。

probe は QueueService module、選択した完全な producer method、NoteCreateService の投票条件 block 全体、NoteDraftService.schedule 全体、ApRequestCreator.createDigest method を実行する。Queue/add/addBulk/scheduler・decorator・時計 `1800000000000`・UUID は明示した double である。digest は実 source method と `node:crypto` で計算し、偽の digest を置かない。fixture の省略可能な `undefined` は Redis payload と同じく JSON 化で消える。

これは source の payload/name/opts と scheduler 呼び出しの証拠である。BullMQ の保存処理・Redis・Nest DI・本家 full server・業務 worker を動かした証拠にはしない。fixtures は `jobs: [{name,data,opts}]` の同じ形で single/bulk を保存する。

| fixture ID | 実行した source |
| --- | --- |
| deliver-single / deliver-bulk | QueueService.deliver / deliverMany |
| poll-future | NoteCreateService.postNoteCreated の poll 条件 block |
| webhook-note / reply / renote / mention / follow / unfollow / followed | QueueService.userWebhookDeliver |
| inbox / system-archive | QueueService.inbox / scheduleAnnouncementArchive |
| db-import / relationship-delayed | createImportFollowingToDbJob / createDelayedUnfollowJob |
| object-storage / system-webhook | createDeleteObjectStorageFileJob / systemWebhookDeliver |
| scheduled-note | NoteDraftService.schedule |

## 全10名と実 payload

以下の source path は固定コミットの `packages/backend/src/` からの相対 path。完全な型は `queue/types.ts:18–145`、全 producer の保持引数は既存 [retention 観測](../queue-retention/observations.json) を参照する。新資料の他7名は代表 fixture であり、未移植 handler の実行確認ではない。

| 物理 queue 名 | 名前・payload・特別な opts | source | 現在の処理先 |
| --- | --- | --- | --- |
| deliver | URL の最初の https:// と /inbox を除いた名前。`user/content文字列/digest/to/isSharedInbox`。attempts 設定値または12、custom backoff | core/QueueService.ts:149–225 | 実装済み |
| endedPollNotification | note.id を名前、`{noteId}`。期限までの delay | core/NoteCreateService.ts:819–834 | 実装済み |
| userWebhookDeliver | webhook.id を名前、`type/content/webhookId/userId/to/secret/createdAt/eventId` の投入時 snapshot。attempts override または4、custom backoff | core/QueueService.ts:700–730 | generic snapshot sender を実装済み。新 producer は投稿4イベント |
| system | 下記9定期仕事、または archiveAnnouncement `{announcementId,autoArchiveAt}`。単発だけ明示 jobId と delay | core/QueueService.ts:59–88,120–145,252–282 | 未実装。#199/#200 |
| postScheduledNote | draft.id を名前、`{noteDraftId}`、未来の有効な予約だけ delay 投入 | core/NoteDraftService.ts:307–327 | 未実装。#183 |
| inbox | activity.id 由来の名前、`{activity,signature}`。attempts 設定値または8、custom backoff | core/QueueService.ts:228–249 | 未実装。#195 |
| db | 下記各名前と import/export/account の材料 | core/QueueService.ts:291–604 | 未実装。#199 |
| relationship | follow/unfollow/block/unblock。`from/to` の id と optional silent/requestId/withReplies。delayed unfollow だけ delay | core/QueueService.ts:607–663 | 未実装。#182 |
| objectStorage | deleteFile `{key}`、cleanRemoteFiles `{}` | core/QueueService.ts:666–692 | 未実装。#188/#199 |
| systemWebhookDeliver | webhook.id、userId を除く webhook snapshot。attempts override または4、custom backoff | core/QueueService.ts:738–767 | 未実装。#198 |

db の deleteDriveFiles/exportCustomEmojis/exportNotes/exportClips/exportFavorites/exportMuting/exportBlocking/exportUserLists/exportAntennas は `{user:{id}}`。exportFollowing は excludeMuting/excludeInactive（既定 false）を追加する。importFollowing/importMuting/importBlocking/importUserLists/importCustomEmojis は `{user:{id},fileId}`、importFollowing は optional withReplies を追加する。importFollowingToDb/importBlockingToDb は bulk の `{user,target,withReplies?}`、importAntennas は `{user:{id},antenna}`、deleteAccount は `{user:{id},soft?}`。deliverMany と import-to-db は caller の user を渡すので、未知の余分な user field を自動的に消す契約ではない。

単発と bulk の通常 opts は成功 `{age:604800,count:30}`・失敗 `{age:604800,count:100}`。age は秒、delay はミリ秒。上記 retry 指定以外の attempts は省略される。名前に note.id/webhook.id/draft.id を渡すことは固定 jobId の指定ではない。明示 ID は archiveAnnouncement の `archiveAnnouncement-${id}-${epochMs}` だけで、既存同IDが非終端なら投入せず、終端なら remove 後に再投入する。その他は BullMQ の counter ID を保つ。保持の実挙動は既存 retention 資料へ引き継ぐ。

system scheduler は名前を key として upsert し、`immediately:false` と age-only の成功/失敗7日 opts を template に渡す。tickCharts は `55 * * * *`、resyncCharts/cleanCharts/aggregateRetention/clean/bakeBufferedReactions は `0 0 * * *`、checkExpiredMutings は `*/5 * * * *`、checkModeratorsActivity は `30 * * * *`、cleanRemoteNotes は `0 4 * * *`。source constructor は getJobSchedulers の現在9名にない key を remove する。この処理は double 上だけで採取し、検査目的で実 Redis に source constructor を起動しない。

## 接続先と Redis の実形式

`config.ts:323–326,372–380` は redisForJobQueue を優先し、未指定時は redis を使う。prefix は URL host、DB は0が既定。port/auth/TLS/DB も含めて同じ接続先を選ぶ。`queue/const.ts:23–30` は ioredis keyPrefix を外し、BullMQ prefix を `<prefix>:queue:<name>`、空 prefix なら `queue:<name>` にする。BullMQ がさらに queue 名を付けるため、物理 root は **`<prefix>:queue:<name>:<name>`** となる。

固定 source と現在の manifest/installed BullMQ はいずれも **6.3.11**。新旧の relevant JS/Lua は同じ内容だった。新形式への変換・依存更新は追加しない。installed `bullmq/dist/cjs/` の根拠は次のとおり。

- `commands/includes/storeJob.lua:4–31` は job hash に name/data/opts/timestamp/delay/priority、必要時に rjk を保存する。`classes/redis-queue-backend.js:2004–2058` は圧縮 opts、ats/atm/stc/rjk/defa を decode する。
- `commands/includes/getDelayedScore.lua:7–24` の delayed score は due epochMs×4096 と順序 slot。opts.delay だけから現在の再試行時刻を作り直さない。
- `classes/job-scheduler.js:176–193,292–293` の occurrence ID は `repeat:<schedulerId>:<nextMillis>`。repeat ZSET と `repeat:<id>` hash の pattern/opts/data/ic が次回登録にも必要になる。
- `classes/worker.js:43,74` と `commands/moveStalledJobsToWait-9.lua:53–119` は active・期限付き lock・stalled counter を扱う。lock が消えたことを未実行の証拠にしない。
- `classes/worker.js:525–550` は旧 `name:id:endDate:tz:pattern/every` 型 repeat key が新 scheduler と確認できなければ次回登録のエラーを出す。現在の source が新 API を使うことは、古い repeat の継続証明にはならない。
- `classes/job.js:827–838` の明示 retry は失敗/終了情報を変える。failed は worker 再起動だけで自動再実行される仕事ではない。

## 実 BullMQ fixture の生成入口

`generate-bullmq.cjs` は隔離テスト専用の producer child。実装側の結合/プロセステストから次の形で起動する。

```sh
node docs/superpowers/compatibility/queue-handoff/generate-bullmq.cjs /path/to/pinned-upstream /tmp/test-queue-config.json /tmp/test-queue-receipt.json
```

設定は `{redis:{host,port,db,prefix,...},fixtureIds:["deliver-single","poll-future","webhook-follow"],schedulerIds:[]}`。prefix と fixtureIds の明示が必要である。実 source mode の任意の `bindings` で userId/noteId/webhookId/webhookUrl/deliverUrl/sharedInboxUrl/activity を **source 呼び出し前の材料として**差し替えられる。静的 fixture を再書換せず、変更後の材料でも完全な source producer を実行する。URL はテスト用宛先を指定し、Redis 設定・receipt は機密を含めて commit しない。

実 source mode の helper は最初に固定期待値を照合し、固定 source 引数を再採取した後、本家 package から解決した実 BullMQ 6.3.11 の Queue.add/addBulk/upsertJobScheduler に渡す。source が選んだ job opts を書き換えない。全 Queue.close の完了後に mode0600 の receipt を保存して終了する。新 worker の開始は child の正常終了後に行う。receipt の fixtures[].jobs は実 ID/name/data/opts/state を保持する。

CI では upstream checkout の代わりに `--recorded` を渡す。これは commit 済みの固定 source 引数 fixture を読み、上記3 queue の定義済みフィールドだけへ明示したテスト用 bindings を適用し、現在の backend-next に installed の同じ BullMQ 6.3.11 で保存する。source の再実行や本家 installed module の実行ではない。receipt の `mode` は `recorded-arguments`、実 source mode は `pinned-source` で、`evidence` も区別する。両方とも実 Redis に実 BullMQ の job を作るが、証明する source 実行の範囲が異なる。通常 CI は `/tmp` の本家 clone・network・cached 依存へ依存しない。手元の別確認は `BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream` を結合/プロセステストへ渡す。

recorded bulk の宛先 binding は source fixture の `Map` と同じく、同じ URL が2回現れた場合に最後の値を保持する。deliverUrl と sharedInboxUrl が同じなら shared=true の1件になり、別の single deliver は shared=false のままである。`node docs/superpowers/compatibility/queue-handoff/generate-bullmq.cjs --check-bindings /path/to/pinned-upstream` で、異なる URL と同じ URL の両ケースについて、binding 後の引数を実 source capture へ直接照合できる。この照合は Redis を使わない。

ここで実行するのは **固定 source の producer 引数＋実 BullMQ**。本家 full server や業務 worker の実行とは区別する。単なる `.add` の成功は配送・通知保存・webhook HTTP の成功を証明しない。それらは実装側の引継ぎテストで現在の業務 handler に接続して確認する。

## 判定と未対応の境界

新 deliver parser は user.id/content/digest/to の文字列と isSharedInbox の boolean を要求する。固定 producer は満たす。一方 source signedPost は digest 省略時に生成し、source deliver worker は isSharedInbox を使わないため、さらに古い欠落 payload を無条件に互換としない。poll は非空の noteId が必要である。

本家 `models/Webhook.ts:10` は mention/unfollow/follow/followed/note/reply/renote/reaction の8名を列挙する。`core/UserWebhookService.ts:17–26` の content 分岐は投稿4名の `{note}` と follow/unfollow/followed の `{user}` で、reaction 分岐はない。新 sender は runtime で snapshot をそのまま送るため、TypeScript の新 producer 型だけを理由に過去の follow/followed を拒否しない。この資料は7種の source fixture を保存し、実送信の確認範囲は実装側の結果を参照する。

7未実装 queue の nonterminal/failed/scheduler、active/lock、孤立/不明形式を消去・再投入・自動 retry して切替条件を満たさない。全旧 producer/worker/scheduler を完全停止したうえで同じ Redis DB/prefix を検査する。全10名を管理 API で読めることは全10業務 handler の引継ぎ完成を意味しない。最終切替・backup/rollback は #139、通知移行は #177 が所有する。外部 HTTP 成功後に完了記録前の crash があれば再送し得るため、厳密に一度だけの実行保証は追加しない。

## この資料の検証

source `--check` は17 fixture・全10名・11 sourceで成功した。別の期待値コピーの deliver digest を `wrong-digest` に変える negative control は不一致で exit1、元期待値への再実行は成功した。実 Redis・業務 handler・built process の検証結果は、この source 採取の成功と分けて実装側のテスト/計画に記録する。

## 実Redis・業務handlerとprocessの検証

通常CIと実source modeを別々に実行した。通常CIのreceiptは`recorded-arguments`で、記録済み17 fixtureへ明示したテストbindingを適用し、現在installedのBullMQ 6.3.11で実Redisへ保存する。実source modeのreceiptは`pinned-source`で、固定Git sourceの実producerをテストbindingを渡して再実行し、本家packageから解決したBullMQ 6.3.11で保存する。いずれもproducer childのclose/正常終了後に検査し、同じjobを通常built workerへ渡す。source double、実BullMQの状態生成、実業務handlerの結果を混同しない。

専用PG/Redisを[backend-nextの検証手順](../../../../packages/backend-next/README.md#検証)で起動し、利用する公開portを指定する。この実測ではPG `55487` / Redis `56387`と一意なDB/prefixを使った。

```sh
pnpm --filter backend-next test test/unit/job-queue/handoff.test.ts test/unit/job-queue/retention.test.ts test/unit/job-queue/deliver.test.ts test/unit/job-queue/ended-poll-notification.test.ts test/unit/job-queue/user-webhook.test.ts
BACKEND_NEXT_TEST_DB_PORT=55487 BACKEND_NEXT_TEST_REDIS_PORT=56387 pnpm --filter backend-next test:integration test/integration/queue-handoff.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
BACKEND_NEXT_TEST_DB_PORT=55487 BACKEND_NEXT_TEST_REDIS_PORT=56387 pnpm --filter backend-next test:process test/processes/queue-handoff.test.ts
```

別途、固定本家checkoutとそのinstalled依存を用意して次を実行した。通常CIにこのcheckoutやnetworkは要求しない。targeted processの2回を、実source modeの全4件一括成功とは表記しない。

```sh
BACKEND_NEXT_TEST_DB_PORT=55487 BACKEND_NEXT_TEST_REDIS_PORT=56387 BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream pnpm --filter backend-next test:integration test/integration/queue-handoff.test.ts
BACKEND_NEXT_TEST_DB_PORT=55487 BACKEND_NEXT_TEST_REDIS_PORT=56387 BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream pnpm --filter backend-next test:process test/processes/queue-handoff.test.ts -t 'stopped source fixture'
BACKEND_NEXT_TEST_DB_PORT=55487 BACKEND_NEXT_TEST_REDIS_PORT=56387 BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream pnpm --filter backend-next test:process test/processes/queue-handoff.test.ts -t 'old transient'
```

| 実行 | 確認した結果 |
| --- | --- |
| 近傍単体 | 5 files / 135 tests成功。新checker38件を含む |
| 通常CIの実Redis結合 | 1 file / 31 tests成功 |
| 実source modeの実Redis結合 | 1 file / 31 tests成功 |
| 通常CIのprocess全体 | 1 file / 4 tests成功、73.12秒 |
| 最終binding修正後の通常CI業務process | targeted 1件成功、7.68秒 |
| 実source modeの3 handler・7 webhook業務process | targeted 1件成功、8.12秒 |
| 実旧BullMQの遅延retry→新業務worker | targeted 1件成功、63.50秒 |
| 依存順build / source・test typecheck / 変更runtime・testのquiet ESLint | 成功 |

実Redisでは401件のpaging、globを含むprefixと隣接prefix/別DBの隔離、空namespaceへのkey未作成、全7未対応queueのpending/failed拒否とcompleted保持、実sourceのsystem scheduler/次回delayed instance、active/lock、孤立したhash/repeat metadata、legacy repeat、dependency、不正Redis typeを扱う。検査前後のDUMPを独立に比較し、拒否した状態も変更しない。途中切断と接続拒否は有限時間で非0終了し、任意のpayload/URL/普通の文字列に埋めた機密sentinelを出力しない。

通常built workerは元のID/data/optionsを持つsingle/bulkの3 AP送信、実5秒遅延pollからPGのpollEnded通知保存、note/reply/renote/mention/follow/unfollow/followedの全7 webhook envelopeを処理する。署名/Digest/body、投入時secret（現在DBのsecretとは異なる）、eventId/createdAt/type/content、実HTTPと保存latestStatusを確認し、SIGTERMで正常終了した。7種の既存transportの検証であり、新しいevent producer/設定API #197やreactionの実装ではない。

retry用の旧BullMQ Workerは業務handlerのdoubleで状態を生成し、sourceのcustom backoffのjitterだけを0に固定した。実際の60,000ms遅延・attemptsMade=1を保存し、停止/読取検査後に新built workerが自然な期限到来で同IDをattemptsMade=2へ進め、外部HTTP成功は1回だった。source job optsは変更せず、promote/retry/再投入で待機を代用しない。同時に残したterminal failedは同ID/attemptsMade=1のまま保持する。これは旧本家の業務handlerやfull serverを実行した証拠ではない。

processには既存の同時`client.query()`に関するpg deprecation warningが出た。exit0と保存/外部効果の一致を確認した結果として記録し、warningのない実行とは扱わない。実測とsource比較の成功は、現在7未対応handlerやsystem schedulerを切替可能にしない。[停止専用コマンド](../../../../packages/backend-next/README.md#停止下のqueue引継ぎ確認165)、[queueごとの判断・#139のbackup/rollback](../../../backend-next/posting-contract.md#停止下の既存queuepayload引継ぎ165)を参照する。#165の4条件に対応する検査・比較の完了候補と、#124/#176/#139全体の完成を区別する。

## #255 runtime consumer validation (2026-11-10)

Raw read-only inspection and fixed generator/bindings are unchanged. Original saved jobs, seven webhook envelopes, results and natural old-Worker retry are exercised by the retained handoff process cases; their success does not complete the broader process gate.

The parent's separate serial queue integration run passed **185 tests / 10 files, 0 failed/pending** (Node v26.4.0, pnpm 12.9.1; isolated `backend-next-255`, PostgreSQL `55455`, Redis `56395`). The earlier overlapping run had 184 passes / 1 globalSubscriber interference failure; it is not recorded as PASS. [Current runtime paths, exact commands and artifact receipt](../queue-runtime/README.md) distinguish these new consumers from the unchanged frozen source observations. No new pinned-source run is claimed.

Initial process validation has **57 passed / 4 failed / 8 files**; only the new queue-runtime cases fail. Final process gate PASS: the unchanged seven process files passed 43 cases; the corrected new file passed all 18 cases in a separate execution. Remaining seven handlers, nine schedulers, #139 cutover and existing feature owners are unchanged.
