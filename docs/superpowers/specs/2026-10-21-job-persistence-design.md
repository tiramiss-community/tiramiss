# 最初の実ジョブの保存・再開・形式変更の契約

日付: 2026-10-21

対象: [#123](https://github.com/tiramiss-community/tiramiss/issues/123)。親は [#122](https://github.com/tiramiss-community/tiramiss/issues/122)、対応順は [#114](https://github.com/tiramiss-community/tiramiss/issues/114)。

状態: 設計 PR の提案。実ジョブ・独自 migration・管理 API はまだ実装しない。[基本設計](2026-10-15-misskey-backend-redesign-design.md) §7–11 と [投稿設計](2026-10-21-note-flow-design.md) §6 の契約を、#124 で検証できる保存単位・状態遷移・上限に具体化する。本書の受け入れ表は実行結果ではない。

## 1. 題材と選択

最初の題材は、成立済みローカル投稿の AP 宛先展開と宛先別 Create/Announce・Delete/Undo 配送。DB 内の一度だけの成立も検証するため、同じ出来事によるローカル通知を併せる。#124 は業務の確定内容を受ける型付き入口から保存・実 worker・fake inbox まで通す。投稿 HTTP・本家 AP 表現の全移植は #127 の N2/N4、通知条件の全移植は N6 と区別する。

| 案 | 判断 |
| --- | --- |
| PostgreSQL の依頼と対象別進捗を正とし、BullMQ は実行のきっかけにする（採用） | 業務更新と同時保存でき、Redis 投入との隙間を再走査で埋められる。二つの claim と有限な再走査が必要 |
| BullMQ の jobId と履歴だけに任せる | 履歴削除、投入前停止、DB 成立直後の停止を同じ契約で扱えない |
| すべてを DB ポーリングだけで処理する | 保存と取得は単純だが、既存のキュー管理・資源分離と BullMQ 採用方針を置き換えるため採らない |

本家調査は投稿設計と同じ `8e07cf085adf7009583d234a208e30436f020e26`。固定版の [QueueService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts) は AP の既定12試行、webhook の既定4試行、完了履歴7日/30件・失敗履歴7日/100件、キュー別 pause/resume/clear/retry/remove を持つ。[DeliverProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/DeliverProcessorService.ts) は配送制限を再確認し、応答・通信失敗を分類する。この PR はソースを確認した設計であり、本家実測 fixture は投稿 N0 で作る。

## 2. 所有範囲と依存

| 所有者 | 公開する能力・責任 |
| --- | --- |
| 投稿 UseCase | Note/Poll・必要な限定更新と `PostWorkRequests.append` を同一 transaction で成立させる。削除では取消世代と削除依頼も同時確定 |
| 配送 | 固定した出来事から宛先を計画し、配送制限と取消を確認する独立 UseCase。AP 本文の意味、成功/恒久失敗/再試行/結果不明を決める |
| 通知 | 受信条件を再評価し、通知保存と成立記録を同時確定する独立 UseCase |
| 実行基盤 | 依頼・対象別進捗の保存、投入/実行 claim、走査、上限、BullMQ adapter、停止接続。配送可否を独自に判断しない |
| composition/worker | kind と schemaVersion を検証し、業務型へ変換して適切な UseCase を呼ぶ。業務例外を進捗へ分類する |

依頼契約はデータと transaction に結び付いた append 操作だけを公開する。業務へ EntityManager、BullMQ Job、物理キュー名、再試行 API を渡さない。配送・通知・投稿の UseCase は兄弟であり相互に呼ばない。通知の DB 更新窓口と進捗更新窓口は同じ transaction を使い、adapter が独自 commit しない。

現在の `src/processes/worker.ts` は寿命の枠だけ、`internalMigrations` は空、BullMQ は新パッケージへ未導入。この事実を実ジョブ実装済みと解釈しない。独自テーブルはすべて `backend_internal`、独自 migration とその履歴を使う。本家テーブルへの列・trigger 追加や managed file の手編集はしない。

## 3. 保存する識別子と状態

以下は #124 の物理設計の基準。時刻は `timestamptz`、世代とカウンターは非負整数、ID は衝突しない文字列とする。SQL の実装ではチェック制約・一意制約・索引と併せて検証する。

| 保存単位 | 主キー・主要列と不変条件 |
| --- | --- |
| `work_request` | PK `request_id`、UNIQUE `(event_id, kind, note_generation)`。`event_id, note_id, actor_id, note_generation, kind, schema_version, payload, payload_hash, occurred_at, not_before, deadline_at, state`。確定内容と hash は immutable。kind ごとのデータ検証を行う |
| `work_item` | PK `work_id`、UNIQUE `(request_id, kind, target_key)`、request への FK。`schema_version, payload/hash, state, next_attempt_at, deadline_at, attempt_count, dispatch_owner/until/epoch, execution_owner/until/epoch, dispatch_seq, last_enqueued_at, last_outcome, reason_code, result_ref, finished_at`。対象別に進捗を保存 |
| `note_work_state` | PK `note_id`。単調増加の `generation`、`deleted_at`、作成時の公開範囲/localOnly、`recipient_coverage`（not_started/fixed/expired/unavailable）、`recipients_fixed_at`。Note が消えても配送の取消・確認に使う。Note の復元には使わない |
| `delivery_recipient` | UNIQUE `(create_event_id, inbox)`。`note_id, inbox, shared, actor_id, activity_id, send_state, retain_until`。初回集合と送信実績/結果不明の最小台帳。投稿本文を保存しない |
| `notification_effect` | UNIQUE `(request_id, recipient_id, notification_type)`。作成した通知 ID または抑止理由。requestへのFKで出来事/kind/世代の一意な依頼に結び付ける。通知の FK は削除により成立記録まで cascade させない |
| `queue_dispatch` | PK `(work_id, dispatch_seq)`。`queue_key, queue_generation, token, token_expires_at, state, reserved_at, released_at`。投入ごとの容量予約を識別し、reserved/enqueue_unknown/enqueued/retired/released を保存。古いseqも照合対象に残す |
| `work_control` / `work_capacity` | 制御対象キーを PK とする pause/queue世代、および容量の使用/予約量。容量は transaction 内の条件付き更新で確保・解放し、全件 COUNT による競合を避ける。`reserved_rows/reserved_bytes` は §6.2 の保存単位別見積りを使い、使用中と確保済み未使用分の合計を管理する。host枠は宛先host別の所有世代/leaseを持ち、有効参照がなくなって30日で回収 |

`requestId` は一つの種類の依頼、`eventId` は一回の投稿作成/削除という出来事を表す。同じ出来事から AP 展開・通知など別 kind を依頼するときは eventId を共有し requestId は分ける。同じ `(eventId, kind, noteGeneration)` の再生成は新しい依頼にせず、確定内容を照合して既存requestIdへ解決する。別のクライアント操作は同内容でも新しいeventIdを持つため統合しない。投稿作成 generation=1、削除=2 とし、形式版や所有世代とは混同しない。将来更新を増やすときも単調増加を維持する。

targetKey は展開なら `all`、AP 送信なら正規化済みの確定 inbox、通知なら受信者 ID と通知種別の組、webhook なら hook ID。組は区切り文字の曖昧さがない符号化を使う。同じ inbox に別イベントを送る仕事は別 requestId。同じ本文であることを重複判定に使わない。

AP 展開 request は `ap.expand` の集合固定 item、`ap.expand.page` のページ生成 item、`ap.send` の子送信 item を同じ requestId の下に持つ。子自身も schemaVersion を持つ。本文は一回だけ保存し参照を共有できるが、参照先は子と同じ保持・変換契約を持つ。秘密鍵、webhook secret、HTTP 認証 token は payload/queue/log に入れない。署名等に必要な秘密は実行時 adapter が読む。

requestの業務キー `(event_id, kind, note_generation)` とPKの双方、itemの対象キーに対して、同じキーへの insert は `ON CONFLICT DO NOTHING` の後で immutable 内容を照合する。hash だけを衝突のない識別子とせず、差があれば生成 transaction を rollback して不整合として扱う。既存の完了・試行回数・cursor を上書きする upsert を禁止する。同じ業務キーに新requestIdを提示しても既存requestIdを返し、そのIDでitem/notification_effectを取得・生成する。eventId/世代・kind・版・確定payload等を照合し、不一致ならhash一致の場合もrollbackする。これにより新requestIdを使った同一出来事の通知再成立を防ぐ。本文廃棄後は実体照合ができないため、同業務キーへのappendは照合不能として拒否し、既存結果の照会だけを許す。hashだけが一致しても依頼を作り直さない。業務キーだけ廃棄して成立記録を残す分離はせず、§7の依存/保持順序を守る。requestId の別業務キーへの再利用や欠落行の worker による新規作成も禁止する。

request.state は open/settled/needs_attention。初期 item の作成は依頼 insert と同時。展開完了と全子 item の終端を確認して settled にする。失敗・不明の打ち切り・隔離が一つでもあれば needs_attention とし、成功だけにまとめない。集約は再計算でき、request.state だけで実行可否を決めない。

## 4. 投入と実行のプロトコル

### 4.1 業務成立と COMMIT 結果不明

投稿 transaction は Note と依頼/初期 item/容量予約/取消世代を同じ接続で書く。commit 前の失敗は全 rollback。commit 応答喪失時は requestId を構造化ログに残し、別接続で結果を照会できるが、不在という一回の読みによって rollback 確定とはしない。HTTP 切断でも投稿を再実行しない。確定済み依頼は走査が見つける。クライアントの別 HTTP 投稿に独自の同内容統合はしない。

### 4.2 再走査と投入 claim

各 worker の実行基盤は起動時と通常5秒ごとに走査する。これは永続依頼を回収する処理で、業務の定期ジョブではない。Supervisor に同じ走査スケジュールを重ねて登録しない。複数 scanner が動いても DB claim で分担する。

1. `next_attempt_at <= DB時刻 < deadline_at` で実行 claim が無い/期限切れの未終端 item を、索引順に最大100件選ぶ。さらに投入claimが無い、または `dispatch_until <= DB時刻` であることを選択条件と条件付きUPDATEの双方に含め、queue制御と合わせてtransaction内で再確認する。`FOR UPDATE SKIP LOCKED` と条件付き更新で dispatch_owner、until=現在+30秒、epoch+1、dispatch_seq+1 を確定する。同じitemの有効な投入claimを上書きせず、競合するscannerの一つだけがこの更新と次項の容量予約を確定できる。
2. 同じtransactionで `(workId, dispatchSeq)` の queue_dispatch と容量予約を作る。transaction を閉じ、queue には workId・kind/schemaVersion・dispatchSeq・queue世代だけを渡す。BullMQ jobId は workId と dispatchSeq の安定した符号化。1回の投入操作の再送では同じ値を使う。内容は PostgreSQL から読む。
3. enqueue 後は dispatch epoch/owner に条件付けて時刻を記録し投入 claim を解放する。実行中へは変えない。enqueue 後・DB 保存前の停止なら次回は別 dispatchSeq で重複し得る。
4. 投入済みでも開始確認が無い item は60秒後に再投入候補とする。別seqを発行する場合も既存seqの予約を推測解放せず、追加予約を必要とする。Redis 消失・削除・完了 entry の残存を正本にしない。有効な実行 claim 中は再投入せず、投入/queue entry の数は業務試行数へ加算しない。

### 4.3 実行 claim と DB 内の成立

worker は DB の item を読み、payload と版を検証する。終端/欠落なら副作用をせず終了。未来の実行時刻・pause・有効な別実行所有者なら同じく副作用をせず、その queue entry の終了だけを記録する。DB の未完了状態は残り、適切な時刻に再走査される。

pause・not_before・削除の前件待ち・host枠不足は実処理を開始しない待機であり、next_attempt_at だけを更新して試行を消費しない。前件が未終端のDeleteをFIFO順だけで開始しない。実行可能なら共通ロック順で前件/世代とhost枠を確認し、必要なhost枠のlease取得、execution_owner/until/epoch の条件付き更新、attempt_count の1増加を一つの短いtransactionで行う。いずれかが取れなければ全rollbackし、無消費の待機に戻す。claim 直後停止も1試行として数える。期限切れ回収でも回数・最初の期限をリセットしない。DB 時刻を権威とし、実行 lease は60秒、10秒ごとに条件付き更新する。各処理段階で新しい現在時刻と最新の必要条件を評価する。

通知の場合は **note_work_state → item 行の順にロック → owner/epoch/lease・取消・通知条件の確認 → 通知と notification_effect を insert → item 成功** を一つの transaction にする。同じ item の旧 worker による確定は owner/epoch/有効期限の条件で拒否し、通知も rollback する。commit 応答喪失なら次の処理は成立記録を照会し、同じ通知を作り直さない。通知がその後ユーザーに削除されても、成立記録から再作成しない。

### 4.4 外部送信

送信開始前に item と note_work_state を短い transaction で確認し、送信権・開始時刻・attempt を記録する。共通ロック順は **note_work_state → work_item（ID順）→ 容量/host枠**。通知のように note を確認する仕事もこの順に合わせる。外部 HTTP の間は DB ロックを保持しない。

送信直前にも所有世代・取消と取得済みhost枠のleaseを再確認し、固定 activity/event ID・固定本文/digest を送る。応答後は所有世代に条件付けて結果と recipient 台帳を更新する。実行権を失った旧 worker は結果を上書きできない。claim が切れた sending は unknown として回収し、送信していないと決め付けない。通知と異なり、DB claim は相手サーバーの受信を制御できない。

| 状態/結果 | 次の処理 |
| --- | --- |
| ready/retry_wait | 時刻・回数・期限・制御条件が揃えば running |
| running → succeeded | DB 内の成立、または外部の成功応答を確認。自動再実行しない |
| running → skipped/cancelled | host 配送禁止/停止、削除済みの未送信 Create、通知条件不成立等。理由を区別して終端にする |
| running → retry_wait | 再試行可能失敗。next_attempt_at を保存して実行権を解放 |
| sending の応答喪失/lease失効 | last_outcome=unknown。予算内なら固定内容で retry_wait、予算切れなら exhausted_unknown |
| 恒久失敗/予算切れ | failed_permanent/exhausted。自動再実行しない |
| 未知kind/版/破損形式 | quarantined。推測実行せず確認対象 |

終端は succeeded/skipped/cancelled/failed_permanent/exhausted/exhausted_unknown/quarantined。手動再試行で開ける範囲は §7 に限定する。retry_wait の last_outcome=unknown と打ち切った exhausted_unknown を区別する。外部受信の重複・順序逆転をゼロと保証しない。

## 5. 宛先展開・削除・古い仕事

最初の AP 展開は、初回の一つの DB snapshot で候補 inbox を `INSERT … SELECT` により台帳へ保存し、recipient_coverage=fixed と同時確定する。follow/relay/direct の規則は投稿設計 §6.1 に従う。外部 actor 解決が必要なら先に材料を用意し、展開 transaction 中に HTTP をしない。20秒で終わらない場合は全 rollback し、予算内で再試行する。未確定の途中集合を配送に使わない。次の試行は最初に成功した snapshot を固定点にでき、commit 後は followers を再取得して集合を拡大しない。

集合の固定と取消は note_work_state を先にロックして調停する。集合固定itemの成功と最初の `ap.expand.page` item の生成を同時確定する。ページのtargetKeyは確定集合の開始cursor（初回は固定の先頭値）とし、最大100宛先の `ap.send` item、次ページitem、現在ページの成功を一つのtransactionで確定する。成功後は実行枠を返す。正常継続は別ページの初回実行であり、前ページの失敗予算を消費しない。各ページは合計8試行を上限とし、root requestのdeadlineを全ページ/送信へ引き継ぎ、ページ生成時に延長しない。snapshot 台帳の宛先順で再開し、成功ページを再処理/初期化しない。最大20万宛先/出来事を超える場合は切り詰めず確認対象とする。数の上限・容量不足と snapshot timeout を別の理由にする。

削除は generation を上げ、未送信 Create/Announce の claim・子生成を止め、Delete/Undo 依頼を同時保存する。大量 item の更新を削除 transaction で行わず、generation の確認により送信を禁止する。public 以外の削除先は初回集合と送信済み/不明台帳だけ。public は投稿設計の concerned recipients を加えられる。localOnly/channel は0件。台帳が無ければ非 public を現在の followers 等で補わず、recipient_coverage を unavailable/expired として確認対象に残す。

同じ note/inbox の削除は、開始済み Create の成功・失敗・不明の終端を待つ。削除確定後は Create の unknown を再送しない。不明な sending の lease が切れてから追加30秒の猶予を置き、結果不明を終端として Delete を実行できる。削除依頼の期限は削除時点から独立して持つ。旧 worker が外部へ遅れて送る窓は残るため、fake inbox でその制約を観測する。単に queue の FIFO を根拠にしない。

本書は AP/通知の具体契約を確定する。検索/TL の旧仕事が削除を復活させない外部 version 条件・直列化は N6/#132 で各 adapter ごとに証明する。AP の claim だけで検索への fencing も完成したとは扱わない。

## 6. 回数・期間・負荷の既定値

以下は #124 へ渡す初期既定値。測定済みの処理性能ではない。`backendNext.jobs` 設定領域で調整可能にし、正数・範囲と lease/timeout の整合を起動時に検査する。既存 `deliverJobMaxAttempts` は AP の回数へ引き継ぐ。上限値を緩める変更では保持・容量・障害テストも更新する。

| 対象 | 既定値と打ち切り |
| --- | --- |
| AP送信 | 合計12試行、実行可能時刻から24時間。各送信 HTTP 全体20秒、実行 lease 60秒。timeout/通信断は unknown |
| 展開・通知・派生反映 | item当たり合計8試行、rootの実行可能時刻から24時間。展開は集合固定と各100件ページを別itemにし、正常継続で失敗予算を使い切らない。DB処理20秒。通知の受信者別itemもroot期限を継承。派生 adapter の外部保証は N6 で別途検証 |
| webhook | 合計4試行、実行可能時刻から1時間、HTTP20秒。AP同様に unknown を区別。hook無効化は skipped |
| stream | 最大1試行、5分以内。欠落/重複を許容し、Pub/Sub失敗を永続通知の失敗へ変えない |
| 投票終了 | not_before=確定した終了時刻。その時刻から24時間/8試行。未来の投票を起動時に前倒ししない。遠い終了時刻の依頼も容量枠に含める |
| backoff | n回目の失敗後 `min(60秒 × 2^(n−1), 1時間)` に0–20%の加算 jitter。next_attempt_at が deadline 以降なら exhausted。webhookも同式。DB時刻の期限が優先 |
| 走査/投入 | 5秒周期、100件/回、投入claim30秒、開始未確認の再投入60秒。処理中の投入枠はプロセス当たり最大100件 |
| 実行同時数 | worker当たり AP16、通知/展開などローカル4、user webhook4。host当たり AP2/webhook1をDB lease枠で全worker共有。1hostが全枠を占有しない |
| Redis待機量 | 各物理queueの待機/遅延/activeと投入未確認予約の合計1万件を上限とする。queue_dispatch単位の予約と下記の原子的投入/失効で守る。空きがなければ投入を遅らせ、DBの未投入依頼を捨てない |

HTTP 成功は2xx。恒久/再試行可能 status の境界は固定本家の `StatusError.isRetryable` と比較して N4 に移植し、少なくとも 410(sharedInbox)・429・5xx・DNS/timeout のケースを含める。429 の Retry-After は残る deadline を超えない範囲で backoff より長い待機にできる。配送禁止・host停止は本家同様 skip とし、自動で待機を無期限延長しない。連続失敗は backoff と host枠で抑え、優先度を下げる共通規則は採らない。削除は元の仕事の後続条件を守り、優先度だけで追い越さない。

### 6.1 queue予約の解放と照合

DBの予約だけでは、予約解放後に遅れたenqueueが届く競合を防げない。BullMQ adapter は Redis 側にもqueue世代とdispatch tokenを置き、**有効token/世代の確認と同じjobIdのqueue追加を同じ原子操作で行う**。通常の「確認してから別のadd」にはしない。ライブラリ固有の実装はadapter内に閉じ、#124で採用版BullMQとの結合検証を行う。この原子境界を実現・検証できるまでは厳密な容量上限を満たしたとしない。

tokenの絶対有効期限は予約時刻+60秒としてDB予約に固定し、延長・同じseqの再発行を禁止する。Redis側の初期発行・再初期化・queue追加の全経路で、queue世代とこの期限をRedis時刻で検証する。期限切れはtokenが欠落していても拒否し、再走査は新seq/新予約を必要とする。DB/Redisの時計差が5秒を超える場合は投入開始を止め、時計修正後に期限を照合する。相互の時計が同期していることを運用前提にする。失効tokenのtombstoneは元の絶対期限まで残し、それ以降は期限検証で再有効化を拒否できるため削除する。token情報の件数は有限のqueue_dispatch記録数以下とし、TTLを延長する再発行で増やさない。

予約を解放する際は先にRedis側tokenを原子的に失効させ、対象entryの終了/除去を確認してから、DBの当該queue_dispatchを released へ条件付き更新する。同じtransactionで容量を1戻す。二重の終了通知や複数scannerによる照合でもreleasedから再解放しない。enqueue応答不明・token失効応答不明では予約を保持し、同じseq/tokenを照会・再試行する。未投入/終了を確認できないだけで空き枠に数えない。entryの終了とDB成立は別なので、重複entryの終了でitemは成功にしない。

Redis全消失時は既存の障害経路で子を停止する。再起動後、受付/投入開始前にDBのqueue世代を上げ、新世代のRedis gateを初期化し、古い世代を拒否する。旧entryが残る場合は実行せず照合・除去し、旧予約を一度だけ解放してから新世代で再投入する。未知のqueue entryも検証前に実処理へ渡さない。初期化/照合失敗時は起動失敗とし、予約を全てゼロ扱いにして継続しない。照合は最大100件/回でDB・Redisの応答を確認し、世代変更と通常投入を競合させない。

### 6.2 容量と受理

DB の基盤状態は全体100万行/20 GiB（request/item・payload・宛先台帳・成立記録・dispatch予約を含む論理サイズ）を上限とする。依頼と初期payloadは最大2 MiB、個々の AP/webhook 本文も最大2 MiB。展開集合は最大20万宛先/出来事、基盤状態全体の件数枠を予約してから固定する。未知の展開件数は上限+1までの集合取得で検出し、同一transaction内の予約が取れなければ全 rollback。ページ分割で容量を超過しない。実際のDBディスク上限・空き容量も観測し、論理容量だけでディスク安全性を保証しない。

20 GiB は次の **論理予約bytesの合計** に対する上限であり、ディスク上の厳密な実サイズではない。各保存単位は `charged_bytes = align1024(4 × (base_bytes + variable_bytes))`、`align1024(x)=1024 × ceil(x/1024)` で課金する。4倍は行ヘッダー・ページ余白・通常索引・TOAST等の付加領域を見込む初期係数であり、常に実サイズを上回る保証ではない。#124の代表/最大サイズデータで `pg_total_relation_size`（索引・TOAST込み）と比較し、過小見積りなら係数を引き上げる。圧縮による割引はしない。

| 保存単位 | base_bytes | variable_bytes と予約時点 |
| --- | --- | --- |
| request / item | 1024 / 1536 | ID・kind・targetKey・外部参照等のUTF-8 byte数と、行内payloadの確定JSONをUTF-8化したbyte数。作成transaction前に算定 |
| 共有payload | 256 | 確定JSON/本文のUTF-8 byte数。物理的に独立保存する場合は一つの行だけを課金し、参照元は参照IDだけを課金。行内に複製する実装なら各複製を全額課金 |
| 宛先 / 通知成立 | 512 / 256 | inbox・actor・activity ID / 受信者・通知種別・通知IDの最大UTF-8 byte数。集合固定/通知成立のtransactionで予約 |
| dispatch予約 | 512 | work/queue ID・tokenの最大UTF-8 byte数。各seqの予約transactionで確保 |
| note状態 / 制御・host枠 / 内部の管理操作進捗・対象関連 | 256 / 256 / 1024 | 対象ID・queue/host・操作ID等のUTF-8 byte数。動的行は生成時、固定の制御/容量行はmigration時にbaselineとして予約 |

base_bytesは固定列とライフサイクル中の進捗・理由・所有者・時刻の最大幅を含む。理由は列挙codeと最大256 byteの要約、owner/token/IDには列ごとのbyte上限を#124のschemaで設定し、無制限のstacktrace/ログを保存しない。可変の未確定列はschema上限で予約し、確定後に減額できる。上限を超える更新は事前に差分を追加予約し、取れなければ更新全体をrollbackする。外部送信後の結果記録に必要な列は送信前に最大分を確保しておく。

各課金行には `capacity_formula_version / charged_bytes` を保存し、減額・削除は現在の係数による再計算ではなく保存した予約額を基準にする。係数・算定規則の変更は完全停止下で全課金行の再見積り、保存額と集約カウンターの更新・照合を行ってから再開する。新見積りが上限を超えたときは受理を再開せず、清掃または明示的な上限見直しが必要になる。

行数とbytesは同じtransactionで条件付き加算する。宛先の集合固定は取得した全件分、ページ生成は子item/次ページ分を事前予約し、競合insertで既存行を再利用した分はそのtransaction内で返す。rollbackは予約もrollback。終端化だけでは解放せず、本文削除/行削除と同じtransactionで対応するbytes/行数を一度だけ減算する。共有payloadは最後の有効参照の削除まで全額保持する。dispatchのqueue枠の解放と、7日保持するdispatch行のDB容量解放は別々に管理する。

物理容量は論理枠と別に、DB volumeの空きbytes/全体bytesとDB・対象relationの実サイズを60秒ごとに監視する。空きが `max(2 GiB, volume全体の10%)` 未満、または空き情報が120秒以上不明なら、新規業務受付と容量を増やす展開/生成を止め、清掃・既存状態の照会は続ける。閾値回復を確認して再開し、実DBの書込み失敗は従来どおりrollback/結果不明で扱う。publicのModerationLogはジョブの20 GiB/100万行枠から外し、既存の監査保持方針とこの物理容量監視に含める。WAL・他のpublicテーブル・bloat・backupの使用量はこの論理枠に含まれないため、4倍係数や20 GiBだけを物理ディスク安全性の判定にしない。監視値の供給と専用環境での閾値検証は#124、配布環境への接続は#137の必須条件とする。

全容量の10%は削除・取消依頼とその宛先に予約し、通常作成から利用しない。通常受付が90%に達したら投稿成立前に受理制限する。展開容量が後から不足した場合は依頼を retry_wait に残すが、24時間で exhausted として必要な仕事の未完了を確認対象にする。本文上限/容量に達しても成功済みの仕事を切り詰めたり黙って捨てたりしない。削除用枠も満杯なら、削除と依頼の transaction 全体を失敗させる。ローカル削除だけを成功扱いにしない。

一時的な容量不足は業務例外 `WorkCapacityExceeded` を HTTP adapter で **503、code=`BACKEND_BUSY`、id=`3ba27d7e-a4eb-4ae9-89ad-152bc40aad2d`、message=`The server is temporarily busy. Please try again later.`** とする提案。2 MiB超過は別の `WorkPayloadTooLarge` とし、**413、code=`WORK_PAYLOAD_TOO_LARGE`、id=`5cde2882-f54c-4e85-b0e4-9294ba269a6b`、message=`The work payload exceeds the size limit.`** を返す。同じ入力の再送では直らない非再試行エラーで、Retry-Afterを付けない。認証/認可・本家の入力検証の後、確定payloadのサイズ検証、容量予約の順に判定する。両条件に該当するときは413。commit後に初めて生成した本文が上限超過なら当該itemをfailed_permanent/理由payload_too_largeとし、既存投稿のHTTP応答を変更せず確認対象にする。本家との差異として N0/N2/N5 で413/503のJSON・検証順・失敗時保存0件を固定比較する。commit 後の容量不足で503を返し直さない。容量を解放するまで受理制限が続くことは、有限保存の代償として運用に明示する。

## 7. 保持・確認・手動操作

| 記録 | 保持と廃棄条件 |
| --- | --- |
| BullMQ観測履歴 | 本家と同じ完了7日/30件、失敗7日/100件を出発点とする。上限の先着側で消える。回復や重複防止の正本にしない |
| 終端request/itemの本文 | 終端から7日で削除。結果不明/失敗は理由とIDを残す。手動再実行の受付はこの期間内だけ |
| 重複防止・通知成立・最小結果 | 終端から30日、本文なし。終端子/親・有効claim・削除後続の参照を調べてから廃棄。台帳など別の依存がある間は先に参照を最小化 |
| 作成の宛先台帳 | 固定時から90日。本文なし。削除依頼が期間内に参照を確保したら、その依頼の終端+30日までは延長可能。全体容量枠を消費し続ける |
| 取消世代・coverage | 最後の依存item/宛先を廃棄した後30日。廃棄後は missing と expired を同じ「復元不可」に扱い、非publicの最新宛先を推測しない |
| 隔離・打ち切り | 本文7日・最小結果30日。同じ時間制限と容量枠を使い、無期限に残さない。廃棄前に件数/理由別集計と構造化ログを出す |
| queue_dispatch | 予約解放済みの記録は7日。失効したtoken/queue世代により遅れたenqueueを拒否し、記録廃棄後に同じseqを再利用しない。未確認予約は期限切れでも先に失効・照合を完了してから解放する |

廃棄前に全依存が終端かを確認し、未完了が期限超過なら先に exhausted/exhausted_unknown にする。pause/quarantine も deadline を止めない。poll の未来の not_before は例外で、まだ実行期限が始まっていない。清掃は最大100件/回・1分間隔で行い、所有する状態の回収として worker の寿命に接続する。停止中は保存期間を超えて物理行が残り得るが、再起動時は実行前に期限判定し、容量上限を維持する。

遅延 queue entry が廃棄後に届いても、欠落 request/item から仕事を再生成しない。これにより短い Redis 履歴に依存せず同じ仕事の復活を防ぐ。90日を過ぎた投稿や移行元に台帳が無い非 public 投稿は、ローカル削除・削除依頼は成立しても配送先復元不可を needs_attention にする。最新 followers への拡張はしない。この配送可能期間の制限は意図的な差異であり、#137 の切り替え/運用文書と N5 のテストに引き継ぐ。

管理者は requestId/workId/eventId/noteId、state、attempt、次回時刻、deadline、reason、unknown有無、coverage を照会できる。本文・inbox・受信者IDを通常ログへ無制限に出さない。構造化ログの保持上限は既存基盤/運用側で設定し、業務テーブルをログの代用にしない。期限/容量/unknown/隔離/台帳消失は件数と最古待機時間を観測する。

手動再実行は **元の requestId/workId・固定本文・試行回数・deadline を維持** する。retry_wait は次回を現在へ早められるが、上限超過、期限切れ、succeeded/cancelled、形式未対応、本文廃棄後は拒否。failed_permanent は原因解消を明示した管理操作で、残り予算がある場合だけ再開できる。unknown は重複リスクの表示を必須にする。予算をリセットする「再試行」や、別requestIdによる自動複製は用意しない。打ち切り後は結果確認や N6 の派生再構築、#137 の個別復旧判断へ渡す。

### 7.1 管理操作の認証・対象・監査

ここでいう管理者照会は、固定本家のqueue endpointと同じ **現在のmoderator以上（administratorを含む）** に限る。通常ユーザーは自己の投稿に関する依頼でも照会できない。native token/App/access tokenの資格・停止アカウント・scope判定は既存の共通認証とRole資格の契約を使い、App/access tokenには次表のscopeを要求する。native tokenには既存と同じscopeの免除規則を適用する。新しい管理用の認証迂回路は作らない。

| 操作 | 必要scope・範囲 |
| --- | --- |
| list/stats（jobs/queues/queue-statsを含む） | `read:admin:queue`。実装済みqueueだけの状態/件数、ID・進捗を返す。全ローカルactorの仕事を運用対象にできるが、queue指定で絞り、listは最大100件/ページ |
| show/log | `read:admin:queue`。指定queueに属するwork/requestだけ。IDだけ指定して別queueへ越境しない。logは最大100件/ページのcode・時刻・試行・結果要約。固定payload/投稿本文、secret、raw外部応答/stacktraceは返さない |
| pause/resume/retry/promote/remove/clear | `write:admin:queue`。指定queueとその対象だけ。最新資格と状態/予算をtransaction内で再確認し、§7の再実行制約を通す |

この内部ジョブ照会のlist/show/logでは完全なinboxと受信者IDは返さない。配送先はhostのみ（URLのpath/query/userinfoは省略）、受信者は一律`[redacted]`とし、仕事の区別にはworkIdを使う。secretや本文は資格に関わらず返さない。既存QueueJobが公開するpayload項目との差分は意図的差異として#124/#129の比較表へ記録し、旧API互換と無条件に扱わない。通常ログにも同じ表示規則を適用する。

外部到達可能な照会はactor単位でread全操作を合算して60回/分、write全操作は20回/分、未認証はIP単位で60回/分を上限とする提案。認証/資格/scopeはデータ取得前に検査し、レート制限超過は既存共通の429形式へ変換する。Redisで全HTTPプロセスに共有し、障害時は制限を迂回して継続しない。list/logのページ上限とレート制限は本家との差異としてfixture化する。

状態変更は操作ID・実行者・queue・対象ID/選択条件・変更前後・理由・時刻を、DB状態変更と同じtransactionで永続監査へ記録する。retryでは元の試行数/deadline、unknownを含むremove/clearでは結果不明の注意を残す。bulkは1操作の監査と対象との関連を保存し、進行cursorと各バッチの状態変更を同時確定する。DB制御後のRedis調停失敗も操作IDで追記し、監査が無ければ成功応答を返さない。監査はpublicの既存ModerationLogの保持方針に従い、§6.2のジョブ論理容量枠には算入しない。内部に保存するbulk操作の進捗・対象関連だけは論理枠へ算入し、終端後は最小結果として30日保持後に削除する。両者を同一の記録として混用しない。監査への本文/inbox/受信者IDの転記はしない。資格拒否は業務状態を変えず、秘匿した失敗理由だけを通常ログへ残す。

本家の [show-job.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/show-job.ts) / [retry-job.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/retry-job.ts) を含む固定版のqueue endpointでmoderator資格とread/write scopeを確認した。全状態変更の同時監査は本家で未統一の箇所も補う意図的差異。資格・scope不足・対象queue違い・マスキング・レート上限・監査rollbackは#124の受け入れ対象とし、API/画面移植を#129で照合する。

### 7.2 物理キューと既存管理操作

AP は旧 `deliver`、user webhook は旧 `userWebhookDeliver` の制御範囲を維持する。ローカル通知/展開用は `postLocal`、poll は旧 `endedPollNotification` に割り当てる。AP宛先展開は deliver 停止中に子送信を増やさない。AP と webhook は外部host遅延の隔離、ローカル仕事は短い待ち時間の確保が分離の理由。system webhook等の未移植queueを実装済みのように返さない。

pause/resume は対応する `work_control` と BullMQ を接続する。DB制御を先に確定して新claimを止め、Redis操作が失敗したら不一致を表示して再実行で調停する。pause は開始済み送信を取消さない。無関係なqueueは止めない。retry/promote は §7 の予算・形式・期限確認を通し、管理APIから直接 BullMQ を操作して迂回しない。

remove/clear は観測履歴だけの除去と、未完了仕事の明示的取消を分ける。後者は DB を cancelled にした上で entry を除去するため、走査で勝手に復活しない。開始済み外部送信は止まらずunknownを残し得る。成功済み投稿の必要な配送を管理者が打ち切った事実を表示する。本家のqueue削除そのものとは保存モデルが違う意図的差異として比較する。list/stats/show/log は DB の業務状態と BullMQ の輸送状態を区別して表示し、既存フィールド/権限/エラーの対応 fixture を #124 で採取する。新API/管理画面の移植完了は #129 と照合し、基盤だけの完了で互換としない。

## 8. 形式変更・切り替え・旧コードへ戻す条件

初期の `ap.expand`、`ap.expand.page`、`ap.send`、`notification.create` は各 schemaVersion=1。poll/webhook/stream/派生は投稿設計の登録時に各version=1の形式と検証を追加する。kind、schemaVersion、必須項目、値域、immutable内容を検証し、未知形式は quarantine。期限切れや管理者操作でも未対応形式を推測実行しない。

番号を上げる変更では、PR に「読める版、書く版、残数、変換方法、戻せるコード」を記録する。初回変更は新コードが旧/新版を読めるよう先に用意し、完全停止下で schema とreaderを更新する。全プロセスが新readerになった後に writer を新版へ切り替える。対応するのは現行と直前版を最長30日の移行期間とし、残仕事には元の期限を適用する。未来のpollなど30日でdrainできないものは停止中に変換し、放置しない。

事前変換はバックアップ・dry-run件数/hash照合の後、最大100件/transaction、request/item の型と参照を揃えて行う。ID・出来事・recipient集合・回数・期限・結果は維持する。意味を保存できない変換は quarantine とし、成功扱いにしない。送信済み/unknown の本文・activity/event ID は変換で変えない。新形式で再送本文の互換を保てなければ、その残仕事を処理/打ち切り確認するまで切り替えない。

旧コードへ戻すには全プロセス停止、新writer停止、残っているrequest/子itemと参照先の版を集計し、旧readerがすべて解釈可能でschema互換もあることを確認する。不可逆変換・新形式残存時は単なるbinary rollbackを禁止し、readerを残した修正版で回復する。DB backupへの復元は外部送信済み事実を巻き戻せないため、配送の再発行を伴う個別復旧判断になる。Redisは保存したIDから再投入できるが、旧backendの既存queueの移行/破棄判断は #137 で別に決める。新基盤が旧queueを無条件に消費しない。

## 9. #124 以降の実装単位と受け入れ

以下は既存 Issue 内の分割 ID であり、新 Issue はこの PR で起票しない。

| ID | レビュー可能な単位・完了条件 | 依存 |
| --- | --- | --- |
| J1 保存 | 型付きAP/通知依頼、独自migration up/down/登録、unique/容量/世代、同一接続transaction、保持索引。実DBでrollback・commit応答不明を検証 | #123 |
| J2 投入/実行 | BullMQ導入、二つのclaim・走査・制御・試行予算・資源枠、実workerと寿命。固定出来事を業務transactionから受けfake inboxへ送り、通知結果を同時確定。空handlerだけにしない | J1 |
| J3 競合/運用 | 削除世代・台帳・重複・停止・上限・未知版・移行/rollback事前検査・照会/手動操作・清掃。実DB/Redis/BullMQの専用CI必須化 | J2 |
| 投稿N0/N2/N4/N5/N6/N7 | 本家比較fixtureと実API/完全な表現・宛先条件・署名・通知・派生へ接続して縦断検証 | J1–J3、投稿設計の依存順 |

#124 の試験 producer は実際に保存された固定の投稿事実と同じ transaction で依頼を作る。必要な本家Entityは機械同期して利用し、独自の偽Noteテーブルを製品基盤へ追加しない。#127 の投稿APIの完了とは区別する。実装用の細かなファイル/コマンド計画は #124 着手時に作る。

| ケース | 必須の観測 |
| --- | --- |
| 業務保存前/依頼insert時/commit応答喪失 | rollback時は業務・依頼0、不明時は投稿再作成なし。確定依頼を同じIDで検出 |
| commit後queue前、enqueue後DB前、queue全消失 | 再走査で進行し、重複entryでも通知1件・固定activity ID。廃棄済みIDは副作用0 |
| 二つのscanner/worker、lease切れ旧worker遅延 | 対象一意、同じitemの投入claim/seq/容量予約を確定できるscannerは一つ。有効投入claimを上書きせず、期限切れ回収後の旧epoch確定は0。owner/epochを失ったDB確定は0。queue重複終了で正本を成功にしない |
| 外部受信直後応答喪失/結果保存応答喪失 | unknownと固定本文の再送を観測。fake inboxの複数受信をDB内成立と区別 |
| 展開中follow変更・途中停止・20秒/20万件/容量超過 | 成功snapshotを再利用、cursor再開。1000宛先以上の正常継続で8試行に達しない。失敗ページだけ再開しroot期限を延ばさない。上限超過を切り詰めず、台帳と容量予約が部分commitされない |
| 展開前/送信権前/後の削除・旧Create遅延 | 未開始Createは0、開始済み/unknownの後にDeleteを試行。非publicの追加宛先0、public/localOnlyを別確認 |
| 別eventIdで同内容、同eventId/kind/世代で別requestId、同キーで別payload | 別eventIdは別仕事。同じ業務キーは既存requestIdへ解決し通知1件、本文廃棄後のappendは拒否して照会のみ、異kindは別依頼。不一致payload/hashは生成transaction全体をrollback。終端/成立記録の上書き0 |
| host停止、host枠不足/Delete前件待ち、410、429、5xx、timeout、上限試行直前停止 | 資源/前件待ちだけではattempt増加0。実行claim後停止は1消費。分類・backoff・累積回数・deadlineを維持。1hostが全資源枠を占有しない |
| 容量予約の並行確保、共有payload、本文/行の清掃、サイズ超過と混雑の同時発生 | 共有分は1件課金、保存したformula版/charged_bytesによる差分/削除の一度だけ解放、係数変更時の停止下再見積り、rollbackで予約残0、論理bytesの上限と物理閾値を別検証。両条件該当は413、容量不足だけなら503、いずれも成立前失敗は保存0 |
| 管理照会/変更の資格・scope・queue・表示・頻度・監査 | 通常ユーザー/不足scope/別queue対象の拒否、inbox path/受信者/本文の非返却、ページ上限/429、状態変更と監査の同時rollback。Redis調停失敗を同操作IDで照会可能 |
| enqueue応答喪失、遅れた投入、重複終了、Redis全消失 | seq単位の予約が一度だけ解放、失効後の遅延token初期化とtoken廃棄後enqueueは0、新世代開始前の照合、上限超過0。予約待ちでDBの必要な依頼を失わない |
| pause/remove/clear/retry、期限超過/容量満杯 | 独立queueの制御、取消の非復活、予算迂回0、原子的受理制限。終端理由を照会可能 |
| 版不明/破損payload、v1→v2、旧readerへ戻す検査 | 副作用0/隔離、意味とIDを保持した変換、未対応残数があるrollback拒否 |
| 本文7日/成立30日/宛先90日、遠いpoll | 廃棄後再生成0、台帳消失の非public削除を確認対象にする。pollを前倒し/期限延長しない |
| shutdown/強制終了/Redis障害 | 取得・走査停止→受理済み待機→接続解放。既存終了期限内に終わらなければ不明として回収。DBへの縮退なし |

テストは注入時刻と停止点を使って境界を検証し、実時間で90日待たない。#124 の必須CIと #127 の本家比較は補完関係。#132/#133 の再構築、#137 の実運用・移行と容量値の調整は後続に残し、実ジョブ基盤ができただけでリリース可能とは扱わない。
