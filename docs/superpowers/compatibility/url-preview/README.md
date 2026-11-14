# URL preview #377 / #560

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `/url` を、通常の backend-next HTTP と既存外向き HTTP へ接続する限定実装。製品は `9d4f0e0234b3366957576e172845ace4d8cdcaab` と query 修正 `4047f7fc8696ee45104d0ed317722273afbcce1e`。同じ PR で #377 と #560 を満たす。#196/#216 全体、画像バイト配信、S3/Web Push/download 等の完了は意味しない。

## 実装と対応

| 契約 | 実装・確認 |
| --- | --- |
| 公開 GET/HEAD `/url` | `composition/http-app.ts` → `url-preview-http.ts` → `http/url-preview-api.ts`。認証不要、HEAD は取得を行い本文を返さない |
| url/lang の検証 | URL 欠落・重複、lang 重複は 400 空本文。空文字・不正 URL 文字列は取得へ渡す。括弧キーは literal。percent/UTF-8 不正時は fast-querystring と同じく query component 全体を保持 |
| 設定 8 項目 | `urlPreviewEnabled` / `AllowRedirect` / `Timeout` / `MaximumContentLength` / `RequireContentLength` / `SummaryProxyUrl` / `UserAgent` / `SensitiveList` を既存 Meta reader から読む |
| 無効・取得失敗 | 無効は 403 `URL_PREVIEW_DISABLED`、取得・結果検証失敗は 422 `URL_PREVIEW_FAILED`。固定本家の error ID/kind。入力 400 は設定判定より先 |
| 直接 Summaly | 同版 5.5.2、既存 default httpAgent/httpsAgent。redirect・timeout・content length・UA・lang を実際の library 呼び出しに渡す |
| summary proxy | 本家と同じ `proxy?query` と encodeURIComponent、順序・空文字・既存 query も保持。プレビュー設定は query に渡し、実取得は既存 getJson の 5000ms / 256KiB / Misskey UA / AllowLocalAddress=true |
| 結果検証 | URL と truthy な player.url の lowercase `http://` / `https://` prefix。player 欠落/null は 422。任意の追加プロパティを保持 |
| sensitive / 画像 | raw result を clone 後、icon/thumbnail を mediaProxy の preview.webp へ変換。null/undefined は null、空文字も wrap。sensitive=true は維持、それ以外は現在のリストを結果 URL に RE2 / AND 単語で照合 |
| キャッシュ | プロセス内 1h / 100件。key `${url}@${lang ?? '_DEFAULT_'}`、未指定と言語 literal `_DEFAULT_` の衝突も本家どおり。取得失敗/検証拒否は保存しない。並行 miss は独立取得 |
| expiry/LRU | get は age>1h、3分 GC と挿入時 GC は age>=1h。hit はアクセス順だけ更新し保存時刻を維持。raw 結果を保存し応答ごとの変換が汚染しない |
| 応答 cache | 成功と 422 に `max-age=86400, immutable`。400/403 には preview cache header を付けない |
| 終了 | 通常 HTTP の受付停止/待機と resources cleanup を使用。preview は timer を解除し開始済み取得を待ってから、既存 outbound agents を解放。新しい永続状態なし |

実装は `modules/url-preview/public.ts` の plain-data 契約、platform の library/DB 接続、HTTP/組み立てに分離。業務モジュールに Hono、Agent、EntityManager、Summaly 型を渡さない。

## transport の本家互換

- 直接 Summaly は URL 非依存の既定 agent pair を受けるため、設定済み proxy を使い、`proxyBypassHosts` は直接経路には適用しない。summary proxy は既存 getJson の URL ごとの agent 選択を使い、exact hostname bypass を適用する。
- 直接経路は composition で本番条件を注入した private guard と `allowedPrivateNetworks` を継承する。summary proxy の AllowLocalAddress=true、proxy 経由の既存の扱いも変えない。
- `outgoingAddress` は直接/native bypass 接続の実 peer address で確認した。hpagent 1.2.0 は Agent の `localAddress` を CONNECT request に転送しないため、proxy 接続では指定値へ bind されない。本家も同じ設定・同版依存を使用する。この挙動は既存の独立本家観測 [outgoing-address-proxy](../outbound-http/http-cases.json) にも記録されている。今回の HTTP/TLS CONNECT 試験も同じ結果であり、proxy peer に指定アドレスが届いたとは主張しない。

## 比較方法と実測

[`corpus.json`](corpus.json) と [`source-probe.mjs`](source-probe.mjs) は固定 Git source の handler/cache/query/ApiError/keyword methods を抽出し、実 Fastify parser・RE2・明示時刻で **59 ケース / 174 リクエスト** を観測する。取得だけを double とし、新実装は読み込まない。結果と source blob/SHA-256 は [`observations.json`](observations.json)。source 全サーバー・本家の実 DB/Redis/Summaly を動かした比較ではない。

新実装の source replay は同じ入力で status/body/cache header と取得引数を比較する。HTTP 以外の unit は cache の並行 miss、100件 LRU、境界時刻、timer 解放/取得待機を検証する。

実通信試験は同じ実装の fake origin / TLS / CONNECT server に **実 Summaly 5.5.2** を向け、直接 HTTP/TLS、proxy と bypass の違い、private 拒否/許可、source address、UA・言語、redirect 可否、content-length/size、timeout、切断/非2xxを確認する。summary proxy の query、ローカル endpoint、TLS、固定 256KiB / 5秒 timeout も確認する。proxy に渡す preview timeout と実 fetch timeout は区別する。

専用 PG/Redis で通常 listening HTTP から保存済 Meta の 8 設定、更新後の disabled/sensitive、raw cache、直接 Summaly 切替、HEAD、malformed query の実際の送信値を確認する。built HTTP 子は保持中の summary proxy 取得を SIGTERM 後に解放し、接続中/切断済クライアントの両方で終了 0 を確認する。

最終製品 `4047f7fc8696ee45104d0ed317722273afbcce1e`、Node 26.4.0 / pnpm 12.9.1 の有限実測は [`current-evidence.json`](current-evidence.json)。27入力の実行前後 SHA-256 は同一。

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter backend-next... build` / `typecheck` | PASS |
| `pnpm --filter backend-next test test/unit/url-preview-source.test.ts test/unit/url-preview.test.ts test/unit/url-preview-network.test.ts test/unit/composition/http-app.test.ts test/unit/outbound-http` | PASS 544 / 6 files |
| `pnpm --filter backend-next test:integration test/integration/url-preview.test.ts test/integration/http-app.test.ts test/integration/instance-admin.test.ts` | PASS 30 / 3 files |
| `pnpm --filter backend-next test:process test/processes/url-preview.test.ts test/processes/children.test.ts` | PASS 15 / 2 files |
| `node docs/superpowers/compatibility/url-preview/source-probe.mjs --check` | PASS 59 cases / 174 requests |
| `pnpm --filter backend-upstream sync:check` | PASS |

専用 Compose project は `s1-preview377-20261115`、PG/Redis/Meilisearch の公開 port は `16441/16442/16443`。既存の `misskey-infra` は使用しない。上の unit/network 試験は DB 不要。

初期試験の fixture 誤り（CONNECT の source address 期待、Node の自動 content-length、二重解放）と、source corpus の重複 ID は修正して再実行した。独立レビューの malformed query 指摘は、source replay 5失敗を先に確認し、追加コミットで修正して再比較した。旧製品 `9d4f0e0` の R1 実測は `/tmp/tiramiss-s1-377-20261115/r1-product-run-receipt.json` と `frozen-*.log` に保持し、最終 head の検証とは数えない。ローカルログの保存先は `/tmp/tiramiss-s1-377-20261115/`。

全体の `node --test scripts/*.test.mjs` は **605/605 PASS、0 skip、314.655秒**。前半は関連78件（114.832秒）と独立レビューの検査が重なったため、無競合の baseline 比較としては扱わない。関連78件、inventory `--check`、changed-file shipping（lint/SPDX/locale）も PASS。CI の実行時間と外部レビュー結果は別途確認する。

## 既存証跡と残範囲

`scripts/url-preview-evidence.mjs` は現在の27入力と実行記録を検証した後、[`predecessor.json`](predecessor.json) の8変更入力だけを過去の読取へ射影する。#362 の3ファイル（http-app / connect-resources / composition unit test）に加え、古い metadata 証跡が保持する package.json・application/outbound-http・composition/outbound-http・platform/outbound-http/client・pnpm-lock の5入力を含む。7つの小さいファイルは完全な base バイト、lock は唯一の context anchor を持つ importer の逆差分と旧 SHA-256 で再現する。過去の instance-admin / Emoji / outbox 等の receipt・期待値バイトは変更しない。root contract は8入力の履歴 identity、全27入力への個別 drift、receipt/predecessor/利用可能 raw log の破損、host artifacts 不在時を検証する。これは過去テストの再実行を主張する仕組みではない。

Meta は既存の DB reader から取得するため、本家の injected/cache Meta と更新の時点・失敗の扱いに差がある。これは既存 #217 の責任に残し、stable Meta と保存後の新実装更新を区別する。一般 web header/CORS/error fallback、HTML/SPA/SSR/feed、mediaProxy が返す画像バイト、本家 full server/DB での全経路比較は範囲外。#196/#216 と親の未完了項目、`notes/create:partial` / `postingComplete:false` は維持する。

CHANGELOG 候補: `Feat: 新バックエンドで URL プレビューと設定・キャッシュ・画像 URL 変換を利用可能にする`

## CI 後の試験 mock 補正

PR #593 の初回 checks job `132616298876` は、既存 `remote-emoji-resources.test.ts` の外向き HTTP mock が `close` だけを返し、新しく利用する `defaultAgents` を持たないため単体1件が失敗した（他4288件成功）。製品を変えず、試験 mock に既定 agent 窓口と想定外の取得を拒否する getJson を追加した。修正 `f84d9df32f26caaf63d9ace0846dea798675495e` の後、focused1件・全単体4289件/113files・shipping が成功し、その1入力の実行前後 hash も一致した。

この補正は [`fixture-correction-evidence.json`](fixture-correction-evidence.json) と [`fixture-correction-predecessor.json`](fixture-correction-predecessor.json)、`scripts/url-preview-fixture-evidence.mjs` で、既存27入力/8経路の製品記録とは独立した1ファイルの末端として扱う。旧製品 receipt バイトは更新しない。取得時の working tree 入力を明記し、過去の全単体結果・初回CI失敗を新しい head のCI成功へ読み替えない。新しい head のCI・Webレビューは別途確認する。
