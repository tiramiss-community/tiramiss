# core/DeleteAccountService.ts

[索引へ戻る](../../../../README.md)

### UF-003 アカウント削除の前に削除ログを書く

- 本家: [`DeleteAccountService.ts:53`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/DeleteAccountService.ts#L53) で `deleteAccount` のログを書く。削除の配送、削除ジョブの作成、[`:99`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/DeleteAccountService.ts#L99) の `isDeleted: true` への更新は、その後に行う。
- 内容: ログは待たずに書かれ、後続の処理より先に記録される。後続の配送の準備や更新が失敗しても、削除ログは残る。
- 影響: アカウントが削除状態になっていないのに、「モデレーターが削除した」という記録が残り得る。
- 新実装での扱い: 未移植（[#199](https://github.com/tiramiss-community/tiramiss/issues/199)）。移植するときは、削除状態の確定後に書くかを決め、比較資料に差異として残す。
- 本家への報告: 未報告
