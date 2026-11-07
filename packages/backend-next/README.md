# backend-next

[目的と初期完成条件](../../docs/backend-next/GOALS.md) / [全体計画と現在地](../../docs/backend-next/ROADMAP.md)。

Misskeyバックエンド再設計の実行基盤・Role初期実装・投稿参照。
既存トークンで `admin/roles/show` と `admin/roles/update` を利用できる。
`notes/show` は保存済み本家データから取得・可視性判定・出力を提供する。通常workerは本家の投票終了ジョブと、既存のaccepted relayへの配送を含むAP配送ジョブを実行する。その他のAPIと業務ジョブは後続の実装範囲。

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

## 検証

テスト専用のPostgreSQL・Redisを使う。既存の`misskey-infra`とは別のComposeプロジェクトであり、
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

既定ポートはPostgreSQL `55432`、Redis `56379`。
`BACKEND_NEXT_TEST_DB_PORT` / `BACKEND_NEXT_TEST_REDIS_PORT`で変更できる。
結合・プロセステストは専用DBに接続し、`backend_next_<ランダムID>`のDBだけを作成・削除する。
本番設定は読み込まない。

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
relay登録・受理/拒否・inbound検証・actor公開は#195、削除配送は#172で接続済み、チャートは#200。
本家との比較は[AP配送の比較資料](../../docs/superpowers/compatibility/ap-deliver/README.md)、業務規則と残りは[本家配送の引き継ぎ](../../docs/backend-next/ap-delivery-handoff.md)を参照する。
基本text保存のためだけにjobやdispatcherを作らない。queue・payload・保持の値は[投稿の最小契約](../../docs/backend-next/posting-contract.md#通常ジョブ162)を参照する。

#174の第1sliceは通常投稿からhome/local/user/list/channelのRedisリストを更新する。返信・添付・公開範囲・購読関係・休眠フラグを本家のproducer規則で判定し、保存時のNoteと現在の関係/Metaを使う。`list:<timeline名>`を既存prefix内へ保存する。3分より古いIDは現在の末尾より日時が新しい場合だけ追加し、recentは10%で指定件数へtrimする。削除時は本家どおりIDを消さない。失敗は投稿HTTP成功を取り消さず記録し、終了時に開始済み処理を待つ。

非channel投稿の10%でローカル非休眠followerを最大1000件抽出し、最終活動が50日より古いUserとその全Followingを休眠化する。WebSocket接続と5分ごとの活動記録でUserとFollowingの休眠フラグを解除する。検索・antenna・hashtag・featured・role timeline等は#174の後続、閲覧APIは#185/#186、role関連は#181/#189、チャートは#200、再構築は#132/#133に残る。[比較範囲](../../docs/superpowers/compatibility/note/timeline/README.md)を参照。

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
未登録のリモートユーザー宛ては、WebFingerによる解決（#195）まで501 `NOT_IMPLEMENTED`で保存前に拒否する。
登録済みリモートユーザーも、#195までは `lastFetchedAt` が古くても再同期せずに使う（暫定制限）。
投票終了ジョブ（#162）、AP配送（#171。既存のaccepted relayへの配送を含む）、投稿通知/stream producer（#173）と下記の通常TL producer（#174）は接続済み。投稿webhookと下記のWebSocket受信も接続済み。検索等が残るため投稿領域全体の完成ではない。
最小契約と既存実装の撤去順は[投稿の最小契約](../../docs/backend-next/posting-contract.md)を参照。

## 投稿削除（#172）

通常HTTPの `POST /api/notes/delete` は `{ noteId, i? }` とBearerを扱い、成功時204・空本文。作者または現在のmoderatorに許可し、`write:notes` が必要。停止ユーザーは拒否するが移行済みユーザーは削除できる。productionではdelete専用の1秒間隔・1時間300回をRoleのfactorで調整する。

返信数の減算→必要な配送開始→Note削除→他人削除の監査開始という本家の境界を維持する。後段のDB失敗で先行減算・配送を巻き戻したとは扱わない。Poll/Vote/Reactionは既存FKで削除し、user/Renote/channelのcountは減らさない。`notePostDelete.idle()` は開始済み配送・監査の待機窓口で、通常終了にも接続している。保存済みNote/作者/元投稿からDelete/Undoを生成し、followers・relay・concerned directを独立投入する。

`test/integration/note-delete.test.ts` は認証/監査/DB/エラー/制限/宛先、`test/processes/note-delete.test.ts` は固定C10/F8・原文署名・削除配送の終了待機を確認する。削除streamは#173で接続済み。TLは本家どおりIDをpurgeしない。検索更新は#174の後続、webhookは#175、チャートは#200、縦断完成は#176。


### 投稿通知・stream producer（#173 第1slice）

通常HTTPの投稿からreply/mention/quote/renote/note通知の受信条件とPG保存、Redisのnotes/main publicationを開始する。通常投票終了workerは通知保存後のpublicationへ接続し、削除は物理DELETE前のdeletedイベントを開始する。保存後のpublish失敗で本文やHTTP成功を巻き戻さず、終了時は開始済み処理を待つ。

`test/integration/note-notifications.test.ts`は実HTTP/PG/Redis subscriberで条件変更・payload・失敗・snapshot/current Poll・通常poll workerを確認する。main/homeTimelineと削除購読のWebSocket受信を下記で接続した。他channelは#189、広域の共有fanout/cacheは#217、通知閲覧/既読/未読timer/push/移行は#177に残る。[詳細と検証結果](../../docs/superpowers/plans/2026-11-07-notification-stream-173.md)。

投稿 webhook は author note、ローカル受信者の mention/reply/renote を通常 `userWebhookDeliver` queue と worker へ接続する。設定管理と投稿以外のイベントは #197、最終の縦断確認は #176 に残る。設定キャッシュ・投入時 snapshot・固定本家との比較と実行方法は[比較資料](../../docs/superpowers/compatibility/user-webhook/README.md)を参照。

### 投稿WebSocket受信（#173、#189の一部）

通常HTTPプロセスの `/streaming` にWebSocketで接続し、native/app/miauth token（Bearer優先、query `i`）またはguestを受け付ける。app/miauthには `read:account` が必要。`connect` の `main` と `homeTimeline`、`subNote`/`s`/`sr` と `unsubNote`/`un` による削除 `noteUpdated` を扱う。`disconnect`、`pong: true` の接続ack、接続ID置換、32channel・1536note上限を本家に合わせる。

HTTPプロセスごとに専用Redis subscriberを1本持ち、各受信者の関係factsを接続時と10秒ごとに取得する。TLの公開snapshotは維持し、nested hideと自分のreactionを受信者ごとに適用する。followers本文を隠す判定だけは本家の別following cacheに相当する現在DB材料で行う。接続時と5分ごとの活動日時更新、1分ごとのpingと2分超の無pong切断を行い、停止はupgrade/WSを拒否・終了し、開始済みDB処理を待ってから依存先を解放する。

実HTTP create/delete、通常投票worker、実PG/Redis/WSと停止・heartbeat・relation refreshを検証する。[固定本家比較と検証範囲](../../docs/superpowers/compatibility/stream/README.md)。`readNotification`・channel書込・他17channelは#189/#177、通知閲覧/既読/未読/push/移行は#177、投稿全体の縦断完成は#176に残る。
