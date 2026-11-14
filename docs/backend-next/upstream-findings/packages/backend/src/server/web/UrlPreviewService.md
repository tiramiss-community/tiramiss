# server/web/UrlPreviewService.ts

[索引へ戻る](../../../../../README.md)

2026-11-15、URL preview移植の [PR #593](https://github.com/tiramiss-community/tiramiss/pull/593) のレビュー指摘を、固定本家の抽出処理と新実装の両方で確認した。以下は別URL・別言語の公開プレビューが返るという再現済みの問題であり、どちらも修正済みとは扱わない。

### UF-008 URLと言語を区切り文字で連結したcache keyが衝突する

- 本家: [`UrlPreviewService.ts:105`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/UrlPreviewService.ts#L105)。URLと言語を `${url}@${lang ?? '_DEFAULT_'}` で連結してsummary cacheを引く。
- 内容: URLと言語の双方に区切り文字を含められ、異なる入力の組が同じkeyになる。後の入力を取得せず、先の入力に対するsummaryを返す。
- 影響: 別URLのタイトル・リンク先などのプレビューが表示される。言語別の結果も正しく分離されない。
- 新実装での扱い: 同じ挙動を引き継いだ（#377/#560、[観測対象のcache key](https://github.com/tiramiss-community/tiramiss/blob/5fd08942be882a6280924fd9476e745fd5eebf4e/packages/backend-next/src/modules/url-preview/preview.ts#L56)）。固定版との互換性を維持し、キーのタプル化などの変更は行っていない。修正する場合は観測可能なcache挙動の差として別途合意・比較する。
- 本家への報告: 未報告

#### 再現条件と観測

URL previewを有効にし、同じ空cacheを持つ処理へ次の2入力を順番に渡す。取得部分は、受け取ったURLをsummaryの `url` と `title` に入れるdoubleとし、呼び出し回数を数える。`player.url` はnullとする。

| 順序 | URL | lang | 生成されるkey |
| --- | --- | --- | --- |
| 1 | `https://example.test/a` | `b@c` | `https://example.test/a@b@c` |
| 2 | `https://example.test/a@b` | `c` | `https://example.test/a@b@c` |

固定本家では実際の `UrlPreviewService.handle` と `MemoryKVCache` を抽出実行し、新実装では `createUrlPreview` を呼び出した。両方とも取得は **1回** で、返されたURLは順に **`a`, `a`**（いずれも `https://example.test/a`）だった。2回目の入力URL `https://example.test/a@b` のsummaryは取得されていない。

これはhandler/cacheと取得doubleによる観測であり、実サイトのスクレイピングや本家サーバー全体のHTTP/DB試験ではない。`lang` の全入力やcache有効期限の全境界をこの再現で確認した意味でもない。

### UF-009 Summalyの共有optionsが並行取得の言語を上書きする

- 本家: [`UrlPreviewService.ts:143–154`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/UrlPreviewService.ts#L143) は呼び出しごとに新しいoptionsを渡す。固定本家の [`packages/backend/package.json:65`](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/package.json#L65) は `@misskey-dev/summaly` を **5.5.2** に固定している。
- 関連する依存: Summaly 5.5.2のtagが指すcommit [`2a01181225e0e32c34ce6958095af9f2f9ec0cb0`](https://github.com/misskey-dev/summaly/tree/2a01181225e0e32c34ce6958095af9f2f9ec0cb0)。[`src/index.ts:84`](https://github.com/misskey-dev/summaly/blob/2a01181225e0e32c34ce6958095af9f2f9ec0cb0/src/index.ts#L84) の `Object.assign(summalyDefaultOptions, options)` は共有の既定options自身を変更する。redirect確認のHEADをawaitした後、[`:128–137`](https://github.com/misskey-dev/summaly/blob/2a01181225e0e32c34ce6958095af9f2f9ec0cb0/src/index.ts#L128) で同じobjectからscraping用optionsを作る。観測に使ったインストール済み5.5.2の `built/index.js` でも、対応する処理は465行と495–503行にある。
- 内容: 言語の異なる並行呼び出しで、先行処理がHEADを待つ間に後発処理が共有optionsを書き換える。先行処理のGETも後発処理の言語になり得る。呼び出し側でoptionsを複製するだけでは依存内部の共有object変更を解消しない。
- 影響: 要求した言語と異なるタイトル・説明の公開プレビューが返る。
- 新実装での扱い: 同じ挙動を引き継いだ（#377/#560、[観測対象の直接取得adapter](https://github.com/tiramiss-community/tiramiss/blob/5fd08942be882a6280924fd9476e745fd5eebf4e/packages/backend-next/src/platform/url-preview.ts#L15)）。同じSummaly 5.5.2へ呼び出しごとに新しいoptionsを渡す。依存の修正・更新や取得の直列化は行っていない。固定版との互換性・並行取得の挙動を変える場合は別途合意・比較する。
- 本家への報告: 未報告

#### 再現手順と観測

1. URL previewは有効、summary proxyは未使用、redirect追従は有効とする。実Summaly 5.5.2と実HTTPのローカルoriginを使い、ページA/Bは `Accept-Language` をそのままHTMLのtitleへ入れて返す。HTTP/HTTPSには通常のNode agentを渡す。
2. Aをlang=`en`で開始し、ページAへのHEADの応答だけを保留する。
3. Bをlang=`ja`で開始する。BのHEADが来たらBだけ解放し、Bのsummary完了を待つ。
4. AのHEADを解放してAのsummary完了を待ち、ページのHEAD/GETの言語とtitleを比較する。faviconへのHEADは保留しない。
5. 固定本家の抽出した `fetchSummary` と、新実装の直接取得adapterで同じ順序を実行する。

両方で次の結果になった。faviconへの補助HEADは表から省く。

| 順序 | ページ取得 | Accept-Language |
| --- | --- | --- |
| 1 | HEAD A | `en` |
| 2 | HEAD B | `ja` |
| 3 | GET B | `ja` |
| 4 | GET A | `ja` |

要求はA=`en`・B=`ja`だが、結果のtitleは **A=`ja`・B=`ja`** だった。固定本家のimport/decoratorの組み立てだけを置き換えたmethod実行と、新adapterの実行が同じ実ライブラリ・実HTTPで一致した。

この観測はdirect取得でHEAD待機を制御した1つの並行順序に限定する。summary proxy、全options・全plugin、実インターネットサイト、本家full server/DBは比較していない。通常agentを使ったため、外向きHTTPのアドレス制限の検証を意味しない。

#### 観測の版の固定

観測対象の新実装は `5fd08942be882a6280924fd9476e745fd5eebf4e`。固定本家 `UrlPreviewService.ts` のSHA-256は `fed3026c5f3d57b0566df10f086444cb31907ffc910923ac23340ca5bc2cc9ea`、実行したSummaly 5.5.2 `built/index.js` は `e2877c389b300b13dfcd4432e67c9f83b3bc34a82521960cf9b9162b2fd76ccc`。新実装と本家抽出処理の観測を混同せず、いずれもこの版・手順に対する結果として残す。
