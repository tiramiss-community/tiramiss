# ClientServerService

### UF-014 Twemojiバッジの96px指定に対して512pxが出力される

- 本家: 固定SHA [`8e07cf085adf7009583d234a208e30436f020e26`、ClientServerService.ts:329–370](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/ClientServerService.ts#L329)。
- 内容: 実際の3ルートcallbackを抽出し、Sharp 0.35.5・emoji-assets 17.0.3の `1f600.svg` を用いてlistenしたFastifyへリクエストした。コードは `.boolean(mask, 'eor').resize(96, 96)` を指定するが、実測PNGのmetadataは512×512だった。すべての入力画像・Sharp版への一般化はしていない。
- 影響: この固定画像のレスポンスは指定された96pxより大きい。表示側で縮小しても、PNGの画素数は512×512となる。
- 新実装での扱い: 同じSharpパイプラインと実測結果を引き継いだ。新旧の固定画像PNGはSHA-256まで一致。[比較資料](../../../../../../../superpowers/compatibility/emoji-images/README.md)を参照する。
- 本家への報告: 未報告。
