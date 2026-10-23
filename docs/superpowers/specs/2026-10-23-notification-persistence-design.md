# 投稿通知の保存正本と成立記録

日付: 2026-10-23

対象: #124（親 #122、対応順 #114）。状態: **PostgreSQL 保存をユーザー承認済み**。本書の受け入れ条件は実装結果を示さない。

## 解決する差異

[ジョブ設計 §4.3](2026-10-21-job-persistence-design.md#43-実行-claim-と-db-内の成立) は、実通知・notification_effect・item 成功を同じ PostgreSQL transaction で確定する。一方、固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の [NotificationService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NotificationService.ts) は、`notificationTimeline:<userId>` Redis Stream に `XADD MAXLEN ~ perUserNotificationsMaxCount` で JSON を保存する。[MiNotification](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/models/Notification.ts) は union 型であり、同期可能な通知 Entity は存在しない。

本家の保存方式のままでは DB の成立記録と通知実体を原子的に確定できない。Redis 書き込みを DB transaction の中で呼んでも、この問題は解消しない。

## 推奨案と代案

推奨は `backend_internal` に通知実体を置き、DB 同時確定の契約を維持すること。これは通知の正本を Redis から変える意図的差異であり、基本設計の「業務データ構造を再設計しない」方針に対する個別の判断としてユーザーが承認した。本家 public の定義・migration は変更しない。

Redis 正本を維持する代案では、DB の依頼から外部副作用として保存し、結果不明・再送・ユーザーによる削除・Stream の切り詰め後の再生成を扱う必要がある。現在の同時確定の保証を変更するため、単に保存アダプタを差し替える実装にはしない。

通知の ID だけを DB に記録して実体を Redis に書く案は、通知実体の DB 同時確定を満たさないため、同時確定の保証を維持する場合は採らない。

## PostgreSQL 案の所有と成立境界

通知モジュールが実体を所有し、実行基盤が成立記録と進捗を所有する。業務へ TypeORM / BullMQ を公開しない。呼び出し元が transaction を所有し、限定更新窓口は独自 commit しない。

- `backend_internal.notification`: 通知 ID、受信者、種別、作成日時、通知元、Note ID、種類固有の必要材料。通知一覧の実体となる。
- `backend_internal.notification_effect`: UNIQUE `(request_id, recipient_id, notification_type)`、通知 ID または抑止理由、成立日時、容量課金。request への FK を持つ。通知削除に連動して成立記録を消す FK は付けない。
- 共通ロック順は `note_work_state → work_item → 容量`。既存 `withLocalWorkCompletion` の中で最新の通知条件を確認し、実体・成立記録・item 成功を確定する。
- 旧 owner/epoch、lease/deadline 失効、取消世代の更新は保存を拒否する。最終進捗更新で権利を失っていれば実体と成立記録も rollback する。
- 成立記録が存在すれば、その記録を参照して終了する。実体がユーザー操作等で消えていても再生成しない。既存の結果を upsert で置き換えない。
- commit 応答不明は自動で保存をやり直さず、再接続後に同じ依頼の記録を照会する。

## 種類固有の材料

初期契約は reply / mention / quote / renote / note を候補として受ける。固定本家の renote 通知は `noteId` に加えて `targetNoteId` を必要とする。実 `MiNote.renoteId` を確認して保存するか、対応範囲を種類で明示的に限定する。欠損した材料を使って全種類を成功扱いにしない。

候補は通知許可を表さない。実行時の条件再評価を省略して無条件に通知を保存する worker を起動しない。受信設定・mute・thread mute 等の本家条件全移植は N6 で扱う。

## 保持・削除・移行の境界

通知実体は業務データ、effect は終端から30日を基本とし、依存する親子・有効 claim 等を確認した後に廃棄する回復状態であり、寿命を分ける。ジョブ清掃によってユーザーの通知一覧を消さない。通知削除によって同じ依頼の通知を再作成しない。

実体の件数上限・削除方法、実体と effect の論理容量への算入、実体削除時の容量解放は下記の今回範囲で一緒に定める。無期限・無上限に通知を蓄積する保存アダプタを導入しない。

通知 API、既読境界、ID によるページング、一覧件数、stream/push は N6 の互換性検証対象。Redis 障害時に DB へ縮退する機能として導入しない。Redis 必須の既存停止契約を維持する。

完全停止下の切り替えで既存 Redis 通知・既読位置をどう引き継ぐかは N6/#137 の必須条件。保存方式の追加だけで移行済みとは扱わない。

## 実装の受け入れ条件

実 MiNote と受信者から通知実体を保存し、次を実 DB で検証する。

1. 実体・成立記録・item 成功の同時確定と、途中例外による全 rollback。
2. 並行実行・重複 entry・旧 owner/epoch・lease 失効で追加実体を作らない。
3. commit 後の再接続で既存結果を取得できる。通知実体を削除しても同じ依頼から再生成しない。
4. 別 eventId の同内容は別通知。同一出来事の別 requestId は既存の canonical requestId に解決する。
5. 抑止理由を保存し、抑止された仕事を成功通知と混同しない。
6. 行数/bytes の容量不足は実体・成立記録・進捗・容量更新をすべて rollback する。
7. 新 migration の up/down、内部 schema 差分、本家349件の履歴と public 定義を維持する。

## 今回の実装範囲

保存アダプタは5種類を扱い、Renote の targetNoteId は実 Note の renoteId から固定する。対象消失・自分宛・remote 受信者は抑止記録を残す。その他の条件は必須の再評価コールバックが同じ transaction 内で判定する。条件全移植前に通常 worker へ接続しない。

通知実体も effect も既存の通常作成用90%の論理容量枠へ算入する。実体は base_bytes=512、effect は256とし、各保存ID等のUTF-8 bytes を加えて既存係数4・1024単位切り上げで課金する。実体の削除時だけ保存済み課金を解放し、effect は残す。ジョブ清掃から実体を削除しない。

受信者ごとの件数上限は本家の既定値500を採用し、アダプタ構築時に正の整数として指定できる。全体の行数上限100万を超える設定は拒否する。同じ受信者への追加/全削除を transaction advisory lock で直列化し、追加時に created_at・notification_id が古い実体から上限超過分を削除する。これは内部の保持順であり、通知APIのcursor互換を実装済みとは扱わない。Redisの近似MAXLENとは異なり厳密な上限になる。

同一の caller-owned transaction 内で、既存の成立記録確認、最新の実 Note/ユーザー取得、条件再評価、実体・成立記録の保存、件数制限、容量増減、fencing 付き仕事完了を行う。成立記録が既存なら現在の条件で作り直さない。本文や通知先は保存済みの依頼から取得して検証し、呼び出し元が claim の payload を変更しても対象を差し替えられない。

通知一覧/既読API・stream/push・既存Redis状態の移行・通常workerの接続は後続作業。保存アダプタと実DBでの成立を今回の完成単位とする。
