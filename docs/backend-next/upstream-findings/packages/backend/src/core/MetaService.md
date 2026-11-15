# MetaService

### UF-012 取得中の古いMetaが通知済みの値を上書きする

- 本家: [固定SHAのfetch](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/MetaService.ts#L67) と [onMessage](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/MetaService.ts#L47)。
- 内容: DB取得のsnapshotが古い場合、取得中に到達した`metaUpdated`より後にその値をcacheへ代入する。
- 影響: 更新した表示名などが次の通知・明示取得・周期再取得まで古い値に戻り得る。
- 新実装での扱い: 同じ挙動を引き継ぎ、独自のversion fenceや取得の集約は加えない。[有限のsource観測と制約](../../../../../../superpowers/compatibility/meta-cache/README.md)を参照。
- 本家への報告: 未報告。

### UF-013 周期再取得のDBエラーにrejection handlerがない

- 本家: [固定SHAの周期処理](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/MetaService.ts#L34)。
- 内容: `fetch(true).then(...)`にcatchが無く、失敗は未処理rejectionになる。source probeは成功時の周期を実行し、この失敗経路は固定ソースの静的確認による。
- 影響: DBエラーがプロセスの未処理rejection方針へ漏れる。
- 新実装での扱い: 周期再取得失敗を既存loggerへ報告する。明示取得はrejectし、温まった値は保持する。新しいDB/Redis縮退保証は追加しない。[比較資料](../../../../../../superpowers/compatibility/meta-cache/README.md)を参照。
- 本家への報告: 未報告。
