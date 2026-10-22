# backend-upstream

固定された本家コミットのEntity・マイグレーションを無改変で複製する、内部用ライブラリ。

- `pnpm --filter backend-upstream sync`: `upstream-sync.json`のGitオブジェクトから複製・公開入口生成。
- `pnpm --filter backend-upstream sync:check`: コピー・生成物の一致検査。
- `pnpm --filter backend-upstream build`: ESMと型定義の生成。

Note・Channel と必要な共通定義 `src/types.ts` も同じ固定SHAから同期する。
本家の `@/` import はソースを変更せず、`tsc` の型解決と `tsc-alias` の出力変換で扱う。
JavaScript・型定義とも相対importへ変換し、利用側にalias設定や専用loaderを要求しない。

利用側は`backend-upstream/entities`、`backend-upstream/migrations`からimportする。
複製先の`src/`・`migration/`・生成された`exports/`は手編集しない。
同期範囲を変更する場合はmanifestを更新する。新しい依存は自動拡張せず検出時に停止する。
ライブラリは接続の作成・マイグレーション適用を行わない。
