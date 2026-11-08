# server/api/endpoints/admin/queue/promote-jobs.ts

[索引へ戻る](../../../../../../../../README.md)

### UF-005 遅延ジョブの前倒しを待たずに成功を返し、ログを書く

- 本家: [`promote-jobs.ts:34`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/promote-jobs.ts#L34) で `queuePromoteJobs`（async）を待たずに呼び、[`:36`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/promote-jobs.ts#L36) で `promoteQueue` のログを書く。
- 内容: 前倒しの完了も失敗も確かめずに204を返す。ログの書き込みも、前倒しの完了を待たずに始まる。失敗すると、未処理の Promise 拒否になるだけになる。
- 影響: 管理画面では成功したように見え、ログにも記録が残るが、遅延ジョブが前倒しされていないことがある。
- 新実装での扱い: 引き継いだ。本家と同じく待たずに204を返す。ただし失敗は `queue-admin.detached-failed` として操作名つきで診断ログに出し、終了時には開始済みの操作の完了を待つ（[queue管理の比較資料](../../../../../../../../../../superpowers/compatibility/queue-admin/README.md)）。
- 本家への報告: 未報告
