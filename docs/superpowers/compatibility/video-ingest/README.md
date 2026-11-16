# #281 動画サムネイル生成

固定本家 `8e07cf085adf7009583d234a208e30436f020e26`、親 #188/#114。#280 の画像変換を使い、動画 bytes のサムネイル生成能力を移植する。保存、multipart/API、remote 取得、センシティブ推論はそれぞれ #284/#285/#287/#282 に残る。

## 公開境界

- `extractVideoFrame(bytes)` は platform の FFmpeg/一時ファイル adapter。5% 地点を PNG にし、入力とフレームを読み終えてから一時ディレクトリの削除を待つ。失敗は例外。
- `generateVideoThumbnail(bytes, extractFrame)` は画像契約に渡して WebP、inside 498×422、拡大なし、metadata 除去。直接呼出の失敗は例外。
- `generateVideoAlts(bytes, generator, extractFrame)` は Drive の動画分岐。外部 generator が null/undefined 以外ならローカル処理を省略する。生成失敗は webpublic/thumbnail 両方 null。
- `getExternalVideoThumbnailUrl(url, generator)` は null/undefined なら null、設定時は thumbnail=1 と percent encode した URL。既存 `file-view.ts` の動画 fallback をこの純粋関数へ委譲し、PNG/FFmpeg ライブラリを pack へ読み込まない。query を持つ generator の接続記号も本家 appendQuery に合わせる。

生成と外部 URL 決定を同時に行う UseCase、保存や HTTP 接続の完成は主張しない。後続の upload は必要な adapter を composition で組み立てる。

## 固定本家との比較

[fixtures.json](fixtures.json) は一度 FFmpeg で生成して固定した実 MP4 bytes（base64）。640×480 の4秒動画は red 0–0.12秒、lime 0.12–0.52秒、blue 0.52–4秒で、5% = 0.2秒の緑を検証する。最初や中間のフレームを誤取得すると色が変わる。80×120 の動画は拡大しないことを確認する。AAC 音声だけの MP4、破損 bytes、切詰 MP4 も含む。

[source-probe.mjs](source-probe.mjs) は4つの固定本家ソースを Git object と照合し、AST で VideoProcessingService、ImageProcessingService、DriveService のメソッドと URL 関数を抽出して実行する。実 fluent-ffmpeg 2.1.3 / FFmpeg / sharp 0.35.5 と filesystem を使用する。tmp.dir の窓口だけを native mkdtemp/rm に置き換え、本番と同じ cleanup を有効にする。logger は no-op、NestJS/HTTP/DB は起動しない。5入力の直接生成・Drive local/external分岐、5種の generator URL、実際に exit 17 する子プロセスの失敗と cleanup を [observations.json](observations.json) に記録する。

新実装テストは固定観測値と WebP の format、寸法、平均 RGB、metadata 有無を比較する。codec 出力の圧縮 bytes 完全一致は要求しない。一時ディレクトリは成功・動画 track なし・破損・子プロセス異常・WebP 変換異常で解放を検証する。新実装では frame bytes を読み終えた時点で削除を待つため、その後の画像変換失敗でも資源が残らない。本家の development 用 cleanup 無効化は引き継がない。

## 依存と履歴証跡

本家と同じ fluent-ffmpeg 2.1.3 と型 2.1.28 を追加し、既存 lock snapshot を使う。FFmpeg と ffprobe は従来と同じ OS 実行ファイルを使う。新しい運用設定は足さない。

`dependency-predecessor.json` と `scripts/video-ingest-dependency-evidence.mjs` は package/lock の今回の有限差分のみを exact patch と全体 SHA256 で復元する。CLI reader は package だけ、image-ingest reader は lock だけを復元してからそれぞれ元の検証へ渡す。CLI の unrelated lock 読取は raw を保つ。既存の本家観測値・歴史 receipt・seal は変更しない。再利用した reader でも raw bytes と proof seal を毎回検査する。

## 検証

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test
UPSTREAM_ROOT=/path/to/pinned/upstream node docs/superpowers/compatibility/video-ingest/source-probe.mjs --check
node --test scripts/video-ingest-contract.test.mjs scripts/image-ingest-contract.test.mjs scripts/cli-package-evidence.test.mjs scripts/url-preview-contract.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 0927918fe987cae2fcbf2b69bdb58ee6c5ca734a
```

[current-evidence.json](current-evidence.json) は最終 worktree の有限な入力 SHA256 と実行ログを記録する。runtime は input set の digest で識別し、未commit入力を base commit の実装とは扱わない。CI は unit/契約を再実行し、過去 host の実測を新しい CI 測定とは数えない。

DB/Redis/HTTP/process サーバー、API 型生成、migration は変更がなく対象外。全 root 契約は既存 CI gate が実行する。CHANGELOG は編集しない。
