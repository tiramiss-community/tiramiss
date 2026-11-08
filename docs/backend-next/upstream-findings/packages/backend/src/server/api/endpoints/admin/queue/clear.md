# server/api/endpoints/admin/queue/clear.ts

[索引へ戻る](../../../../../../../../README.md)

### UF-004 queueの消去を待たずに成功を返し、ログを書く

- 本家: [`clear.ts:35`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/clear.ts#L35) で `queueClear`（async）を待たずに呼び、[`:37`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/clear.ts#L37) で `clearQueue` のログを書く。
- 内容: 消去の完了も失敗も確かめずに204を返す。ログも消去の完了前に書かれる。消去が失敗すると、未処理の Promise 拒否になるだけになる。
- 影響: 管理画面では消去に成功したように見え、ログにも消去の記録が残るが、ジョブは残っていることがある。
- 新実装での扱い: 引き継いだ。本家と同じく待たずに204を返す。ただし失敗は `queue-admin.detached-failed` として操作名つきで診断ログに出し、終了時には開始済みの操作の完了を待つ（[queue管理の比較資料](../../../../../../../../../../superpowers/compatibility/queue-admin/README.md)）。
- 本家への報告: 未報告
