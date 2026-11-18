# QueueService

### UF-016 アーカイブ予約の存在確認後に削除されると再投入しない

- 本家: 固定SHA [`QueueService.ts:257–265`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts#L257)。
- 内容: `getJob()`が既存jobを返した後、保持件数制限や管理操作がそのjobを削除すると、`getState()`は`unknown`を返す。`completed`/`failed`以外は戻るため、この競合では予約が存在しないまま正常終了する。
- 影響: DBに期限が残っても次回の予約復元まで自動アーカイブjobが投入されない。公開取得の期限判定は別に存在するため、期限済みのお知らせをactive一覧へ返すという意味ではない。
- 新実装での扱い: [#449/#450の固定本家比較](../../../../../../superpowers/compatibility/announcement-archive/README.md)では同じ判定を引き継いだ。`unknown`だけを再投入する変更は、本家相当の初期移植から独立した改善として扱う。CodeRabbit CLIの指摘を固定本家と同梱BullMQ 6.3.11 `getStateV2-8.lua`で照合した。
- 本家への報告: 未報告。
