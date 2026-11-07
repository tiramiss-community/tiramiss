# Queue管理とQueueStatsの固定本家比較（#163）

対象は `misskey-dev/misskey@8e07cf085adf7009583d234a208e30436f020e26`。本資料は本家の管理API全14登録・10 queue・QueueStatsの契約を固定する。新backendの実装完了や、本家full serverとの一致を示すものではない。[現在の目的](../../../../docs/backend-next/GOALS.md)・[全体計画](../../../../docs/backend-next/ROADMAP.md)・[Issue #163](https://github.com/tiramiss-community/tiramiss/issues/163)を優先し、Issueの折り畳まれた旧PG制御・原子的監査・本文秘匿・最大100件ページ等を現行契約へ持ち込まない。

## 再実行

repo rootで実行する。固定commitのGitオブジェクトを持つcheckoutと、workspaceのTypeScript・AJV 8.20.0が必要。旧backendのbuildは不要。AJVは旧backendの依存が未linkの場合、既存pnpm storeの同じ固定版から読み込む。

```sh
node docs/superpowers/compatibility/queue-admin/reference-queue-admin.cjs /path/to/upstream-checkout
cmp /tmp/tiramiss-queue-admin-observations.actual.json docs/superpowers/compatibility/queue-admin/observations.json
```

`UPSTREAM_ROOT`・`REPOSITORY_ROOT`・`OUTPUT`で入力checkout、依存を探すrepo root、出力先を指定できる。既定出力はtmpのactualファイル。期待値を更新するときだけ`OUTPUT`をこのディレクトリの`observations.json`へ明示する。checkoutのHEADではなく、全入力を`git show <固定SHA>:<path>`で読み、各blobとSHA-256をJSONに残す。97観測、30ソースを固定した。

## 実行した境界

- 全14 endpointの実moduleとcallback、`Endpoint`の実AJV検証、`ApiCallService.handleRequest`の実認可順序・エラー/HTTP応答変換を実行する。
- `QueueService`の実moduleからconstructorを実行せずinstanceを作り、管理メソッドとJob packerを実行する。constructorのsystem scheduler登録は対象外。監査は実`ModerationLogService`からinsert doubleまで実行する。
- `QueueStatsService`・channel・Channel baseの実moduleを実行する。ConnectionはASTから`connectChannel`・`disconnectChannel`・`onChannelMessageRequested`・`dispose`を本文変更せず抽出する。
- WebSocketの入口は`StreamingApiServerService`の実field宣言と`attach`・`detach`をAST抽出し、実upgrade callbackを実行する。接続後のsocket実通信はdoubleである。

外部のQueue・QueueEvents・Redis INFO・認証結果・現在role一覧・Nest組み立て・Xev・clock・request/reply/socketは明示したdouble。AJVは本家指定版の実ライブラリ。`@bindThis`、JSON object判定、API error classも固定sourceを実行する。実Redis、BullMQ内部、実トークン検証、roleの期限/条件式計算、実socket、全本家server起動は実行しない。API DTOのresponse schemaは本家同様にruntime sanitizerとして使わない。

## 固定したsource契約

全endpointはcredential＋現在moderator/administrator、rootUserIdのrole bypass、read/writeの`admin:queue` scopeを持つ。endpoint固有の`limit`はなく、rate limiterを呼ばない。role判定・scope判定はschema検証より先。失敗時の固定error code/id・`info.param`（AJV schemaPath）/reason・HTTP status/認証headerをJSONに保存する。現在roleの取得結果を与えており、role計算自体の再検証ではない。

| endpoint末尾 | scope | 入力 | 操作/結果 |
|---|---|---|---|
| clear | write | queue,state | `clean(0,0,state)`。`*`は7状態並行。clearQueue監査 |
| deliver-delayed | read | object | deliver delayedの`data.to` URL host件数、降順 |
| inbox-delayed | read | object | inbox delayedの`signature.keyId` URL host件数、降順 |
| jobs | read | queue,state[],search? | packed jobs。cursor/limitなし |
| pause / resume | write | queue | await pause/resume後にpauseQueue/resumeQueue監査 |
| promote-jobs | write | queue | `promoteJobs()`、promoteQueue監査 |
| queue-stats | read | queue | counts/paused/metrics/qualifiedName/Redis INFO |
| queues | read | object | 10 queueのcounts/paused/metrics、固定順序 |
| remove-job | write | queue,jobId | 対象queue内のjob.remove。不存在は成功、監査なし |
| retry-job | write | queue,jobId | finishedOnあり→retry、なし→promote。不在成功、監査なし |
| show-job | read | queue,jobId | pack。不在は汎用Error→500 INTERNAL_ERROR |
| show-job-logs | read | queue,jobId | getJobLogsのlogsのみ、存在判定なし |
| stats | read | object | deliver/inbox/db/objectStorageの4 countsのみ |

10名は`system`・`endedPollNotification`・`postScheduledNote`・`deliver`・`inbox`・`db`・`relationship`・`objectStorage`・`userWebhookDeliver`・`systemWebhookDeliver`。現在workerが接続するqueueだけへselectorを縮小しない。追加のretry/promote/clean endpointは本家に存在しない。

入力は追加propertyを拒否しない。jobIdは空文字も有効、jobs state[]は空配列/重複を禁止しない。jobsの通常取得は`getJobs(types,0,100)`、truthy searchは`getJobs(types,0,1000)`後にpack・JSON全文の小文字検索・空白分割AND条件・slice100。本probeのinclusive range doubleでは通常101件、検索100件を返す。これは引数と変換のsource実測で、BullMQ内部のinclusive range動作は実Redis検証の責任とする。

packerは2 webhook queueのtop-level secretだけを`(redacted)`にする。本文・完全URL・userId・opts・returnValue・logsまで秘匿する契約はない。stacktraceのfalsy除去/逆順、attemptsMade→attempts、isFailedの判定も固定する。Redis INFOは整数parseを行い、fragmentation ratioも切り捨てる。実INFOのrunId等の値そのものはdouble。

clear/promote-jobs/retry-job/remove-jobのcallbackはserviceのPromiseをawait/returnしない。sourceの204後の失敗はfixtureの`detachedRejections`に残す。pause/resumeはserviceをawaitするが監査はawaitしない。sourceが投げっぱなしにする失敗を新backendで診断・drainする場合も、期待値を改変せず差異として説明する。sourceのプロセス終了方針はこのprobeのprocess-wide rejection捕捉からは証明しない。

QueueStats channelは公開、追加のqueue scopeやmoderator資格は不要。ただし**upgrade入口ではapp tokenに`read:account`が必要**（固定`StreamingApiServerService.ts:61–65`）。guest・自己credential・`read:account` appは通り、scopeなしappは401。`stream-connection-unscoped-app`はupgradeを明示的に迂回したConnection単体観測で、実入口から到達できるという主張ではない。調査初期の「scopeなしappも購読できる」という広い解釈は、この入口の独立調査により訂正した。

producerは初回即時＋10秒周期、deliver/inboxだけの`activeSincePrevTick/active/waiting/delayed`を発行。履歴は最新先頭200件。requestLogはobject/string id/number lengthを要求し、fractional/negative/0を追加制限せずJS sliceに渡す。共有channelの重複購読は無視する。source disposeはstats購読とintervalを外す一方、producerのQueueEvents/requestLog listenerとchannelの未応答once listenerを閉じない。これらsource固有の寿命不足も観測に残す。

## 新実装への直接比較

`observations.json`は`formatVersion/fixedCommit/sources/queueTypes/metadata/observations`を持つ。各観測は`id/layer/input/expected`。

- `http-handler`: `input.route/params/actor/doubles?`を同じ材料で実行し、`expected.response`（status/headers/body）とqueue/監査callsを照合する。fixtureのactorは認証doubleの条件名。`doubles.jobs`は指定job、`doubles.fail`は拒否する公開メソッド。既定job・counts・metrics・INFOはprobeの`createContext`に明示する。汎用500の新規診断UUIDだけ固定値へ正規化する。
- `endpoint-callback`の`boundary-*`: `heldQueueOperation`を解放する前後のcallback完了と監査/call順序を比べる。`jobs-*`は`repeatedJobs` recipeを1002件へ展開し、既定job fieldを補い、件数/両端/full JSON SHA-256を比較する。これは簡略化した代表値だけの比較ではない。
- `stream-upgrade`: app permission/停止状態とupgrade結果を比べる。`stream-connection`:公開channel/duplicate/pong/logを比べる。`stream-producer-channel`:activeイベント、tick、履歴順序/切り詰めを比べる。履歴の200 tickはactive値100→299を順に与える。layerを跨いでunscoped appの到達性を解釈しない。

source-onlyのXev/timer/QueueEvents実装詳細と、新backendが終了時に追加する診断・drainを、公開API互換性の照合と分けて記録する。実Redisでのpause/resume/retry/promote/remove/clean、実HTTP/認証/WS、障害と終了は新backendの結合・process検証で別に確認する。この資料自体で、それらを通したことにはしない。
