# backend-next

[目的と初期完成条件](../../docs/backend-next/GOALS.md) / [全体計画と現在地](../../docs/backend-next/ROADMAP.md)。

Misskeyバックエンド再設計の実行基盤・Role初期実装・投稿参照。
既存トークンで `admin/roles/show` と `admin/roles/update` を利用できる。
`notes/show` は保存済み本家データから取得・可視性判定・出力を提供する。通常workerは本家の投票終了ジョブと、既存のaccepted relayへの配送を含むAP配送ジョブを実行する。通常投稿後は[Role timeline producer](../../docs/superpowers/compatibility/note/role-timeline/README.md)も既存の材料評価・Redis cache・pubsubへ接続する。Role閲覧API/WS channelと、その他のAPI・業務ジョブは後続の実装範囲。

全公開契約の移植状況・保存/副作用・担当Issueは[バックエンド対応表](../../docs/superpowers/compatibility/backend-inventory/README.md)を参照する。
登録APIだけでなく、非API HTTP、stream、ActivityPub、定期/業務ジョブ、CLIも追跡する。
adapterの部分実装と、通常worker/APIを通した機能の完成を区別する。

## Role実装に着手するとき

#116の成果物は[Role互換性契約](../../docs/superpowers/specs/2026-10-17-role-compatibility-contract.md)と[本家比較資料](../../docs/superpowers/compatibility/role/README.md)にある。比較資料にはJSONの期待値、再実行できるTypeScript probe、固定した本家コミットと実行結果を保存している。

#117–#121では[後続Issueでの利用と更新](../../docs/superpowers/compatibility/role/README.md#後続issueでの利用と更新)に従い、担当する期待値を新実装のテストへ接続する。本家probeの通過は本家側の確認結果であり、新実装のテスト成功とは扱わない。

## ビルドと起動

リポジトリが指定するNode.jsとpnpmを用いる。

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-upstream sync:check
pnpm --filter backend-next... build
```

本家形式の`.config/default.yml`を読み込む。`NODE_ENV=test`では`test.yml`、
`MISSKEY_CONFIG_YML`では`.config/`基準のファイル名または絶対パスを指定できる。
旧backendの設定コンパイルやビルドは不要。

```yaml
backendNext:
  workerCount: 1
  startupTimeoutMs: 30000
  shutdownTimeoutMs: 30000
```

外向きHTTPは本家と同じキー `proxy`・`proxyBypassHosts`・`allowedPrivateNetworks`・`outgoingAddress`・`deliverJobConcurrency`（proxy接続数の算出とdeliver Workerの並行度）を読む。
AP配送は本家と同じキー `deliverJobPerSec`（既定128）・`deliverJobMaxAttempts`（既定12）も読む。本家と同じく`??`で既定値を補うため、0はそのまま使う。
投稿タイムラインは `redisForTimelines`（省略時は `redis`）と `perChannelMaxNoteCacheCount`（既定1000）を使う。既存のMetaにあるfanout有効化・home/list/local-user/remote-userの上限も読む。
既定値は本家と同じく未指定。private宛ての遮断は `NODE_ENV=production` のときだけ行う。
`allowedPrivateNetworks` の不正なCIDRは、本家と異なり起動時に `INVALID_CONFIG` で拒否する（承認済みの差異）。
User-Agentは `Misskey/<固定本家のversion> (<設定ファイルのurlそのまま>)`。比較資料は[外向きHTTP](../../docs/superpowers/compatibility/outbound-http/README.md)を参照。

サービスを完全停止した状態で、先にマイグレーションを適用する。
既存MisskeyのDB・データは事前にバックアップし、稼働中の旧backendへ接続して適用しない。

```sh
pnpm --filter backend-next migrate
pnpm --filter backend-next check-migrations
pnpm --filter backend-next start
```

`migrate`は本家の`public.migrations`を引き継ぎ、全履歴の未適用分を実行した後、
`backend_internal`と独立した履歴、通知保存用テーブルを管理する。過去の独自ジョブ表は新migrationで検査して廃止する。
本家の`MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY=1`指定も引き継ぐ。
起動時は適用状況を確認するだけで、履歴やschemaを自動作成しない。

SupervisorはHTTP×1、worker×指定数を起動し、全子のreadyを待つ。
子の予期しない終了時は兄弟も停止して異常終了し、自動再起動しない。
`SIGTERM`/`SIGINT`では受付を止め、処理・接続の終了を期限まで待つ。
期限超過は異常終了する。HTTP接続切断を業務取消として扱わない。

プロセスを外部管理する場合は`start:http`、`start:worker`を使う。
各子は独自のDB・Redis接続を持つ。Redisなしの縮退運転はしない。

ジョブは本家と同じく`redisForJobQueue`（未指定なら`redis`）へBullMQの通常のQueue/Workerで接続する。
queueごとのprefixは本家と同じ`<prefix>:queue:<queue名>`。各子は投入用のQueueを持ち、workerは実ジョブのあるqueueだけを取得する。
本家と違い再接続せず、稼働中の切断は子の異常終了とする。workerの停止は取得の停止→実行中のジョブの完了→接続の解放で、
停止期限を超えると異常終了する（止めたジョブはBullMQのstalled検査で戻る）。
ログはstdoutへのJSON行で、設定全体や認証情報を出力しない。

`POST /api/admin/queue/*` の本家14 APIを通常HTTPへ接続する。現在moderator（administrator/rootを含む）と`read:admin:queue`または`write:admin:queue`で認可し、全10 queue名の照会・pause/resume/retry/promote/remove/cleanを扱う。管理handleはHTTPだけが所有し、未接続の業務Workerを起動しない。`show-job`/`jobs`は2 webhook queueのtop-level secretだけを秘匿し、本文・URL・userId・logsは保持する。

`/streaming` の `connect` で `channel: "queueStats"` を購読し、`{ type: "ch", body: { id: "stats", type: "requestLog", body: { id: "log", length: 10 } } }` を購読ID `stats` へ送る（`channel`も同じ）と履歴を得る。公開channelなのでguestや受理済み`read:account` appはqueue管理資格なしで購読できる。HTTPに1つのobserverがdeliver/inboxのactiveイベントと現在件数を即時/10秒周期で発行し、最新先頭200件をメモリ保持する。再起動を跨ぐ保持はない。

pause/resumeは制御完了を待つ。clear/promote/retry/removeと監査は本家の非待機HTTP204を維持し、失敗を診断して開始済み処理を停止時に待つ。QueueEvents・listener・intervalもHTTP停止へ接続する。管理接続にも既存の無再接続方針を適用する。[固定source比較・実依存検証・差異](../../docs/superpowers/compatibility/queue-admin/README.md)。通常保持/清掃#164は[保持の比較・実依存検証](../../docs/superpowers/compatibility/queue-retention/README.md)で確認済み。停止下の残payload引継ぎ#165は[下記の専用checker](#停止下のqueue引継ぎ確認165)で確認する。

現在の業務queueは `deliver` / `endedPollNotification` / `userWebhookDeliver` の3つ。成功7日/30件・失敗7日/100件を各jobに指定し、同じqueue・同じ終端状態への次の遷移時に清掃する。静かな履歴の7日後の消去は保証しない。Queue/Workerの保持fallbackはなく、無設定jobも後続jobの共有終端集合の清掃対象にはなり得る。終端限定clearは未完了jobを残すが、明示`*`/非終端clearは破棄操作である。全10名の管理handleは残る7業務producer/Workerの完成を意味しない。通知本体の保持は#177、保守/定期jobは#199/#200などの各担当へ残る。

## 停止下のqueue引継ぎ確認（#165）

ビルド後、旧新すべてのHTTP・worker・scheduler・scanner・補助producerを完全停止し、復元した隔離先を向く設定で実行する。

```sh
MISSKEY_CONFIG_YML=/secure/candidate.yml pnpm --filter backend-next check-queue-handoff --stopped
```

`--stopped`をちょうど1回指定する。これは利用者による完全停止の確認であり、分散した全プロセスの停止をコマンドが証明するものではない。引数不正は設定読込/接続前に非0終了する。

通常と同じ設定読込を使い、`redisForJobQueue`（省略時は`redis`）のhost/port/DB/auth/TLS/prefixを検査する。通常Redis・pubsub・timeline Redisと取り違えない。未指定prefixは設定URLのhost（portを含む）、DBは0が既定。ioredisのkeyPrefixを外し、BullMQ prefix `<prefix>:queue:<queue名>` にさらにqueue名が付くため、物理rootは`<prefix>:queue:<queue名>:<queue名>`。空prefixなら`queue:<queue名>:<queue名>`となる。過去の独自adapter用prefixは呼出元が選んでおり、別途棚卸しする。

checkerはraw Redisの読取だけで全10 queueを調べ、Queue/Worker/QueueEvents、DB接続、通常アプリ起動を使わない。job ID/name/data/options/試行数/遅延時刻/paused/履歴を元のまま保持し、export/replay・変換・retry/promote/clear・scheduler変更をしない。接続/command期限は`backendNext.startupTimeoutMs`、再接続とoffline queueは無効で、終了時に接続を解放する。

JSONの`ready`、各`queues`の`queue`/`counts`/`paused`/`blockers`、全体`blockers`を返す。件数はwait/paused/active/delayed/prioritized/waiting-children/completed/failed/repeat、拒否理由は固定codeとcountのみ。job/Redis key/scheduler ID・payload・URL・secret・例外本文は出力しない。`ready:true`だけexit0、blockerと検査失敗はexit1となる。

active/lock/stalled、scheduler/repeat/dependency、未対応queue、payload/options不整合、孤立/不明な記録は拒否する。理由codeは`ACTIVE`/`LOCK`/`STALLED`/`SCHEDULER`/`DEPENDENCY`/`UNSUPPORTED_QUEUE`/`INVALID_PAYLOAD`/`UNSUPPORTED_OPTIONS`/`UNKNOWN_RECORD`/`UNKNOWN_QUEUE`。引数不足は`STOPPED_ATTESTATION_REQUIRED`、その他引数不正は`INVALID_ARGUMENTS`、接続等の検査失敗は`QUEUE_HANDOFF_INSPECTION_FAILED`となる。

現在3業務handlerの対応jobだけを保持でき、他7 queueは未完了とfailedが切替を止める。completed履歴だけなら保持可能。systemの9定期schedulerはwaiting=0でも#199/#200待ちのblockerである。failedのretryは別の運用判断とし、検査のためにqueueを消去しない。[queueごとの判定・所有者と#139のbackup/rollback](../../docs/backend-next/posting-contract.md#停止下の既存queuepayload引継ぎ165)を参照する。

成功は検査時のqueue条件だけを示す。未移植機能の確認#135、配布#138、通知移行#177、完全停止切替#139、親#124/投稿全体#176の完成はそれぞれ別に確認する。[固定sourceと実旧BullMQの証拠・新workerの実測範囲](../../docs/superpowers/compatibility/queue-handoff/README.md)も参照する。

## 検証

テスト専用のPostgreSQL・Redis・Meilisearchを使う。既存の`misskey-infra`とは別のComposeプロジェクトであり、
コンテナ名・ネットワーク・ポートを共有しない。データはtmpfsに置く。

```sh
docker compose -p backend-next-test -f packages/backend-next/compose.test.yml up -d --wait
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next... lint
pnpm --filter backend-next test
pnpm --filter backend-next test:integration
pnpm --filter backend-next test:acceptance
pnpm --filter backend-next test:process
docker compose -p backend-next-test -f packages/backend-next/compose.test.yml down
```

既定ポートはPostgreSQL `55432`、Redis `56379`、Meilisearch `57779`（検証image `getmeili/meilisearch:v1.3.4`）。
`BACKEND_NEXT_TEST_DB_PORT` / `BACKEND_NEXT_TEST_REDIS_PORT` / `BACKEND_NEXT_TEST_MEILI_PORT`で変更できる。
結合・プロセステストは専用DBに接続し、`backend_next_<ランダムID>`のDBだけを作成・削除する。
本番設定は読み込まない。

#164の保持・清掃に絞る場合は、上記のCompose手順で専用のPostgreSQL/Redisを起動後に次を実行する。source oracleの再実行は[保持比較資料](../../docs/superpowers/compatibility/queue-retention/README.md#実行と直接比較)を参照する。handler結果を制御した実adapter検証とsource比較を分け、既存の各業務・processテストを引き継ぐ。

```sh
pnpm --filter backend-next test test/unit/job-queue/retention.test.ts test/unit/job-queue/deliver.test.ts test/unit/job-queue/ended-poll-notification.test.ts test/unit/job-queue/user-webhook.test.ts
pnpm --filter backend-next test:integration test/integration/queue-retention.test.ts test/integration/queue-admin.test.ts
```

#165の近傍検証は次を使う。通常CIは記録済み引数＋明示的なテストbinding＋現在の同版BullMQを使う。固定本家sourceと本家installed BullMQを実行する別確認は、`BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream`を結合/プロセステストに渡す。[両modeの再実行と実測範囲](../../docs/superpowers/compatibility/queue-handoff/README.md#実redis業務handlerとprocessの検証)を参照する。

```sh
pnpm --filter backend-next test test/unit/job-queue/handoff.test.ts
pnpm --filter backend-next test:integration test/integration/queue-handoff.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next test:process test/processes/queue-handoff.test.ts
```

`check-schema`は検証用DBで使う。同期したEntityの対象に限って定義差分を検出し、DDLは実行しない。
本家の未同期Entityに対応するテーブルを削除対象として扱わない。

本家のコピーを更新する場合は`backend-upstream/README.md`を参照。
アーキテクチャと後続のRole実装範囲は`docs/superpowers/specs/`に記載する。

## Role材料キャッシュ（#119）

各HTTP/workerプロセスの起動時に、Role定義全件とユーザー別手動割り当てのメモリキャッシュ、専用Redis購読を作る。Redisに材料の値は保存しない。実効ポリシーは複数操作間でキャッシュせず、操作内のRoleEvaluationだけでメモ化する。

```yaml
backendNext:
  roleCache:
    rolesTtlMs: 30000
    assignmentsTtlMs: 30000
    assignmentsMaxEntries: 10000
```

上記は既定値。各値は正のsafe integerを指定する。期限は単調時計でDB取得開始から数え、参照で延長しない。割り当ては取得中の項目を含むLRUで件数制限する。業務上の割り当て失効はRoleEvaluationの基準時刻で別に判定する。

`runtime.roleMaterials` の `readRoles` / `readAssignments` を通常参照のRoleFactsReaderに渡し、ユーザー属性・インスタンス設定は操作内で取得する。`changes` は `createUpdateRole` に渡すRoleChangesであり、UseCaseがcommit後に操作内メモ・自プロセスの材料を無効化し、Redis通知を試みる。更新認可は引き続きtx内DB材料を使う。HTTP・認証・ID codecとの組み立ては#120で接続済み。

発行・購読とも `redisForPubsub`（省略時は `redis`）へ接続する。channelは `<prefix>:backend-next:role-materials:v1`。プロセス間で同じ接続先とprefixを使う。通知には `{ kind: 'role-definitions-changed', roleId }` だけを載せ、受信側はRole全件を破棄する。割り当て・ユーザー・設定の更新APIはまだなく、それらの通知契約は各書き込み機能の追加時に接続する。

購読切断・再接続時に両材料を破棄し、subscribe応答の確認までは通常参照をエラーにする。通知だけが欠落した場合は期限後の次の参照でDBから取得する。無効化・追い出し済みの取得が完了してもキャッシュへ戻さない（開始済みの呼び出しにはその取得値を返せる）。接続切断や購読世代変更をまたぐ取得はエラーにする。再接続できるのは購読接続で、稼働後に発行接続が予期せず終了した場合は既存の停止経路へ障害を通知し、受付停止・期限付きの受理済み処理待機を経て子プロセスを異常終了する。Supervisorも兄弟プロセスを停止する。再起動は運用側で行う。通常のリソース解放による切断は異常終了にしない。Redis操作失敗によるDBへの縮退は行わず、commit後の通知失敗は更新の失敗へ変換しない。

## Role HTTP API

`POST /api/admin/roles/show` はモデレーター以上、`POST /api/admin/roles/update` は管理者の資格を要求する。JSON本文の `i`、または大文字小文字を区別する `Authorization: Bearer <token>` を使う。Bearerがあれば本文へ再試行しない。16文字のnative token、既存AccessTokenのhash/token、Appに設定されたscopeを認証する。AccessTokenはshowで `read:admin:roles`、updateで `write:admin:roles` が必要。資格・scopeの判定はUseCaseで入力検証より先に行う。

showはロールと有効な手動割り当て人数を取得した後、DBにアクセスせず表示形へ変換する。updateは同一トランザクションで最新DBの認可・更新・監査を確定し、成功時は204・空本文。接続切断を取消へ結び付けず、送信失敗でも更新を再実行しない。非文字列token（null/未指定以外）は、合意済みの修正として400・空本文で完了する。

本家設定 `id`（`aid` / `aidx` / `meid` / `meidg` / `ulid` / `objectid`）をIDの日時復元と監査ID生成へ渡す。大文字小文字は正規化し、未知の方式は起動時に拒否する。未指定時は `aidx`。移行先では既存DBと同じ方式を設定する。

受け入れ比較の固定期待値は[Role比較資料](../../docs/superpowers/compatibility/role/README.md)を参照。`test:acceptance` は実トークンHTTP・保存/監査・次操作のポリシー評価・通知前停止とTTL回復を検証する。既存の `test:integration` はDB/Redisの障害・競合、`test:process` は起動停止・切断を担い、3つとも専用CIの必須step。固定期待値の変更もCIを起動する。本家比較と意図的差異・検証範囲は比較資料の#121受け入れ表を参照。

## 投稿と非同期処理

初期経路は[投稿の最小契約](../../docs/backend-next/posting-contract.md)を正とする。
旧[ジョブ設計](../../docs/superpowers/specs/2026-10-21-job-persistence-design.md)の
永続request・二重claim・容量・世代復旧は履歴であり、実行コードと専用テストは撤去した。
AP snapshot/page/host leaseと関連する通常起動のEntity登録も撤去した。
APの宛先規則は[本家配送の引き継ぎ](../../docs/backend-next/ap-delivery-handoff.md)に残す。

通常workerは #162 で本家の投票終了ジョブ（`endedPollNotification`）を実行する。BullMQ依存は本家と同じ版で、このjobと一緒に導入した。
期限のある投票の投稿は保存後の後続処理で投入し、期限後にworkerが作者とローカルの投票者へ`pollEnded`の通知をPGに保存する。
配信（stream・未読・push）は#173/#177/#189、webhook等のjobと本家のretry/backoff/limiterは各機能で接続する。

AP配送は #171 の最初の PR で接続した。HTTP子が投稿の後続処理で保存済みの投稿を読み直し、Create/Announceの表現と宛先を決めて `deliver` queueへ投入する。
worker子は投票終了と同じ子で `deliver` のWorkerも動かし、本家どおりスキップ判定・署名付き送信・instance台帳の更新を行う。
HTTP子も作者の鍵を読み、公開投稿のコピーへJSON-LD署名を1回付けて、既存のaccepted relayごとに個別の配送ジョブを投入する。外向きHTTPによる署名付き送信はworker子が行う。
relay登録・受理/拒否・inbound検証・full actor公開は#195、削除配送は#172で接続済み、チャートは#200。
本家との比較は[AP配送の比較資料](../../docs/superpowers/compatibility/ap-deliver/README.md)、業務規則と残りは[本家配送の引き継ぎ](../../docs/backend-next/ap-delivery-handoff.md)を参照する。
基本text保存のためだけにjobやdispatcherを作らない。queue・payload・保持の値は[投稿の最小契約](../../docs/backend-next/posting-contract.md#通常ジョブ162)を参照する。

#174の第1sliceは通常投稿からhome/local/user/list/channelのRedisリストを更新する。返信・添付・公開範囲・購読関係・休眠フラグを本家のproducer規則で判定し、保存時のNoteと現在の関係/Metaを使う。`list:<timeline名>`を既存prefix内へ保存する。3分より古いIDは現在の末尾より日時が新しい場合だけ追加し、recentは10%で指定件数へtrimする。削除時は本家どおりIDを消さない。失敗は投稿HTTP成功を取り消さず記録し、終了時に開始済み処理を待つ。

非channel投稿の10%でローカル非休眠followerを最大1000件抽出し、最終活動が50日より古いUserとその全Followingを休眠化する。WebSocket接続と5分ごとの活動記録でUserとFollowingの休眠フラグを解除する。検索と通常Role timeline producerは接続済み。antenna・hashtag・featured等は#174の後続、閲覧APIは#185/#186、role関連の閲覧API・WS受信は#181/#189、チャートは#200、再構築は#132/#133に残る。[比較範囲](../../docs/superpowers/compatibility/note/timeline/README.md)を参照。

## 通知のPostgreSQL保存

通知本体は承認済みの `backend_internal.notification` を維持する。
`PostNotificationPersistence.save(manager, notification)` は、UseCase側で受信条件・ID・時刻を決めた
plain recordをcaller-owned transactionで保存する。`flush(manager, recipientId)` は指定受信者の本体を削除する。
両方ともawaitし、例外はtransaction外へ伝える。adapterは独自にtransactionを開始・確定しない。
通知条件・認可をadapterへ隠さず、managerはcompositionから結び付けて業務コードへ公開しない。

reply/mention/quote/renote/note/pollEndedの保存列を保持。`notifier_id`はpollEndedだけ`NULL`（`PollEndedNotification1793706223869`。`down`はpollEndedの行を削除して以前の制約へ戻す）。受信者別に既定500件をcreated_at/notification_idの降順で残す。
保持削除とflushの競合だけをtransaction advisory lockで直列化する（本家Redisの近似MAXLENとの差異）。
request/claim/lease/effect/容量会計は不要で、同じ操作の一度だけ成立や自動再実行を保証しない。

通知条件・stream/push接続は #173、閲覧/未読・既読/設定/清掃と既存Redis通知の移行は #177。
この保存窓口だけで通知機能を完成扱いにしない。Redisは引き続き必須。

## 旧内部ジョブ表を廃止するmigration

`RetireDurableWork1793635233676` は完全停止下の `migrate` でのみ実行する。
publicデータ・本家migration履歴・通知の全業務列/ID/日時を保持し、
不要な9表と通知の課金2列を削除する。適用済み6migrationは編集せず履歴に残す。

1. 旧新の全HTTP/worker/独自scannerを停止し、DBと使用していたRedisのバックアップを取る。
2. 独自adapterを手動実行した環境では、呼出元が選んだBullMQ prefixにある旧 `deliver` / `postLocal` を通常Queue APIで照会する。
   waiting/active/delayed/waiting-children等の未処理jobと `{workId,dispatchSeq,queueGeneration}` の旧payloadを確認し、残件を解決・退避する。
   通常起動は旧adapterを接続していなかったため、共通の固定prefixはない。本家のdeliver queueや他アプリのRedisを一括消去しない。
3. `migrate` → `check-migrations` → 検証DBで `check-schema`。通常起動はこのmigration未適用を拒否する。

migrationは対象表を先にロックし、request非settled、item非成功/抑止/取消・残存owner、
未解放dispatch、予約残数/復旧中、host ownership、未完了AP宛先があれば
`DURABLE_WORK_REQUIRES_REVIEW` と種別ごとの件数で停止する。期限切れ・失敗・結果不明も自動破棄しない。
検査・DDL・履歴更新は同じtransactionで、拒否時は元の状態を保持する。
停止した場合は旧versionとバックアップ/保存payloadから処理の成否・残仕事を確認して対応を決める。
検査を通すためだけにstateを書き換えない。DB検査はRedis内の残jobを直接検査したことにはならない。

成功時は完了済みjob/宛先/effect履歴も廃止する。以後それらを使う再実行・強いCreate/Delete順序は提供しない。
`down` は空の旧schemaと保持中の通知の課金を復元するが、廃止したjob/effectデータは再生成しない。
通知件数/容量が旧上限を超える場合は旧制約でdownも拒否される。完全な旧版への復元は停止時バックアップを使う。
通知のRedis移行や未解決jobの自動変換を、このmigrationで実施したとは扱わない。

## 投稿参照（#168 / N1）

通常HTTP起動から `POST /api/notes/show` を利用できる。`{noteId,i?}` の既存tokenとBearerを扱い、guestのserver/作者制限と、閲覧者別のhiddenを区別する。Noteと関連factsは階層ごと/集合ごとにRepositoryで取得し、変換中はDB/Redisへ接続しない。replyは簡略、renoteは詳細を保つ。

循環と64階層・256 Noteの予算超過はログ付き500とし、部分JSONを返さない。新実装の保護契約として[比較台帳D7](../../docs/superpowers/compatibility/note/intentional-differences.json)へ記録する。[本家比較資料のN1節](../../docs/superpowers/compatibility/note/README.md#n1-notesshow-の接続168)にN0期待値との照合範囲と未実測を残す。

本家形式の `redisForReactions` を指定した場合は専用接続で反応bufferを読み、未指定なら通常Redisを使う。`mediaProxy` / `videoThumbnailGenerator` とDBの `proxyRemoteFiles` を添付URLに適用する。専用接続も起動・終了期限と必須接続の障害監視に参加する。

投稿作成は#169/#170、作成のAP配送は#171、投稿削除とDelete/Undo配送は#172で接続した。残る変更系API・配信は後続。保存済みデータのshow検証だけで投稿縦断の完成とは扱わない。

## 基本投稿作成（#169 / N2）

通常HTTPの `POST /api/notes/create` で基本text投稿を保存し、`createdNote`を返す。
認証/production rate/停止・移行・scope/入力の順序、public→home補正、禁止語、
CW/localOnly/reactionAcceptanceを扱う。保存直後にnotes/showで参照でき、投稿数は保存後に加算する。
DB失敗やクライアント切断を理由に自動再作成しない。通常終了では開始済みの投稿数更新も待つ。

#170で添付（所有権・指定順・attachedFileTypes）と投票（NoteとPollを1つのtransactionで保存）、返信/Renote/引用・channel、
指定宛先、MFM抽出（メンション・ハッシュタグ・絵文字）を接続した。メンションはローカルユーザーと登録済みリモートユーザーをDBで解決する。
未登録remote mentionはWebFinger→actor取得→呼出元所有transactionでcore保存する。登録済みremoteは `lastFetchedAt` が24時間を超える/nullの場合に先にattempt時刻・必要なURI補正を保存してrefreshする。各出現の失敗は本文/CW/pollを保持して省略し、先行書込は残る。保存前501とstale refresh省略は現行coreから除去済み。
最小actor公開・system/author鍵発見・signed/unsigned取得と通常worker配送の[実測・比較限界・actor効果所有者](../../docs/superpowers/compatibility/remote-user/runtime-results.md)を参照。media/emoji・attached user hashtag・instance/chart・cache・featured/Move/full actor/inbox/remote Notes等は未完了。全95 unitケースは95 real HTTPケースを意味しない。
投票終了ジョブ（#162）、AP配送（#171。既存のaccepted relayへの配送を含む）、投稿通知/stream producer（#173）と通常TL・Role timeline producer（#174）は接続済み。投稿webhookと下記のWebSocket受信も接続済み。検索・Role・featured・hashtag・antennaの通常producerも接続した。Role/antenna等の閲覧APIやWS channel、remote受信・chart・投稿全体#176は別に残る。
最小契約と既存実装の撤去順は[投稿の最小契約](../../docs/backend-next/posting-contract.md)を参照。

## 投稿削除（#172）

通常HTTPの `POST /api/notes/delete` は `{ noteId, i? }` とBearerを扱い、成功時204・空本文。作者または現在のmoderatorに許可し、`write:notes` が必要。停止ユーザーは拒否するが移行済みユーザーは削除できる。productionではdelete専用の1秒間隔・1時間300回をRoleのfactorで調整する。

返信数の減算→必要な配送開始→Note削除→他人削除の監査開始という本家の境界を維持する。後段のDB失敗で先行減算・配送を巻き戻したとは扱わない。Poll/Vote/Reactionは既存FKで削除し、user/Renote/channelのcountは減らさない。`notePostDelete.idle()` は開始済み配送・監査の待機窓口で、通常終了にも接続している。保存済みNote/作者/元投稿からDelete/Undoを生成し、followers・relay・concerned directを独立投入する。

`test/integration/note-delete.test.ts` は認証/監査/DB/エラー/制限/宛先、`test/processes/note-delete.test.ts` は固定C10/F8・原文署名・削除配送の終了待機を確認する。削除streamは#173で接続済み。TLは本家どおりIDをpurgeしない。検索解除は下記のproducerへ接続済み。固定本家に削除webhookはなく、投稿webhookは#175で接続済み。チャートは#200、縦断完成は#176。


### 投稿通知・stream producer（#173 第1slice）

通常HTTPの投稿からreply/mention/quote/renote/note通知の受信条件とPG保存、Redisのnotes/main publicationを開始する。通常投票終了workerは通知保存後のpublicationへ接続し、削除は物理DELETE前のdeletedイベントを開始する。保存後のpublish失敗で本文やHTTP成功を巻き戻さず、終了時は開始済み処理を待つ。

`test/integration/note-notifications.test.ts`は実HTTP/PG/Redis subscriberで条件変更・payload・失敗・snapshot/current Poll・通常poll workerを確認する。main/homeTimelineと削除購読のWebSocket受信を下記で接続した。他channelは#189、広域の共有fanout/cacheは#217、通知閲覧/既読/未読timer/push/移行は#177に残る。[詳細と検証結果](../../docs/superpowers/plans/2026-11-07-notification-stream-173.md)。

投稿 webhook は author note、ローカル受信者の mention/reply/renote を通常 `userWebhookDeliver` queue と worker へ接続する。設定管理と投稿以外のイベントは #197、最終の縦断確認は #176 に残る。設定キャッシュ・投入時 snapshot・固定本家との比較と実行方法は[比較資料](../../docs/superpowers/compatibility/user-webhook/README.md)を参照。

### 投稿WebSocket受信（#173、#189の一部）

通常HTTPプロセスの `/streaming` にWebSocketで接続し、native/app/miauth token（Bearer優先、query `i`）またはguestを受け付ける。app/miauthには `read:account` が必要。`connect` の `main` と `homeTimeline`、`subNote`/`s`/`sr` と `unsubNote`/`un` による削除 `noteUpdated` を扱う。`disconnect`、`pong: true` の接続ack、接続ID置換、32channel・1536note上限を本家に合わせる。

HTTPプロセスごとに専用Redis subscriberを1本持ち、各受信者の関係factsを接続時と10秒ごとに取得する。TLの公開snapshotは維持し、nested hideと自分のreactionを受信者ごとに適用する。followers本文を隠す判定だけは本家の別following cacheに相当する現在DB材料で行う。接続時と5分ごとの活動日時更新、1分ごとのpingと2分超の無pong切断を行い、停止はupgrade/WSを拒否・終了し、開始済みDB処理を待ってから依存先を解放する。

実HTTP create/delete、通常投票worker、実PG/Redis/WSと停止・heartbeat・relation refreshを検証する。[固定本家比較と検証範囲](../../docs/superpowers/compatibility/stream/README.md)。queueStatsとそのrequestLogを除く`readNotification`・channel書込・他16channelは#189/#177、通知閲覧/既読/未読/push/移行は#177、投稿全体の縦断完成は#176に残る。

## 通常検索producer（#174/#172）

`fulltextSearch.provider: meilisearch` の場合だけSDK 0.62.0で外部索引を更新する。未指定/`sqlLike`/`sqlPgroonga` はNote本体を使い、`meilisearch` 設定があっても通信しない。設定は本家のrootキーを使う。

```yaml
fulltextSearch:
  provider: meilisearch
meilisearch:
  host: localhost
  port: 7700
  apiKey: ''
  ssl: false
  index: misskey
  scope: local
```

`port` は数値/文字列、`apiKey`/`index` は空文字も許す。`scope` は既定`local`、`global`、完全一致のhost配列。選択時に設定が無ければ`INVALID_CONFIG`。`${index}---notes`のsettingsを起動時に依頼するが、受付/適用待ちで起動を止めない。失敗は`search-settings.failed`へ記録する。

作成はpack/mention準備成功後にsnapshotを登録し、public/homeかつtextまたはcw非nullを対象とする。削除はpublic/homeならscope/contentに関係なくDB DELETE前に解除を開始する。失敗は`search-index.failed`/`search-unindex.failed`にnoteIdと安全なerror情報を残し、保存済みHTTP成功を取り消さない。終了時は開始済みHTTP要求を既存期限まで待つ。SDK成功はtask受付であり、engine側の適用完了を保証しない。

専用Compose起動後、`test:integration test/integration/note-search-index.test.ts`で実HTTP handler/PG/Redis/Meiliのdocument・settingsと削除を確認し、`test:process test/processes/note-search-index.test.ts`で実HTTP子の開始/停止/障害を確認する。task完了待ちは試験だけで行う。[固定source比較・制約・再構築材料](../../docs/superpowers/compatibility/note/search/README.md)を参照。検索API #186、再構築 #132/#133、#174/#172/#176全体の完成は含めない。


## antenna producerと通常派生集計（#174）

通常投稿は保存時作者・補正後channel・insert直後のraw Noteを保持し、pack前の独立post-saveでantenna照合、専用timeline Redisのmax200とraw pubsub publicationを開始する。アンテナ定義は最初だけactiveを取得し、その後はinstance hostのinternal created/updated/deletedを受信する。設定API自体は#185に残る。followingは通常Redisの30分cache/1分memory、list membershipは照合時のDBを使う。削除でcached IDをpurgeせず、遅延snapshotも残す。詳細・source oracle・再構築制約は[比較資料](../../docs/superpowers/compatibility/note/antenna/README.md)と[投稿契約](../../docs/backend-next/posting-contract.md#通常投稿のantenna-producerと派生集計174)。

channel集計はpack/mention準備成功後の3つの独立SQL。remote Instance.notesCountはstats設定有効時だけ、既存台帳からinstance IDを得て5分集約+1、通常削除で直接-1を行う。終了時に開始済みpost-save/deleteとbatchを待ち、失敗を再予約しない。remote token HTTP投稿は未対応で、remote snapshot producerと管理者HTTP削除を検証する。chartやremote受信の実装完了を示さない。[全更新責任と保持/再構築材料](../../docs/superpowers/compatibility/note/derived-updates/README.md)。

専用Composeと`BACKEND_NEXT_TEST_DB_PORT`/`BACKEND_NEXT_TEST_REDIS_PORT`を設定したうえで、次を実行する。

```sh
pnpm --filter backend-next test test/unit/note/antennas.test.ts test/unit/note/antenna-lifecycle.test.ts test/unit/note/instance-counts.test.ts test/unit/note/post-save.test.ts test/unit/note/created-events.test.ts
pnpm --filter backend-next test:integration test/integration/note-antennas.test.ts test/integration/note-instance-counts.test.ts test/integration/migrations.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next test:process test/processes/note-antennas.test.ts
```

実依存検証は通常認証HTTP・PostgreSQL・分離したtimeline Redis・pubsub、internal設定受信、raw payload全列、部分失敗、即削除後のsnapshot、SQL拒否、subscriber解放を扱う。通常HTTP子の照会保留中SIGTERMと、managed子の5分batchを待たず終了時flushして終了0を観測する。source corpusの抽出実行とは別の証拠として記録する。

## N7投稿検証（#176）

[証拠の種類・実測・残るblocker](../../docs/superpowers/compatibility/note/n7/README.md)を参照。既存の検証手順で専用依存を準備し、repo rootで実行する。既定portを使い、並行時だけ既存の`BACKEND_NEXT_TEST_DB_PORT` / `BACKEND_NEXT_TEST_REDIS_PORT` / `BACKEND_NEXT_TEST_MEILI_PORT`を上書きする。依存のinstallや共有DBへのmigrationは以下に含めない。process試験はbuild済み成果物が必要。 `note-delete-integration.test.ts`は`/proc/<pid>/stat`と`SIGSTOP`/`SIGCONT`を使うLinux専用のため、CIやWSLなどのLinux環境で実行する。

```sh
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test:integration test/integration/note-create.test.ts test/integration/note-posting-lifecycle.test.ts test/integration/note-create-relations.test.ts test/integration/note-show.test.ts test/integration/note-delete.test.ts test/integration/deliver-queue.test.ts test/integration/user-webhook.test.ts
pnpm --filter backend-next test:process test/processes/note-delete-integration.test.ts
pnpm --filter backend-next test:process test/processes/note-deliver.test.ts
pnpm --filter backend-next test:process test/processes/posting-websocket.test.ts test/processes/poll-ended.test.ts
node --test scripts/note-contract-*.test.mjs scripts/backend-contract-inventory.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs
```

Supervisor自然retry試験は通常の60–72秒backoffを待つ（test timeout180秒）。新WS接続へのlive通知でありreplayを証明しない。通常CIは記録済みfixtureを利用し、固定本家checkoutでの任意確認時だけ`BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream`を指定する。N7旧証跡の501/stale制限は履歴として固定し、#195の現行core取得/refresh実測で証明した部分だけをsupersedeする。rich actor効果・C2/C10比較ギャップ・投稿全体・本番切替は未完了。#242はマージ済みで#124はCLOSED、N7の監査時OPENは過去の事実として保持する。
