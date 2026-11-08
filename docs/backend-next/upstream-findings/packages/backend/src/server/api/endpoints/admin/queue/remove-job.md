# server/api/endpoints/admin/queue/remove-job.ts

[索引へ戻る](../../../../../../../../README.md)

### UF-007 ジョブの削除を待たずに成功を返す

- 本家: [`remove-job.ts:35`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/remove-job.ts#L35) で `queueRemoveJob`（async）を待たずに呼ぶ。
- 内容: 削除の完了も失敗も確かめずに204を返す。指定したジョブが見つからなくても何もせずに成功を返す。実行中でロックされたジョブの削除などで失敗しても、未処理の Promise 拒否になるだけになる。
- 影響: 管理画面では削除に成功したように見えるが、ジョブが残っていることがある。
- 新実装での扱い: 引き継いだ。本家と同じく待たずに204を返す。ただし失敗は `queue-admin.detached-failed` として操作名つきで診断ログに出し、終了時には開始済みの操作の完了を待つ（[queue管理の比較資料](../../../../../../../../../../superpowers/compatibility/queue-admin/README.md)）。
- 本家への報告: 未報告
