# 新バックエンドの全体計画

更新: 2026-11-02。判断基準は [GOALS](GOALS.md)。全体Issueは [#114](https://github.com/tiramiss-community/tiramiss/issues/114)。本書は工程と現在地、Issueは個別作業と依存、各PRは実装・検証結果を持つ。

## 今回の方針整理

既存コードを全廃せず、本家相当の業務機能を通す順序へ戻す。独自の障害保証を備えた基盤の完成を、投稿機能の先行条件にしない。基本設計の依存境界は引き継ぐが、後から詳細化した同時確定・復旧・容量の契約は初期必須か再評価する。

目的は以前の基本設計にも存在した。詳細な保証と同じ長文に入り、部分実装の完了を次の前提へ積み上げたことで、通常worker未接続のままジョブadapter群が増えた。セッション継続やcompactだけを原因とは断定しない。セッションを替えても、古い必須条件をそのまま読むと同じ方向へ進むため、入口と計画を揃える。

## 現在地と既存成果

基準: develop `621d74caa106fb524681643257d32aaa8fcb7cec`（PR #205マージ後）。本家の固定基準は `packages/backend-upstream/upstream-sync.json` を参照。

| 成果 | 初期実装での扱い |
| --- | --- |
| 別パッケージ、機械同期、migration履歴、設定、HTTP/workerの起動停止 | 引き継ぐ。単純化の余地は機能を通しながら確認する |
| Role初期2 API・ポリシー評価・認証/認可・互換性資料（#115） | 引き継ぐ。他のRole APIは未移植 |
| notes/showの集合取得・可視性・純粋出力（#168 / PR #205） | 引き継ぐ。参照上限などの意図的差異は既存台帳で追跡する |
| 本家比較fixture、probe、公開機能の棚卸し案（#167 / PR #201） | 引き継ぐ。PR #201は未マージで、棚卸しは機能完成を示さない |
| 独自PG request/item・dispatch/execution claim・Redis全損復旧・容量台帳（#148–#153） | 強化実装として保留。通常BullMQ adapterの前提にしない |
| AP宛先snapshot/page・PG host lease（#156–#158） | 宛先選定規則などは再利用候補。永続集合・fencing・保持課金は後続へ分ける |
| PG通知保存・effect記録（#155） | ユーザー承認済みの差異。初期実装の負担を再評価し、保存先は今回変更しない |
| 物理容量監視と受付停止（#166 / PR #206） | 初期範囲から外し保留。PRは未マージのまま残し、勝手にclose/mergeしない |

現在の通常workerは起動停止だけで、実ジョブhandlerは未接続。notes/create・deleteと配送を通した完成品はまだない。既存の独自migrationは改変・削除せず、未接続のadapterを保持したまま通常経路を実装できる。

## 本家比較から分かった追加仕様

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` のGitオブジェクトで確認した。

| 対象 | 本家 | 現行の強化案と見直し |
| --- | --- | --- |
| ジョブ | QueueServiceのadd/addBulk、既定12試行のAP配送、backoff・履歴管理 | PG正本・二重claim・世代/token・容量予約は別の実行プロトコル。初期はBullMQの通常APIを使うadapterを推奨 |
| BullMQ接続 | 公開queue APIから投入する | 現adapterはBullMQ内部Luaを差し替え、再試行をPG側が所有。通常adapterへ名前だけ変えて流用しない |
| AP宛先 | followers/direct/relayから宛先を選び、sharedInboxを重複排除 | 永続snapshot・100件page・90日保持は追加保証。選定条件と投入の境界を分けて移植する |
| 通知 | NotificationServiceがRedis Streamへ保存 | PG案は通知とeffectの同時確定を維持するための承認済み変更。Redisへ戻す案とPGの閲覧/既読/移行まで完成させる案の負担を再比較する |
| 投稿後続処理 | 保存後に後続処理を開始し、全配送完了をHTTP成功条件にしない | DB/queue間の喪失をなくす永続依頼や強いCreate/Delete順序は、互換性の必須条件と区別する |

根拠: 本家 [QueueService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[NotificationService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NotificationService.ts)、[ApDeliverManagerService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApDeliverManagerService.ts)。旧判断は[投稿設計のD1–D4](../superpowers/specs/2026-10-21-note-flow-design.md#7-意図的な差異とリリース上の扱い)と[通知保存設計](../superpowers/specs/2026-10-23-notification-persistence-design.md)に残す。

## 進め方

1. **投稿に必要な最小契約を再確定する（次の作業）。** #124/#127で、本家のNote保存・後続処理開始・通常BullMQ投入/実行・通知保存をどこで分けるか、小さい具体契約にする。認可/可視性・配送先・失敗/再試行・HTTP成功時点を比較する。通知保存先の再判断もここで明示する。既存PG通知adapterは永続claimと`withLocalWorkCompletion`へ依存しており、通常BullMQ経路へそのまま接続できない。独自の永続台帳を必須にしない。新しい万能dispatcherや汎用イベント基盤は作らない。
2. **投稿の縦断フローを通す。** #169の基本作成 → #170の投稿要素 → #171/#172の配送/削除 → #173–#175の通知/stream/TL/検索/webhook → #176の連携確認。途中から通常workerへ接続し、HTTP・DB・Redis・配送先の結果を小さく確認する。すべての副作用を必ずqueue化する設計にはしない。本家の必要な失敗処理も確認する。
3. **残る本家機能を移植する。** #129/#178–#200の棚卸しを入口に、利用できる機能単位で進める。未評価・未移植・比較済みを区別し、基盤PR数を完成率に換算しない。
4. **全体の互換性と切り替えを確認する。** #130/#131/#137の必要な回復・既存データ・配布/観測・完全停止移行を、実装した機能に合わせて整える。移行に必要な処理は先送りしない。本家以上の自動復旧や運用基盤を一括のリリース前提にしない。

## Issueと依存の見直し

| Issue | 現時点の位置付け |
| --- | --- |
| #114 | 本書を入口とし、初期の機能同等性と後続強化を区別する |
| #124 / #127 | 独自PG基盤の完成待ちをやめ、次の最小契約と通常worker/投稿の縦断へ向けて完了条件を改訂する |
| #159 / #161 / #163–#166 | 強いclaim/配送順序、独自台帳の管理・保持・形式移行、物理容量制御は後続強化として保留。本家のキュー管理・通常retryまで保留にしない |
| #160 / #162 | 署名HTTPと通常worker接続は引き続き必要。PG実行プロトコル依存を外すため、最小契約に合わせて再分割/改訂する |
| #169 | #166を初期の必須依存から外す。#168は完了済み。旧413/503・PG依頼同時保存をそのまま移植条件にせず、最小契約へ改訂して着手する |
| #177 / #138 / #139 | 通知保存先の判断と、既存データ/配布上必要な作業を反映する。承認済み差異や移行を黙って消さない |

個別の新しい依存は、利用する具体契約が決まった時点で設定する。依存解除だけで#169の設計改訂も済んだとは扱わない。既存Issueを自動close/reopenせず、履歴と未完了範囲を維持する。

## 再開時に確認すること

[GOALS](GOALS.md)、本書、対象Issue、PR/ブランチの実状態を確認する。今回の次の作業は上記1であり、PR #206のマージ待ちでも、新たな基盤強化の実装でもない。着手するPRでは「移植する本家機能/解く依存」「必要な比較」「追加保証の有無」を短く説明する。
