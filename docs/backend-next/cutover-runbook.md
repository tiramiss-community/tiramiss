# 完全停止下の切替・復旧手順（#581）

判断基準は[GOALS](GOALS.md) → [ROADMAP](ROADMAP.md) → [親#139](https://github.com/tiramiss-community/tiramiss/issues/139)。本手順は準備用であり、本番切替の許可や[#584](https://github.com/tiramiss-community/tiramiss/issues/584)の対象版リハーサル成功を示さない。無停止切替・旧新同時稼働・無条件rollbackは行わない。

## 入力と記録

実施責任者は、以下をリポジトリ外の保護された実施記録へ埋める。空欄・未承認・復元未確認があればS0で停止する。認証情報やbackup内容をIssue・stdoutへ出さない。

| 入力 | 記録する内容 |
| --- | --- |
| 対象版 | 固定本家SHA（現在 `8e07cf085adf7009583d234a208e30436f020e26`）、旧binary/config・新binary/configのhashと保管先、#135の全機能・既知差異・未対応なし判定、#138の配布物 |
| 停止対象 | 全ホストのHTTP/stream、worker、scheduler、scanner、CLI/cron、補助producer、外部process managerの自動再起動・自動deploy、手動独自adapterの一覧と停止コマンド |
| 依存先 | PGの全schema/履歴、`redis`/`redisForPubsub`/`redisForJobQueue`/`redisForTimelines`/`redisForReactions`の実host・port・DB・TLS・prefixと共有関係、外部保存・検索・mail/push/AP/webhookの行き先 |
| backup | 停止確認時刻、同一復旧点のPG・全対象Redis・必要なファイル/object storageのbackup ID・hash・tool版、復元先・復元コマンド、鍵/config/旧binary、復元確認結果 |
| ジョブ | 10 queueの件数/paused/blocker、9 system scheduler、別prefixの旧独自adapter、failed/結果不明/送信済み副作用の担当と処置 |
| 通知 | #177の既存Redis通知・既読/未読・timer等の棚卸しと、PGへの移行/保持/打切りの承認、専用手順・入力/出力件数・照合結果 |
| 復旧 | 段階ごとの復旧責任者、旧binary復帰可否、外部副作用の照合先、許容される新書込損失と利用者への扱い |

Redisの用途別設定を省略するとbase Redisを使う。実体が同じ接続は1つのsnapshotで関連DB/prefixをまとめて保持し、別実体は個別に取得する。pubsubの過去メッセージはbackupから再送されない。cache/再構築可能な状態も、担当の根拠なしにqueueや通知と一緒に削除しない。

## 実行順序

以下の`pnpm`はビルド済みの対象版repo rootで行う。`MISSKEY_CONFIG_YML=/secure/candidate.yml`を全コマンドへ指定し、接続先を実施記録と照合する。停止・backupツールは環境依存なので、S0で具体的なコマンドに置き換える。単に「backup済み」と記録しない。

| 段階 | 入力・コマンド/操作 | 期待結果 | 中止条件・復旧先 |
| --- | --- | --- | --- |
| S0 準備 | 上表と#135/#138/#165/#177・各handlerの完成条件を照合。別環境で下記fixtureと実backup復元を実施 | 対象SHA・旧新配布物・通知方針・全復元手順が確定 | 未実装/未検証・未承認は切替延期。稼働中の旧版を維持 |
| S1 受付と全process停止 | ingress/streamをメンテナンスへ変更。process manager/cronの自動起動を止め、棚卸しした旧新HTTP/worker/scheduler/scanner/producerを停止 | 全ホストのservice/container/PID状態と終了コード、PG接続/Redis client一覧を照合し、更新主体がいない。期限超過終了は結果不明として記録 | 停止未確認・active/lock残存・外部producerがあれば進めない。旧版へ戻す場合も起動主体を1組に限定 |
| S2 同期backup・復元確認 | 停止状態を維持し、PG全schema（`public.migrations`/`backend_internal.migrations`を含む）・各Redis・外部保存を取得。hash/ID/時刻を記録。別の空の依存先へrestoreし、件数/履歴・queue payload/options/TTL・保存物hashを照合 | 全依存先が同じ停止復旧点へ戻り、復元した旧版の起動/読取を外向き隔離下で確認して再停止 | backup不完全・復元/照合失敗なら元の停止済み依存先を保持しR0。不可逆操作へ進まない |
| S3 残job検査 | 旧版の起動確認で worker が queue を消費し得るため、全 process の再停止後、S2 と同一の backup から PG・全 Redis・必要な外部保存を空の復元先に再展開する。件数・履歴・queue・保存物の照合後、その設定で `pnpm --filter backend-next check-queue-handoff --stopped`。下記の別prefix・通知も照合 | exit0、`ready:true`、全queue/全体blockerなし。reportと停止確認証跡を対に保存 | exit1・検査不能・未対応job/schedulerは旧版/担当で解決後S1から新backupで再実施するか延期。clearで通さない。R0 |
| S4 migration | 外向き隔離した復元先で `pnpm --filter backend-next migrate` → `pnpm --filter backend-next check-migrations` → `pnpm --filter backend-next check-schema` | 本家public→独自schemaの順に適用、両履歴一致・登録Entity範囲のschema差分0 | 非0/応答不明/履歴・schema不一致はR1。通常起動で自動修復しない |
| S5 通知移行 | #177の承認済み専用手順を実行し、旧Redis通知/未読とPG通知の件数・ID・時刻・既読・未読を照合 | 承認した保持/移行/打切りと一致。旧Redisから暗黙の破棄・二重保存がない | 専用手順未実装/未承認/不一致なら中止、R1。`migrate`だけで移行済みとしない |
| S6 新版の隔離起動 | `pnpm --filter backend-next check:connect`、全停止下でcheckerを再実行し、その後 `pnpm --filter backend-next start`。通常HTTP/worker・delayed retry・通知・停止/再開を確認 | 全子ready、期待する保存結果/副作用と一致、外部配送は隔離先のみ。正常停止も確認 | 起動・実処理・停止失敗や未知の外部効果はR2。checker成功を全機能完成に数えない |
| S7 本番実施判断 | #584の対象版成功・途中失敗・復旧証拠、#135の未対応なし、通知照合、配布物を責任者が確認。本番依存先でもS1–S5を新しいbackupで実施してから新起動・ingress再開 | 隔離環境と同じ対象版/手順、旧process停止継続、新版だけが動作 | 不一致・未完了ならメンテナンス維持。新consumer開始後はR2 |

S1のprocess検査例は `systemctl is-active <各unit>` / `docker compose -p <対象project> ps --all` / 全ホストの `ps`、PGの `pg_stat_activity`、用途別Redisの `CLIENT LIST`。これらは既知のprocess一覧との照合に使う。checkerの`--stopped`は利用者の宣言であり、全process停止の自動証明ではない。queue pauseだけではproducer・scheduler・取得済みjobは止まらない。

## checkerの判定と解消先

[実装](../../packages/backend-next/src/platform/job-queue/handoff-policy.ts)・[raw Redis検査](../../packages/backend-next/src/platform/job-queue/handoff.ts)・[#165比較](../superpowers/compatibility/queue-handoff/README.md)を正とする。jobのID/name/payload/options/試行数/遅延時刻/pausedを保持する読取専用検査であり、export/replay・retry・promote・clearは行わない。

| 状態 | 現在の判定 | 担当/必要な対応 |
| --- | --- | --- |
| `deliver` / `endedPollNotification` / `userWebhookDeliver`のwait/paused/delayed/prioritized/failed | 対応payload/optionsなら保持可能。failedも自動retryしない | 対象版handlerと通常retryの比較。必要なretryは別に承認した運用判断 |
| 残る7 queueの未完了・failed | `UNSUPPORTED_QUEUE` | inbox #195、db/system #199、relationship #182、objectStorage #188、systemWebhookDeliver #198、postScheduledNote #183。解決/対応を待ち、clearしない |
| completed履歴のみ | 未対応queueでも保持可能。ただしname/data欠落・不正な構造/metadata・残lock・dependency・schedulerがあれば阻害 | completedであるだけで全記録を無条件に許容しない。payload/optionsの業務解釈を省略できる条件と、queue全体の整合検査を区別 |
| active / lock / stalled | `ACTIVE` / `LOCK` / `STALLED` | 完全停止を確認し、旧版で通常の完了/復旧を行う。lock削除だけで回避しない |
| waiting-children / 親子参照 / 依存key | `DEPENDENCY` | 対応機能で依存を解消し、新しい停止backupから再確認 |
| repeat / scheduler / jobのrepeat参照 | `SCHEDULER`（wait=0でも阻害） | 9 system scheduler: tickCharts/resyncCharts/cleanCharts/aggregateRetention #200、bakeBufferedReactions #184、clean/checkExpiredMutings/checkModeratorsActivity/cleanRemoteNotes #199。所有者の移植・通常運用確認が必要 |
| 不明queue/孤立key/不正型・payload/options | `UNKNOWN_QUEUE` / `UNKNOWN_RECORD` / `INVALID_PAYLOAD` / `UNSUPPORTED_OPTIONS`または検査失敗 | 実データと対象本家版の調査。自動変換/破棄はしない |

job Redisの物理rootは通常 `<prefix>:queue:<queue名>:<queue名>`。checkerは`redisForJobQueue`だけを検査する。手動実行した旧独自adapterの`deliver`/`postLocal`は呼出元が選んだ別prefixであり、共通prefixを推測しない。対応する旧版Queue APIで全状態・`{workId,dispatchSeq,queueGeneration}`・lock・定期定義を別に棚卸しし、残件の解決/退避と復旧方法を記録する。退避だけで仕事を完了扱いしない。

## PR #213の内部状態廃止

`RetireDurableWork1793635233676`は完全停止下で9旧内部表と通知の課金2列を廃止し、通知の業務列と本家publicデータ/履歴を保持する。[PR #213](https://github.com/tiramiss-community/tiramiss/pull/213)・[検証](../../packages/backend-next/test/integration/retire-durable-work.test.ts)。

request非settled、item非succeeded/skipped/cancelledまたは残owner、未released dispatch、予約数/復旧中control、host ownership、未完了recipientは、期限切れやfailed/結果不明でも`DURABLE_WORK_REQUIRES_REVIEW`となる。各種別件数を担当へ渡して停止し、検査を通すためにstateを書き換えない。旧表lock・検査・DDL・内部履歴更新は同一transactionで、拒否ならそのtransactionは戻る。ただし先に成功した本家migrationまで一括rollbackされたとは限らない。

`down()`は空のprotocol表と通知課金列を再作成するだけで、廃止したwork/effect/宛先/送信履歴を復元できない。旧binaryへ戻す手段は、確認済みの停止backup一式の復元である。DB検査はRedis残job・既存Redis通知の移行を検証しない。

## 失敗時の分岐

| 分岐 | 成立条件 | 復旧操作と再開条件 |
| --- | --- | --- |
| R0 migration前 | checker等の読取だけで、新consumer/通知変換/外部書込を開始していない | 元の依存先が未変更と確認できれば、旧binary/configで旧processだけを起動できる。複製fixtureだけを壊した場合は元backupから作り直す。元依存先変更が疑わしければR1 |
| R1 migration途中/通知変換後 | 本家migrationの一部が既にcommitされた可能性、独自transactionの失敗、成否不明を含む | 全旧新processを停止、失敗時のDB履歴/logを保全。同じ復旧点のPG・Redis・必要な外部保存を空の復元先へ一緒にrestoreし、履歴・件数・旧binary/config起動を隔離下で検証して旧版へ戻す。down連打/無条件migrate再実行は禁止。再試行は原因と適用済み状態を確認して新backupから |
| R2 新書込/consumer開始後 | 新HTTPが受理、job取得、通知保存または外部配送を開始した時点。起動結果不明も含む | ingress閉鎖→全新process停止、書込/配送/未完了jobと結果不明を保全・照合。backup復元は新書込を失うため責任者が復帰可否と扱いを判断。復帰する場合は同一復旧点の全依存先をrestoreし、外部効果を照合してから旧版を1組だけ起動。自動rollbackしない |

AP/webhook/mail/pushの送信やobject storageへの外部変更はDB/Redis復元では取り消せない。復元したjobのretryは二重配送になり得る。送信結果不明も個別に照合する。通常BullMQ以上のexactly-once保証や新たな独自台帳は本手順の前提にしない。新PG通知は旧binaryが読めるとは限らず、binaryだけの差し戻しを復旧としない。

## 外部配送を隔離するfixture

[Compose](../../packages/backend-next/test/fixtures/cutover/compose.yml)は専用PG・5用途のRedis・保存領域を持ち、全serviceを`internal:true`の1 networkへ閉じる。公開port・host network・Docker socket・本番volumeを持たない。送信先のURLを書き換え忘れても外へ配送できない構成とし、[probe](../../packages/backend-next/test/fixtures/cutover/probe.mjs)で内部接続成功と公開IPへの経路不在（`ENETUNREACH`）を確認する。実配送の成功比較には、このnetwork上の受信sinkを対象handlerのfixtureで追加してURLを向ける。proxy・mail・push・storage認証は本番値を使わない。

```sh
# repo root。自分専用のproject名を使い、実施中は同名を他作業と共有しない。
cutover_project=backend-next-cutover-example
cutover_compose=packages/backend-next/test/fixtures/cutover/compose.yml
docker compose -p "$cutover_project" -f "$cutover_compose" up -d --wait postgres redis redis-pubsub redis-jobs redis-timelines redis-reactions storage
docker compose -p "$cutover_project" -f "$cutover_compose" run --rm probe
bash packages/backend-next/test/fixtures/cutover/smoke.sh
```

fixtureは合成データ専用。[snapshot.sh](../../packages/backend-next/test/fixtures/cutover/snapshot.sh)はcandidateが停止した状態でPG custom dump、5 RedisのRDB、保存領域をbackup/restoreする。専用project名と新規絶対snapshotディレクトリが必要で、PGと全5 RDBの存在、保存領域を含むmanifestの完全一致、完了markerを復元前に確認し、欠落/破損/追加のあるbackupは依存先を変更する前に拒否する。RedisはRDBロードのため停止/再起動し、保存領域は置換する。アプリ停止を全ホストで証明する仕組みではない。復元に失敗した場合は依存先を部分復元状態のまま起動せず、原因を直して同じ完全backupからrestoreを完了する。本番ではS0で定めたbackup toolを使い、この合成fixture用スクリプトを流用しない。

```sh
# アプリ・migration・補助producerをすべて停止してから実行。
bash packages/backend-next/test/fixtures/cutover/snapshot.sh "$cutover_project" backup /tmp/cutover-snapshot-example
bash packages/backend-next/test/fixtures/cutover/snapshot.sh "$cutover_project" restore /tmp/cutover-snapshot-example
```

`candidate` profileは#138の検証済み配布imageを`CUTOVER_CANDIDATE_IMAGE`に指定して使う。既定の`unbuilt` imageは存在を前提にしない。`/misskey`にbackend-nextと依存を持つimage用の入口であり、既存旧backend Dockerfileを新実装の配布物とみなさない。設定例は全依存先をfixture内へ向ける。対象配布物のpath/entrypointが異なる場合は実施記録付きのoverrideを用意し、同じinternal networkだけへ接続する。

```sh
# CUTOVER_CANDIDATE_IMAGE に検証済み配布imageを指定済みの場合。
docker compose -p "$cutover_project" -f "$cutover_compose" run --rm candidate node packages/backend-next/built/entrypoints/check-queue-handoff.js --stopped
docker compose -p "$cutover_project" -f "$cutover_compose" run --rm candidate node packages/backend-next/built/entrypoints/migrate.js
docker compose -p "$cutover_project" -f "$cutover_compose" run --rm candidate node packages/backend-next/built/entrypoints/check-migrations.js
docker compose -p "$cutover_project" -f "$cutover_compose" run --rm candidate node packages/backend-next/built/entrypoints/check-schema.js
# S5を完了し、対象版のfixture入力/受信sinkを揃えた後だけ起動。
docker compose -p "$cutover_project" -f "$cutover_compose" --profile candidate up -d candidate
docker compose -p "$cutover_project" -f "$cutover_compose" stop candidate
# 自分が作成した合成fixtureだけを破棄。
docker compose -p "$cutover_project" -f "$cutover_compose" --profile '*' down -v
```

## #581の検証と#584への引き継ぎ

`smoke.sh`は自分専用projectを作り、内部/外部接続probe、合成PG/Redis/保存物のbackup、途中SQL失敗、新書込後の全依存先復元・余分な保存物の削除を確認して片付ける。これは復旧操作のfixture検査であり、本家全migration/handler/旧binaryの最終リハーサルではない。

```sh
pnpm --filter backend-next test test/unit/job-queue/handoff.test.ts
pnpm --filter backend-next test:integration test/integration/queue-handoff.test.ts test/integration/migrations.test.ts test/integration/retire-durable-work.test.ts
```

#584は対象版の全機能・7未対応handlerと9 scheduler・通知移行・配布物を揃え、実backupの復元、R0/R1/R2、通常HTTP/workerと外部sink、失敗と再起動の証拠を記録する。#581を閉じても#139/#114や本番切替完了は意味しない。

2026-11-18、base `c0123d10df`で近傍単体37件・結合3ファイル58件がPASS。合成fixtureはnetwork probe、稼働中one-off candidate拒否、途中SQL失敗後/新書込後の復元（Redis DB 0/1を含む）、manifest短縮＋PG dump欠落・保存物追加・RDB破損の事前拒否がPASS。これは本家全機能比較・本番backup復元・#177通知移行・#584最終リハーサルの測定ではない。
