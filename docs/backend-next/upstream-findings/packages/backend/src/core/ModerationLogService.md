# core/ModerationLogService.ts

[索引へ戻る](../../../../README.md)

### UF-001 モデレーションログの書き込み失敗が検出されない

- 本家: [`ModerationLogService.ts:26`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ModerationLogService.ts#L26)。呼び出し元は57か所で、すべて結果を待たない（例：[`RoleService.ts:713`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/RoleService.ts#L713)、[`NoteDeleteService.ts:120`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteDeleteService.ts#L120)）。
- 内容: `log` は insert を待つ async 関数だが、どの呼び出し元も `await` も `.catch` もしない。insert が失敗すると未処理の Promise 拒否になり、[`process-error-handler.ts:51`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/boot/process-error-handler.ts#L51) が汎用のエラーとして出力するだけになる。どの操作の記録が失われたかは分からない。
- 影響: 管理操作は成功したのに監査記録だけが失われ、それに誰も気づかない。監査ログを根拠にした事後調査で、記録の欠落を見分けられない。
- 新実装での扱い: 変えた。
  - queue管理とnote削除は、本家と同じく待たずに書く。ただし失敗は診断ログに出し（`queue-admin.detached-failed`・`note-post-delete.failed`）、終了時には書き込みの完了を待つ。queueの監査の失敗は `operation: 'audit'` として出るだけで、`clear`・`pause` などどの操作の記録が失われたかは診断ログから区別できない。
  - Role更新は、更新と同じトランザクションの中で待って書く（[Role比較資料](../../../../../../superpowers/compatibility/role/README.md)で承認済みの差異）。
  - 書き込みを共通の書き込み口へまとめる作業は [PR #246](https://github.com/tiramiss-community/tiramiss/pull/246)。待つかどうかは呼び出し元が選ぶ。
- 本家への報告: 未報告
