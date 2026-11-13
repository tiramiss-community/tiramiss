# 新バックエンドの全体計画

更新: 2026-11-14。判断基準は [GOALS](GOALS.md)。全体Issueは [#114](https://github.com/tiramiss-community/tiramiss/issues/114)。本書は工程と現在地、Issueは個別作業と依存、各PRは実装・検証結果を持つ。

## 今回の方針整理

既存コードを全廃せず、本家相当の業務機能を通す順序へ戻す。独自の障害保証を備えた基盤の完成を、投稿機能の先行条件にしない。基本設計の依存境界は引き継ぐが、後から詳細化した同時確定・復旧・容量の契約は初期必須か再評価する。

2026-11-03のGOALS改訂で、本家機能は原則すべて初期範囲に含め、例外は保留と明示した追加保証と承認済みの意図的差異だけとした（[網羅性監査](coverage-audit.md)のP4）。

目的は以前の基本設計にも存在した。詳細な保証と同じ長文に入り、部分実装の完了を次の前提へ積み上げたことで、通常worker未接続のままジョブadapter群が増えた。セッション継続やcompactだけを原因とは断定しない。セッションを替えても、古い必須条件をそのまま読むと同じ方向へ進むため、入口と計画を揃える。

## 現在地と既存成果

基準: develop `50ffa6157c557f72ca10857201f390b5855c8016`（PR #270マージ後）。保存済みlocal actorフィールド公開 `efd6b94ea9911fc6b9aeaad0edeea04da3932da1` は#269でマージ済み。#267のlocal actor画像、#268のWebFingerとstdout JSON診断も引き継ぐ。PR #270でマージ済みのlocal featured collection＋AP Note GETのsourceは `bcb828e878c5d14cb5be7b9ebf743fd452cca648`（元の通常2コミット・23ファイルとUnicode修正、[限定結果](../superpowers/compatibility/remote-user/local-featured-results.md)）。本家の固定基準は `packages/backend-upstream/upstream-sync.json` を参照。

[画像削除の限定結果](../superpowers/compatibility/remote-user/actor-image-removal-results.md): public remote mentionの作成・canonical復旧後、両画像が不在なら6フィールドを消去し、更新失敗は報告してmentionを継続する。

現在のS1進捗は次のとおり。各PRの限定した実装・比較範囲と、Issue全体の完了を区別する。

| 対象 | 実装済み | 残作業・完了判定 |
| --- | --- | --- |
| local WebFinger #195 | 通常GET/HEAD/OPTIONS `/.well-known/webfinger`、resource解決・JRD/XRD・path限定CORSを既存actor GETへ接続。[source49とR3単体235・実HTTP/PG46の結果](../superpowers/compatibility/remote-user/local-webfinger-results.md)。既存HTTP/actor55は別R1実行 | wildcard OPTIONS・他well-known/host-meta/NodeInfo/authorize-follow・collections/inbox/remote Notesは未完了。sourceはFastify inject＋doubles、error body診断文字列とMeta DB対injected cache/通知同等性は未比較。#176/#127/#195 OPEN、notes/create partial・postingComplete:false |
| local actor保存済フィールド #195 | 既存HTTP/内部actorへisCat・設定3項目・movedTo・alsoKnownAsとfeatured URLを公開。[source21・単体283・実HTTP/PG177の親実測](../superpowers/compatibility/remote-user/local-actor-fields-results.md) | 当該slice当時はfeatured endpointが未実装だったが、PR #270でlocal featured/AP Note GETはマージ済み。Move実行・Drive/media・remote Notes・inbox/cacheは未完了。内部取込の設定prefix差とMeta/cache差を維持。#176/#127/#195 OPEN、notes/create partial・postingComplete:false |
| local followers/following GET #195 | 実R4 runtime `10c0d76c3724cd4e52a0a17c24ed92accaa10f75`、991入力、source318・単体3735・integration1319（collection PG/HTTP324含む）・acceptance65、全9コマンド/no drift PASS。[新R4証跡](../superpowers/compatibility/remote-user/local-follow-collections-results.md) | 業務resultのHTTP/cache除去とGit不要の静的R2 fixtureを実装。57有限入力とR3 public→R4の明示binding、旧9証跡/featured歴史投影を保持。内部18-file APPROVED・CLI16/14/12/11指摘0・旧5acf全4CI成功は新外部指摘前の履歴。今回のtargeted review・thread replies・新head PR271 CIは親待ち。full upstream server/PG・厳密診断/MetaCacheは未証明。#176/#182完了ではない |
| 共有root | PR #249でHTTP・既存worker・CIの整理がマージ済み | 追加handlerを実装した意味ではない |
| 投稿N0–N6 | #167–#175はCLOSED。#238で削除連携も確認済み | 全通知・閲覧・全WS等は各領域に残る |
| 投稿N7 #176 | #242で基本縦断・停止再開・通常retry、#250でC2/C10の比較不足を補完。#243のremote解決もマージ済み | 残るactor関連の初期機能の実装・比較待ち。#176/#127はOPEN |
| 連合 #195 | #243のremote user解決に加え、user hashtag #258、localプロフィール #259、remote絵文字取込 #262、local actor tag公開 #263、#266のremote actor画像削除、保存済Driveによるlocal actor画像URL公開と#268 WebFinger・#269保存済みfield公開。PR #270のlocal featured/AP Note GETはマージ済み。現在のfollowers/following GETは未マージの限定read slice。path修正とtest期待値補正後の実R3bはPASS、最終review/CIは別gate | inbox中核・署名検証・受信activity、画像バイト配信・Drive取得・remote media・remote featured/Note取込・Move等の残範囲あり |
| 連合土台 #215 / 外向きHTTP #216 | actor作成後usersCount #260、現在のactor取得/配送成功後のmetadata/getHtml #261 | inbox用の#215段階4、他のinstance取得経路、Drive等のHTTP利用側は未完了 |

2026-11-14: raw pathの不正percent/UTF-8をCORS・Metaより前に400拒否し、一度だけdecodeする。Phase1のsource318/近傍430/typecheck PASS後、親R3でencoded-valid pageのmember期待数4件が失敗した。JS-doubleとPG照合順の差を独立SQLで補正し、fresh R3bが324 collectionを含む全integration1319を通過。Phase2はruntime無変更で実測product `498009e4d8bdfc0afc581fbcf5954da2c2953fed` の証跡を更新する。旧7証跡＋R2 C355 bytes、3既知identityの歴史的/current投影を保持し、55入力中の変更7件と全request差分10件を明示する。旧製品CR16/metadata14各指摘0・root366/inventory/shippingは過去snapshotの履歴。今回の最終scoped re-review/PR checksとCI成功は主張しない。

2026-11-09のユーザー回答に従い、残る初期機能を実装・比較するまで#176を未完了に保つ。担当Issueを付けるだけでは閉じない。#195全体を一括のblocked-byにはせず、#176に必要な機能単位で照合する。画像/Driveは#188/#195（S5と連携）、他のinstance経路は#215、chartは#200（S3）、rich actor/featured/Move等は#195/#199、cache/remoteUserUpdated等は#217（S3）に残る。`notes/create:partial`・`postingComplete:false`を維持する。

[現在のactor関連の実装・比較資料](../superpowers/compatibility/remote-user/README.md)、[N7の実測と完了条件](../superpowers/compatibility/note/n7/README.md)、[instance metadataの限定範囲](../superpowers/compatibility/instance-metadata/README.md)、[local actor tag公開の限定範囲](../superpowers/compatibility/remote-user/local-actor-tags-results.md)、[local actor画像公開の限定結果](../superpowers/compatibility/remote-user/local-actor-images-results.md)を参照する。source-method観測と実DB/HTTP/process検証は別の証跡であり、本家full serverの全経路比較ではない。local actor tag公開だけでremote mentionの残機能やcache差が解消したとは扱わない。

| 成果 | 初期実装での扱い |
| --- | --- |
| 別パッケージ、機械同期、migration履歴、設定、HTTP/workerの起動停止 | 引き継ぐ。単純化の余地は機能を通しながら確認する |
| Role初期2 API・ポリシー評価・認証/認可・互換性資料（#115） | 引き継ぐ。他のRole APIは未移植 |
| notes/showの集合取得・可視性・純粋出力（#168 / PR #205） | 引き継ぐ。参照上限などの意図的差異は既存台帳で追跡する |
| 本家比較fixture、probe、公開契約の対応表（#167 / PR #201・#218） | 引き継ぐ。対応表は入口687行と[網羅性監査](coverage-audit.md)の1,432行に担当を割り当てたもので、機能完成を示さない |
| 独自PG request/item・dispatch/execution claim・Redis全損復旧・容量台帳（#148–#153） | 通常BullMQへ移行し、不要な実装・設定・依存・永続状態を削減する。将来案は仕様/Git履歴に残す |
| AP宛先snapshot/page・PG host lease（#156–#158） | 実行コードを削減し、本家の業務規則は[引き継ぎ](ap-delivery-handoff.md)へ残す。旧snapshotを互換性の基準として再利用しない |
| PG通知保存・effect記録（#155） | 保存先の承認を維持し直接save/flushへ分離。effect/課金への依存を撤去し、閲覧/既読/移行は#177へ残す |
| 物理容量監視と受付停止（#166 / PR #206） | 初期範囲から外し保留。PRは未マージのまま残し、勝手にclose/mergeしない |

投稿の現在地（2026-11-07）: #170/#171、投稿に必要な通知・WebSocket受信 #173、投稿webhook #175 と通常TL/検索/集計producer #174 は実装・比較済み。#174 は PR #237 で完了した。#172の削除連携sliceでは、作成後続と削除の連携を、同じ投稿を使う実HTTP/worker・PG/Redis/Meili・WebSocket・fake AP/webhookで検証した。sourceと製品の独立レビューは承認済み。#172 の完了判定と、#176 の削除に絞って確認した範囲は[削除連携の計画](../superpowers/plans/2026-11-07-note-delete-integration-172.md)を参照する。後述の各sliceにある過去の残作業記述は当時の状態を示す。

通常workerは投票終了・AP配送・投稿webhookのhandlerを実行する。#163の管理14 API・公開QueueStatsは下記の実依存検証で完了条件を満たす。#164の現在3業務queueの保持と全10名の終端清掃も下記の検証で完了条件を満たす。実payload互換/残仕事引継ぎ#165は下記の停止専用checkerと実測範囲を確認し、最終切替#139へ渡す。#124は2026-11-08の[独立した現行条件監査](../superpowers/compatibility/note/n7/README.md#remaining-ownership-and-124-audit)で全必須条件PASSとなった。#242の独立レビュー・マージを経て#124はCLOSED。監査時OPENや当時のclosure referencesは履歴として保持する。#176/#127は未完了。他の実ジョブは担当領域へ残る。#169 / PR #212は、基本text作成のHTTP・保存・応答・後続count更新と、独自BullMQ transport/Redis復旧の撤去を完了。[PR #213](https://github.com/tiramiss-community/tiramiss/pull/213)でPG通知を直接保存へ分離し、残るPGジョブ/AP protocol・専用テスト・起動Entity登録・未使用依存を撤去した。新migrationは未解決の仕事を拒否し、通知本体を保持して不要9表/課金列を廃止する。マージ済みの独自migrationは履歴として保持するが、未使用adapterや不要テーブルを最終構成に残す方針ではない。

## 本家比較から分かった追加仕様

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` のGitオブジェクトで確認した。

| 対象 | 本家 | 現行の強化案と見直し |
| --- | --- | --- |
| ジョブ | QueueServiceのadd/addBulk、既定12試行のAP配送、backoff・履歴管理 | PG正本・二重claim・世代/token・容量予約は別の実行プロトコル。初期はBullMQの通常APIを使うadapterを推奨 |
| BullMQ接続 | 公開queue APIから投入する | 旧adapterの内部Lua差替えはPR #212で撤去済み。残るPG実行基盤も削減し、必要な実jobで通常APIを導入する |
| AP宛先 | followers/directでsharedInboxを重複排除し、relayは別payloadで配送 | 永続snapshot・100件page・90日保持は追加保証。選定条件と投入の境界を分けて移植する |
| 通知 | NotificationServiceがRedis Streamへ保存 | 保存先の差異は承認を維持。最小契約でclaim/effect/容量を外すことを確定し、閲覧/既読/保持/移行は#177へ残す |
| 投稿後続処理 | 保存後に後続処理を開始し、全配送完了をHTTP成功条件にしない | DB/queue間の喪失をなくす永続依頼や強いCreate/Delete順序は、互換性の必須条件と区別する |

根拠: 本家 [QueueService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[NotificationService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NotificationService.ts)、[ApDeliverManagerService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApDeliverManagerService.ts)。旧判断は[投稿設計のD1–D4](../superpowers/specs/2026-10-21-note-flow-design.md#7-意図的な差異とリリース上の扱い)と[通知保存設計](../superpowers/specs/2026-10-23-notification-persistence-design.md)に残す。

## 進め方

1. **投稿に必要な最小契約を再確定する。** PR #212で[最小契約](posting-contract.md)を確定しマージ済み。保存/応答と後続開始を分け、必要な実jobだけ通常BullMQへ渡す。PG通知を維持し、独自の永続台帳・claim/effect/容量は初期経路から外す。新しい万能dispatcherや汎用イベント基盤は作らない。
2. **既存実装を縮小し、投稿の縦断フローを通す。** 最小契約に照らして不要と確認できた部分から削減する。置換が必要な部分は、本家相当の経路を接続するPRか直後のPRで旧経路を撤去し、全機能の完成後まで待たせない。#169の基本作成 → #170の投稿要素 → #171/#172の配送/削除 → #173–#175の通知/stream/TL/検索/webhook → #176の連携確認。途中から通常workerへ接続し、HTTP・DB・Redis・配送先の結果を小さく確認する。すべての副作用を必ずqueue化する設計にはしない。本家の必要な失敗処理も確認する。
3. **残る本家機能を移植する。** #129/#178–#200/#215–#217の対応表を入口に、利用できる機能単位で進める。未評価・未移植・比較済みを区別し、基盤PR数を完成率に換算しない。複数セッションで並行する順序・担当・並走禁止は「[並列作業とクリティカルパス](#並列作業とクリティカルパス2026-11-08)」に従う。
4. **全体の互換性と切り替えを確認する。** #130/#131/#137の必要な回復・既存データ・配布/観測・完全停止移行を、実装した機能に合わせて整える。移行に必要な処理は先送りしない。本家以上の自動復旧や運用基盤を一括のリリース前提にしない。

## マージ済み実装の削減

PR単位で一括revertせず、現在の参照・必要な業務規則・保存データを確認して不要部分を除去する。マージ済みであることを、維持する理由にしない。

| 対象 | 削減する候補と残すもの |
| --- | --- |
| #148–#153の永続ジョブ/dispatch/復旧 | PG request/item・独自claim/lease/epoch・世代/token・容量予約、BullMQ内部Lua差替え、専用scanner/recoveryと強化専用テストを削減。本家相当の通常BullMQ投入/実行/retryと業務境界を残す |
| #154のproducer fixture | 強いPG依頼同時保存を完成条件にするfixtureを整理。実Note・ロールバック・本家相当の作成結果を検証する材料は残す |
| #156–#158のAP snapshot/page/host lease | 永続宛先台帳・独自ページ再開・host lease/fencing・保持課金を削減。宛先選定/重複排除/federation条件は本家比較のうえ分離して移植する |
| #155のPG通知 | 最小契約でPG保存の維持を確定。不要な永続claim/effect/容量課金への依存を撤去し、本体・通常保持を残す |
| 横断する残骸 | composition/import/設定、通常起動のschema/検査登録、未使用の依存、README/テストを合わせて整理する。必須設定だけ消して複雑なコードを残す対応で終えない |

削減PRでは、除去する対象と参照元、残す比較/業務処理、DB/残ジョブへの影響を短く示す。不要な独自テーブル/列/索引は、既存データと利用状況を確認し、停止下の新しいmigrationで廃止する。マージ済み履歴と本家public schemaを直接書き換えない。必要なデータ/残ジョブがある場合は、その扱いを先に確定する。

**削減の完了条件**: 本家相当の経路と必要な失敗処理が動き、不要な旧実装がruntime・起動・運用・テストの前提に残っていない。通常workerは投票終了・AP配送・投稿webhookのhandlerを実行する現状で、他の既存adapterを無条件に代替完了扱いしない。仕様・比較観測・Git履歴を保持することと、未使用の実行コードを残すことを区別する。

## Issueと依存の見直し

| Issue | 現時点の位置付け |
| --- | --- |
| #114 | 本書を入口とし、初期の機能同等性と後続強化を区別する |
| #124 / #127 | 最小契約、既存PG基盤の縮小/撤去、通常worker/投稿の縦断を追跡する。削減も初期の完了条件に含める |
| #159 / #161 / #166 | 強いclaim/配送順序、物理容量制御は後続強化として保留。前提の独自実行基盤は撤去済みで、旧コードをそのまま再利用できる状態ではない |
| #163 / #164 / #165 | 既存Issueを本家相当のqueue管理API/QueueStats、通常履歴保持/清掃、実queue/payload互換/残仕事引継ぎへ改訂し、初期作業として扱う。旧PG制御・課金・全版readerの保証は履歴へ分離する |
| #160 / #162 | 投稿に必要な署名HTTP・通常worker接続は実装済み。#124もCLOSED。残るhandlerは各領域が所有する |
| #169 / #170 | 基本文字投稿と添付/返信等の限定投稿範囲は実装・比較済み。#195のremote解決は#243で接続し、残る初期機能は#176で追跡する |
| #177 / #138 / #139 | 通知保存先の判断と、既存データ/配布上必要な作業を反映する。承認済み差異や移行を黙って消さない |

個別の新しい依存は、利用する具体契約が決まった時点で設定する。#169の基本範囲の完了を投稿全体の完成とは扱わない。既存Issueを自動close/reopenせず、履歴と未完了範囲を維持する。

## 計画とIssueの対応・依存

2026-11-03に、全体計画配下のopen 57件と完了済みの子11件を照合した。その後の[網羅性監査](coverage-audit.md)で、既存の領域に収まらない横断的な責務に担当がないと分かったため、#215（連合の共通土台）・#216（外向きHTTPとSSRF対策）・#217（プロセス間イベントとキャッシュ同期）を追加した。本家設定・観測・既存データ形式の互換は #138 に寄せた。対応表（PR #201・#218、マージ済み）は入口の行と監査行の担当を示すだけで、対応表の存在や領域Issue数を機能完成率にしない。

| 計画の対象 | 個別作業・完了確認の所有者 |
| --- | --- |
| Role初期範囲 / 残るRole API | #115（#116–#121完了）/ #181 |
| 投稿の代表フロー | #125 → #127 → #176が未完了。#167–#175はCLOSED、N7の基本比較は実施済み |
| 通常ジョブ・署名HTTP・worker | #122 → #124 → #160 / #162 |
| 本家queue管理・QueueStats / 履歴保持 / 実payload互換 | #163/#164実装・比較済み / #165は停止専用検査・現在3業務handlerの実引継ぎを検証。7業務handlerと最終切替は各担当へ残る |
| 全公開契約の棚卸し / 残る機能の実装 | #128 → #129 / #177–#200（領域別の所有者表は #128）|
| 横断的な共通土台 | #215 連合の共通土台 / #216 外向きHTTP・SSRF / #217 プロセス間イベント・キャッシュ（いずれも #128 の子）|
| 外部保存・部分完了 / 派生データ・必要な保守 | #130 と #188/#199 / #131 → #132/#133、#174/#185/#186/#200 |
| 本家追従・移植支援 | #134 → #135/#136 |
| 配布・CLI・観測 / 完全停止切替 | #137 → #138/#139、#165/#177 |

Issueの有効な本文・タイトル・完了条件も本方針へ揃え、旧条件は履歴へ分ける。#178–#200の共通条件から独自台帳/claim/容量/強い復旧の一律要求を外し、各機能の本家の保存境界・後続開始・通常retry・必要な保持を比較する。未移植の機能は今後、利用できる小さな単位へ分割して実装する。

GitHubの親子関係は領域所属として維持し、blocked-byは次の具体的な依存へ合わせる。

- #162は署名HTTP #160の一律完了待ちにしない。AP以外の実仕事から接続でき、AP配送の完成は #171で #160/#162を必須にする。
- #172のAP削除完成は #170/#171が先行。#173/#175は #170/#162、#174は #170から進め、削除との最終連携を #176で確認する。通常更新を汎用再構築設計 #132の完了待ちにしない。
- #163–#165は #162が先行。#139の最終切替リハーサルは #135/#138に加え、実残ジョブ #165と通知移行 #177が先行する。棚卸しや手順案は先に準備できる。
- #215/#216は #160・#171・#195 の先行契約で、内容は[連合の共通土台](federation-base-contract.md)と[外向きHTTP](outbound-http-contract.md)の契約で確定した。各段階は最初の利用者と同じPRか直前のPRで接続し、全体の完了を一括のblockerにしない。
- #170に残していた未登録remote mentionの暫定501とstale再同期の制限は、#195の最初のPR #243で解消済み。#215の鍵・#216の送信・#160のGET署名を使うWebFinger/Person解決とsignedGetを接続した。coreの解消を画像・chart・cache等まで含む全体完成には読み替えない。
- #217は、書き込み系の機能（#180/#182/#194など）がキャッシュを持つ前に、使う範囲の契約を確定する。キャッシュを導入するsliceだけに適用し、キャッシュを持たずDBを直接読むsliceは#217を待たない。
- #124の初期必須子は #160/#162–#165。保留 #159/#161/#166は同領域の履歴として所属するが、初期完成の前提には数えない。
- 2026-11-08に、完了そのものを止める依存をblocked-byへ追加した。#139 ← #195/#182/#183/#188/#198/#199/#200/#193（切替checkerが未対応queueの未完了・failedジョブとschedulerを拒否し、clearによる回避は禁止のため、各queueのhandlerと定期ジョブが必要）。#130 ← #188/#199、#194 ← #179/#198/#188、#196 ← #193/#180、#187 ← #185、#192 ← #189、#199 ← #188。blocked-byは完了を止める依存で、着手は止めない。たとえば#192は、bubble-gameを今すぐ、reversi一覧を#185のページング部品の後、reversi channelを#189 registryの後に着手できるが、完了判定は#189全体の完了後になる。#189のTL系以外のchannel（chatは#190、reversiは#192、driveは#188、adminは#194、serverStatsは#138）はそれぞれの担当が追加し、#189の残りはregistryの担当セッションが最後に行う。
- Issue単位では閉路になる組（#195↔#182、#195↔#199、#195↔#194、#180↔#182、#180↔#179/#181/#186/#194、#188↔#190、#189↔#190/#192）と、相手の一部sliceだけを待つ組（#179/#181 ← #178のgate、#190/#191 ← #185のページング部品。#176 ← PR #243の過去のマージ待ちは解消済み）はblocked-byにせず、各Issue本文の「並列作業での着手順と担当」にslice単位で書く。

方針を変更したときは、GOALS/ROADMAPだけでなく、影響するIssueの有効な本文・完了条件・blocked-byと親の対応順を一緒に更新する。PRの実装/検証結果は実際のマージ状態を確認して反映する。

## 並列作業とクリティカルパス（2026-11-08）

複数セッションで同時に進めるための分類。Issue本文・契約文書・本家のService依存・backend-nextの実コードから暗黙の依存を洗い出し、slice単位で判断した。分類表と各Issueの着手順は [#114](https://github.com/tiramiss-community/tiramiss/issues/114) と各Issue本文、共通部品の担当表は [#128](https://github.com/tiramiss-community/tiramiss/issues/128) を正とする。

**クリティカルパス。** 切替checkerは未対応queueの未完了・failedジョブとrepeat schedulerを拒否するため、10 queueすべてのhandlerと9つの定期ジョブが揃うまで#139は通らない。そこへ向かう最長の鎖は次の2本で、どちらも#199と#195のinbox完成に合流する。

1. #180 UserDetailedNotMe → #182 follow/block/muteのUseCase → #195 inbox完成 / #199 移行・import → #139
2. #188 Drive（ファイル追加・ダウンロード・削除）→ #199 export・import・削除 → #139

#200の全chart、#183の予約投稿handler、#198のsystem webhook配送、#193のお知らせ期限切れジョブも#139の前提になる。

**先に出す土台の現在地。** #178の初期API gateは#245、ModerationLog appenderは#246、#182のFollowRequest Entity同期は#248、共有root整理は#249でマージ済み。#178の残範囲、#185のページング部品、#177の通知型拡張migration、#197のwebhookイベント型拡張等は各Issueで進める。#243のマージ待ちや共有root整理の再実装は不要。#180 UserDetailedNotMe、#182の関係UseCase、#188のDriveへの順序と機能単位の依存は維持する。

**セッション割り当て（5本の場合）。**

| セッション | 順序 |
| --- | --- |
| S1 連合 | #243・共有root #249はマージ済み → #176（基本比較済み・残初期機能待ち）→ #195 inbox中核（署名検証・#215段階4、未実装）。限定補完は#258–#263と#265がマージ済み。画像削除の限定補完も確認（[結果](../superpowers/compatibility/remote-user/actor-image-removal-results.md)）。remote profileのHTML→MFM/fields有限比較と添付選択失敗優先順位修正を確認（[結果](../superpowers/compatibility/remote-user/remote-profile-results.md)）。#176/#127/#195は未完了 |
| S2 API・ユーザー | #178の初期gate #245 → appender #246 → FollowRequest Entity #248はマージ済み。続く順序は#191 Page pack → #180 → #182の残り → #181 → #179。#178の残範囲は同Issueで追跡 |
| S3 イベント・通知 | #177 → #197 → #217 → #198 → #189 registry → #200 chart core → #189の残り（接続操作と別名、他の担当が追加しないchannel、全channelの比較） |
| S4 閲覧系 | #185 → LTL/GTL → TL系WebSocket channel（#189 registryの後）→ #186 → #187 |
| S5 Drive・保守 | #188 → #199（定期ジョブのsliceから先に）→ #130 |
| 独立トラック | #132 → #135 → #138 → #139の手順書の下書き |

3本に絞る場合は「S1 連合」「#178 → #185 → #177 → #182のFollowRequest Entity同期 → #191 Page pack → #180 → #182の残り → #217 → #189 registry → TL系WebSocket channel → #189の残り（接続操作と別名、他の担当が追加しないchannel、全channelの比較）」「#188 → #199 → #200」。空いたセッションは #193 /api/meta → #190 → #184 → #192（#189 registryの後）→ #191の残り → #196の独立route → #194 meta/ad/stats の順で拾う。#180のDetailedは#182のFollowRequest Entity同期と#191のPage packを待つため、どちらの案でも#180より先に出す。

**同時に走らせない組み合わせ。** PR #243との過去の同時マージ制限は解消済み。#176・#215・#195等は現在の変更ファイルと証跡単位で調整する。#178と#179・#181。#185と一覧API全般。#182と#195（Follow系rendererは#182が作る）。#189 registryとchannel追加。#136の本家固定SHA更新は全セッションを止めて単独で行う。

**共有ファイルの運用。**

1. 進捗は作業中にplansと`compatibility/<domain>/README.md`へ書き、本書には要約とリンクだけをマージ直前に足す。
2. 対応表（backend-inventory）は自分の行だけを編集する。衝突したらdevelop側を採って生成し直す。`implementationCommit`を進めた後の追従はmergeで行う（rebaseすると記録したSHAが孤立する）。
3. `backend-upstream`のEntity同期は、`upstream-sync.json`の`files`を和集合でマージし、同期スクリプトで生成し直す。共有Entityは最初に必要とする担当が同期し、他の領域はrebaseして使う。
4. 独自migrationは未マージの側が`Date.now()`で振り直す。同じテーブルを触るmigration同士は並列にしない。
5. lockfileはマージ直前に生成し直す。設定キーは領域ごとのネストしたオブジェクトとして足す。
6. 検証環境はセッションごとに専用のComposeプロジェクトとポート（`BACKEND_NEXT_TEST_DB_PORT` / `BACKEND_NEXT_TEST_REDIS_PORT`）を使う。

**未決事項。**

1. inboxのfailedジョブの扱い：#139の前に全activityのhandlerを必須とするか、契約を変えるか（期限切れを待つ、受理だけする等）。クリティカルパスの長さが大きく変わる。
2. 共有Entityを担当ごとに同期するか、1本のPRでまとめて同期するか。
3. **解決済み:** #251の段階3として承認し、#255 / PR #257で既存3 queueをmokuroku-js 0.2.0へ移行済み。未対応7 handler・system 9 schedulerは元の担当へ残る。
4. **確定済み（2026-11-09）:** #176はPR #243で残るmedia/emoji・instance・chart・cache等の初期機能を実装するまで未完了とする。担当の割り当てだけでは閉じない。これらは強化や承認済み差異ではなく、`Closes #176` / `Closes #127` は使わない。
5. #115・#122は残りを#181・#199/#200へ移してcloseするか。

## 再開時に確認すること

[GOALS](GOALS.md)、本書冒頭の現在地、対象Issue、PR/ブランチの実状態を確認する。S1の共有root整理・基本縦断・C2/C10比較・#258–#263の限定補完はマージ済みで、#176/#127/#195は残範囲があるためOPEN。#176に必要な機能単位と他担当待ちを区別し、過去のPR待ちを着手条件に戻さない。初期機能の完了条件・担当・正式なblocked-byは今回変更しない。

着手するPRでは「移植する本家機能/解く依存」「必要な比較」「追加保証の有無」を短く説明する。以下の履歴やsource観測の測定件数を、現在の全機能の完了証明には用いない。

## 実装・検証の履歴

各記録の「次」「未実装」「未完了」は、その記録時点の状態を示す。現在の作業選定・完了判定には冒頭の現在地と各Issueを使う。既存の比較資料・測定件数・出典は保持する。

<details>
<summary>2026-11-07頃の再開案内（履歴。現在の着手条件には用いない）</summary>

[GOALS](GOALS.md)、本書、対象Issue、PR/ブランチの実状態を確認する。最小契約と基本text作成の実装/検証は[実装計画](../superpowers/plans/2026-11-03-note-create-169.md)を参照する。PG通知の分離と残存PGジョブ/AP adapter削減の[作業記録](../superpowers/plans/2026-11-03-simplify-jobs-124.md)を確認する。#215の段階1（ホスト正規化・連合可否・Meta読み取りの統一）は実装済み。#170 のローカル部分は実装済み（PR #221。未登録リモートユーザー宛てのメンションは#195まで501、登録済みリモートユーザーも#195まで再同期しない）。#215 の段階2（鍵とシステムアカウント、PR #222）と #216 の最初の PR（send・getJson と private 宛ての遮断、PR #223）は、通常起動から呼ばれない状態で実装済み。#160 の最初の PR（AP の署名・署名付き送信・配送結果の分類と、`extractDbHost`・`isFederationAllowedUri`）は、呼び出し元のない状態で実装済み。インスタンス台帳・配送前のスキップ判定・状態の書き込みは配送を接続する PR へ回した（[引き継ぎ](ap-delivery-handoff.md)）。#162 の最初の PR（通常の BullMQ の Queue/Worker と、本家の投票終了ジョブの投入から PG の通知保存まで。Redis 接続は再接続しない）は実装済み（[投稿の最小契約](posting-contract.md#通常ジョブ162)）。#171 の最初の PR（ノート作成の Create/Announce の表現・宛先・deliver queue と Worker・インスタンス台帳。#215 の段階 3 を含み、relay を除く）は実装済み（[引き継ぎ](ap-delivery-handoff.md#171-の最初の-pr-で入れたもの)）。relay への配送と JSON-LD 署名は #171 の2番目のPR #227でマージ済み。続く #172 は下記の削除sliceを実装した。#170 の保存列だけで進められる #174 も並行して着手できる。#163–#165 は #162 の実 queue の情報（同じ節の表）から着手できる。PR #206のマージ待ちでも、新たな基盤強化の実装でもない。着手するPRでは「移植する本家機能/解く依存」「必要な比較」「追加保証の有無」を短く説明する。

</details>


#171 第2slice（PR #227、マージ済み）は、既存accepted relayの10分cache、作者鍵RsaSignature2017、個別Queue.addとpost-save drainを接続した。controllerの最終検証で単体1,652件、関連結合150件、process3件、固定本家probe2件が成功している。過去workerのlocalhost EPERMは最終未実行状態ではない。[実測](../superpowers/plans/2026-11-06-ap-relay-171.md)。登録・受信・actorは#195、チャートは#200、metadataは共通土台の段階5に残る。

#172（2026-11-07）の削除sliceは、notes/deleteの認可・scope/rate・現在moderator・物理削除・返信数減算・監査と、作者鍵によるDelete/Undo/fallback配送を実装した。固定C10とF8非public late followerを実processで比較し、DELETE失敗時の本家の減算/配送開始境界も固定本家サービスと実DB triggerで測定した。stream/通知/TL/検索/webhook/チャートを接続済みとは扱わない。[計画と検証](../superpowers/plans/2026-11-07-note-delete-172.md)。次は#173の通知条件/投稿・削除streamを、承認済みPG通知保存と既存投稿列へ接続する。#174/#175は必要な具体契約が揃った部分から並行でき、最終連携は#176で確認する。


2026-11-07: PR #228の削除実装はマージ済み。次の#173第1sliceで投稿通知の条件・PG直接保存、投稿/削除/通知のRedis publication、既存投票終了workerの通知発行を通常起動へ接続した。実Redis subscriberで観測し、WebSocketクライアント受信の完成とは区別する。[実装・検証記録](../superpowers/plans/2026-11-07-notification-stream-173.md)。この時点で未完了だった投稿の実受信は下記#173受信sliceで接続した。全WebSocket #189、通知API/既読/未読/push/移行 #177と広域fanout/cache #217、投稿全体の縦断#176は未完了。

2026-11-07: PR #229マージ後、#174の第1sliceでhome/local/user/list/channelのRedis timeline producer（files/replies派生・設定・休眠sampleを含む）を投稿後続へ接続した。削除時は本家と同じくcached IDをpurgeしない。[比較資料](../superpowers/compatibility/note/timeline/README.md)と[実装・検証](../superpowers/plans/2026-11-07-note-timeline-174.md)。#174は検索・antenna・hashtag・featured・role timeline等の後続を残し、閲覧API #185/#186、role関連 #181/#189、当時未接続のWebSocket休眠解除（下記#173で接続）、account API全体 #180、チャート #200・再構築 #132/#133の完成とは区別する。次は#174の残る通常更新または#175のwebhookへ進め、縦断比較は#176へ接続する。

2026-11-07: #175の投稿 webhook slice を本変更で実装。note/reply/renote/mention を既存post-saveから通常queue/workerへ接続し、固定本家の内部設定イベント、投入時snapshot、secret headerと通常retryを扱う。[比較と残範囲](../superpowers/compatibility/user-webhook/README.md)。固定本家に削除 webhook はない。管理API・他イベントは #197、最終縦断は #176 に残る。#174第1sliceは PR #230 としてマージ済み。

2026-11-07: #173の投稿WebSocket受信sliceは実装コミット `6f4a5444ca9f02634972e81b5ffe7368302f7335` でmain/homeTimeline・note購読を通常HTTPへ接続した。実HTTP作成→home/main通知、通常投票終了worker→pollEnded通知WS受信とPG保存、HTTP削除→noteUpdated/deletedを新実装の実processで検証し、#173に残っていた受信とstream側削除連携を満たす。[比較範囲と差異](../superpowers/compatibility/stream/README.md)。固定source64ケースの比較は本家full server実行との比較ではない。10秒facts、5分activity/休眠解除、heartbeatと開始済み処理の終了待機も検証した。他17channel・既読/WS書込等#189、通知API/未読/push/移行#177、広域cache#217と投稿全体の#176は未完了。次は#174の検索等の通常更新と残る削除連携を進め、#176へ接続する。#172/#174/#189全体は今回の完了に含めない。


2026-11-07: #174/#172の検索producer sliceを実装。Meili SDK 0.62.0でsource互換設定・settings・scope・documentを扱い、作成準備成功後のsnapshot登録とDB DELETE前の解除へ接続した。固定source256ケースと完全なpostNoteCreatedの8境界ケースを保存し、240のpolicy/document/解除条件を新実装へ直接照合。新実装の実HTTP handler/PG/Redis/Meili v1.3.4と実HTTP子の起動/停止/障害を別に検証する。[比較範囲・差異・再構築材料](../superpowers/compatibility/note/search/README.md)、[実装計画](../superpowers/plans/2026-11-07-note-search-174.md)。#174にはantenna/hashtag/featured等、#172には最終連携、#176には縦断完成が残る。検索API #186・再構築 #132/#133・未登録remote mention #195・queue管理/保持/引継ぎ #163–#165を完成扱いしない。


2026-11-07: #174の通常Role timeline producerを投稿イベントのpacked描画直後へ接続した。既存Role材料cache・公開selector・現在User事実を使い、assigned＋conditionalの取得順/重複を維持して、専用timeline Redisのmax1000投入とhost-topic packed publicationを開始する。visibility/channel/fanout/Role公開可否で除外しない。削除purgeはなく、既存post-saveが部分失敗を診断し開始済み処理を終了待機する。[比較・実依存検証・再構築材料](../superpowers/compatibility/note/role-timeline/README.md)、[計画](../superpowers/plans/2026-11-07-note-role-timeline-174.md)。本家の5分User cacheとの差異とnotesCount競合を記録し、順序保証を強化しない。#174のantenna/hashtag/featured等、Role閲覧API #181/#185・Role WS channel #189、最終削除連携#172/#176、再構築#132/#133は未完了。

2026-11-07: #174のRenote featured producerを実装コミット `399987210060b90db0aaac89ed16bfaa69b95768` で通常投稿へ接続した。他人Renote/quote・nonbotに対するsample `< 0.3`・対象ID時刻からstrict3日未満の+5を、元投稿のchannel/public/local/reply条件に従って通常Redisへ書く。global/channelは3日、per-userは7日windowとし、9日/21日のEXPIRE NXを維持する。DB countと各rankingを独立して開始し、既存post-saveの診断・終了待機へ接続した。[比較範囲・差異・再構築材料](../superpowers/compatibility/note/featured/README.md)、[計画と検証](../superpowers/plans/2026-11-07-note-featured-174.md)。固定本家の実メソッド50観測と新実装への直接JSON照合39件はsource比較であり、新実装の実HTTP handler/PG/通常Redis結合11件・通常HTTP子のRenote直後終了1件とは区別する。ranking取得/2-window平均・閲覧#185、reaction加点#184、gallery ranking、hashtag/antenna等#174、最終削除連携#172・投稿全体#176は未完了。削除時purge/減点は本家にもなく追加しない。sampling・処理時刻window・初回expiryを含む過去scoreは現存Note/renoteCountだけから正確に復元できず、再構築#132/#133へ制約を引き継ぐ。上の過去sliceでfeatured全体を残作業とした記述は当時の状態を示す。


2026-11-07: #174のnote hashtag producerを通常post-saveへ接続した。固定本家MiHashtagの機械同期と既存migration登録を行い、public/home snapshotからhistorical mentioned作者のlocal/remote原子集計、通常Redisの1時間unique SET・10分HLL・featured hashtag +1を実装。hidden/sensitiveはRedisだけを除外し、NX期限・独立clock・非原子的unique競合と削除時の残留を維持する。新しいMeta読取がDB進行を妨げない構成とし、開始済みRedisの診断・終了待機を既存post-saveへ接続した。[比較資料](../superpowers/compatibility/note/hashtag/README.md)、[実装計画と検証](../superpowers/plans/2026-11-07-note-hashtag-174.md)、[契約と再構築制約](posting-contract.md#通常投稿のhashtag-producer174)。profile attached/解除・hashtag API/packer/stream・chart読取、antennaと#174/#172/#176全体、再構築#132/#133は未完了。上の過去sliceでhashtag全体を残作業とした記述は当時の状態を示す。


2026-11-07: #174のantenna producerを通常post-saveへ接続。保存時作者・補正後channel・TypeORM insert後のraw Noteを保持し、lazy active一覧/internal変更受信、30分Redis/1分memoryのfollowing cache、現在list membershipと固定source順の照合を使う。全照合成功後だけ専用timeline Redisのmax200とraw antenna publicationを開始し、独立失敗の診断・終了待機へ接続した。通常HTTP子の照会中SIGTERMと、専用subscriberの接続/購読失敗後解放も検証する。[比較資料](../superpowers/compatibility/note/antenna/README.md)、[実装計画](../superpowers/plans/2026-11-07-note-antenna-174.md)。

同じ#174の全責任監査で見つかったchannel集計の開始境界とremote Instance.notesCountも接続した。channelはpack/mention準備成功後に3仕事を別SQLで開始し、remoteは既存instance台帳の登録後に初回期限5分の+1集約、削除時に直接-1。新しい永続状態・retry・cache書換は加えない。終了時はenqueuerを待ちqueued/既発火の更新をdrainする。[全通常更新の監査と#132/#133への材料](../superpowers/compatibility/note/derived-updates/README.md)が現在の#174完了判定の根拠であり、上記過去sliceの曖昧な「等」を残責任の根拠にしない。remote受信#195、antenna CRUD/閲覧#185・WS#189・import/clean#199、chart#200、広域cache#217と投稿全体#176は別に残る。

2026-11-07: #172 の削除連携を実プロセスで確認した。通常HTTP/workerとPG/Redis/Meili、WebSocket、fake inbox/webhookで、作成・show後の削除成功とDB拒否、第三者の削除拒否を観測した。DB拒否でも先行するdeleted stream・AP Delete・unindexは残り、成功時だけ物理削除・他人削除監査へ反映する。TL ID・既存PG通知・hashtag/ランキング履歴・投入済み作成webhookを削除で取り消さず、削除webhookを追加しない。

固定sourceとの比較で判明した純粋Renoteの元投稿照会を、認可用snapshotの準備から、deleted stream後の該当AP準備へ移した。照会拒否でも既発行streamが残り、localOnly/remote等では不要な照会を行わない。[固定sourceと実プロセスの比較範囲](../superpowers/compatibility/note/delete-integration/README.md)、[実装・検証記録](../superpowers/plans/2026-11-07-note-delete-integration-172.md)。source methodのdouble実行と本家full server比較は区別する。

#172の通知/stream/TL/検索/webhook削除連携は、実依存検証と承認済みの独立レビューにより完了条件を満たした。文書を含む全差分の独立レビューも承認済み（[PR #238](https://github.com/tiramiss-community/tiramiss/pull/238)）。#176については削除に絞った連携確認である。#176全体には、#124の必須子#163–#165（queue管理・通常保持・残payload引継ぎ）と、C群全体・停止再開・暫定501を含む未対応台帳の照合が残る。全通知#177、閲覧#185/#186、全WS#189、remote受信#195、chart#200、再構築#132/#133の完成とはしない。次は#176の先行依存として#163–#165の必要な通常queue契約を進める。


2026-11-08: #163の本家queue管理14 APIと公開QueueStatsを実装コミット`1f023061eb86a18a3113d29517cb7eded091edc6`で通常HTTPへ接続した。全10名の管理handleは既存3業務workerと分離する。固定97 source観測の95公開投影を直接照合し、残る2件はsource listener/QueueEvents寿命不足を再現しない差異として記録した。新実装は実HTTP/PG/Redis/WSで全route・現在Role/scope・実Worker制御・失敗時204と監査を、通常HTTP子で接続断/部分起動失敗/SIGTERM/期限超過を確認した。独立source/productレビューも承認済み。[比較範囲と実測](../superpowers/compatibility/queue-admin/README.md)、[実装計画](../superpowers/plans/2026-11-08-queue-admin-163.md)。

統計は単一HTTP observerがXevを置き換え、即時/10秒周期・最新200件のメモリ履歴を持つ。公開channelでもapp upgradeの`read:account`は維持する。sourceの非待機操作/監査とHTTP204を維持し、診断と終了待機を追加した。既存のRedis無再接続差異も維持する。#163の完了は通常保持/清掃#164、実payload互換/残仕事引継ぎ#165、他stream#189・他管理#194、#124全体の完了ではない。次は#164/#165を進め、#176に残るC群・停止再開・未対応台帳の照合へ接続する。上の過去sliceで#163を残作業とした記述は当時の状態を示す。


2026-11-08: #164の現在3業務queue（deliver/endedPollNotification/userWebhookDeliver）の通常保持と全10管理selectorの終端清掃を、コミット `2549ec263662c10cdd238448482f325c1693c035` の比較資料・テストで確認した。固定source24観測（8ファイル・32 producerメソッド）、新規直接比較28件、実Redis8件と全10名HTTP追加10件を分離して記録する。最終近傍単体4 files / 97 tests、結合2 files / 49 tests、build/typecheck、変更testのlint・SPDX・locale safetyは成功した。独立したsource/runtimeレビューは承認済みで、製品コードの変更は不要だった。[契約・実測・後続所有者](../superpowers/compatibility/queue-retention/README.md)、[計画](../superpowers/plans/2026-11-08-queue-retention-164.md)。

保持は各jobの7日・成功30/失敗100設定を同じ終端状態への遷移時に適用し、静かなqueueの厳密TTLや周期清掃ではない。固定本家の全10 Queue/Workerにfallbackはなく、将来のsystem定期jobはage-onlyと古いscheduler定義の整理をその実装時に移植する。残る7業務handler、保守#199/chart等#200、通知本体#177は各担当が所有する。#164の現行条件を満たした後の実payload/scheduler互換・残仕事引継ぎ#165は下記の検証へ進めた。切替は#139、親#124と投稿全体#176は未完了である。上の過去の進捗に残る#164未完了記述は当時の状態を示す。


2026-11-08: #165の停止専用`check-queue-handoff --stopped`を追加し、raw Redisの読取だけで全10名の残仕事・payload/options・active/lock・repeat/scheduler・不明記録を検査する。固定本家の17 fixture・全10名・9 scheduler template・11 source guardを採取した。通常CIは記録済みsource引数＋明示したテストbinding＋現在のBullMQ 6.3.11を使い、別確認は固定sourceをbinding適用後に実行して本家installedの同版BullMQで保存する。本家full serverの実行比較ではない。[source/実依存の証明範囲と再実行](../superpowers/compatibility/queue-handoff/README.md)、[計画](../superpowers/plans/2026-11-08-queue-handoff-165.md)。

近傍単体5 files / 135 tests（新checker38件）、通常CIと実sourceそれぞれの実Redis結合31件、通常CIのprocess4件が成功した。実sourceの通常built workerで3業務handler・全7 webhook envelopeを確認した1件と、旧BullMQ workerの60秒遅延retryを同ID・attempts1→2で継続した1件は、別々の成功した実行である。PG通知、署名付きAP HTTP、webhook snapshot/保存status、未対応7 queue/実system schedulerの拒否と検査前後の保持、CLIの有限終了/機密非出力を確認した。build/typecheck・変更ファイルquiet lintも成功した。processに既存のpg query deprecation warningがあり、成功結果と分けて記録する。

#165はPR #241でマージ済み。全形式の棚卸し・保持/旧側完了/拒否の判断・実検査とbackup/rollback手順・実旧状態の隔離検証の4条件を満たす限定範囲の成果である。最終切替の成功を示さない。現在3 handler以外の7 queueは未完了/failedがblockerで、systemの9 schedulerはwaiting=0でも#199/#200待ちとなる。systemのarchiveAnnouncementは#199、systemWebhookDeliverは#198、他の所有者と完全停止backup/復元は[現在の契約](posting-contract.md#停止下の既存queuepayload引継ぎ165)を参照する。7 webhookのtransport検証は新イベントproducer/管理API#197やreactionの完成ではない。#135/#138/#177を含む最終切替#139、親#124と投稿全体#176は未完了のまま残る。過去の進捗にある「次は#165」は当時の対応順を示す。

2026-11-08: 次の#176 bounded N7検証で、C1/C8全履歴、C2のread/Bearer観測、C4補正後のsource由来AP audience、実Supervisor停止再開とHTTP起点の自然AP/webhook retry、認可/保存失敗を既存テストへ接続した。[N7の台帳・実測・残責任](../superpowers/compatibility/note/n7/README.md)で全104 primary行とcross-domain責任を照合し、元inventoryを昇格させない。親の実測は統合214件、process別3実行で8＋5＋7件。runtime cleanupの独立再レビュー、証跡task review、全branch最終レビューは承認済み（Spec PASS / Quality APPROVE）。このN7 sliceは#242でマージ済み。

#242はマージ済みで#124はCLOSED。N7の全必須条件PASS・監査時OPEN・当時のclosure referencesは履歴として保存する。#176/#127は未完了で、その他7handler/system9scheduler・閲覧/通知/全WS/保守/切替は既存所有者に残る。

2026-11-08: #195の限定core runtime `33e67182e3dea5a39bd2b7c251ba9ee9ec4e0f45` で未登録remote mention取得、stale refreshと失敗出現の省略、最小actor/key公開から通常worker署名配送までを接続した。[source95ケースの実消費・実測・残責任](../superpowers/compatibility/remote-user/runtime-results.md)に、local URI parser修正後の近傍単体254/5 files、結合61/2 files、native process3/1 fileを別実行として記録する。旧e133a0fでのTask2 scoped reviewはSpec PASS / Quality APPROVE。77b6c405の全branchレビューで指摘されたlocal URI parserとEOF改行を修正した。修正後の独立再レビュー・CodeRabbit差分確認は未記録である。

media/emoji #188/#195、user hashtag関係 #195、actor由来instance usersCount/metadata #215、chart #200、featured/Move/full actor/inbox/remote Notes #195、cache/remoteUserUpdated #217とN7 C2/C10のqualified比較ギャップ #176が残る。旧501/stale blockerは履歴を保持して証明したcoreのみsupersedeする。`notes/create` partial / `postingComplete:false`と#195/#176/#127未完了を維持し、未移植機能を後続強化へ読み替えない。

2026-11-08: #178の最初のsliceで、API共通gate（トークン抽出・permission集合の認証・資格→凍結→ロール→scope・共有Ajv・共通エラー）を実装コミット `65f88fcd54b8b561779230ad8233e4cb0b262154` で導入し、Role 2・queue 14 APIを載せ替えた。認可要件はendpoint定義に置き、UseCaseは事実を読んだ位置で判定する（roles/updateはトランザクション内）。[比較資料と意図的差異](../superpowers/compatibility/api-common/README.md)・[計画と検証](../superpowers/plans/2026-11-08-api-gate-178.md)。note APIのgate移行（prohibitMoved・rate limit段階）、未知endpoint 404、allowGet、multipart（#188と同じPR）などが#178に残る。#179・#181はこのgateの上で着手できる。

2026-11-08: S2の#178の次として、moderation_logへの書き込みを共通appender（`platform/database/moderation-log.ts`の`appendModerationLog`、記録型は`modules/audit`）へ集約した。実装コミットは `e03c4fbf2920c8dbec5e798df702265af986d579`。queue・Role更新・note削除の3経路は、非待機かトランザクション内か・info・id時刻を変えずに書き込みだけを移した。以後の所有は#194で、新しい種別は記録する機能のsliceが追加する。[計画と検証](../superpowers/plans/2026-11-08-moderation-log-appender-194.md)。次は#182のFollowRequest Entity同期。

2026-11-08: S2のModerationLog appenderの次として、#182の最初の小PRで固定本家の`FollowRequest` Entityを`backend-upstream`へ同期した（実装コミット `b6832111a5817f30c33334d8091e7f80e79dbe33`）。読み込み・`user`への2関係と、実PGでのschema差分0を確認した。読み書きする業務はまだない。following/requests API・承認/拒否・AP・UserDetailedNotMeは#182・#180の後続sliceで扱う。[棚卸しの照合](../superpowers/compatibility/backend-inventory/README.md#182-followrequest-entity同期の照合2026-11-08)。次は#191のPage pack、その後#180。

2026-11-09: この変更で HTTP・既存 worker・CI の shared-root 構造抽出を実装した。[計画と検証状況](../superpowers/plans/2026-11-09-shared-roots-s1.md)。登録は静的かつ明示的で、追加 worker の自動発見や登録漏れの実行時検知は行わない。S1 の次は #176、続いて inbox の #195。N7 の closure の判断を解決するものではなく、queue の対応範囲も拡大しない。

2026-11-09: #176の限定比較で既存のC2 rate DB差分とC10 moderator応答・監査・削除streamの4観測を直接照合した。親の結合検証は86件/3ファイルPASS、残る初期機能は上記の確定条件に従う。[比較と検証計画](../superpowers/plans/2026-11-09-note-n7-176.md)。


## #251 stage 1 の限定着手（2026-11-09）

ユーザー承認により、更新UseCaseが増える前の区切りで共通transaction lifetimeとRole show/update compositionのみをstage 1として実装する。Task 2はRole factory抽出と既存HTTP入口からの委譲まで。実測・残る所有箇所は[運用inventory](application-foundation-inventory.md)を参照。統合後のbuild/typecheck・単体2,801件・DB28件・Role acceptance65件・停止時2件は通過。Note/Pollのstage 2とmokurokuのstage 3は別途承認・調整を要し、既存の対応順・blocked-byは変更しない。


## #253 stage 2 の限定実装（2026-11-09）

上の #251 stage 1 記録は当時の状態。承認済みの #253 では Note/Poll writer の共通 lifetime 接続と作成専用 `composition/note.ts` factory を実装し、通常 HTTP の作成 assembly を委譲した。投票なしの直接 insert、投票の両行 atomic write、remote 解決・応答描画・後続の transaction 外境界と開始順を維持する。[実装計画](../superpowers/plans/2026-11-09-backend-next-note-foundation-253.md)、[運用 inventory の実測と検証](application-foundation-inventory.md)。統合先で build/typecheck・単体2,811件・実 DB217件・process17件と後続待機1件・upstream sync は PASS。worker の sandbox EPERM は検証履歴として台帳に残す。作成用 constructor は3→factory1、Note 固有 runner2→1・lifetime owner1→0、対象3ファイルは179→200行。stage 3 #254/#255、通知/remote-user/system-account の残責任と `connect-resources.ts` の投稿系組み立ては残る。#251 全体完了や全 platform→composition 依存の解消を意味せず、既存対応順・blocked-by を変更しない。

## #255 stage 3 の実装と検証待ち（2026-11-10）

#251/#253の上記stage 1/2記録は履歴として保持する。#255では公開core/adapter `0.2.0` を固定し、既存3業務queueの投入・workerをmokurokuへ接続した。旧wrapper・静的registry・重複starterを撤去し、管理10名と実行3 handlerを分離する。[採用経路・実測・残る所有者](../superpowers/compatibility/queue-runtime/README.md)、[現在のinventory](application-foundation-inventory.md)。

親のbuild/typecheck、単体2,828件/86 files、queue結合185件/10 files（processと分けたserial再実行）、C2/C10の88件/3 filesはPASS。初回processは57成功・4失敗/8 filesで、新queue-runtimeの4ケースが失敗した。最終process gateはPASS。既存7 filesの43件と、fixture/test修正後の新規1 fileの18件を別実行で確認した。 CodeRabbitは提出33 filesをレビューし指摘0件、結果のローカルcache保存だけがEROFSだった（後続の文書/修正はこのレビュー範囲外）。

残る7 handler・system9 schedulerは既存の#182/#183/#188/#195/#198/#199/#200等が所有する。通知#177、他webhook#197、platform→composition依存、六つのactor gapと投稿partialを維持し、#251全体・#176/#127/#139の完了や正式な対応順/blocked-by変更とはしない。

2026-11-10: public remote mention からの actor 作成・canonical duplicate・refresh に user hashtag の attached 更新、独立 ranking、停止時 drain を接続した。[設計](../superpowers/specs/2026-11-10-remote-user-hashtags-design.md)と[追加実測](../superpowers/compatibility/remote-user/runtime-results.md#public-actor-user-hashtags-2026-11-10)に source 境界10件・既存 profile5件、単体310件、結合101件、process4件、全単体2,855件を記録する。歴史的 corpus/receipt は保持し、public caller の user-hashtag gap だけを満たす。他の五つの actor gap、`notes/create:partial` / `postingComplete:false`、#176/#127/#195 未完了と既存の対応順を維持する。

2026-11-10: #195の限定sliceでlocal actorのdescription・followedMessage・fields・birthday・locationを必須Profile読取と共通の純粋描画へ接続した。[独立source観測・実測と残責任](../superpowers/compatibility/remote-user/local-actor-profile-results.md)。rich actor全体を含む五つのactor gap、`notes/create:partial` / `postingComplete:false`、#176/#127/#195未完了と既存の担当順を維持する。

2026-11-10: public remote mentionのactor作成・canonical duplicate復帰後に、instance登録とusersCountの非待機加算を接続した。[限定契約・新規観測と検証](../superpowers/compatibility/remote-user/actor-instance-registration-results.md)。metadataを含む五つのactor gap、#176/#127/#195/#215未完了、`notes/create:partial` / `postingComplete:false`と既存の対応順を維持する。

2026-11-10: #215段階5/#216 getHtmlの限定sliceで、public actor作成/canonical復帰と配送成功へinstance metadata取得を接続した。[source境界・実測・残責任](../superpowers/compatibility/instance-metadata/README.md)。親の凍結検証は実依存144件/5files、process14件/3files、全単体2,939件/90filesが成功。両callerの独立開始・HTTPS実取得・停止時drainを含む。Meta同期snapshotとの時点差、他metadata取得経路と五つのgap、`notes/create:partial` / `postingComplete:false`、#176/#127/#195/#215未完了と既存順序を維持する。Node26のroot契約153件・inventory・shippingも成功。独立レビューは親の別gateで追跡する。

2026-11-11: #195の限定sliceで、public notes/createのremote mention作成・canonical復帰・stale refreshへactor絵文字の抽出・emoji表保存・User.emojisを接続した。[独立source55観測・実測・残責任](../superpowers/compatibility/remote-user/remote-emojis-results.md)。抽出失敗時の空配列と部分書込み、create/refreshで異なる実行位置、canonical既存名を維持し、応答後も残るtag処理は終了時に待機する。Drive画像、local actor絵文字公開、他caller・remote Note・cache鮮度等は未完了。#176/#127/#195未完了、notes/create partial・postingComplete:falseと正式な対応順を維持する。

2026-11-11: #195のlocal actor tag公開で、既存GET `/users/:id`と内部local解決へ絵文字・hashtagを接続した。[固定source12観測と実測](../superpowers/compatibility/remote-user/local-actor-tags-results.md)。入力順・重複・localOnly除外、各絵文字の時刻と鍵取得前の失敗境界を維持し、共有したNote描画・DB読取も検証した。単体3,021件・結合145件が成功。DB直読と本家cacheの鮮度差は#217に残る。これは#176のremote mention残機能の完了ではなく、#176/#127/#195未完了、notes/create partial・postingComplete:falseと正式な対応順を維持する。

2026-11-11: #195の限定sliceで、既存GET `/users/:id`と内部local解決へ保存済Driveのicon/image、identicon・system Meta fallbackを接続した（基準PR #266 `62cdeb54289bdcf46ad57e7f8a28db8a4c5f2ee7`、実装 `ac37daa75d55b24cc811a7c4082ffd0da924fc3c`）。[固定本家33件のsource-method doublesとR2実測](../superpowers/compatibility/remote-user/local-actor-images-results.md): build/typecheck、近傍単体317件、実HTTP/PG actor53件・remote-user108件が成功。全単体/processや本家full HTTP/PGを測定した意味ではない。Meta DB直読の鮮度・失敗差、既存内部remote-row guard差を保持する。画像バイト配信（identicon/files/proxy）、Drive取得・remote media・他rich actor等は未完了。#176/#127/#195はOPEN、`notes/create:partial` / `postingComplete:false`、正式な対応順と過去の画像削除証跡を維持する。

2026-11-11: #195の限定WebFinger公開（元実装 `770750d88b4d27820616d7f264b186017e52b9c9`、診断修正後 `e9d8ebd07bc3d8e51c0a36c08ebbc97137504be4`）を通常HTTPへ接続した。[固定source49と実測](../superpowers/compatibility/remote-user/local-webfinger-results.md): R2 build/typecheck、近傍単体231件、実HTTP/PG WebFinger46件。既存HTTP/actor55件は別のR1実行として保持する。検証はWebFingerとstable Metaに限定し、wildcard OPTIONS/他well-known、本家full server/PG、error body診断文字列、Meta通知/cache #217は未検証。#176/#127/#195 OPEN、notes/create:partial・postingComplete:false、正式な対応順と過去記録を維持する。


2026-11-11（診断形式の追加修正）: local WebFingerの既存Logger stdout JSON契約を `1716e0f14207ddfe5b51730e256347ebe7579c5e` で反映した。[R3の実測結果](../superpowers/compatibility/remote-user/local-webfinger-results.md#final-diagnostic-format-fix-r3-2026-11-11): build/typecheck、単体235件、通常listening HTTP/PG46件、変更のないsource49件がPASS。R2 current recordは完全なバイト複製をarchiveして保持し、current proofをR3へ更新する。既存HTTP/actor55は別R1の記録であり再測定していない。上記のR2履歴と正式な対応順、stable Meta/source-methodの検証範囲、#217および#176/#127/#195 OPEN・notes/create partial・postingComplete:falseを維持する。

2026-11-13: PR #268後の基準 `6601944296f367e66fde8ecf3a2458c946ae2a6c` で、#195のlocal actor保存済フィールド限定sliceを `efd6b94ea9911fc6b9aeaad0edeea04da3932da1` に実装。[scopeと実測](../superpowers/compatibility/remote-user/local-actor-fields-results.md): 親の877凍結入力でsync/build/typecheck、近傍単体283件、実HTTP/PG actor69件+remote-user108件、固定renderPerson source21件とshippingがPASS。sourceは明示doubleによるmethod観測で本家full server比較ではない。featured URL公開だけでcollection endpointはnot_implemented、movedTo/alias公開だけでMove実行はない。Drive取得/画像配信・他remote media、remote Notes/collections、inbox中核/署名/受信activity、cache鮮度/remoteUserUpdated #217と他instance/chart/rich actorの残責任を維持する。五つのgap、#176/#127/#195 OPEN、notes/create:partial・postingComplete:false、正式な対応順は変わらない。過去のslice結果・件数・hashは履歴として保持する。Task2 root/inventoryのhost gateと親のレビュー/PR完了はこの製品実測からは主張しない。

2026-11-13: #195のlocal公開sliceで保存済みpinのfeatured collectionとAP Note GETを通常HTTPへ接続した（base PR #269 `0b5ab105952292ea1ac63ea54cefc638cbf88012`、最新source `bcb828e878c5d14cb5be7b9ebf743fd452cca648`）。[独立source100と実測・残責任](../superpowers/compatibility/remote-user/local-featured-results.md): 親R3は1084凍結入力でsync/upstream5/build/typecheck、単体257・別composition6・実DB/listening HTTP203・migration/schema6・source100・shippingを通過、全test 0失敗/0skip。R1の実DB4失敗（Meta fixtureが本物のnone既定を継承）は履歴に残し、fixtureのみ修正したR2を別receiptに保持する。R2後の独立reviewでUnicode P2を発見し、修正のscoped reviewはspec PASS / quality APPROVE。sourceはliteral methods＋実Fastify inject/doublesであり本家full HTTP/PGではない。local public collectionはremote featured/Note取込・object lock・inbox・Move・pin mutationを実装しない。HTML frontend #196、generic global headers/Fastify診断は比較外。Meta/cacheとmention順差、五つのgap、#176/#127/#195/#215 OPEN、notes/create:partial・postingComplete:false、正式な共有root → #176 → inboxの順序を維持する。Task2 metadata host gate・最終レビュー/PRはこの製品receiptから主張しない。

2026-11-14 PR271外部レビュー追補: 内部最終承認後のGitHub指摘2件を修正し、実R4で3735/1319/65/source318がPASS。HTTP status/cacheはadapterのみ、R2履歴は静的fixtureでGit不要とする。旧R3b/R2/R1は履歴、今回のtargeted review・返信・新head CI成功は未主張。#176/#127/#195/#215 OPEN、posting partial、五つのgapと担当/正式順序を維持する。
