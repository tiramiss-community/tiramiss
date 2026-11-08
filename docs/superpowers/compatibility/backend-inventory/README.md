# バックエンドの公開契約と移植対応表

[#129](https://github.com/tiramiss-community/tiramiss/issues/129) の棚卸し。全体の入口は [#114](https://github.com/tiramiss-community/tiramiss/issues/114)、未移植領域の取りまとめは [#128](https://github.com/tiramiss-community/tiramiss/issues/128)。

この表は固定版の入口を漏れなく担当へ割り当てるための資料。個々の入力・出力・エラー・永続化・副作用を本家と実行比較した結果の代用ではない。詳細仕様と比較 fixture は各担当 Issue で追加する。

## 監査基準

- 本家: `8e07cf085adf7009583d234a208e30436f020e26`。`backend-upstream/upstream-sync.json` と同じ SHA。fork の現在の `packages/backend` からは列挙しない。
- 新実装: `6f62cb897d2a03e8fd7727eadf45c20d8bfcf206`（PR #213 マージ後）。判定と根拠はこの地点に固定する。
  - 行の `implementation`/`verification` は `domains.json` の `implementationCommit` の木で存在を検査する。#216 の最初の PR で外向き HTTP の行の根拠を参照できるよう `224416b352fa474a37fb286cd4838d8818947fc8` へ、#215 段階 2 の PR で連合の共通土台の行の根拠も参照できるよう、両方を含む `36cad9edcbfd2b990d36b2f6645b677b1e54f0e4` へ、#160 の最初の PR で AP の署名・配送結果の分類の行の根拠も参照できるよう `02612df99fe3c529fc692d76b3bd37498a2e0e1a` へ、#162 の最初の PR で投票終了ジョブと通常 worker の行の根拠も参照できるよう `00c6b5b75ddcf4bb9e5e79291e2f54a9dd4933e4` へ、同じ PR で queue 接続のコメントを直した `ae30e864a06baf64a793d10ab6fb844ee3821502` へ、#171 の最初の PR でノート作成の AP 配送の行の根拠も参照できるよう `d9b718359e583fd9e33711c8321fc06b83c06b53` へ、同じ PR で MFM の `br` の行・起動中の投入口の接続の喪失を直した `47c9c75dd6b5fc9527c3976b86364b06c46f3a04` へ進めた。#172の削除sliceで追加した実装・検証の根拠を参照できるよう `ba51607ba514de5fe2e4a1bf574575d5f0d42fa9` へ進めた。#173第1sliceの通知・stream producerと4 Entityの根拠を参照できるよう `40239a1244b1a088e4fe836e0c57360d0065c912` へ進めた。#174第1sliceのTL producer・設定・休眠判定・ChannelFollowingの根拠を参照できるよう `6a7e2e3e46c7ad49fed7e87f23a7b781c145532c` へ進めた。#173の投稿WebSocket受信sliceの根拠を参照できるよう `6f4a5444ca9f02634972e81b5ffe7368302f7335` へ進めた。#174/#172の検索producerの根拠を参照できるよう `2ed681dcf3ba502865dd325baec2545568333018` へ進めた。#174のRole producerの根拠を参照できるよう `381eb4ff11106d62139f912cd237634385bde256` へ進めた。#174のRenote featured producerの根拠を参照できるよう `399987210060b90db0aaac89ed16bfaa69b95768` へ進めた。#174のnote hashtag producerの根拠を参照できるよう `3a35fec002a26bb681a5c3b44315b247d20f8e24` へ進めた。#174のantenna・channel集計境界修正・remote Instance.notesCountと通常更新全体の監査の根拠を参照できるよう `4d777eda753920a9638ec2ad5df93a3c0ced06c7` へ進めた。監査の判定（`audit`）はこれらの更新で変えていない。
- 対象: 登録 API と非 API HTTP、WebSocket、AP 受信/公開/送信、業務保存・副作用、job/周期処理、CLI/運用。fork 固有機能は対象外。固定本家の機能を一括で見送らない。

## 現在の到達点

Role 初期対象の `admin/roles/show` と `admin/roles/update` は、新実装・本家比較資料・HTTP/受け入れテストに接続済み。これを `verified`（検証根拠あり）とする。他の Role API は未実装。根拠は [Role 比較資料](../role/README.md)、[#115](https://github.com/tiramiss-community/tiramiss/issues/115) と #116–#121。

`notes/show` は固定本家の観測 JSON と照合済みで `verified`。`notes/create` は #170 のローカル部分（添付・投票・返信/Renote・channel・指定宛先・MFM 抽出）まで実装した `partial` で、未登録リモートユーザー宛てのメンションは #195 まで保存前に 501 で拒否する。PG 通知保存と起動・migration の基盤は `partial`。旧 PG ジョブ基盤と AP 宛先 snapshot/page/host lease は PR #212/#213 で撤去したため、当時のAP送信とジョブ管理は `not_implemented` に戻した。現在の管理14 API/QueueStatsは下記#163で検証済み。**通常 worker は本家の投票終了（`endedPollNotification`、#162）・AP配送（`deliver`、#171）・投稿webhook（`userWebhookDeliver`、#175）の3ジョブを実行する。** 投票終了ジョブの投入・queue と Worker の設定・受信者の選定と PG への保存は本家 probe と比較して `partial` にした（[比較資料](../poll-ended/README.md)）。 #160 の最初の PR で、AP の署名・署名付き送信・配送結果の分類を本家と比較して `partial` にした。#171 の最初の PR で、ノート作成の Create/Announce の表現・宛先の選定・deliver queue と Worker・配送前の判定・インスタンス台帳を通常起動へ接続し、本家 probe と note の C9（relay を除く）と比較して `partial` にした（[比較資料](../ap-deliver/README.md)）。relayとJSON-LD署名は#171の2番目のPR #227で接続済み。Delete/Undoは#172の下記sliceで接続した。 部分実装から公開機能全体の完成を推測しない。

#174の通常更新はhome/local/user/list/channel・休眠判定、検索登録/解除、Role TL、Renote featured、note hashtag、antenna、channel集計、remote Instance.notesCountまで接続した。固定source全責任監査と再構築材料の引継ぎを完了し、下記の最終sliceで`Closes #174`の根拠を記録する。`capability:timeline`は閲覧APIとRole/antenna WS受信が残るため`partial`を維持する。

main/homeTimelineとnote購読は下記の#173受信sliceで`partial`とした。queueStatsは#163で`verified`、channel/chはそのrequestLogのみ`partial`。他16channel・readNotification・他channel書込は未実装。その他の入口も個別行のstatusに従う。これは見送りではなく、担当 Issue による設計・実装・比較が必要な状態。棚卸しの整合性検査自体はHTTP/連合機能の比較テストではない。`verified`の根拠は各行に記録した個別の比較・実依存検証に従う。

## #194 ModerationLog共通appenderの照合（2026-11-08）

`implementationCommit`を`e03c4fbf2920c8dbec5e798df702265af986d579`へ進めた。`service:ModerationLogService`と`responsibility:instance-moderation:15`（info省略時の空オブジェクト）を`partial`とした。Role・note削除の実装時に記録していなかった`deleteNote`・`updateRole`の種別行には、既存の結合テストを根拠に付けて`partial`とした。queueの種別4行は`verified`のまま、根拠に共通appenderを加えた。全行の監査A/B・担当domain・本家source/lineは維持する。

根拠は新しい結合テスト（実PGで空info・jsonb直列化・呼び出し元トランザクションへの参加・失敗の伝播）と、3経路の既存テストである。本家の残る49種と`admin/show-moderation-logs`・`ModerationLogEntityService`は`not_implemented`のまま、各機能のsliceで追加する。[計画と検証](../../plans/2026-11-08-moderation-log-appender-194.md)。

## #178 API共通gate最初のsliceの照合（2026-11-08）

`implementationCommit`を`65f88fcd54b8b561779230ad8233e4cb0b262154`へ進め、`capability:api-common`と監査16行（トークン抽出・認証種別・lastUsedAt・認証失敗応答・共通gate・rate limit・Ajv・応答規則・route共通設定・関連service・CORS mount）を`partial`とした。全行の監査A/B・担当domain・本家source/lineは維持する。Role 2・queue 14 APIはgateへ移ったが、既存の`verified`根拠は変えない。

根拠は新実装の単体（判定順・route guard・段階別500・本家meta 16件との照合）と、既存の固定比較（queue 67観測、Role 28ケース、note結合）である。本家full serverとの同時比較ではない。note APIのgate移行・未知endpoint 404・allowGet・multipart（#188）・secure・requiredRolePolicy・匿名IP limit・user_ip・OpenAPIは`not_implemented`または`partial`のまま残す。[比較資料と意図的差異G1〜G8](../api-common/README.md)。

## #163 管理APIとQueueStatsの照合（2026-11-08）

`implementationCommit`を`1f023061eb86a18a3113d29517cb7eded091edc6`へ進め、管理14 API・queueStats channel/capability・個別管理操作・packer/INFO/統計timer/service・4つのqueue監査書込を`verified`とした。全10 queue名と広いqueue能力は`partial`、channel/chもqueueStatsのrequestLogだけの`partial`とする。監査時判定`audit.A/B`と領域の担当は変更しない。serverStatsと広域Xev連携は未実装で、共有stream責務は`partial`に留める。

固定97観測の95公開投影を直接照合し、sourceの寿命不足2件は差異として残す。新実装の全2499単体・関連45結合・10 processとbuild/typecheckが成功し、全14 API/10名・現在Role/scope・実Worker制御・公開WS/upgrade認可・非待機失敗/監査・接続断/部分起動/停止待機を検証した。source/productの独立仕様・品質レビューも承認済み。[再実行・証拠と制約](../queue-admin/README.md)。本家full server比較や全10業務workerの証明にはしない。通常保持/清掃#164は下記で検証した。残payload引継ぎ#165の現在の検証範囲は下記を参照する。他WS#189・他管理#194、親#124と投稿全体#176は未完了。

## #164 通常保持・全10管理対象の終端清掃（2026-11-08）

`implementationCommit`を根拠テスト・source資料のコミット `2549ec263662c10cdd238448482f325c1693c035` へ進めた。全2,119契約と1,432監査行のID・担当・source・status・監査時A/Bは維持する。queue領域と`capability:queue`、現在3業務queue名、`queue-producer:deliverMany`、`responsibility:queue-daemons-charts:01`に保持の根拠を追加した。既存14管理API・管理操作・全10 queue名の#164未完了表記も現在の検証範囲へ更新し、既存の管理結合テストから全10名の追加10件を参照する。source probeだけを根拠に未移植producer/processor/schedulerを昇格させていない。

固定sourceは24観測・8ファイル・32 QueueService producerメソッドの明示double実行。新実装との直接比較は追加28件、近傍を含む4 files / 97 testsが成功した。実Redis/BullMQの3 producer/Worker保持8件と全10名の管理HTTP終端清掃追加10件は2 files / 49 testsで成功し、製品コードの変更はなかった。source実行と、handler結果を制御した実adapter検証を区別し、本家full serverや全10業務handlerの実行とは扱わない。[再実行・境界・後続所有者](../queue-retention/README.md)。

保持は7日・成功30/失敗100をjobに指定するlazy清掃で、同じqueue・同じ終端状態への次の遷移時に働く。Queue/Worker fallbackや周期履歴清掃を追加していない。現在3業務queue以外の7業務handler、system定期/保守#199/#200、通知本体#177は各担当へ残る。既存payload/schedulerの引継ぎ#165は下記で検証し、切替は#139であり、`capability:queue`と各queue名は`partial`を維持する。親#124と投稿全体#176の完了には換算しない。

## #165 停止専用検査と実payload引継ぎ（2026-11-08）

`implementationCommit`を製品コミット `7b6be9556a10ef786a7f6afc2665e0221c127036` へ進めた。全10 queueの固定source台帳と停止専用raw Redis checkerを追加し、現在3業務handlerで元jobを引き継いだ。固定sourceは17 fixture・全10名・9 scheduler template・11 source guard。通常CIは記録済みsource引数＋明示テストbinding＋現在のBullMQ 6.3.11を使い、別確認は固定sourceをbinding適用後に実行し、本家installedの同版BullMQを使う。[再実行・実測・証明範囲](../queue-handoff/README.md)。本家full serverの比較ではない。

近傍単体5 files / 135 tests（新checker38件）、通常CI/実sourceそれぞれの実Redis結合31件、通常CIのprocess全4件が成功した。実source modeの3業務handler/7 webhook送信1件と、旧BullMQが残した60秒遅延retryの同ID継続1件は別々のtargeted成功であり、実sourceの全4件一括成功とはしない。build/typecheck・変更runtime/testのquiet lintは成功し、processの既存pg query deprecation warningを記録した。

既存の管理・保持の根拠を残し、現在の#165未完了表記と実装/検証参照だけを更新する。全2,119契約・1,432監査行の順序/ID・担当・status・監査A/Bは維持し、`capability:queue`と各queue名は`partial`のままとする。未対応7 handlerの未完了/failedやsystemの9 schedulerは実際の切替blockerであり、clearやscheduler削除で代用しない。7 webhookのtransport確認は他イベントproducer/API #197やreactionの完成ではない。#165の4条件に対応する完了候補と、完全停止切替#139・通知移行#177・親#124/投稿全体#176の完成を区別する。[所有者とbackup/rollback](../../../backend-next/posting-contract.md#停止下の既存queuepayload引継ぎ165)。

## #172 sliceと固定監査表の照合（2026-11-07）

生成表の `implementationCommit` を削除sliceの実装コミット `ba51607ba514de5fe2e4a1bf574575d5f0d42fa9` へ進め、下記8行を `partial` として同期した。validatorはこの固定Git treeで実装・検証ファイルの存在を検査する。削除stream等の未接続を含むため、領域全体の完成とは扱わない。

| 契約ID/対象 | 現在の実装と比較 | 残る範囲 |
| --- | --- | --- |
| `api:notes/delete` | `http/note-delete-api.ts` と `modules/note/delete-note.ts`。実トークンHTTP・C10認可/監査/DB・production rateを `test/integration/note-delete.test.ts` で検証 | 削除stream/通知、TL/検索、webhook、チャート |
| `ap-render:renderDelete` / `ap-render:renderUndo` | `modules/federation/note-deletion.ts`。C10 Delete/Undo/fallbackとF8を `test/processes/note-delete.test.ts` で原文署名・Digestも比較 | AP受信/actor公開は#195 |
| `ap-send-site:NoteDeleteService.deliverToConcerned -> deliverToFollowers` / `-> deliverToUsers` | followersとconcerned directを独立投入。remote返信/Renote作者の実DB照会とqueue jobsも比較 | 強い取消/順序/固定宛先台帳は保留#161 |
| `responsibility:notes-core:30` | Delete/Undo表現と配送先決定を接続。relayは作者鍵LD署名付きで別投入 | 残る縦断連携は#176 |
| `service:NoteDeleteService` / `responsibility:notes-core:29` | 認可/物理削除/返信数/監査/配送の部分実装。DELETE失敗境界を固定本家probeで比較 | stream#173、TL/検索#174、webhook#175、チャート#200 |

実装ファイルは `packages/backend-next/src/`、試験は `packages/backend-next/` からの相対パス。[計画と実測](../../plans/2026-11-07-note-delete-172.md)、[削除比較資料](../note/README.md#172-削除sliceの追加検証2026-11-07)を参照する。

## #173 producer sliceの照合（2026-11-07）

投稿6種の通知条件・PG直接保存・保存後のpackとRedis発行、投稿/削除stream、通常投票終了workerの発行を接続した。20監査行と通知能力・processor・削除APIの3 overrideへ実装/検証の参照を同期し、すべて`partial`を維持する。4 Entityは通知factsの読み取りに使う範囲であり、各領域の変更APIを完成済みとは扱わない。

実HTTP/PG/Redis subscriber、通常worker、C10固定値とsource由来の条件を検証した。[計画と実測](../../plans/2026-11-07-notification-stream-173.md)。当時未完了だった投稿のWebSocket受信は下記sliceで接続した。通知API/未読/既読/push/移行#177、他WS機能#189、全体縦断#176、他のプロセス間イベント/cache同期#217は未完了。上の#172時点で未接続だった削除streamも、このsliceで発行まで接続している。

## #174 TL producer sliceの照合（2026-11-07）

実装コミット `6a7e2e3e46c7ad49fed7e87f23a7b781c145532c` を根拠に、12監査行と `capability:timeline` を `partial` とした。既存監査のA/B判定・所有者は維持している。

- `responsibility:notes-core:14/15/16`、`service:FanoutTimelineService`: home/local/user/list/channel（files/replies派生）の宛先・LPUSH/trim・古いID制約・休眠判定。読み出し/sort/fallbackは#185。
- `config:redisForTimelines` / `perChannelMaxNoteCacheCount`、fanout有効化と4件の保持数Meta設定: 現在の設定を通常投稿と接続の寿命へ反映。全設定用途の完成ではない。
- `entity:channel_following`: 固定本家の機械同期と投稿時の購読者照会。follow/unfollow APIは#187。

根拠は `src/composition/posting-timelines.ts`、`src/platform/database/note-timelines.ts`、`src/platform/timeline-cache.ts` と対応unit/実HTTP・PG・Redis/process試験。固定本家メソッドを抽出した1,280ケースの比較はRepository/Redisをdoubleにしたソース実行比較で、本家全体の実HTTP測定とは区別する。[検証記録](../../plans/2026-11-07-note-timeline-174.md) / [比較資料](../note/timeline/README.md)。検索・antenna・hashtag・featured・Role TL等は#174の後続、閲覧は#185/#186、活動時刻更新・休眠解除は下記#173受信sliceでWebSocket接続へ接続した。account API全体#180と他WS機能#189は未完了。

## #173 投稿WebSocket受信sliceの照合（2026-11-07）

実装コミット `6f4a5444ca9f02634972e81b5ffe7368302f7335` で、main/homeTimeline、connect/disconnect、subNote/s/sr/unsubNote/unを通常HTTPへ接続した。認証/read:account/凍結、受信者別filter・snapshotのhide・myReaction、関係factsの初回/10秒更新、接続時/5分の活動更新と休眠解除、heartbeatと終了時drainを含む。生成入口の新規10行・既存4行と監査55行に今回の証拠を反映し、対象行はすべて`partial`とする。ChannelMutingは固定本家の機械同期と受信facts照会のみで、変更APIや清掃/cache同期の完成ではない。

[比較資料](../stream/README.md)の固定source64ケースと、新実装の実HTTP/PG/Redis/WS・通常HTTP/worker processで比較した。本家全サーバーの実行比較ではない。実processはHTTP作成→home note/main mention・notification→通常投票終了workerのpollEnded通知とPG保存→HTTP削除→購読noteUpdated/deleted、再接続・接続中SIGTERMを確認する。周期処理とpending認証/renderの終了順は実Redis/WSと明示clockの試験で確認する。

これにより#173が残していた投稿・削除・通知のクライアント実受信とstream側削除連携を満たす。#173の完了を#176全体の完了に換算しない。他17channel・readNotification・channel/ch書込等の#189、通知API/既読/未読/push/移行#177、検索等#174と残る削除連携#172、広域cache同期#217、投稿全体の縦断#176は未完了。常時clone・JSON null frame無視・本文hideの現在following照会の差異も比較資料に記録した。

## #174/#172 検索producer sliceの照合（2026-11-07）

実装コミット `2ed681dcf3ba502865dd325baec2545568333018` を基準に、`capability:search`、`config:fulltextSearch` / `config:meilisearch`、`responsibility:notes-core:44`、`service:SearchService`を`partial`へ進めた。既存の`responsibility:notes-core:27/29`、`service:NoteDeleteService`、`api:notes/create/delete`は`partial`を維持し、検索の根拠を追加した。監査A/B・担当・本家sourceと既存根拠は維持する。provider選択だけではquery/view制御を実装したことにならないため、`responsibility:notes-core:43`は`not_implemented`のまま。

[比較資料](../note/search/README.md)の固定source256ケースと完全な元メソッドの追加8ケースはcollaborator doubleによる実行であり、本家全HTTP/DB/engine測定ではない。新unitはそのうち240行を直接照合する。対象を限定したsettings/登録/解除producerは実装済みだが、新旧264ケースすべてを直接差分照合したという意味にはせず、索引ルール行も保守的に`partial`とした。実engineの適用はHono `app.request`と専用PG/Redis/Meilisearch v1.3.4/SDK0.62.0による結合試験で確認し、実HTTP子の起動・停止はSDKとloopback gatewayによるprocess試験で確認した。両者を同一の子→実engine試験とは扱わない。productionはtask受付だけを待ち、task適用待ちは試験内のみ。

settings、ID由来の8-field document、scope/visibility/content条件、作成準備成功境界とsnapshot、quiet/content/scopeで省かないDB DELETE前解除、DB失敗/SDK拒否、設定と終了待機を検証した。全unit最終60 files/2093 tests、関連integration2 files/16 tests（検索8件）、process1 file/5 tests、既存fixture8件はPASS。独立product/runtimeレビューはAPPROVE。[実装・検証記録](../../plans/2026-11-07-note-search-174.md)。検索API#186、再構築#132/#133、antenna/hashtag/featured/Role TL等#174、削除最終連携#172、投稿全体#176は未完了であり、このsliceでcloseしない。上の過去sliceにある検索未接続の記述は当時の状態を示す。

## #174 Role producer sliceの照合（2026-11-07）

実装コミット `381eb4ff11106d62139f912cd237634385bde256` を固定根拠に、`responsibility:instance-moderation:14`、`stream-event:RoleTimelineEvent.note`、`service:RoleService` を `partial` とした。`responsibility:notes-core:22`、`service:FanoutTimelineService`、`api:notes/create`、`capability:timeline` は `partial` を維持して既存根拠へ追加した。全行の監査A/B・担当domain・本家source/lineと既存実装/検証参照は保持する。

pack成功後の既存Role材料と現在User factsによる適用Role選択、Redisリスト追加、packed publicationだけを接続した。maxlen1000は最近IDの10%trim時に適用し、古い直接更新はtrimしない。常時hard capではない。固定source229ケースの再生とJSON一致を確認し、新実装との直接fixture照合は所属16件。新実装はfocused unit48件、近傍112件、全unit2119件、実HTTP handler/PG/専用Redis11件、通常HTTP子の投稿直後SIGTERMとcache/publication/終了1件を検証した。[比較範囲と差異](../note/role-timeline/README.md) / [実装・検証記録](../../plans/2026-11-07-note-role-timeline-174.md)。

`roles/notes`、`roleTimeline` WS channel、イベントごとの公開Role確認は `not_implemented` のまま。Role管理/割当API #181、閲覧 #185、Role WS #189、antenna/hashtag/featured等 #174、再構築 #132/#133、最終削除連携 #172・投稿全体 #176を完了扱いしない。上の過去sliceでRole TL全体を残作業とした記録は当時の状態を示し、本sliceで接続したproducerと未接続のconsumerを区別する。

## #174 Renote featured producer sliceの照合（2026-11-07）

実装コミット `399987210060b90db0aaac89ed16bfaa69b95768` を固定根拠に、`responsibility:notes-core:13`、`responsibility:notes-core:40`、`service:FeaturedService` を `partial` とした。`api:notes/create` と `capability:timeline` は `partial` を維持して既存根拠へ追加し、`responsibility:notes-core:44` と `service:SearchService` は古い残範囲説明だけを更新した。対象は7行で、全行の監査A/B・担当domain・本家source/line/referencesと既存根拠配列の順序を保持する。

他人Renote/quote・nonbotの元投稿について、sample `< 0.3` とID由来の時刻からstrict3日未満の条件で+5を開始する。channel付き非replyはchannel、channelなしのpublic/local/非replyはglobalとper-userへ加点する。通常Redisの独立MULTIへ書き、3日/7日windowと9日/21日のEXPIRE NXを使う。DB count拒否や一方のranking失敗を他方の開始条件にせず、開始済み処理は既存診断・終了待機へ接続する。

固定sourceメソッド50観測の再生成一致、新実装との直接JSON比較39件を確認した。本家全サーバーの実HTTP/実Redis比較とは区別し、ID日時変換はsource/unitのdouble、実codecは新実装の結合/processで検証する。新実装の単体62ファイル2,174件、featured実HTTP handler/PG/通常Redis結合11件、近傍投稿結合163件、通常HTTP子のRenote直後SIGTERMとscore成立/終了1件、依存順build/typecheckは成功。[比較範囲と差異](../note/featured/README.md) / [計画と検証記録](../../plans/2026-11-07-note-featured-174.md)。

ranking取得/2-window平均・featured閲覧#185、reactionによる加点#184、gallery ranking、hashtag/antenna等#174、Role WS#189、再構築#132/#133、最終削除連携#172・投稿全体#176は未完了。削除時purge/減点は本家にもなく追加しない。過去sliceでRole TL/featured全体を残作業とした記録は当時の状態を示し、本sliceの書込producerと残るconsumer/他producerを区別する。

## #174 note hashtag producer sliceの照合（2026-11-07）

実装コミット `3a35fec002a26bb681a5c3b44315b247d20f8e24` を固定根拠に、`entity:hashtag`、`responsibility:notes-core:41/42`、`service:HashtagService`を`partial`とした。Entityの内容は固定本家と同一だが、接続済みの利用者はnote producerであり、profile attached更新/解除・API/packerを完成扱いしない。`responsibility:notes-core:40`と`service:FeaturedService`にはhashtag加点の根拠を追加し`partial`を維持する。`api:notes/create`と`capability:search`は既存根拠へ追加、`capability:timeline`と検索service/責務2行は古い残範囲の説明だけを更新した。対象11行（監査8・override3）のA/B・担当domain・本家source/line/referencesと既存根拠配列の順序を保持する。

public/homeの保存snapshotから、hashtag表のhistorical mentioned利用者をtotal/local/remote別に原子的に追加する。hidden/sensitiveはRedisだけを除外する。通常Redisの1h unique set・10分HLL・1h featuredランキング（+1、3h EXPIRE NX）を接続し、非原子的な同時通過・NX非延長を維持する。DB失敗は後のタグだけを止め、設定/ランキング失敗はDBを止めず、開始済みの独立仕事は既存診断・終了待機へ含める。本家の注入Metaに対して新実装は対象producerごとに現在Metaを非同期取得し、未知設定時はrankingを抑止する。この読取境界とcommand error検出/drainの差異を記録し、新cache・retry・永続依頼・削除purgeを足していない。

固定sourceの87観測は再生成一致し、新unitとの直接JSON比較はupdate28＋post12の40件、実PGの全列比較（生成id除外）は4件である。87件すべての新旧直接一致を示すものではない。sourceは実際の固定メソッドとDB/Redis等のdoubleを使い、新実装の実HTTP handler/PG/Redis検証と区別する。非同期設定読取による独立処理のinterleavingはmembershipと他commandを別streamとして比較する。新実装の全unit63ファイル2,234件、実依存結合38件（hashtag21・migration6・近傍featured11）、通常HTTP子の投稿直後SIGTERM1件、upstream同期5件・sync:check・依存順build/typecheck・専用DBのmigrate/check-migrations/check-schema（差分0）が成功した。[比較範囲と差異](../note/hashtag/README.md) / [計画と検証記録](../../plans/2026-11-07-note-hashtag-174.md)。

利用者配列は削除で減らず、Redis結果は過去の設定・実行window・expiry・同時通過に依存するため、現存Noteだけでは厳密に再構築できない。#132/#133では近似と履歴再現を区別する。profile/remote attached更新、管理hiddenTags変更時のranking cleanup、hashtag API/packer/stream・chart reader、antennaと#174の全更新照合、#172/#176の最終連携は残る。featured閲覧/2-window merge・reaction/galleryも別責任であり、このsliceで完了にしない。

## #174 通常更新の最終sliceと完了判断（2026-11-07）

実装コミット `4d777eda753920a9638ec2ad5df93a3c0ced06c7` を固定根拠に、アンテナproducerとそのuserFollowings cache/内部イベント受信、channel集計の境界修正、remote Instance.notesCountを接続した。対象27行（監査23・override4）では既存の本家source/line/domain/references・監査A/B・根拠配列の順序を保持し、16行を`not_implemented`から`partial`へ更新、11行は既存`partial`を維持する。antenna CRUD/閲覧、WS受信、account move/clean/import/export、follow APIや他user cache、chart/remote AP入口を完成扱いしない。

保存時の投稿・作者・補正後channelを使い、全定義の照合成功後だけmax200のantenna timeline追加とraw Noteのpublicationを開始する。source形のlazy active一覧とinternal設定受信、通常Redisの30分following cache/1分memory・follow受信による無効化を扱う。pack成功はantenna開始条件ではなく、削除purgeや強いCreate/Delete順序を足さない。初期化競合・接続/終了・診断/drainの実装契約、直接比較したsource観測と実依存検証の範囲は[比較資料](../note/antenna/README.md)と[計画・検証結果](../../plans/2026-11-07-note-antenna-174.md)を参照する。source抽出実行と新実装の実HTTP/PG/Redis/processは別の証拠であり、本家full server実測とは区別する。

現存Noteと現在の定義/follow/listから過去の一致・定義変更・処理順・trim結果を厳密に復元できないため、#132/#133へ近似と履歴再現の違いを渡す。固定本家NoteCreate/Deleteの通常派生更新を全体照合し、監査で見つかったchannel/remote counterも接続したため、#174の有効な完了条件を満たす。PRは`Closes #174`とし、投稿全体の縦断 #176、API閲覧 #185/#186、他stream #189、chart #200を同時に完了扱いしない。過去slice節の未接続記述は当時の状態である。

固定sourceはantenna184件・channel5件・counter17件を独立再生成し、JSON一致を確認した。製品との直接比較はmatcher87件、timelineのage/tail/random24件、実PG raw payload5件、counter fixture6件であり、source全206件を新旧直接比較したという意味ではない。新実装は全unit66ファイル2,401件、関連integration5ファイル104件、process2件、upstream同期5件・sync:check、依存順build/typecheck、専用DBのmigrate/check-migrations/check-schema（差分0）、shippingが成功した。sourceのRepository/Redis/timer doubleと、新実装の実HTTP handler/PG/Redis/通常HTTP子・managed counter fixture子の結果を区別する。本家full serverとの同時比較、remote AP受信、antenna WSクライアント受信を証明した結果ではない。

channelのnotesCount/lastNotedAt/usersCountはpack/mention等の準備成功後に独立更新する。remote Instance.notesCountは既存台帳を使い、enabledなremote作者hostの作成+1を初回期限5分で集約、削除-1は通常HTTP削除（本家のquiet=false相当）で直接開始する。quiet=trueは本家観測のみで、新実装のquiet削除経路は未実装。cache refresh/負数clamp/retryを追加せず、DELETE失敗時の先行減算と終了flushを検証する。source全体の派生更新一覧・channel/instance比較・#132/#133への入力は[通常更新の棚卸し](../note/derived-updates/README.md)へ集約する。#174を閉じる根拠はこの具体的範囲のsource照合・実依存検証・独立Spec PASS/Quality APPROVEと共通検査であり、chart #200やAP受信 #195全体の完成を主張しない。

## 列挙した範囲

| 単位 | 件数 | 根拠と数え方 |
| --- | ---: | --- |
| api | 438 | endpoint-list.ts の登録名。440 .ts のうち2件は test なので除外。全438 handlerとの集合一致を検査。 |
| http | 84 | server 内 fastify の明示登録。/api、/oauth、/oauth/token、/healthz の mountを記録。API共通の動的登録2経路も含む。 |
| stream-channel | 19 | Connection.getChannelConstructor の19種と実handlerファイル。 |
| stream-command | 10 | 接続操作と別名。チャネル内の書込も別途追跡。 |
| ap-inbound | 14 | ApInboxService.performOneActivity のdispatch。Collectionの展開/検証も領域の責任に含む。 |
| job | 35 | QueueProcessorService の全35文字列dispatch。importのDB phase/relationship4操作も別に列挙。 |
| processor | 36 | 全36processorファイル。dispatchと重複するので足し算して機能数にしない。 |
| schedule | 9 | QueueService の9定期登録とcron式。遅延archive/poll/予約は各processor/領域で扱う。 |
| cli | 3 | boot/cli.ts のhelp/ping/reset-captcha。migration等は運用能力でも追跡。 |
| capability | 39 | 領域の正本・副作用とqueue外timer/WS書込/static配信の明示的な確認単位。内部の全関数一覧ではない。 |

### 監査で追加した行

[網羅性監査](../../../backend-next/coverage-audit.md)（2026-11-03）で、上の機械列挙に現れない本家の機能・責務 1432 行を [audit-items.json](audit-items.json) に追加し、担当領域を割り当てた。種別は service・packer・entity・config・env・Meta 設定・stream/internal イベント・通知種別・webhook イベント・ロールポリシー/条件・モデレーションログ種別・AP の表現/送信箇所・queue 名/投入メソッド・timer・`responsibility`（暗黙の責務）など。

- 監査時の判定（割り当て前）: 計画あり 1075 / 曖昧 341 / 計画なし 15 / 意図した後回し 1。対応表では計画あり以外に「（監査: 曖昧）」等を付ける。担当を割り当てたことは、その領域 Issue が中身を調査・実装することを意味し、移植済みを意味しない。
- 機械列挙の行と違い、`--check` は再列挙しない。上流の場所・担当領域・判定値・重複を検査する。本家更新時は [#135](https://github.com/tiramiss-community/tiramiss/issues/135) の記録と合わせて人が見直す。
- 横断的で既存領域に収まらない責務は、新しい 3 領域（連合の共通土台・外向きHTTPとSSRF対策・プロセス間イベントとキャッシュ同期）へ分けた。本家設定キー・環境変数・観測（Sentry/telemetry）・既存データ形式の互換は #138 に寄せた。Meta 設定・通知種別・stream イベントは、効き先または発行する機能の領域に置いた。

**687行は独立した機能数でも PR 数でもなく、完成率の分母にしない。** 同じ機能が API・stream・job・共通能力の複数行に現れる。監査行を含む全行も同様。残作業は下表の31領域と各 Issue の完了条件で判断する。将来の本家更新で対象集合も変わる。

全契約は生成された [対応表](contracts.md)、機械可読版は [contracts.json](contracts.json)。保存・副作用・実装・検証・既知差異は [domains.json](domains.json) にまとめ、各行の `domain` から引く。行の `source` と本家 SHA が本家参照、`issue` が担当、`implementation`/`verification` が新実装と根拠、`differences` が明示した差異を表す。

## 担当領域

| 領域 | 監査時点 | 担当 / 連携 |
| --- | --- | --- |
| [API共通契約](#domain-api-common) | 未実装 | [#178](https://github.com/tiramiss-community/tiramiss/issues/178) |
| [ログイン・認証情報・アプリ認可](#domain-identity) | 未実装 | [#179](https://github.com/tiramiss-community/tiramiss/issues/179) |
| [ユーザー・設定・クライアントregistry](#domain-accounts) | 未実装 | [#180](https://github.com/tiramiss-community/tiramiss/issues/180) |
| [Role全API・割り当て変更](#domain-roles) | 初期2 APIは検証根拠あり、領域は未完了 | [#181](https://github.com/tiramiss-community/tiramiss/issues/181) / #115, #116, #117, #118, #119, #120, #121 |
| [follow・block・mute・関係管理](#domain-social) | 未実装 | [#182](https://github.com/tiramiss-community/tiramiss/issues/182) |
| [投稿初期フロー](#domain-notes) | 部分実装 | [#127](https://github.com/tiramiss-community/tiramiss/issues/127) / #167, #168, #169, #170, #171, #172, #173, #174, #175, #176 |
| [投稿周辺参照・下書き・予約](#domain-notes-extra) | 未実装 | [#183](https://github.com/tiramiss-community/tiramiss/issues/183) / #127 |
| [reaction・投票・favorite・thread mute](#domain-engagement) | 未実装 | [#184](https://github.com/tiramiss-community/tiramiss/issues/184) |
| [TL・アンテナ・一覧閲覧](#domain-timeline) | producer部分実装 | [#185](https://github.com/tiramiss-community/tiramiss/issues/185) / #132, #133, #174 |
| [検索・ハッシュタグ](#domain-search) | 検索/hashtag producer部分実装 | [#186](https://github.com/tiramiss-community/tiramiss/issues/186) / #132, #133, #174 |
| [list・clip・channel](#domain-collections) | 未実装 | [#187](https://github.com/tiramiss-community/tiramiss/issues/187) |
| [通知・未読/既読・push](#domain-notifications) | 部分実装 | [#177](https://github.com/tiramiss-community/tiramiss/issues/177) / #155, #173, #139 |
| [Drive・ファイル配信・外部保存](#domain-drive) | 未実装 | [#188](https://github.com/tiramiss-community/tiramiss/issues/188) / #130, #170, #139 |
| [WebSocket接続・購読・状態変更](#domain-stream) | 投稿受信部分実装 | [#189](https://github.com/tiramiss-community/tiramiss/issues/189) |
| [chatメッセージ・room](#domain-chat) | 未実装 | [#190](https://github.com/tiramiss-community/tiramiss/issues/190) |
| [pages・Play・gallery](#domain-content) | 未実装 | [#191](https://github.com/tiramiss-community/tiramiss/issues/191) |
| [Reversi・bubble game](#domain-games) | 未実装 | [#192](https://github.com/tiramiss-community/tiramiss/issues/192) |
| [instance公開情報・emoji・announcement](#domain-discovery) | 未実装 | [#193](https://github.com/tiramiss-community/tiramiss/issues/193) |
| [管理・モデレーション・設定](#domain-moderation) | 未実装 | [#194](https://github.com/tiramiss-community/tiramiss/issues/194) |
| [AP受信・remote解決・actor公開](#domain-federation) | 未実装 | [#195](https://github.com/tiramiss-community/tiramiss/issues/195) / #160, #171 |
| [投稿AP送信・宛先](#domain-ap-outbound) | 未実装 | [#124](https://github.com/tiramiss-community/tiramiss/issues/124) / #159, #160, #161, #162, #171, #172 |
| [HTML・feed・preview・公開配布経路](#domain-web) | 未実装 | [#196](https://github.com/tiramiss-community/tiramiss/issues/196) |
| [user webhook設定・全イベント配送](#domain-user-webhook) | 投稿部分のみ | [#197](https://github.com/tiramiss-community/tiramiss/issues/197) / #163, #175 |
| [system webhook設定・配送](#domain-system-webhook) | 未実装 | [#198](https://github.com/tiramiss-community/tiramiss/issues/198) |
| [import/export・移動/削除・保守ジョブ](#domain-maintenance) | 未実装 | [#199](https://github.com/tiramiss-community/tiramiss/issues/199) / #130, #139 |
| [charts・retention・統計](#domain-analytics) | 未実装 | [#200](https://github.com/tiramiss-community/tiramiss/issues/200) / #132, #133 |
| [ジョブ管理・照会・制御](#domain-queue) | 管理14 API/QueueStats・現在3業務queueの保持/実payload引継ぎ・全10名の停止専用検査を検証。7業務handlerと最終切替は未完了 | [#163](https://github.com/tiramiss-community/tiramiss/issues/163) / #124, #162, #164, #165 |
| [起動・migration・CLI・配布](#domain-operations) | 部分実装 | [#138](https://github.com/tiramiss-community/tiramiss/issues/138) / #113, #135, #136, #137, #139, #162, #166 |
| [連合の共通土台（システムアカウント・鍵・ホスト判定・排他）](#domain-federation-base) | 未実装（監査で追加） | [#215](https://github.com/tiramiss-community/tiramiss/issues/215) / #195, #124, #160, #171 |
| [外向きHTTPとSSRF対策](#domain-outbound-http) | 未実装（監査で追加） | [#216](https://github.com/tiramiss-community/tiramiss/issues/216) / #160, #188, #195, #196, #197, #198 |
| [プロセス間イベントとキャッシュ同期](#domain-process-events) | 未実装（監査で追加） | [#217](https://github.com/tiramiss-community/tiramiss/issues/217) / #119, #178, #189 |

## 対応順と依存の扱い

1. 投稿は #167（比較契約）・#168（show）・#169（基本作成）まで完了。次は #170（関連入力）。既存トークンによる参照は全ログイン/トークン発行の移植を待たせない。
2. 実配送は #160（署名 HTTP）と #162（通常 worker。投票終了ジョブで接続済み）の上に、必要な実仕事（#171/#172）と合わせて接続する。#171 の最初の PR でノート作成の配送（relay を除く）を接続した。縦断比較は #176。#159/#161/#166 は追加保証として保留し、初期完成の依存にしない。
3. 次にユーザーの取得と関係 facts、一覧/TL、通知/streamを接続すると、投稿→閲覧→通知まで使える範囲を増やせる。公開情報・ユーザー参照・検索の設計は独立した部分から進めてよい。
4. Drive の外部保存やアカウント削除等は #130 の機能別回復設計を先に切り出す。#130を全参照 API の一括 blocker にしない。派生状態の通常更新は #174、正本/再構築は #132/#133、TL/検索の閲覧は各領域が所有する。
5. 認証発行、social graph、AP inboundは、狭い facts・署名/remote解決・個別activityを下位 Issue に分ける。親領域同士の全完了を相互に要求する循環を作らない。
6. #135/#136（本家追従）と #138（配布/観測）は並行準備し、全対象の成立後に #139（完全停止切り替え/残ジョブ/Redis移行）を最終検証する。

各領域 Issue は詳細設計・下位分割・実装・受け入れまでを追う取りまとめ。Issue を作成しただけ、または仕様を列挙しただけでは、その領域を完成にしない。新たな必須依存は該当する下位 Issue と親の順序へ同時に反映する。

## 検査・更新

```sh
node --test scripts/backend-contract-inventory.test.mjs
node scripts/backend-contract-inventory.mjs --check
```

`--check` は固定 Git オブジェクトと TypeScript AST から再列挙し、snapshot と生成表の一致、handler 全集合、未分類・重複、担当 Issue の設定、参照ファイル、部分実装/検証済みの証拠有無を検査する。Node/TypeScript はルートの既存依存を使う。ネットワーク接続や旧 backend のビルド・起動は不要。全履歴と指定 SHA の Git オブジェクトが必要。

1. 本家更新の評価では先に #135 の記録で固定 SHA と差分の意味を確認する。`domains.json` の SHA を黙って進めない。
2. 新規入口は既存領域へ責任を割り当てるか Issue を追加する。HTTP の動的 path/mount/Accept 分岐、channel内部の書込、coreのqueue外timer・外部保存/通信も読む。列挙スクリプトは業務の意味を自動判定しない。
3. 実装が増えたら新実装監査 SHA を明示的に更新し、個別 contract の status と実装/比較テスト/意図的差異を記録する。ファイルが存在するだけで verified にしない。
4. 監査行（`audit-items.json`）は手で編集する。担当を変えるときは `domain` を、実装したら `status`/`implementation`/`verification` を更新し、`audit` は監査時の値のまま残す。
5. `node scripts/backend-contract-inventory.mjs --write` で両形式を更新し、差分をレビューして再度 `--check` を通す。対応 Issue と親の進捗も更新する。CIでもNodeテストと整合性検査を実行する。

## 領域ごとの保存・副作用・根拠

<a id="domain-api-common"></a>

### API共通契約

登録/GET可否/multipart/共通認証・scope・制限・error/metadata公開。Role個別のgateだけで全API互換としない。

- 担当: [#178](https://github.com/tiramiss-community/tiramiss/issues/178).
- 正本/保存: 本家User/App/AccessToken/Meta / Redis rate limit。
- 副作用: 共通エラー・認可・入力検証順。
- 本家: [ApiServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/ApiServerService.ts)、[ApiCallService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/ApiCallService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-identity"></a>

### ログイン・認証情報・アプリ認可

signup/signin/passkey/2FA/メール検証/password reset/App/native token/MiAuth/OAuth/招待を含む。

- 担当: [#179](https://github.com/tiramiss-community/tiramiss/issues/179).
- 正本/保存: User/Profile/App/AccessToken/招待/認証状態。
- 副作用: メール・認可redirect・token発行・失効。
- 本家: [SigninApiService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/SigninApiService.ts)、[SignupApiService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/SignupApiService.ts)、[OAuth2ProviderService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/oauth/OAuth2ProviderService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-accounts"></a>

### ユーザー・設定・クライアントregistry

ユーザー表示/プロフィール/個人設定/registry/achievement/メモ等。ログイン発行とアカウント削除・移動は別の所有者。

- 担当: [#180](https://github.com/tiramiss-community/tiramiss/issues/180).
- 正本/保存: User/Profile/registry/achievement/関連設定。
- 副作用: profile更新通知・AP表現/更新・キャッシュ無効化。
- 本家: [UserEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/UserEntityService.ts)、[UserService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-roles"></a>

### Role全API・割り当て変更

初期show/updateと区別してcreate/delete/list/assign/unassign/default policies/公開Role参照を移植する。

- 担当: [#181](https://github.com/tiramiss-community/tiramiss/issues/181).
- 正本/保存: Role/RoleAssignment/ModerationLog。
- 副作用: 同時監査・材料cache無効化・資格/ポリシー反映。
- 本家: [RoleService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/RoleService.ts)。
- 新実装: [public.ts](../../../../packages/backend-next/src/modules/role/public.ts)、[role-api.ts](../../../../packages/backend-next/src/http/role-api.ts)。
- 検証根拠: [role-acceptance.test.ts](../../../../packages/backend-next/test/integration/role-acceptance.test.ts)。
- 既知差異: ロール更新と監査を同時確定。HTTPの既知差異はdocs/superpowers/specs/2026-10-17-role-compatibility-contract.mdとcompatibility/role/README.mdを参照。

<a id="domain-social"></a>

### follow・block・mute・関係管理

follow/request/取消・承認・reject、block/mute/renote mute、期限・AP関係activity。remote解決と循環しないsliceで実装。

- 担当: [#182](https://github.com/tiramiss-community/tiramiss/issues/182).
- 正本/保存: Following/FollowRequest/Blocking/Muting/RenoteMuting。
- 副作用: 関係count・通知・AP Follow/Accept/Reject/Undo/Block・期限処理。
- 本家: [UserFollowingService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserFollowingService.ts)、[UserBlockingService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserBlockingService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-notes"></a>

### 投稿初期フロー

notes/create/show/deleteと関連入力・純粋出力。

- 担当: [#127](https://github.com/tiramiss-community/tiramiss/issues/127).
- 正本/保存: Note/Poll/count。
- 副作用: 通知・AP・stream・TL/検索・webhookの後続処理開始。
- 本家: [NoteCreateService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteCreateService.ts)、[NoteDeleteService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteDeleteService.ts)、[NoteEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/NoteEntityService.ts)。
- 新実装: [create-note.ts](../../../../packages/backend-next/src/modules/note/create-note.ts)、[show-note.ts](../../../../packages/backend-next/src/modules/note/show-note.ts)、[note-writer.ts](../../../../packages/backend-next/src/platform/database/note-writer.ts)、[note-reader.ts](../../../../packages/backend-next/src/platform/database/note-reader.ts)。
- 検証根拠: [note-create.test.ts](../../../../packages/backend-next/test/integration/note-create.test.ts)、[note-show.test.ts](../../../../packages/backend-next/test/integration/note-show.test.ts)。
- 既知差異: 保存と後続開始を分け、独自依頼との同時保存はしない（docs/backend-next/posting-contract.md）。notes/showの参照予算D7。

<a id="domain-notes-extra"></a>

### 投稿周辺参照・下書き・予約

初期create/show/delete以外のchildren/conversation/reply/renote/state/bulk show/翻訳、下書きと予約時刻・取消を実装する。

- 担当: [#183](https://github.com/tiramiss-community/tiramiss/issues/183).
- 正本/保存: Note/NoteDraft/予約内容/関連状態。
- 副作用: 予約投稿・翻訳HTTP・遅延取消/再認可。
- 本家: [NoteDraftService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteDraftService.ts)、[PostScheduledNoteProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/PostScheduledNoteProcessorService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-engagement"></a>

### reaction・投票・favorite・thread mute

reactionの追加/削除、投票・推薦、favorite、thread mute、unrenote等の操作と公開契約。

- 担当: [#184](https://github.com/tiramiss-community/tiramiss/issues/184).
- 正本/保存: Reaction/PollVote/NoteFavorite/NoteThreadMuting。
- 副作用: count・通知・AP Like/Undo・stream・buffer反映。
- 本家: [ReactionService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ReactionService.ts)、[PollService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PollService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-timeline"></a>

### TL・アンテナ・一覧閲覧

home/local/hybrid/global/user-list/Role/antenna/mentions/featuredとcursor/可視性。通常更新/再構築は別責任。

- 担当: [#185](https://github.com/tiramiss-community/tiramiss/issues/185).
- 正本/保存: Note/関係facts/アンテナ設定 / Redis TL cache。
- 副作用: 一覧paging・アンテナ設定/候補・stream公開条件。
- 本家: [FanoutTimelineService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/FanoutTimelineService.ts)、[AntennaService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/AntennaService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-search"></a>

### 検索・ハッシュタグ

Note/User/タグ検索・タグ一覧/トレンド等の入力・cursor・可視性。検索データ通常更新/再構築とは別の閲覧契約。

- 担当: [#186](https://github.com/tiramiss-community/tiramiss/issues/186).
- 正本/保存: Note/User/Hashtag / MeilisearchまたはDB検索。
- 副作用: 検索結果と公開範囲・検索記録/制限。
- 本家: [SearchService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/SearchService.ts)、[HashtagService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/HashtagService.ts)。
- 新実装: #174/#172のMeilisearch settings/登録/解除producerを部分実装。検索API・User/タグ検索・hashtag更新・再構築は未完了。
- 検証根拠: [検索比較資料](../note/search/README.md)。固定source256+8ケース、新実装240行直接照合、実Meiliを使うapp.request/PG/Redis結合と実HTTP子/SDK/gatewayのprocess試験。
- 既知差異: detached拒否を安全なログへ記録し、既存の開始済み要求drain/終了期限へ接続。engine task適用は待機しない。

<a id="domain-collections"></a>

### list・clip・channel

リスト/clip/channelの管理・membership・favorite/follow/mute、公開条件・一覧/TLを含む。

- 担当: [#187](https://github.com/tiramiss-community/tiramiss/issues/187).
- 正本/保存: UserList/Clip/Channel/所属・関係行。
- 副作用: count・公開可否・stream・TL候補更新 / clip updatedは先頭即時と3秒静穏後の末尾通知、削除時timer取消。
- 本家: [ChannelEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/ChannelEntityService.ts)、[ClipEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/ClipEntityService.ts)、[ClipService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ClipService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-notifications"></a>

### 通知・未読/既読・push

PG保存と分けて全通知条件、一覧/grouping/cursor/未読/既読/flush/設定、Service Worker push、旧Redis移行を追跡する。

- 担当: [#177](https://github.com/tiramiss-community/tiramiss/issues/177).
- 正本/保存: 本家Redis通知/未読 / 新PG notification。
- 副作用: stream・push配信・遅延未読処理。
- 本家: [NotificationService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NotificationService.ts)、[PushNotificationService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PushNotificationService.ts)。
- 新実装: [persistence.ts](../../../../packages/backend-next/src/platform/database/notification/persistence.ts)、[poll-ended.ts](../../../../packages/backend-next/src/modules/notification/poll-ended.ts)。
- 検証根拠: [notification.test.ts](../../../../packages/backend-next/test/integration/notification.test.ts)、[poll-ended-job.test.ts](../../../../packages/backend-next/test/integration/poll-ended-job.test.ts)。
- 既知差異: 本家Redis StreamからPG保存へ変更（ユーザー承認済み）。effect/容量課金への依存はPR #213で撤去。閲覧/既読/移行は#177。pollEndedは#162で通知元なしのPG保存まで接続（配信は#173）。

<a id="domain-drive"></a>

### Drive・ファイル配信・外部保存

upload/URL取得/移動/削除・folder/容量/添付参照・ファイルproxy/thumbnail/cacheを含める。

- 担当: [#188](https://github.com/tiramiss-community/tiramiss/issues/188).
- 正本/保存: DriveFile/Folder/count / filesystemまたはobject storage。
- 副作用: 外部保存・画像処理・参照更新・清掃/回復。
- 本家: [DriveService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/DriveService.ts)、[FileServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/FileServerService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-stream"></a>

### WebSocket接続・購読・状態変更

接続/auth/heartbeat/再接続、19channel、10接続操作と別名、note購読、channelごとのWS書込とevent payloadを扱う。

- 担当: [#189](https://github.com/tiramiss-community/tiramiss/issues/189).
- 正本/保存: 認証/関係facts / Redis PubSub / chat既読/game状態。
- 副作用: stream配信・通知既読・chat read・game ready/settings/cancel/putStone等。
- 本家: [StreamingApiServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/StreamingApiServerService.ts)、[Connection.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/stream/Connection.ts)、[GlobalEventService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/GlobalEventService.ts)。
- 新実装: `modules/stream`、`platform/streaming-server.ts`、`platform/database/streaming.ts`、`composition/posting-websocket.ts`。main/homeTimeline・note購読のみ部分実装。
- 検証根拠: [固定source比較と実受信](../stream/README.md)。source64ケース、実HTTP/PG/Redis/WS、通常poll worker、終了時drainを検証。queueStatsとそのrequestLogは#163で接続済み。他16channel・readNotification・他channel書込は未実装。
- 既知差異: 常時clone・JSON null frame無視・本文hideの現在following照会は比較資料を参照。広域cache同期#217と全#189の完成を示すものではない。

<a id="domain-chat"></a>

### chatメッセージ・room

DM/room作成・参加/招待・mute・履歴/検索・既読・reaction・添付とWS eventを扱う。

- 担当: [#190](https://github.com/tiramiss-community/tiramiss/issues/190).
- 正本/保存: ChatMessage/Room/Invitation/membership/既読。
- 副作用: 通知・push・WS・添付整合・時刻駆動 / chatUser.readとchatRoom.readの別の既読更新。
- 本家: [ChatService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ChatService.ts)、[chat-user.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/stream/channels/chat-user.ts)、[chat-room.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/stream/channels/chat-room.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-content"></a>

### pages・Play・gallery

pages/flash/Play/galleryの作成・更新・削除・閲覧・like・検索とpage-push。

- 担当: [#191](https://github.com/tiramiss-community/tiramiss/issues/191).
- 正本/保存: Page/Flash/GalleryPost/Like/添付参照。
- 副作用: like通知・embed/OGP・stream等。
- 本家: [PageEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/PageEntityService.ts)、[FlashEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/FlashEntityService.ts)、[GalleryPostEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/GalleryPostEntityService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-games"></a>

### Reversi・bubble game

match/invitation/game状態/verify/surrender/ranking/registerとWS game操作、期限・並行操作を扱う。

- 担当: [#192](https://github.com/tiramiss-community/tiramiss/issues/192).
- 正本/保存: ReversiGame/ranking/ユーザー記録。
- 副作用: WS・game timer・終了/放置処理。
- 本家: [ReversiService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ReversiService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-discovery"></a>

### instance公開情報・emoji・announcement

meta/ping/server-info/ユーザー数、emoji/avatar decoration、announcement/promo/pinned users等の公開取得・個人既読を含む。

- 担当: [#193](https://github.com/tiramiss-community/tiramiss/issues/193).
- 正本/保存: Meta/Emoji/Announcement/Ad/Decoration。
- 副作用: 公開JSON・cache・announce既読・nodeinfo/host-meta。
- 本家: [NodeinfoServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/NodeinfoServerService.ts)、[WellKnownServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/WellKnownServerService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-moderation"></a>

### 管理・モデレーション・設定

他領域で所有しないadmin API：ユーザー制御/通報/設定/emoji/ad/announce/監査/DB状態・メール送信等。

- 担当: [#194](https://github.com/tiramiss-community/tiramiss/issues/194).
- 正本/保存: Meta/ModerationLog/AbuseReport/管理対象。
- 副作用: 監査・配信停止・メール・キャッシュ/公開設定反映。
- 本家: [update-meta.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/update-meta.ts)、[AbuseReportService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/AbuseReportService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-federation"></a>

### AP受信・remote解決・actor公開

inbox全activity・検証/remote actor/Note解決・照会、AP actor/object/outbox/followers等とWebFinger/relay/instance管理を扱う。

- 担当: [#195](https://github.com/tiramiss-community/tiramiss/issues/195).
- 正本/保存: remote User/Note/関係/instance/relay / inbox進捗。
- 副作用: 署名/文書取得・HTTP・受信副作用・AP応答・federation cache。
- 本家: [ActivityPubServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/ActivityPubServerService.ts)、[ApInboxService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApInboxService.ts)、[ApResolverService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApResolverService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-ap-outbound"></a>

### 投稿AP送信・宛先

投稿のAP本文・宛先選定・署名送信・Delete/Undo。署名HTTP(#160)・通常worker(#162)・投稿表現(#171/#172)で接続する。永続宛先台帳・host lease・結果不明の追跡は保留(#159/#161)。

- 担当: [#124](https://github.com/tiramiss-community/tiramiss/issues/124).
- 正本/保存: 本家相当の通常BullMQ deliver queue。
- 副作用: 外部AP HTTP・本家相当のretry/backoff。
- 本家: [ApDeliverManagerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApDeliverManagerService.ts)、[ApRequestService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApRequestService.ts)。
- 新実装: [note-delivery.ts](../../../../packages/backend-next/src/modules/federation/note-delivery.ts)、[deliver-job.ts](../../../../packages/backend-next/src/modules/federation/deliver-job.ts)、[deliver.ts](../../../../packages/backend-next/src/platform/job-queue/deliver.ts)、[deliver-job.ts（composition）](../../../../packages/backend-next/src/composition/deliver-job.ts)。
- 検証根拠: [note-deliver.test.ts](../../../../packages/backend-next/test/processes/note-deliver.test.ts)、[deliver-queue.test.ts](../../../../packages/backend-next/test/integration/deliver-queue.test.ts)、[deliver-processor.test.ts](../../../../packages/backend-next/test/integration/deliver-processor.test.ts)。
- 既知差異: 旧PG宛先snapshot/page/host leaseはPR #212/#213で撤去。本家の業務規則はdocs/backend-next/ap-delivery-handoff.mdに残す。#171の最初のPRでノート作成の配送（relayを除く）を接続。relay・LD署名は#171の2番目のPR、チャートは#200、成功時のfetchInstanceMetadataは#215段階5。意図的な差異はdocs/superpowers/compatibility/ap-deliver/README.md。

<a id="domain-web"></a>

### HTML・feed・preview・公開配布経路

AcceptによるAP/HTML分岐、SPA/OGP/embed/feed/robots/OpenSearch/sw/manifest/assets/tarball、URL preview/RSS等を扱う。

- 担当: [#196](https://github.com/tiramiss-community/tiramiss/issues/196).
- 正本/保存: 公開Note/User/コンテンツ/設定 / preview cache。
- 副作用: HTML/feed・外部URL取得・配布・ブラウザcache制御。
- 本家: [ClientServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/ClientServerService.ts)、[FeedService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/FeedService.ts)、[UrlPreviewService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/UrlPreviewService.ts)、[ServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/ServerService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-user-webhook"></a>

### user webhook設定・全イベント配送

投稿 note/reply/renote/mention を通常 queue と worker に接続。hook 管理6 API と follow/unfollow/followed/reaction 等は #197 に残る。

- 担当: [#197](https://github.com/tiramiss-community/tiramiss/issues/197)、投稿 slice は #175。
- 正本/保存: UserWebhook と通常 BullMQ job。URL/secret は enqueue 時に snapshot。
- 副作用: userWebhookDeliver HTTP、secret ヘッダー、通常 retry。
- 本家・実装・検証の範囲: [投稿 webhook 比較](../user-webhook/README.md)。
- 既知差異: Redis 内部イベントの喪失からの自動回復は保証しない。追加保証は導入していない。

<a id="domain-system-webhook"></a>

### system webhook設定・配送

system hook管理・test・対象業務eventと固定依頼/署名配送をuser hookと区別する。

- 担当: [#198](https://github.com/tiramiss-community/tiramiss/issues/198).
- 正本/保存: SystemWebhook/対象関連 / 固定依頼・結果。
- 副作用: systemWebhookDeliver HTTP・署名・retry/unknown。
- 本家: [SystemWebhookService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/SystemWebhookService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-maintenance"></a>

### import/export・移動/削除・保守ジョブ

エクスポート/インポート、account移動/削除、期限mute/announcement archive/remote cleanup等。保存/外部の部分完了を機能別に設計。

- 担当: [#199](https://github.com/tiramiss-community/tiramiss/issues/199).
- 正本/保存: 各業務正本 / 再開cursor/取消・清掃進捗。
- 副作用: exportファイル・関係/AP・削除・期限処理・有限回復。
- 本家: [QueueService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[QueueProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/QueueProcessorService.ts)、[DeleteAccountProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/DeleteAccountProcessorService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-analytics"></a>

### charts・retention・統計

chart各系列/retention/statsと集計/tick/resync/clean、履歴的countと復元不能な期間を扱う。

- 担当: [#200](https://github.com/tiramiss-community/tiramiss/issues/200).
- 正本/保存: chart系列/retention/履歴集計 / buffer。
- 副作用: 定期集計・flush・保持清掃。
- 本家: [ChartManagementService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/ChartManagementService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-queue"></a>

### ジョブ管理・照会・制御

本家queue単位の照会・制御・retry・QueueStats・履歴/清掃を通常BullMQ公開APIで移植する。

- 担当: [#163](https://github.com/tiramiss-community/tiramiss/issues/163).
- 正本/保存: BullMQ/Redisのqueue状態 / ModerationLog。
- 副作用: pause/resume/retry/promote/remove/clean・監査。
- 本家: [QueueService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[show-job.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/show-job.ts)。
- 新実装: [管理UseCase](../../../../packages/backend-next/src/modules/queue/admin.ts)、[14 HTTP route](../../../../packages/backend-next/src/http/queue-api.ts)、[10 queue adapter](../../../../packages/backend-next/src/platform/job-queue/administration.ts)、[QueueStats observer](../../../../packages/backend-next/src/platform/queue-stats.ts)。
- 検証根拠: [queue source比較](../../../../packages/backend-next/test/unit/queue/source-compat.test.ts)、[実HTTP/PG/Redis](../../../../packages/backend-next/test/integration/queue-admin.test.ts)、[実WS](../../../../packages/backend-next/test/integration/queue-stats.test.ts)、[通常HTTP子と寿命/障害](../../../../packages/backend-next/test/processes/queue-admin.test.ts)、[比較範囲と結果](../queue-admin/README.md)。
- 既知差異: 管理14 API/公開QueueStatsは#163で検証済み。単一HTTP observerがXevを置き換え、即時/10秒周期・最新先頭200件のメモリ履歴を持つ。sourceの非待機204境界を維持して診断/終了待機を追加する。既存のRedis無再接続方針を管理/QueueEventsにも適用する。再起動を跨ぐ統計保持や全10業務workerを追加しない。通常保持/清掃#164は現在3業務queueと全10管理対象で検証した。停止専用検査/実payload引継ぎ#165を検証した後も7業務producer/Worker等が残るため`capability:queue`と各queue名は`partial`を維持する。

<a id="domain-operations"></a>

### 起動・migration・CLI・配布

Supervisor/HTTP/worker・設定/DB/Redis・migration/check・CLI・healthz・配布/監視と完全停止切り替えを扱う。本家設定キー・環境変数の互換、観測（Sentry/telemetry）の扱い、DB接続・ID形式など既存データ形式の互換もここで判断する。

- 担当: [#138](https://github.com/tiramiss-community/tiramiss/issues/138).
- 正本/保存: 本家public履歴/独自履歴 / 設定・接続。
- 副作用: 起動終了・CLI・観測・リリース判定。
- 本家: [cli.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/boot/cli.ts)、[HealthServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/HealthServerService.ts)。
- 新実装: [supervisor.ts](../../../../packages/backend-next/src/processes/supervisor.ts)、[lifecycle.ts](../../../../packages/backend-next/src/processes/lifecycle.ts)、[migrate.ts](../../../../packages/backend-next/src/platform/database/migrate.ts)。
- 検証根拠: [children.test.ts](../../../../packages/backend-next/test/processes/children.test.ts)。
- 既知差異: 本家/独自migration分離、通常起動時自動migrationなし、完全停止切り替え。通常workerは投票終了（#162）・AP配送（#171）・投稿webhook（#175）の3種を実行する。他の業務handlerと配布の統合は未完了。物理容量停止(#166)は保留。

<a id="domain-federation-base"></a>

### 連合の共通土台（システムアカウント・鍵・ホスト判定・排他）

システムアカウントの遅延生成と鍵、ユーザー鍵/公開鍵と鍵形式、ホスト名の正規化と自ホスト判定、連合許可・ブロック・サイレンス・配信停止ソフトウェアの判定、連合インスタンス情報の取得・状態更新・自動停止、APオブジェクト単位の排他。AP受信(#195)・署名送信(#160)・投稿AP(#171)の先行契約。

- 担当: [#215](https://github.com/tiramiss-community/tiramiss/issues/215).
- 正本/保存: SystemAccount/UserKeypair/UserPublickey/Instance / Metaの連合設定 / Redis lock/キャッシュ。
- 副作用: 鍵生成・インスタンス状態更新・配送スキップ/自動停止。
- 本家: [SystemAccountService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/SystemAccountService.ts)、[UtilityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UtilityService.ts)、[FederatedInstanceService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/FederatedInstanceService.ts)、[FetchInstanceMetadataService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/FetchInstanceMetadataService.ts)、[distributed-lock.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/misc/distributed-lock.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 監査行: 32 行（うち監査時に計画あり以外 25 行）。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-outbound-http"></a>

### 外向きHTTPとSSRF対策

AP取得/配送・リモートファイル取得・URLプレビュー・webhook・Web Pushが共有する外向きHTTP。プライベートアドレス遮断とallowedPrivateNetworks、proxy/proxyBypassHosts/outgoingAddress、サイズ・時間・redirect制限。

- 担当: [#216](https://github.com/tiramiss-community/tiramiss/issues/216).
- 正本/保存: 設定（proxy/allowedPrivateNetworks/outgoingAddress）。
- 副作用: 外部HTTP・名前解決・一時ファイル。
- 本家: [HttpRequestService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/HttpRequestService.ts)、[DownloadService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/DownloadService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 監査行: 10 行（うち監査時に計画あり以外 9 行）。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-process-events"></a>

### プロセス間イベントとキャッシュ同期

GlobalEventのRedis pub/sub形式、internalイベントの発行と購読、CacheService・Metaキャッシュ・Redis/メモリ二層キャッシュとTTL。各機能のキャッシュ自体は機能の領域が持ち、通知と反映の契約をここで揃える。Roleの無効化通知(#119)を一般化する。

- 担当: [#217](https://github.com/tiramiss-community/tiramiss/issues/217).
- 正本/保存: Redis pub/sub / Redis/メモリキャッシュ。
- 副作用: 他プロセス・接続中streamへの状態反映。
- 本家: [GlobalEventService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/GlobalEventService.ts)、[CacheService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/CacheService.ts)、[cache.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/misc/cache.ts)、[MetaService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/MetaService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 監査行: 50 行（うち監査時に計画あり以外 38 行）。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。
