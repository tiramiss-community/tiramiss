# PageEntityService

### UF-015 旧content書戻しのDB失敗が未処理rejectionになる

- 本家: [PageEntityService.ts:93](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/PageEntityService.ts#L93)
- 内容: pack が旧 input を変換した後、pagesRepository.update を await せず呼び、返る Promise の rejection handler も登録していない。
- 影響: DB の書込みが失敗すると、変換済みの応答と保存 content が食い違い得る。非同期エラーは pack 呼出しの catch では捕捉できない。本家フルサーバーでのプロセス終了は今回測定していない。
- 新実装での扱い: 非待機の応答と保存失敗時の旧contentを維持し、失敗を logger へ報告する。開始済み書込みは通常 HTTP 終了時に待つ。[比較資料](../../../../../../../superpowers/compatibility/page-read/README.md)
- 本家への報告: 未報告
