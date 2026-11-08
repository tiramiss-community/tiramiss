# core/PageService.ts

[索引へ戻る](../../../../README.md)

### UF-002 ページ削除がロールバックしても削除ログが残る

- 本家: [`PageService.ts:163`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PageService.ts#L163) の `db.transaction` の中で、[`:179`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PageService.ts#L179) の削除の後、[`:183`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PageService.ts#L183) で `deletePage` のログを書き、[`:193`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PageService.ts#L193) で参照ノートの `pageCount` を減らす。
- 内容: ログはトランザクションの `EntityManager` ではなく、`ModerationLogService` の Repository（別の接続）で自動コミットされる。しかも待たない。その後の `decrement` やコミットが失敗するとページの削除は取り消されるが、削除ログは残る。
- 影響: 実際には削除されていないページについて、「モデレーターが削除した」という記録が残る。
- 新実装での扱い: 未移植（[#191](https://github.com/tiramiss-community/tiramiss/issues/191)）。移植するときは、共通の書き込み口へトランザクションの manager を渡すか、コミットの後に書くかを選び、比較資料に差異として残す。
- 本家への報告: 未報告
