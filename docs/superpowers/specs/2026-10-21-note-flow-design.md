# 投稿の作成・取得・配信の詳細設計

日付: 2026-10-21

対象: [#126](https://github.com/tiramiss-community/tiramiss/issues/126)。親は [#125](https://github.com/tiramiss-community/tiramiss/issues/125)、全体順序は [#114](https://github.com/tiramiss-community/tiramiss/issues/114)。

状態: 設計 PR のレビュー対象。本文の「採用」はこの PR で提案する契約を指す。投稿 API・実ジョブは未実装であり、本家との実行比較が通ったことを意味しない。#123 で永続ジョブの物理 schema・運用値を詰め、#124 と本書の実装単位を経て #127 で縦断検証する。

## 1. 方針と範囲

[基本設計](2026-10-15-misskey-backend-redesign-design.md)の所有権・依存方向・同時確定・有限の回復を、投稿の具体的な仕事へ落とす。初期の縦断対象はローカルユーザーによる `notes/create` → `notes/show` → ローカル向け反映・リモート配送と `notes/delete`。削除は配送との競合を定義するためにも先行範囲に含める。

テキストだけの投稿を最初の実装 PR にできるが、それだけで #125/#127 を完了にしない。添付、投票、返信、Renote/引用、指定公開、チャンネル、通知・配信は §9 の依存単位で追跡する。fork 固有機能は引き継がない。

比較した構成案:

| 案 | 利点 | 問題と判断 |
| --- | --- | --- |
| 投稿・依頼を同時保存し、独立した後続 UseCase が反映する（採用） | commit 後停止から再開でき、同期と非同期の責任を区別できる | 依頼・結果の重複対策が必要。機能ごとに小さく実装する |
| 旧 Service の依存と `setImmediate` をそのまま移す | 正常時の移植は速い | UseCase の循環と保存後の仕事の喪失を再現する |
| 配送・通知・検索の完了まで HTTP を待たせる | 成功時点を一見揃えやすい | 外部障害に投稿の成立を結び付け、本家より応答条件を強める |

## 2. 本家調査の基準と確認した境界

固定コミットは `8e07cf085adf7009583d234a208e30436f020e26`。調査は作業ツリーや fork HEAD ではなく `git show <SHA>:packages/backend/<path>` の内容を使用した。次のリンクはすべてその固定地点。

| 本家の根拠 | 確認した契約・実装上の事実 |
| --- | --- |
| [notes/create.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/notes/create.ts) | 認証必須、`write:notes`、移行済アカウント禁止、時間当たり300の制限。既定値、入力 schema、エラー変換、`createdNote` の pack を待つ |
| [NoteCreateService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteCreateService.ts) `fetchAndCreate/create/insertNote` | 所有ファイル・対象投稿・チャンネル・ブロック・投票期限を確認。公開範囲を補正し、MFM から抽出。Note と Poll は同一 transaction。後続処理は保存後の `setImmediate` |
| 同 `postNoteCreated/pushToTl` | 投稿数、返信・Renote 関連更新、Redis TL、アンテナ、通知、stream、webhook、AP 配送、検索、チャートは保存後。複数の Promise は await されず、すべての完了は成功レスポンスの条件ではない |
| [notes/show.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/notes/show.ts)、[NoteEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/NoteEntityService.ts) | 不存在と未ログイン閲覧制限は API エラー。公開範囲による非表示は多くの場合 Note 自体を消さず `isHidden` と本文等の削除で表す。`isVisibleForMe` と `shouldHideNote` は同一ではない |
| [ApDeliverManagerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApDeliverManagerService.ts) | followers を展開後、sharedInbox があればそれを利用。direct inbox と重複排除して投入 |
| [QueueService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[DeliverProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/DeliverProcessorService.ts) | JSON 本文・digest を固定。配送時に federation 許可・配送停止を確認して署名送信。既定12試行、custom backoff、成功/失敗履歴は最大7日かつ件数上限。ネットワーク結果不明は重複の可能性を残す |
| [notes/delete.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/notes/delete.ts)、[NoteDeleteService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteDeleteService.ts) | 作者または moderator。通常投稿は Delete、pure Renote は元投稿が存在すれば Undo(Announce)、消失済みなら Delete(Tombstone)。deleted stream・配送準備は Note 削除以前にも始まり、外部送信と DB 削除は原子的でない |

ここまでの根拠はソース調査。§8 の HTTP/保存/配送ケースは後続実装で実行する比較仕様であり、期待値を実測済みとは記さない。エラーの code/id/message/status は各 endpoint と共通認証処理から fixture 化して実測し、一般化した独自エラーへ置換しない。

## 3. 状態の所有者と公開能力

| 所有モジュール | 正本・更新範囲 | 他領域へ公開する狭い能力 |
| --- | --- | --- |
| 投稿 | Note、Poll 作成、返信/Renote 関係とそのカウント、削除、投稿数としての User.notesCount | `NoteFactsReader`、純粋な投稿/参照 policy。作成・削除 UseCase は公開 Service として呼び回さない |
| アカウント・関係 | アカウント状態、プロフィール、移行、follow/block/mute | `PostingActorFacts`、`RelationshipFacts` を集合取得。User 行全体を投稿側から save しない |
| Role | 実効ポリシーと権限 | 既存の操作境界付き評価。投稿処理から Role 更新 UseCase を呼ばない |
| Drive | ファイル所有権・存在と添付用情報 | `AttachmentFacts` のまとめ読み、transaction 内の存在/利用条件の再確認。アップロードは呼ばない |
| チャンネル | 存在・archive・外部 Renote 制約、投稿数/最終投稿時刻 | `ChannelPostingFacts`、呼び出し元 transaction に参加する限定的な投稿反映操作 |
| 通知 | 永続通知と依頼ごとの成立記録 | 通知の仕事を受ける独立 UseCase。投稿 commit の後で失敗・再試行できる |
| 配信 | AP 表現、宛先展開・送信結果、stream/webhook の配送 | 取得済み投稿事実から配送計画を作る純粋変換、出来事ごとの配送 UseCase |
| 派生データ | Redis TL・検索・アンテナ・タグ集計・ランキング・チャート | 現在状態を反映する仕事。正本は投稿等の業務 DB、独自に Note を作り直さない |
| 実行基盤 | `backend_internal` の依頼・進捗、キューとの橋渡し | transaction に結び付いた `PostWorkRequests.append`、実行契約は §6。物理キュー名を業務へ渡さない |

作者 notesCount は本家では作成で増える履歴的な値で、削除時に減らす実装はない。削除で一律に減算する値と扱わない。repliesCount は返信作成で増え削除で減る。renoteCount は他人の投稿を非 Bot が Renote した時に増え、削除での減算はない。固定 migration に CREATE TRIGGER は無く、これらはアプリ更新。チャンネル notesCount も作成で増える値で、削除で一律に減らさない。N0 はこの条件と時点差を比較し、通常の行数から勝手に再計算しない。

Note/Poll は本家定義を機械同期で追加する。関係や通知など必要な Entity も依存を調べて manifest へ追加し、管理対象を手編集しない。本書ではまだ同期範囲を変更しない。

依存方向は、HTTP/worker → 各 UseCase → 必要な facts/限定更新窓口・Policy → adapter。作成、削除、通知、配送、派生反映は兄弟であり互いの UseCase を呼ばない。配送/派生は投稿の読み取り契約を利用できるが、投稿はそれらの UseCase を参照せず、データだけの依頼契約へ書く。これで公開契約を含む循環も避ける。

## 4. 投稿作成の成立条件と transaction

1. HTTP が本家の認証・scope・移行制限・レート制限・schema 既定値を適用する。実行者と指示を業務型へ変換する。時刻、ID、MFM の抽出結果を明示する。
2. facts をまとめて取得し、ファイル順序、返信/Renote 対象の存在・可視性、ブロック、公開範囲、channel、投票期限、禁止語、メンション数を検証する。Role の同じ操作境界で得た policies を利用する。
3. 本家と同じ正規化を行う。例えば `fileIds ?? mediaIds`、public から home への補正、返信先との公開範囲/チャンネル調整、specified での返信相手追加、抽出抑止フラグは別々に扱う。一律の「公開範囲の最小値」で置き換えない。
4. UseCase 所有の transaction 内で、削除・archive・所有変更等との競合条件を再確認し、Note/Poll、必要な整合更新、後続依頼を保存する。取得と検証に失敗したら全体 rollback。
5. commit が確認できたら必要材料から `createdNote` を構築して返す。レスポンス構築は DB/Redis/API を呼ばない。配送・検索・通知の完了を待たない。

| 同時確定するもの | 理由 |
| --- | --- |
| Note と Poll、投稿内の添付 ID・宛先・返信/Renote 参照 | 成立した投稿の内容を不完全にしない |
| 作者投稿数、対象の repliesCount/renoteCount、チャンネルの投稿数等の限定更新 | 作成/削除の再試行で二重加算しない。所属外の User/Channel 列を上書きしない |
| 必要なローカル反映・AP 展開・通知・派生反映の依頼 | 成功後のプロセス停止でも仕事を失わない |

本家では上記カウント等に遅延がある。新実装では transaction で強める意図的な差異として §7 に記録する。チャンネル usersCount は単純な投稿数と同一視せず、初投稿/削除/再投稿の本家ケースを採取して限定更新契約を確定する（N3 の完了条件）。

競合時は actor → 関係の保護対象 → channel → 参照 Note の ID 順を全更新経路で揃え、限定行ロックまたは同等の条件付き更新を使う。存在しない関係行の競合は行ロックだけでは防げないため、follow/block の更新側も同じ actor ペアのロック規約に参加する。実装時に保護対象・SQL・競合テストを揃える。共有 Service は commit しない。

操作開始時に受け取った認可を永久に固定しない。作成確定前のアカウント停止・関係更新との整合は facts の所有側で再確認する。Role は既存の更新/認可と同じ契約を用い、長い I/O 後は新しい評価境界にする。ロックを保持したまま外部のユーザー解決・HTTP・Redis 配送をしない。

COMMIT 前の確定失敗は rollback、COMMIT 応答の喪失は結果不明。HTTP 切断は取消ではない。投稿全体を内部で自動再実行しない。クライアントが同じ本文を再投稿した場合の二重作成を防ぐ独自冪等 API は追加しない。

## 5. 取得と純粋変換

`ShowNote` は Note が無ければ `NO_SUCH_NOTE`。未ログインなら作者 `requireSigninToViewContents`、server `ugcVisibilityForVisitor` の none/local を endpoint と同じ順に判定する。それ以外の visibility 非表示をすべて不存在エラーへ置き換えない。

`NoteReadPlan` は root と detail に必要な reply/renote、各作者、添付、poll/vote、reaction と閲覧者関係・設定を集合取得する。本家は reply を detail:false、renote を detail:true で pack するため、引用の引用はさらに展開される。一段に切り詰めず、階層ごとに未取得 ID をまとめて取得し、同じ ID の材料を再利用する。User の pinned Note 取得などから Note 取得へ再帰しない。破損データの循環は取得済み集合で検出し失敗として記録する。深い引用の取得予算・上限到達時のエラーは N1 の比較契約に含め、黙って部分 JSON を成功として返さない。

取得結果を業務の `NoteViewMaterials` と ID map に揃え、`renderNote(materials, viewer, now)` を純粋にする。欠落参照は本家の null/省略と合わせる。一覧への拡張でも行数ごとの DB 呼び出しを作らず、ページの ID 集合ごとに取る。`notes/show` 自体にページングは無い。TL の取得条件・cursor は N6/#129 で別に比較する。

可視性は用途を分ける。

- 返信作成等の対象判定は本家 `isVisibleForMe` 相当。followers は作者、フォロワー、返信先作者、メンション相手を区別し、remote 同士で関係不明な場合の分岐も資料に残す。
- 出力は `treatVisibility` → `shouldHideNote` → `hideNote` 相当。作者の時刻制限も評価し、隠す場合は text/cw=null、fileIds/files=[]、poll/visibleUserIds は省略、isHidden=true。作者本人の例外を保つ。
- ネストされた投稿も閲覧者別に変換する。非表示 root の内部参照を通じて本文等が返らないか、実際の本家 JSON と比較する。独自に字段を増減する修正が必要なら意図的な差異としてレビューする。
- ミュート/ブロックをすべての参照経路に共通の拒否条件として追加しない。作成対象、詳細参照、TL、通知で本家の適用箇所を区別する。

## 6. 最初の実ジョブと削除・回復

### 6.1 依頼する仕事

業務更新と同時保存する初期形式は `schemaVersion: 1`、requestId、kind、noteId、actorId、occurredAt、対象ごとの世代/順序、必要な本文・宛先材料。DB 固有/HTTP 固有の型は保存形式へ持ち込まない。生成済みの事実と、実行時に集める材料を混同しない。

| 仕事 | 固定する情報 | 実行時の確認・結果 |
| --- | --- | --- |
| AP 作成の展開 | 出来事 ID、actor、確定した Note 内容・公開範囲・localOnly、direct 宛先の識別、Create または Announce の意味 | 削除有無、federation 制限。followers/relay は最初の展開時に取得し、進捗と生成宛先を保存。再試行で展開済み集合を作り替えない |
| AP 宛先送信 | activity ID、JSON 本文/digest、actor、宛先 inbox/shared 判定、requestId | 最新の host 配送停止・許可、送信前の投稿取消。成功、恒久失敗、再試行可能、結果不明を記録 |
| ローカル通知 | 出来事と候補ユーザー ID、返信/mention/quote/renote、follow の notify による note 等の種別 | mute・thread mute・対象消失等を再確認。通知保存と依頼ごとの成立を同じ transaction で確定し一意にする |
| 投票終了通知 | noteId、投票終了時刻、依頼 ID | 実行時点の存在・投票の期限と対象を確認。削除済みは取消。期限のある poll の成立と同時に依頼し、再実行の通知重複を防ぐ |
| ローカル配信 | Note ID、出来事種別、対象レシピ | 最新の閲覧条件で構築し stream 送信。Redis Pub/Sub 自体の欠落と重複を許容。永続通知の成立とは別 |
| webhook | 出来事 ID・確定したイベント内容、hook 対象 | hook の有効性と配送制限。外部結果不明と重複を AP と同様に扱う |
| 派生反映 | noteId と世代、変更理由 | 現在の存在/状態を読み直して TL/検索等を反映。旧世代が削除を巻き戻さない |

ローカル確定内容は現在の Role に合わせて別の投稿へ作り替えない。送信時に投稿作成権限を再要求しない。取消条件は「投稿の削除」「配送停止」等、その仕事に必要なものに限定する。署名鍵の読み出しは実行時の adapter が担当する。

公開/home/followers は followers レシピ、public は relay も対象。specified は指定先を取り込んだ mention/direct が中心で、followers 一括送信をしない。返信/Renote 先が remote なら direct を追加。localOnly/channel の連合制限を先に適用する。チャンネル投稿は本家同様 public・visibleUsers=[]・localOnly=true に正規化する。sharedInbox と direct の重複排除は本家と比較し、同じ inbox へ届く別イベントを本文一致で併合しない。

followers を投稿 transaction 内で全件固定する案は大規模 actor の transaction を肥大化させるため採らない。最初の展開時点を選ぶのは本家の遅延展開に沿う。展開開始後の関係変更と分割ページの一貫性は N4 で検証し、非公開投稿で新たな宛先を増やさないよう、初回展開のスナップショット/同等の固定集合を有限のバッチで記録する。これは投稿時の関係を厳密に再現する保証ではない。

### 6.2 削除と外部送信の競合

`DeleteNote` は作者または現在の moderator を認可し、対象をロックする。Note 削除、本家と同じ意味の関連カウントの限定更新、moderator 監査、取消世代、Delete または Undo の材料・宛先復元に必要な記録、派生削除依頼を一つの transaction で保存する。削除後に Note 行が残ることへ依存しない。pure Renote は削除確定時に元投稿の存在を再確認し、存在すれば元の Announce を再現する Undo、消失済みなら本家同様 Delete(Tombstone) を依頼する。決定した種類と識別子を固定し、配送時の最新存在状態から別の出来事へ変えない。

配送進捗は `(出来事, 宛先)` を一意とし、Note ごとの作成/削除の世代を扱う。削除確定前に未開始の Create は取消し、開始済み/結果不明の Create には Delete/Undo を後続させる。削除配送は過去の確定済み宛先・不明な送信先を含め、削除時点の followers だけで漏れないようにする。本家の concerned recipients（followers、relay、mention、関連する remote 返信/Renote）も加える。公開範囲を広げる本文の再送はしない。

外部 HTTP を待つ間 DB の投稿ロックを保持しない。送信権の取得を取消境界として、削除はその権利と世代を原子的に確認する。送信権取得前なら Create は送らない。取得後なら送信が起こり得るため、作成の終端（不明含む）を待って同じ宛先の Delete を試行する。lease 切れで旧 worker が動き続け得るため、送信直前の所有権確認、タイムアウトと待機猶予を設けても、外部に届く順序と厳密な一回性までは保証しない。N4 ではこの窓を残したテストも行う。

検索/TL の現在状態反映は別契約。世代を確認してから外部 index へ書く間の競合も対象とし、宛先別直列化または外部の版付き更新と削除 tombstone により、古い作成仕事の最終完了で復活しないことを N6 で証明する。

### 6.3 #123/#124 へ渡す条件

- PostgreSQL の依頼を正とする。commit 後・Redis 投入前の停止、投入後・進捗保存前の停止を再走査で回復する。BullMQ jobId だけを恒久的な重複防止にしない。
- 通知の成立記録、展開 cursor、配送結果、取消世代は業務回復用の最小状態として `backend_internal` に置く。観測履歴を業務 DB に蓄積しない。キュー履歴削除後も保持契約内の再実行を安全にする。
- 配送は既定12試行を出発点とし、期間・backoff・送信時間上限・lease 猶予、保持期間/件数、未展開/宛先数の容量、同時数/host 別枠、手動再実行可能期間を #123 で数値まで定める。7日のキュー履歴だけを回復期限へ流用しない。期限/容量のない #124 実装へ進まない。
- 容量上限なら transaction 前/内で受理を制限するか、永続依頼を残して遅延させる。成功済み投稿の必須仕事を捨てない。エラー形式の本家との差異は明記して比較する。
- 記録廃棄は未完了・送信中・削除後続の依存を確認する。保持切れの仕事は確認可能な打ち切り状態へ移し、自動/手動の無条件再実行を禁止する。本文を含む記録は必要な期間に限定する。
- kind ごとの schemaVersion を検証する。未知版は隔離し推測実行しない。残仕事の変換・drain と旧コードへ戻せる条件は #123、完全停止での本番切り替えは #137 で扱う。

## 7. 意図的な差異とリリース上の扱い

| ID | 本家との違い | 判断・検証 |
| --- | --- | --- |
| D1 | Note 保存後のインメモリ後続起動を、同一 transaction の永続依頼にする | 基本設計の停止回復を実現。レスポンスは配送完了まで待たない。commit 前/後停止ケースを追加 |
| D2 | カウント/関係更新を作成・削除と同時確定する | 二重加算・部分保存を防ぐ。正常時最終値は本家比較、応答直後の時点差は別に記録 |
| D3 | 削除による未送信作成の取消、過去宛先への削除と順序制御 | 本家キューには投稿削除の再確認がない。保存済み Create が削除後に無条件送信される挙動を引き継がない。外部送信済みは取り消せない |
| D4 | 展開/送信の進捗・保持・打ち切りを明示 | #123 の有限保証と合わせる。数値・容量超過 API は #123 のレビューで確定する |

本家の一時的不整合や疑わしい挙動を黙って修正しない。本書で選んだ差異以外は fixture の不一致として残す。本書のマージは投稿領域のリリース可否を保証せず、未移植機能を見送り済みと分類しない。

## 8. 比較入力と受け入れ条件

実装時は Role 比較資料と同様に、固定本家/新実装を別 DB・Redis・fake inbox/webhook で動かす。外部送信はテスト受信器に限定する。時刻・ID・host・署名等の非決定値だけを明示的に正規化し、配列順、null/省略、エラー ID、隠した字段を消して比較しない。

| ID・入力/準備 | 期待する観測（本家実測で fixture 化する内容） | 実装単位 |
| --- | --- | --- |
| C1 通常 local actor、`{text:"hello"}` | public/localOnly=false/reactionAcceptance=null。createdNote と show の本文/作者/添付空。Note 1件、作成依頼1組、fake inbox の Create | N1,N2,N4 |
| C2 未認証、scope 不足、移行済/停止 actor、制限超過 | 本家共通 API エラーと検証順、Note/Poll/依頼0件。停止・移行・レート制限の例外を fixture に含める | N0,N2 |
| C3 空白本文、長すぎる本文、cw、fileIds/mediaIds 両方、不明/他人ファイル | 本家 schema/NO_SUCH_FILE、優先入力と添付順。失敗時保存0件 | N0,N3 |
| C4 public 要求、sensitiveWords 該当/canPublicNote=false | home 補正、保存・返却・AP audience に反映 | N1,N2 |
| C5 followers/specified の投稿を本人、follow、reply相手、mention相手、無関係、guest で show | 本家通りの可視/hidden。guest の server/作者閲覧制限は該当 CONTENT_RESTRICTED_*。不存在は NO_SUCH_NOTE | N1 |
| C6 reply、pure Renote、引用、不可視/不存在/pure Renote 対象 | 各 endpoint 固有 code/id、visibility 補正、reply 相手追加、カウント。pure Renote の AP は Announce、引用は対応する Create | N3,N4 |
| C7 投票 choices、expiredAfter/expiresAt、既に期限切れ | デフォルト multiple=false、期限優先順、CANNOT_CREATE_ALREADY_EXPIRED_POLL。Note/Poll が共に成立または0件 | N3 |
| C8 channel/archive/外部Renote、noExtract*、specified 宛先 | channel/scope 補正、各抽出抑止、指定相手と mention 数、外部送信制限 | N3,N4 |
| C9 localOnly、public/home/followers/specified、remote direct と sharedInbox が重複 | localOnly の AP 0件、followers/relay/direct レシピ・audience・宛先重複排除を固定本家と比較 | N4 |
| C10 作者削除、moderator削除、他人削除、pure Renote削除 | 削除認可と本家 API 結果、Note 消失、監査、Delete/Undo、deleted stream。元投稿を先に削除した pure Renote の Delete fallback と連続削除のエラーも比較 | N5 |
| F1 Note/Poll/関連更新/依頼 insert の各位置で DB 失敗 | 全 rollback。COMMIT 応答喪失は結果不明、自動で投稿を再作成しない | N2,N3 |
| F2 commit 後・queue前/queue後・進捗前に停止 | 再起動で同じ requestId の仕事を再開。通知・カウントは一度だけ成立 | #124,N4,N6 |
| F3 並行作成/削除、follow/block変更、ファイル/チャンネル削除 | ロック規約で成立条件を守る。deadlock は識別し、結果不明と混同しない | N2,N3,N5 |
| F4 Create 待機中/送信権取得直後/送信後応答喪失と削除 | 未開始は取消、開始済み/不明は削除後続。fake inbox で重複と外部順序限界を観測する | N4,N5 |
| F5 古い検索/TL作成が削除後に完了、同一通知を並行再実行 | 削除が復活せず、同じ依頼の通知は1件。別依頼の同内容を抑止しない | N6 |
| F6 未知schema、期限/容量/保持上限、host停止、4xx/5xx/timeout | 隔離/打ち切り/受理制御/再試行分類を #123 の確定値で検証。成功済み依頼を喪失しない | #123,#124,N4 |

ネスト Note、時刻による表示制限、反応/myReaction、poll vote、添付の削除/順序も N1/N3 に含める。比較用の probe・入力/期待 JSON は `docs/superpowers/compatibility/note/` に N0 で追加する。ここでは実行していない結果ファイルを作らない。

## 9. レビュー可能な実装単位と未対応の追跡

次表は #127 の子タスクとして使う分割であり、実装済みチェックではない。番号は本書内の追跡 ID。各行を個別 PR にし、必要なら対応 Issue を分割する。新規 Issue/親 Issue の更新は外部送信の許可に従い行う。本 PR では既存 Issue の本文を自動変更しない。

| ID | 変更と完了条件 | 先行依存 |
| --- | --- | --- |
| N0 比較契約 | 固定本家の実 HTTP、DB、fake inbox/stream の probe と C1–C10 の期待値を保存。未対応・意図的差異の台帳。特に App/native token、共通 gate の不足を洗い出す | #126 |
| N1 参照 | Note/Poll 等の機械同期、集合取得と純粋出力、show の閲覧条件・hidden/detail。参照中の query 数が件数比例で増えない検証 | N0 |
| N2 基本作成 | text 投稿、Role/関係の公開 facts、認証/制限、transaction と依頼、カウント、HTTP出力、rollback/競合 | N0,N1、#123 の依頼契約（永続依頼は #124） |
| N3 関連入力 | 添付・投票・返信・Renote/引用・チャンネル・MFM/メンション。関連所有者の限定更新と競合、投票終了通知の依頼、C3/C6–C8、本家チャンネル usersCount の契約を確定 | N2 |
| N4 配送 | AP表現/宛先展開/署名送信、localOnly/audience、進捗・有限 retry、宛先と世代、fake inbox、削除との競合 | #124,N2。関連形態は N3、削除は N5 と併せて完了 |
| N5 削除 | 認可/transaction/監査、取消/削除依頼、Delete/Undo の復元と配送順序、F3/F4 | N2、#124。Undo は N3、縦断確認は N4 |
| N6 ローカル反映 | 通知（投票終了を含む）の永続成立/重複防止、stream、Redis TL/検索等の現在状態反映、webhook の有限配送、F2/F5 | #124,N2。返信等は N3、削除世代は N5 |
| N7 縦断受け入れ | 作成→show→通知/配信→削除、全 C/F ケースの適用範囲、起動停止、CI 必須化、未対応台帳と #129 棚卸し照合 | N1–N6、#124。#127 の最終確認 |

最初に #123 の具体的なジョブ契約を確定し、#124 で「空の worker」から永続依頼を処理する基盤へ進める。N0/N1 と N2 の純粋判断は並行して進められるが、依頼を保存せず成功を返す暫定実装は完成扱いにしない。表中の相互参照は最終検証の依存であり、UseCase 間呼び出しやモジュール循環を許可するものではない。

| 投稿周辺の領域 | 初期フローへの扱い・後続追跡 |
| --- | --- |
| local 作成/詳細/削除、AP outbound、通知/stream/webhook | N0–N7 の対象。public のみで全体完了としない |
| TL の参照 API/ページング・検索 API、アンテナ/リスト/Role TL・タグ/ランキング/チャート | 投稿による更新は N6 で棚卸し、既存閲覧 API の移植は #128/#129、派生状態の再構築は #132/#133。未実装を落とさず台帳化 |
| AP inbound、remote actor 解決、署名検証、remote 投稿の受信/取得 | #128/#129。N3/N4 に必要な remote facts/署名鍵/安全な HTTP 送信能力は先行して切り出す。remote fixture を挿すテストだけで受信機能完成としない |
| Drive upload/削除、Poll vote、reaction、follow/block/mute の変更 API | #128/#129。既存 DB の参照対応と API 移植は区別する。投稿に必要な整合規約は N1–N6 の時点で定める |
| 編集、予約、import/export、account削除、一括削除、モデレーションの全機能 | #128/#129 で対象本家を棚卸し。通常投稿の受付/削除と混ぜず、固有の取消・回復契約を追加 |
| 本番切り替え、旧 Redis/job の drain/変換、運用観測 | #123/#137。初期フローのテスト通過で本番互換性の全範囲が完了したとはしない |

本書は #126 の設計成果。次は #123、その後 #124 と必要な N タスクを進める。#125/#127 の完了には実装・実比較・残範囲の追跡が別途必要。
