# 新バックエンドの全体計画

更新: 2026-11-03。判断基準は [GOALS](GOALS.md)。全体Issueは [#114](https://github.com/tiramiss-community/tiramiss/issues/114)。本書は工程と現在地、Issueは個別作業と依存、各PRは実装・検証結果を持つ。

## 今回の方針整理

既存コードを全廃せず、本家相当の業務機能を通す順序へ戻す。独自の障害保証を備えた基盤の完成を、投稿機能の先行条件にしない。基本設計の依存境界は引き継ぐが、後から詳細化した同時確定・復旧・容量の契約は初期必須か再評価する。

2026-11-03のGOALS改訂で、本家機能は原則すべて初期範囲に含め、例外は保留と明示した追加保証と承認済みの意図的差異だけとした（[網羅性監査](coverage-audit.md)のP4）。

目的は以前の基本設計にも存在した。詳細な保証と同じ長文に入り、部分実装の完了を次の前提へ積み上げたことで、通常worker未接続のままジョブadapter群が増えた。セッション継続やcompactだけを原因とは断定しない。セッションを替えても、古い必須条件をそのまま読むと同じ方向へ進むため、入口と計画を揃える。

## 現在地と既存成果

基準: develop `3ca82a4a5a2e575ab90daf3f5022669a4a5108ce`（PR #218マージ後）。本家の固定基準は `packages/backend-upstream/upstream-sync.json` を参照。

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

通常workerは本家の投票終了ジョブ（#162の最初のPR）と、ノート作成のAP配送ジョブ（#171の最初のPRと既存 accepted relay の第2slice）を実行する。他の実ジョブhandlerは未接続。#169 / PR #212はマージ済みで、基本text作成のHTTP・保存・応答・後続count更新と、独自BullMQ transport/Redis復旧の撤去を完了。[PR #213](https://github.com/tiramiss-community/tiramiss/pull/213)もマージ済み。PG通知を直接保存へ分離し、残るPGジョブ/AP protocol・専用テスト・起動Entity登録・未使用依存を撤去した。新migrationは未解決の仕事を拒否し、通知本体を保持して不要9表/課金列を廃止する。添付/返信等と配送（relayを除く）は接続済みだが、delete・通知等を通した完成品はまだない。マージ済みの独自migrationは履歴として保持するが、未使用adapterや不要テーブルを最終構成に残す方針ではない。

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
3. **残る本家機能を移植する。** #129/#178–#200/#215–#217の対応表を入口に、利用できる機能単位で進める。未評価・未移植・比較済みを区別し、基盤PR数を完成率に換算しない。
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

**削減の完了条件**: 本家相当の経路と必要な失敗処理が動き、不要な旧実装がruntime・起動・運用・テストの前提に残っていない。通常workerは投票終了ジョブとAP配送ジョブだけを実行する現状で、他の既存adapterを無条件に代替完了扱いしない。仕様・比較観測・Git履歴を保持することと、未使用の実行コードを残すことを区別する。

## Issueと依存の見直し

| Issue | 現時点の位置付け |
| --- | --- |
| #114 | 本書を入口とし、初期の機能同等性と後続強化を区別する |
| #124 / #127 | 最小契約、既存PG基盤の縮小/撤去、通常worker/投稿の縦断を追跡する。削減も初期の完了条件に含める |
| #159 / #161 / #166 | 強いclaim/配送順序、物理容量制御は後続強化として保留。前提の独自実行基盤は撤去済みで、旧コードをそのまま再利用できる状態ではない |
| #163 / #164 / #165 | 既存Issueを本家相当のqueue管理API/QueueStats、通常履歴保持/清掃、実queue/payload互換/残仕事引継ぎへ改訂し、初期作業として扱う。旧PG制御・課金・全版readerの保証は履歴へ分離する |
| #160 / #162 | 署名HTTPと通常worker接続は引き続き必要。PG実行プロトコル依存を外すため、最小契約に合わせて再分割/改訂する |
| #169 | PR #212マージ済み。基本text保存・応答・直後show・保存後countを実装。添付/返信等は#170へ残す |
| #177 / #138 / #139 | 通知保存先の判断と、既存データ/配布上必要な作業を反映する。承認済み差異や移行を黙って消さない |

個別の新しい依存は、利用する具体契約が決まった時点で設定する。#169の基本範囲の完了を投稿全体の完成とは扱わない。既存Issueを自動close/reopenせず、履歴と未完了範囲を維持する。

## 計画とIssueの対応・依存

2026-11-03に、全体計画配下のopen 57件と完了済みの子11件を照合した。その後の[網羅性監査](coverage-audit.md)で、既存の領域に収まらない横断的な責務に担当がないと分かったため、#215（連合の共通土台）・#216（外向きHTTPとSSRF対策）・#217（プロセス間イベントとキャッシュ同期）を追加した。本家設定・観測・既存データ形式の互換は #138 に寄せた。対応表（PR #201・#218、マージ済み）は入口の行と監査行の担当を示すだけで、対応表の存在や領域Issue数を機能完成率にしない。

| 計画の対象 | 個別作業・完了確認の所有者 |
| --- | --- |
| Role初期範囲 / 残るRole API | #115（#116–#121完了）/ #181 |
| 投稿の代表フロー | #125 → #127 → #170–#176（#167–#169完了）|
| 通常ジョブ・署名HTTP・worker | #122 → #124 → #160 / #162 |
| 本家queue管理・QueueStats / 履歴保持 / 実payload互換 | #163 / #164 / #165 |
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
- #170はローカルユーザーと登録済みリモートユーザーへのメンションまでを扱い、未登録のリモートユーザー宛ては暫定で501とし、登録済みリモートユーザーは `lastFetchedAt` が古くても再同期しない（同じく#195で除去する暫定制限）。WebFinger・Person取得による解決は #195 が最初に切り出し、その実装PRで501を除去する。#195の解決には #215の鍵・#216の送信・#160のGET署名が要る。signedGet本体（HTMLのalternate・content-typeの検証・`assertActivityMatchesUrl`）は最初の利用者の#195が持つ。
- #217は、書き込み系の機能（#180/#182/#194など）がキャッシュを持つ前に、使う範囲の契約を確定する。
- #124の初期必須子は #160/#162–#165。保留 #159/#161/#166は同領域の履歴として所属するが、初期完成の前提には数えない。

方針を変更したときは、GOALS/ROADMAPだけでなく、影響するIssueの有効な本文・完了条件・blocked-byと親の対応順を一緒に更新する。PRの実装/検証結果は実際のマージ状態を確認して反映する。

## 再開時に確認すること

[GOALS](GOALS.md)、本書、対象Issue、PR/ブランチの実状態を確認する。最小契約と基本text作成の実装/検証は[実装計画](../superpowers/plans/2026-11-03-note-create-169.md)を参照する。PG通知の分離と残存PGジョブ/AP adapter削減の[作業記録](../superpowers/plans/2026-11-03-simplify-jobs-124.md)を確認する。#215の段階1（ホスト正規化・連合可否・Meta読み取りの統一）は実装済み。#170 のローカル部分は実装済み（PR #221。未登録リモートユーザー宛てのメンションは#195まで501、登録済みリモートユーザーも#195まで再同期しない）。#215 の段階2（鍵とシステムアカウント、PR #222）と #216 の最初の PR（send・getJson と private 宛ての遮断、PR #223）は、通常起動から呼ばれない状態で実装済み。#160 の最初の PR（AP の署名・署名付き送信・配送結果の分類と、`extractDbHost`・`isFederationAllowedUri`）は、呼び出し元のない状態で実装済み。インスタンス台帳・配送前のスキップ判定・状態の書き込みは配送を接続する PR へ回した（[引き継ぎ](ap-delivery-handoff.md)）。#162 の最初の PR（通常の BullMQ の Queue/Worker と、本家の投票終了ジョブの投入から PG の通知保存まで。Redis 接続は再接続しない）は実装済み（[投稿の最小契約](posting-contract.md#通常ジョブ162)）。#171 の最初の PR（ノート作成の Create/Announce の表現・宛先・deliver queue と Worker・インスタンス台帳。#215 の段階 3 を含み、relay を除く）は実装済み（[引き継ぎ](ap-delivery-handoff.md#171-の最初の-pr-で入れたもの)）。relay への配送と JSON-LD 署名は #171 の2番目のPR #227でマージ済み。続く #172 は下記の削除sliceを実装した。#170 の保存列だけで進められる #174 も並行して着手できる。#163–#165 は #162 の実 queue の情報（同じ節の表）から着手できる。PR #206のマージ待ちでも、新たな基盤強化の実装でもない。着手するPRでは「移植する本家機能/解く依存」「必要な比較」「追加保証の有無」を短く説明する。


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
