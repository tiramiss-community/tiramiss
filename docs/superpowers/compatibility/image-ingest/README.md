# #280 画像解析・派生画像生成

固定本家 `8e07cf085adf7009583d234a208e30436f020e26`、実装 `02506f132a6bffefa150f352281772944cdbb73f`。#280 の画像 bytes 能力を完了対象とする。親 #188/#114、保存・API・remote取得は未完了のまま維持する。

## 公開境界

`packages/backend-next/src/modules/drive/image-ingest.ts` の公開関数は次の通り。

| 関数 | 入力と結果 |
| --- | --- |
| `inspectImageBytes(bytes, {fileName?})` | size/MD5、MIME/拡張子、寸法/orientation、blurhash、warnings。画像解析後のMIMEを後続生成へ渡す |
| `convertImageBytes(bytes, format, width, height)` | WebP/AVIF/PNG の bytes・MIME・拡張子。失敗は例外で伝える |
| `generateImageAlts(bytes, mime, generateWeb)` | webpublic/thumbnail。未対応・metadata失敗は両方null、片側変換失敗はその派生物だけnull |
| `isImageConvertible(mime)` | 本呼出で実消費するMIME集合の判定 |

DB、HTTP、remote取得、保存、副作用、DI、推論、動画トラック判別/フレーム処理は含めない。保存は #284/#285、remote取込は #287、動画thumbnailは #281、センシティブ判定は #282、配信/proxyは #321/#510 が所有する。単独bytes能力の完成を通常upload/API経路の完成とは扱わない。

## 固定入力と source 比較

[fixtures.json](fixtures.json) は28個の固定bytes（base64）。合成画像はsharp0.35.5で一度生成し固定した。APNGだけは固定本家の `packages/backend/test/resources/anime.png` を使用する。テスト時に入力を再生成しない。

[source-probe.mjs](source-probe.mjs) は4ソースの作業コピーを固定Gitオブジェクトと照合し、TypeScript ASTから本家の関数本文を抽出・実行する。FileInfoService、ImageProcessingService、DriveService.generateAlts は実ライブラリと一時ファイルを使用し、推論をskipする。NestJS・DB・本家full server/HTTPは起動しない。loggerはno-op、動画分岐は呼ばない。未消費 `safe-file` の入力配列は空doubleだが、対象の `sharp-convertible-image-with-bmp` 判定には影響しない。

[observations.json](observations.json) は本家による28解析・56派生分岐（generateWeb true/false）・9直接変換・3失敗分岐の期待値。新実装から期待値を生成しない。派生物はsharpで実際にdecodeし、format、寸法、alphaの最小/最大、pages/pageHeight、delay/loop、orientationとmetadata有無を比較する。AVIFのsharp format表記は `heif`。codecの圧縮bytes完全一致は要求しない。

| 対象 | 比較した境界 |
| --- | --- |
| 種別・size・hash | PNG/JPEG/WebP/AVIF/TIFF/GIF/APNG/BMP/ICO/SVG、空/未知/切詰入力、txt/csv/jsonと大文字拡張子 |
| 寸法/orientation | EXIF6の元寸法と向き、非px SVGは寸法未設定、16384幅PNG/SVGは寸法を残しoctet-stream化 |
| 破損 | 寸法不能JPEGはoctet-stream。headerから寸法が読める壊れたPNGはMIMEを残しblurhash失敗/派生省略。全破損を一律にoctet-streamとはしない |
| blurhash | 本家同様の5×5、inside64、alpha、最初のframe、rotate無し。BMP/TIFF/ICOは対象外 |
| webpublic | 2048、metadata/EXIF除去、向き補正、SVG/AVIF再生成、元画像が要件を満たす場合とgenerateWeb=false/animatedの省略 |
| thumbnail | 静止498×422、animated374×317。大きいGIFを実縮小しpages/delay/loopを確認、APNGは固定本家のsharp同様に静止thumbnail |
| 直接変換 | 透過PNG・EXIF JPEG・animated GIF→WebP/AVIF/PNG、拡大なし、向き補正、metadata除去、最初のframe |
| 失敗分離 | SVGのwebpublic/thumbnail片側パイプライン引数検証失敗と壊れたPNGのmetadata失敗。encoder内部故障の注入を主張しない |

ネイティブ診断の `Input file` / `Input buffer` だけは入力境界に伴い異なる。unitではこの語を正規化し、警告の種別と結果を比較する。センシティブ/Pornの常時falseフィールドは今回の公開型へ含めず、推論未実装を成功値で表現しない。FileInfoService.detectTypeの例外を包括catchしてoctet-streamに変える処理も追加しない。

## MIME辞書の参照単位

| 辞書/ファイル | 今回の判断 |
| --- | --- |
| `sharp-convertible-image-with-bmp` | Drive.generateAltsの画像分岐で実消費。11MIMEと除外MIMEを比較し移植 |
| `sharp-convertible-image` | DriveFileEntityServiceのthumbnail URL fallbackで消費（#279のpack責任）。今回の画像bytes能力では未使用 |
| `sharp-animation-convertible-image` | 固定本家で呼出箇所なし。今回未使用、機械移植しない |
| `sharp-animation-convertible-image-with-bmp` | FileServerProxyHandlerのアニメーション選択（#510）で消費。今回未使用 |
| `safe-file` | 固定本家で辞書としての呼出箇所なし。今回未使用 |
| `FILE_TYPE_BROWSERSAFE` | Drive保存/配信のContent-Type判断 #284/#321で配列を直接消費。今回未使用 |
| `langmap.ts` / `emoji-regex.ts` | misc-utils:38が束ねた別責任。画像bytes能力では参照しないため機械移植しない |

misc-utils:38・FileInfoService・画像以外を含むgenerateAlts/type判定行はpartialを維持する。画像変換/寸法/blurhashの有限行だけをverifiedにし、#280の完了条件と広いservice全体の移植状態を区別する。

## 依存と履歴証跡

sharp0.35.5、sharp-read-bmp1.3.1、blurhash2.0.5、file-type22.1.1、is-svg6.1.0、probe-image-size7.4.0 は固定本家manifestと同版。workspaceのfile-type/probe-image-sizeは`supports-color@10.2.2`のpeer context（本家backendは8.1.1）で解決するが、画像codecやparser本体の版は同じ。lock差分はbackend-next importer18行と既存版のpeer snapshots44行。

既存URL-preview証跡が参照するmanifest/lockの2入力だけを [dependency-predecessor.json](dependency-predecessor.json) と `scripts/image-ingest-dependency-evidence.mjs` で投影する。現在入力・preimageはSHA256で検証、lockは有限offset patchを元bytesと照合して適用し全体hashを確認する。歴史JSON、既存実測、未変更の実装入力は書き換えない。これは歴史測定の再実行ではない。

## 再実行と検証記録

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/drive/image-ingest.test.ts
UPSTREAM_ROOT=/path/to/pinned/upstream node docs/superpowers/compatibility/image-ingest/source-probe.mjs --check
node --test scripts/image-ingest-contract.test.mjs scripts/url-preview-contract.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base b13645043cfbf422faefa6a2703540d1c8414269
```

[current-evidence.json](current-evidence.json) はこの実装の有限な入力hash・実行コマンド・実ログhashを記録する。入力hashと実ログhashを保存する。CIは契約testを再実行し、過去のhost測定を新しいCI測定とは数えない。

初回全unitは準備順序（upstreamのtsc-alias前）とRE2 prebuiltのGLIBC要件により31suite/14testが失敗した。正式な依存順buildと、別inodeへコピーした既存Node26/ホスト対応RE2で環境を修復したR2は **4637件/124files PASS**。初回失敗ログは `/tmp/tiramiss-280-unit-all.log`、R2は `/tmp/tiramiss-280-unit-all-r2.log`。main/shared RE2は上書きしていない。

DB/Redis/HTTP/processは純粋bytes変更のため実行対象外。ローカル全root契約検査はcoordinator判断で中断・未完（`/tmp/tiramiss-280-root-all.log`）、対象契約41件の成功と区別する。全量root検査はPRのCI gateで行う。出荷のlint/SPDX/localeは別途PASSを確認し、API生成とmigration検査は変更が無いため対象外。CHANGELOGは編集しない。
