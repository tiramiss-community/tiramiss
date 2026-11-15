# server/api/endpoints/drive/folders/create.ts

### UF-010 フォルダー名の入力上限と保存先の長さが異なる

- 本家: [create.ts:46](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/drive/folders/create.ts#L46)、[update.ts:52](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/drive/folders/update.ts#L52)、[DriveFolder.ts:16](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/models/DriveFolder.ts#L16)。
- 内容: create/update の入力 schema は名前を200文字まで許すが、Entity は varchar(128)。129–200文字は入力検証を通過してから保存に失敗する。
- 影響: 長い名前の作成・更新は通常の入力エラーにならず、内部エラーになる。
- 新実装での扱い: schema と同期 Entity を維持した。実PGの128文字成功・129文字失敗と失敗時のイベントなしを確認した。200文字の source handler 比較は Repository double 上の結果であり、実PGで成功したとは扱わない。[比較範囲](../../../../../../../../../../superpowers/compatibility/drive-folders/README.md)。
- 本家への報告: 未報告
