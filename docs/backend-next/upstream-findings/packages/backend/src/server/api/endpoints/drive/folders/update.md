# server/api/endpoints/drive/folders/update.ts

### UF-011 フォルダーの同時更新で別の列の変更を古い値に戻す

- 本家: [`update.ts:69`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/drive/folders/update.ts#L69)、[`update.ts:122`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/drive/folders/update.ts#L122)。固定ファイルSHA256: `0cb5e9eb1f135f5bb6e39541c61934264a3099153c1dbdd6c95a9e12e11f919f`。
- 内容: 更新前の行を取得し、入力で名前だけ・親だけを指定した場合も、取得済みの `name` と `parentId` を両方保存する。同じ初期行を取得した名前変更と親変更は、後から保存した操作が先の別列変更を上書きする。
- 影響: 初期値が `{ name: old, parentId: null }` のとき、名前変更を先に保存し親変更を後に保存すると `{ name: old, parentId: B }` になる。逆の保存順では `{ name: new, parentId: null }` となり、親の変更が戻る。
- 新実装での扱い: 本家と同じ両列更新を維持した。独立検証では、固定本家のliteral handlerと当時の新実装 `c1f09e2a093bd2182e489386da53e99e2b7a69c0` の両方で、同じ取得結果と保存順を制御してこの2結果を確認した。Repositoryと待機位置のdoubleによる限定検証で、実PG/全面HTTPの並行比較ではない。新しい並行更新保証の導入は別の判断とする。
- 本家への報告: 未報告
