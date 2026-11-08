# server/api/endpoints/admin/queue/retry-job.ts

[索引へ戻る](../../../../../../../../README.md)

### UF-006 ジョブの再試行を待たずに成功を返す

- 本家: [`retry-job.ts:35`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/retry-job.ts#L35) で `queueRetryJob`（async）を待たずに呼ぶ。
- 内容: 再試行の完了も失敗も確かめずに204を返す。指定したジョブが見つからなくても何もせずに成功を返す。再試行や前倒しが失敗しても（Redisの障害など）、未処理の Promise 拒否になるだけになる。
- 影響: 管理画面では再試行に成功したように見えるが、ジョブは失敗したまま残っていたり、そもそも存在しなかったりすることがある。
- 新実装での扱い: 引き継いだ。本家と同じく待たずに204を返す。ただし失敗は `queue-admin.detached-failed` として操作名つきで診断ログに出し、終了時には開始済みの操作の完了を待つ（[queue管理の比較資料](../../../../../../../../../../superpowers/compatibility/queue-admin/README.md)）。
- 本家への報告: 未報告
