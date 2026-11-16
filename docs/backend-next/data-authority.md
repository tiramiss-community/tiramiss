# 投稿・検索・TL・chart の正本と保守範囲（#132）

## 判定と参照基準

2026-11-17、[#132](https://github.com/tiramiss-community/tiramiss/issues/132)・親 [#131](https://github.com/tiramiss-community/tiramiss/issues/131)・全体 [#114](https://github.com/tiramiss-community/tiramiss/issues/114) の現在本文を確認した。判断基準は [GOALS](GOALS.md) と [ROADMAP](ROADMAP.md)。実装の調査基点は `2fb256cd889200912cf68258e757f5e39429e495`、固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。以下の「現実装」はこの基点の Git object を指す。

**今回の有限な対象から #133 に追加する専用再構築はない。** 本家の chart 保守は #200（実装単位 [#478](https://github.com/tiramiss-community/tiramiss/issues/478)）が所有し、通常 producer は #174、閲覧は #185/#186 が所有する。停止切替は既存データを引き継ぐ #139 が所有する。現在 DB から作れる候補があることだけを理由に、新しい再構築コマンドを初期必須にしない。

これは #133 の「追加対象なし」の対応レビューへの入力であり、#133/#131/#200 や切替の実行完了を宣言するものではない。未移植の chart 保守を「不要」に変更せず既存担当へ残す。Redis 全損自動復旧・汎用再構築・追加の版/tombstone・厳密な更新削除順序は追加しない。

## 正本・保存・通常更新・保持

Note の本文・属性の正本は PostgreSQL の `note` 等の業務行である。ただし、その行から派生した**履歴値の正本は保存済みの履歴値自身**であり、現存 Note の COUNT や現在の関係を代用できない。[#174 の全更新責任・復元材料](../superpowers/compatibility/note/derived-updates/README.md)を詳細台帳として維持し、以下で保守判断を付ける。

| 対象 / 所有者 | 正本・通常更新と保存先 | 保持と復元できない情報 | 必要な保守入口・現実装の状態 |
| --- | --- | --- | --- |
| user.notesCount/updatedAt、reply.repliesCount、renote.renoteCount、channel の count/lastNotedAt / #169/#170/#172/#174 | Note 保存後の独立更新。reply は削除前に減算するが user/renote/channel は削除時に減算しない。現存値を PostgreSQL で引き継ぐ。[counts](../../packages/backend-next/src/platform/database/note-post-save-counts.ts)・[削除](../../packages/backend-next/src/modules/note/delete-note.ts) | 自動期限なし。削除済み投稿、失敗、channel 初回投稿の競合、削除後再投稿、更新時計を失うと本家の履歴値を COUNT(Note) から復元できない | 固定本家の NoteCreate/Delete にこれらを総再集計する入口はない。通常更新は実装済み。値の意味を変える再集計を #133 へ追加しない |
| remote Instance.notesCount / #174、取得・登録 #215/#195 | remote 作成時の +1 を5分集約、通常削除は先行 -1、stats 設定で gate。PostgreSQL の Instance 値と未 flush のメモリ。[counter](../../packages/backend-next/src/platform/note-instance-counts.ts) | DB値は期限なし。メモリは終了時 flush。quiet/設定/失敗・削除時点による値なので現在 remote Note 件数で履歴を代替できない | 通常 producer と終了 drain/flush は実装済み。失敗 batch 自動 retry や counter 再構築入口なし。chart の instance 系列と別の値 |
| hashtag の mentioned 作者配列/件数、profile attached 作者配列 / #174、profile caller #180/#195 | PostgreSQL hashtag 行が historical mentioned 集合の正本。public/home の Note.tags で作者を原子追加し、削除では戻さない。attached は profile 更新 caller が追加/解除。[Note 更新](../../packages/backend-next/src/platform/database/note-hashtags.ts)・[profile 更新](../../packages/backend-next/src/platform/database/user-hashtags.ts) | 自動期限なし。現存 Note から作れる mentioned 候補は削除済み投稿の作者を失う。attached を Note から作らない | Note 側と限定 profile caller は実装済み。固定本家 HashtagService の通常更新・管理設定による ranking 除去を各 caller が所有し、全履歴を作り直す入口はない |
| Renote featured / #174、reaction 等 #184、閲覧 #185/#187 | 通常 Redis の `featuredGlobalNotesRanking:*`、`featuredInChannelNotesRanking:*`、`featuredPerUserNotesRanking:*` が実際の score の正本。Renote の sample・対象条件を満たす +5。[ranking](../../packages/backend-next/src/platform/featured-ranking.ts) | global/channel は3日 window・9日 NX 期限、user は7日 window・21日 NX 期限。過去 sample、処理時計、reaction 等の別入力、失敗、削除済み対象・初回期限が消えれば復元不能。renoteCount×5 は代替にならない | 通常 Renote producer 実装済み。TTL と通常更新を引き継ぎ、再加点コマンドを作らない |
| hashtag unique/HLL/featured / #174、閲覧 #186 | 通常 Redis の `hashtagUsers:<tag>` SET、10分区切り HLL、`featuredHashtagsRanking:<window>`。hidden/sensitive gate と1時間の参加判定から更新。[ranking](../../packages/backend-next/src/platform/hashtag-ranking.ts) | SET 1h、HLL 3日、1h featured window は3h、いずれも NX 期限。参加順、非原子的競合、処理時計、過去設定、失敗を現存 Note から復元できない | 通常 producer 実装済み。キーを引き継ぎ期限で清掃する。再投入で意図せず +1 を発生させる復元は行わない |
| home/local/user/list/channel の TL / 通常更新 #174、閲覧 #185 | 専用 timeline Redis（未設定なら通常 Redis）の `list:<timeline名>` は配送・保持された ID 一覧の正本。Note snapshot と現在 Following/list/ChannelFollowing/Meta から配送。[planner](../../packages/backend-next/src/modules/note/timeline-plan.ts)・[cache](../../packages/backend-next/src/platform/timeline-cache.ts) | TTL なし。home/list/user は Meta 上限、files は半分、local は1000/files500/replies300/replyTo30、channel は設定上限。recent は10% trim、古い ID は末尾比較後に直接追加し trim しないため常時 hard cap ではない。削除 ID は残る。過去関係・休眠・設定・順序・乱数は DB から復元不能 | 通常 producer 実装済み。固定本家 FanoutTimelineService に push/get/purge/remove はあるが全履歴 backfill はない。閲覧の条件付き DB fallback は #185 の通常機能で、Redis の再構築ではない |
| Role TL / 通常更新 #174、閲覧 #181/#185、WS #189 | 同 Redis の `list:roleTimeline:<id>`。現在 Role/assignment/User 事実から評価。[producer](../../packages/backend-next/src/composition/posting-role-timelines.ts) | max1000 の確率 trim、TTL なし。過去所属・条件・期限・cache 鮮度、同一 ID の重複、削除残留は復元不能 | 通常 producer 実装済み。現在の所属からの候補抽出を過去 TL の復元と呼ばず、Role publication も再送しない |
| antenna TL / 通常更新 #174、管理・閲覧 #185、clean 等 #199、WS #189 | 同 Redis の `list:antennaTimeline:<id>`。resident active 定義、作者/Channel snapshot、follow/list 条件から照合。[producer](../../packages/backend-next/src/composition/posting-antennas.ts) | max200 の確率 trim、TTL なし。過去定義・resident cache・関係・削除残留・trim が失われる。現在 active 行だけでは過去 resident 一覧も再現不能 | 通常 producer 実装済み。設定更新・不要 antenna 清掃は既存担当。raw publication を再送する backfill は追加しない |
| SQL LIKE / PGroonga 検索 / #186、DB index はDB運用 | PostgreSQL Note.text 等が正本。本家 SearchService は LIKE または `note.text &@~ :q` で同じ業務行を検索する。アプリ専用検索 document はない | 元行の保持に従う。削除済み本文は index からの復元材料にしない | PGroonga extension と note.text の index 作成が必要なことは固定本家 `.config/example.yml:249–260` に明記。DDL・DBの再索引は DB 運用、閲覧条件は #186。現実装の SQL provider は外部 Meili 更新をしないが、これで検索 API 実装済みとはしない |
| Meilisearch 検索 / producer #174/#172、閲覧 #186 | PostgreSQL Note と ID方式・現在scope から現在 document を作れる。`${index}---notes` は engine に実際に適用された検索状態。public/home・text または cw 非null、local/global/host配列の gate。[document](../../packages/backend-next/src/modules/search/public.ts)・[adapter](../../packages/backend-next/src/platform/search-index.ts) | アプリ側 TTL なし。engine と設定に従う。削除済み Note・過去scope・失敗/遅延 add と delete の逆転による過去 engine 状態は再現不能。現在候補の再生成と過去索引再現を区別 | settings/index/unindex の通常経路は実装済み。固定本家 SearchService・CLI・scripts で全量再構築入口は見つからない。現在候補を作れることを新コマンド追加の根拠にしない。SDK成功は task 受付まで |
| 12 chart 系列・retention / #200 | chart の時間/日テーブルと retention_aggregation の保存済み履歴、未 flush のメモリが履歴の正本。producer から buffer→DB。現在の業務行は一部 total の補正材料 | chart core の clean は後述の一時 unique 配列の清掃で、全 chart 履歴 TTL ではない。過去の増減・活動・要求・関係・投稿削除・未保存/失敗した buffer は現在DBから復元不能 | 基点では chart core/producer/tick/resync/clean/retention 業務は未実装。Instance counter や hashtag HLL の存在で代替しない。schema #273、各系列と保守 #478、retention #479、stats #480 が既存担当 |

通常投稿は保存失敗なら後続を開始しないが、保存後の独立した派生更新の失敗で Note を rollback しない。削除前の reply 減算・検索解除等は DELETE 失敗でも残り得る。遅延した作成 snapshot が削除後に TL/Meili へ到達することもある。既存の失敗診断・終了待機を維持し、修復のために投稿作成を再実行しない。詳細な開始順と source/製品検証の区別は [#174 台帳](../superpowers/compatibility/note/derived-updates/README.md)による。

## 固定本家の chart 保守で実際に保存するもの

入口は [QueueService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts#L59) の system scheduler → QueueProcessorService → 各 processor。`tickCharts` は `55 * * * *`、`resyncCharts` と `cleanCharts`、`aggregateRetention` は `0 0 * * *`。cron の timezone をここで独自指定しない。system job は成功/失敗とも7日保持で、明示的な attempts/backoff は当該登録にない。再試行・停止再開の移植と比較は #478/#479 の通常実行契約に含める。

[ResyncChartsProcessorService:29–39](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/ResyncChartsProcessorService.ts#L29) は **Drive → Notes → Users** の順に await する。一つが reject すると後続は実行されない。全体 transaction や補償 rollback はない。ユーザー別・instance別は TODO であり、この job の対象に追加しない。

| 呼出し | 集計入力 / 保存結果 | 補正しないもの・失敗と再実行 |
| --- | --- | --- |
| `driveChart.resync()` | [DriveChart:35–40](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/charts/drive.ts#L35) の tickMajor は `{}`。Chart.tick は空列なら return。**DriveFile の COUNT/SUM は実行せず、chart 行も作成・更新しない** | Drive の schema は local/remote の incCount/incSize/decCount/decSize。total 列はない。Drive 全損履歴を再集計する入口と解釈しない |
| `notesChart.resync()` | [NotesChart:37–47](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/charts/notes.ts#L37) が Note の userHost IS NULL / IS NOT NULL を countBy。現在 UTC hour/day の `__chart__notes` / `__chart_day__notes` の `local.total`・`remote.total` を上書き | inc/dec/diffs、過去の hour/day、User.notesCount、Instance.notesCount は更新しない。失敗後は片方の期間だけ書けている可能性がある。同一期間・停止下の再実行は現在件数で再度 total を設定する |
| `usersChart.resync()` | [UsersChart:41–51](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/charts/users.ts#L41) が User の host IS NULL / IS NOT NULL を countBy。現在 UTC hour/day の `__chart__users` / `__chart_day__users` の `local.total`・`remote.total` を上書き | inc/dec、削除ユーザーの過去系列・活動履歴を復元しない。Notes と同じく期間別の部分保存があり得る。期間をまたぐ再実行は新しい現在期間へ保存する |

[Chart core:583–620](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/core.ts#L583) は resync を `tick(true)` に委譲し、返された列だけ range clamp して現在 hour/day 行へ保存する。行がなければ `claimCurrentLog`（369–445）が作り、accumulate 列は最新行から継承し、他列は0で開始する。補正対象の total 以外を既存行でリセットする処理ではない。hour/day の claim と更新は Promise.all で行い、両方を包む transaction はない。件数照会時点と行確保時点も単一 snapshot ではない。稼働中の buffer 差分との厳密な一度だけ合成は保証されない。

同じ #200 の残る通常保守を、resync と分けて移植する。

- [ChartManagementService:70–101](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/ChartManagementService.ts#L70): 12系列を20分ごとと通常終了時（test以外）に save。系列ごとの例外を記録して次へ進む。core.save は buffer を切り離してから書くため、失敗分を自動復旧できない。過去時間の buffer が現在期間へ保存される制限も source に残る。
- [TickChartsProcessorService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/TickChartsProcessorService.ts#L73): 12系列を順次 `tick(false)`。各 tickMinor の結果を保存する通常周期であり、全期間再生ではない。
- [CleanChartsProcessorService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/CleanChartsProcessorService.ts#L73) と [core.clean:624–656](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/core.ts#L624): 12系列を順次清掃。現在時刻から strict 1日超・3日未満の hour/day 行の `unique_temp___*` 配列を空にする。bake 済みの数値を消さず、履歴行削除/全系列 TTL でもない。unique 列のない系列は書込みなし。
- [AggregateRetentionProcessorService:37–90](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/AggregateRetentionProcessorService.ts#L37): 実行時刻の24時間前から生成したIDを超える local User を日次 cohort に登録し、過去約31日分の cohort について lastActiveDate が実行時刻の24時間前を超える人数を日付キーへ記録する。暦日の登録者数・活動者数ではなく、31日も更新対象の照会窓であり全履歴の削除 TTL ではない。過去 cohort の update は await/catch されず、成功ログは保存完了を保証せず rejection も当該処理では捕捉されない。同日キーの insert が重複すると早期 return するため、再実行しても欠けた過去 cohort の update をやり直さない。削除ユーザー・過去の活動日を現在 lastActiveDate から復元できず、resyncCharts でも埋め直さない。

12系列は federation / notes / users / active-users / instance / per-user-notes / per-user-pv / drive / per-user-reactions / per-user-following / per-user-drive / ap-request（[登録一覧](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/entities.ts#L25)）。生成テーブルは `__chart__<snake_case名>` と `__chart_day__<snake_case名>`、grouped 系列は group 付きで保存する。これらの既存履歴と migration を保持する #273/#139 の作業を、現在行からの再構築で置き換えない。

## #133 への対応表と停止条件

[#133](https://github.com/tiramiss-community/tiramiss/issues/133) の現行条件は、対象なしの場合も比較表と既存担当への対応を成果物にでき、動作しないコマンドや #200 の resync 重複移植を要求しない。今回の選定結果は次のとおり。

| 候補 | 入力 → 保存結果 | 実行・停止条件 / 所有先 / #133への追加判断 |
| --- | --- | --- |
| chart resync | 現在 Note/User の local/remote 件数 → 現在 hour/day の total。Drive は無書込み | 通常 system 定期実行は #200/#478。専用 CLI は本家にない。切替検証で固定値を照合する場合は producer・scheduler・全 writer を停止し、受理済み処理/開始済み save と buffer を drain/flush してから DB backup と対象期間を固定する。Notes reject 時の Users 未実行・部分保存・再実行・期間境界は #478 で比較する。**重複追加なし** |
| Meili 現在候補の全量投入 | 現存 Note、ID方式、現在scope/settings → 現在候補 document | 理論上の生成材料はあるが、調査した本家 SearchService/CLI/scripts に全量保守入口はなく、停止切替も既存 engine を保持する。通常更新 #174/#172、閲覧 #186、切替 #139。task 受付と適用を分ける。全量投入を選ぶ別判断が出た時点で、writer 停止・既存 task の完了/失敗・stale document の除去方法・再開条件を具体化する。**現時点では追加なし** |
| SQL/PGroonga index | 現存 PostgreSQL 行 → DBが管理する索引 | extension・index 定義・DB backup/復旧条件を DB 運用で確認する。DB再索引を投稿 producer の再実行にしない。#186/#139との照合対象。**アプリ再構築として追加なし** |
| 通常/Role/antenna TL | 現存 Note と現在関係から現在候補を抽出可能。保存済み Redis の完全な過去一覧とは異なる | 固定本家に全履歴 backfill 入口なし。通常 producer #174、閲覧・条件付きfallback #185、Role管理 #181、清掃 #199、切替 #139 が所有する。Redisを引き継ぐ。現在関係での近似 backfill を必要とする別判断がなければ作らない。**追加なし** |
| 投稿 counter/hashtag/featured/HLL | 保存済み PostgreSQL/Redis 値の保持。現存行から候補は作れても履歴値は一致しない | 通常更新と期限・管理清掃を #174/#180/#184/#186/#195/#199 の各 caller が持つ。履歴値を現在件数へ置換する合意はない。停止切替 #139 で保持。**追加なし** |

停止下の「保守」はアプリの全プロセスを止めるだけでは完結しない。#139 は旧/新 HTTP・worker・外部の書込 producer/scheduler、専用 timeline Redis と通常 Redis、Meili の受付済み task を区別し、DB/Redis/engine と設定を同じ切替点で保全する。再開後に旧 producer が書かないことも確認する。受理済み処理の drain/flush 失敗、未対応 job/scheduler、期間・設定・backup の不一致があれば切替を中止し、保存済み状態を破棄/clear して通さない。既存の [#165 引継ぎ契約](posting-contract.md#停止下の既存queuepayload引継ぎ165)を維持する。

基点の [worker登録](../../packages/backend-next/src/composition/queue-workers.ts)は3業務handlerのみ。[handoff判定](../../packages/backend-next/src/platform/job-queue/handoff-policy.ts)も system scheduler を拒否する。管理handleやqueue名の存在は resync 実行能力を意味せず、**今の backend-next に保守コマンドを実行できるとの手順は提示しない**。上表の停止条件は既存担当が移植・切替試験へ渡す要求であり、今回実施した本番操作ではない。

この範囲に不足が見つかったときだけ #133 の対象を再選定する。その場合は対象名、固定 source の入口または切替に不可欠な理由、正本の入力、書き込む列/キー、fixture、停止/drain/再開条件、途中失敗の残存状態と再実行結果を先に固定する。投稿作成・通知・AP・webhook・stream の再送で代用しない。現時点の対象なし判定を、将来の新しい保守要求の承認と扱わない。

## 照合証拠と検証の限界

今回は文書レビューであり、新しい source probe や製品テストの実行成功は主張しない。基点の実ファイルと固定 Git object を照合した。既存 receipt/corpus/入力hashの付替えや過去の検証結果の再認定は行っていない。

| 基点の検証ファイル | 文書で確認した契約 / この試験が証明しないこと |
| --- | --- |
| [integration/note-search-index.test.ts](../../packages/backend-next/test/integration/note-search-index.test.ts) | document/settings・現在scope・DELETE失敗でも解除・要求保留/拒否・削除後 snapshot。全量再構築や全履歴復元は試験しない |
| [processes/note-search-index.test.ts](../../packages/backend-next/test/processes/note-search-index.test.ts) | settings失敗で起動継続、設定欠落、保留要求の終了待機/期限。engine適用完了や新しいrebuildコマンドの試験ではない |
| [integration/note-timelines.test.ts](../../packages/backend-next/test/integration/note-timelines.test.ts) | 関係/設定の変化・削除ID残留・遅延snapshot・部分Redis失敗・休眠・古いIDの独立更新・小数trimエラー。過去関係からのbackfill試験ではない |
| [processes/note-timelines.test.ts](../../packages/backend-next/test/processes/note-timelines.test.ts) | 通常HTTP子の専用timeline Redisへのdrainと接続喪失時停止。全損後の復元試験ではない |

固定本家の主な調査入力（raw Git blob の識別子。新しい実行 receipt ではない）:

| `packages/backend/src/` からのパス | Git blob |
| --- | --- |
| `queue/processors/ResyncChartsProcessorService.ts` | `0c47fdedb3b0c0926fb5b0294c5d60d8e316121d` |
| `core/chart/core.ts` | `c1a012947be38fef645271c67adf0cf447dc1dda` |
| `core/chart/charts/drive.ts` | `782873809ad49f50f155ba23069fcc8eb83da16a` |
| `core/chart/charts/notes.ts` | `aa64e2329a77f324b2cce41de487fe71c46f5f29` |
| `core/chart/charts/users.ts` | `4471c1df23dc194feb87d66d4a1ea626652554c3` |
| `core/chart/ChartManagementService.ts` | `0db05f76124bb77066f7d12532dc02391b809e9b` |
| `core/QueueService.ts` | `c09fde4ce26238b4b10a4cde97363597b7a131ce` |
| `core/SearchService.ts` | `c54195d91a70e7c5fa9dcdac75ef8e47ebdc620e` |
| `core/FanoutTimelineService.ts` | `ae387dc8e4f6d5e8a8fffe67cd53fcffcd6c4c3a` |

再照合は repo root で、例えば `git show 8e07cf085adf7009583d234a208e30436f020e26:packages/backend/src/core/chart/charts/drive.ts` と `git rev-parse 8e07cf085adf7009583d234a208e30436f020e26:packages/backend/src/core/chart/charts/drive.ts` を使う。現実装の読み直しも `git show 2fb256cd889200912cf68258e757f5e39429e495:<path>` で基点を固定する。Git object がない環境では取得・固定してから照合し、現在の fork ファイルや最新 upstream へ黙って置換しない。
