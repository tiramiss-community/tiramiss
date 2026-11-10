# 外向き HTTP と SSRF 対策の最小契約（#216）

判断基準は[GOALS](GOALS.md)。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。外向き HTTP については、本書を旧詳細設計（旧ジョブや配送保証の設計を含む）より優先する。

#216 が持つのは、送信の安全条件と設定の互換だけ。ほかは次の Issue が持つ。
- AP の署名・digest と、結果の分類（410 と sharedInbox を含む）: #160
- 連合可否・ホストの正規化・自ホストの判定: #215
- 宛先と内容: 各領域
- 名前解決・redirect・timeout: 本書の `send` が提供する。#160 はこれを再実装しない。
- #171: #160 を経由してだけ使う。

DNS キャッシュはプロセス内のものなので、#217 の同期対象ではない。

## 置き場所と依存

- 実装は `src/platform/outbound-http/` に置く。本家と同じライブラリを同じ版で使う（node-fetch 3.3.2、got 16.0.0、hpagent 1.2.0、cacheable-lookup 7.0.0、ipaddr.js 2.5.0。packages/backend/package.json:82-139）。こうすると、redirect・ヘッダーの削除・展開・サイズ超過の挙動が本家と揃う。
- 組み立ては composition で行い、UseCase には下記の関数を渡す。業務コードへ渡すのは、次のものだけにする。
  - 文字列・数値・`Record<string,string>`
  - Web 標準の `Uint8Array`・`FormData`・`URLSearchParams`
  - 失敗クラス
  
  node:http の Agent、ライブラリの Response、DI コンテナは渡さない。
- 失敗クラスと契約型は `src/application/outbound-http.ts` に置く。ここには node 固有の型を入れない。
- 万能の HTTP フレームワークや、目的別の送信ディスパッチャは作らない。

## 公開契約

| 操作 | 入力 → 出力／失敗 | 利用 |
| --- | --- | --- |
| `send(url, {method='GET', headers, body, timeoutMs=5000, maxBytes=10MiB, allowLocalAddress=false}, {okOnly=true})` | `{status, statusText, finalUrl, header(name), text(), json()}`。本文は遅延して読み、maxBytes を超えると読み取り時に失敗する。okOnly で非 2xx なら `OutboundStatusError` | #160 signedPost、#195 signedGet、#215 favicon の HEAD、#188 センシティブ画像判定（multipart）、#197/#198 webhook、#179 captcha・OAuth の client_id・メール検証、#183 翻訳、#196 fetch-external-resources |
| `getJson(url, accept='application/json, */*', headers?)` | 5000ms・256KiB で JSON を返す | #195 WebFinger、#215 nodeinfo・manifest、#196 |
| `getHtml(url, accept='text/html, */*', headers?)` | 5000ms・10MiB で text を返す | #215 インスタンス情報、rel=me 検証の担当 |
| `download(url, destPath)`/`downloadText(url)` | `{filename}`／UTF-8 文字列。非 2xx は `OutboundStatusError`、それ以外は元の例外 | #188 URL からのアップロード・/proxy、#199 import/export・絵文字 |

adapter 専用の agent の窓口は、本家の規則ごとに分ける。業務コードには渡さない。

- `agentByUrl(url, bypassProxy, allowLocalAddress)`: S3（#188）が使う（packages/backend/src/core/HttpRequestService.ts:210-223）。
- `agentPairFor(url, allowLocalAddress)`: got・download（#188）と web-push（#177）が使う（:230-255）。
- `defaultAgents()`: URL に依存しない `{http, https}` の組。summaly（#196）が使う（packages/backend/src/server/web/UrlPreviewService.ts:146-149）。

失敗の扱い:
- **`OutboundStatusError`**: `{statusCode, statusMessage, isClientError(400–499), isRetryable(!isClientError || 429)}` を持ち、message は `${status} ${statusText}`（packages/backend/src/misc/status-error.ts:6-19）。#216 が定義し、#160 は分類だけを扱う。
- **それ以外**（DNS・接続・timeout・`Blocked address`・サイズ超過）: 元の例外を包まずにそのまま送出し、message も変えない。配送の失敗理由やログの文言を本家と揃えるため。

## 維持する本家の挙動

- **agent**
  - native の 2 つ、private 判定付きの 2 つ、proxy 用（hpagent）の agent を持つ。
  - proxy 以外の agent の設定: `keepAlive:true`、`keepAliveMsecs:30000`、CacheableLookup（`maxTtl 3600`、`errorTtl 30`、`lookup:false`）、`localAddress=outgoingAddress`（HttpRequestService.ts:156-175）。
  - proxy の agent の設定: `maxSockets=max(256, deliverJobConcurrency ?? 128)`、`maxFreeSockets 256`、`lifo`（:177-201）。
  - `proxyBypassHosts` は `url.hostname` との完全一致で照合する（:212）。
- **private 判定**
  - 接続後の `socket.remoteAddress` を `range() !== 'unicast'` で判定し、該当すれば `Blocked address: <addr>` で destroy する（:38-72,83-117）。
  - `allowedPrivateNetworks` の CIDR は、アドレスファミリーが一致するときだけ許可に使う。
  - 判定は本番環境（`NODE_ENV === 'production'`）でだけ行い、proxy 経由では行わない。
  - 新実装では、本番かどうかを composition から注入する。テストではこれで判定を有効にする。本番での結果は変わらないので、差異には数えない。
  - OAuth の client_id に対する事前の名前解決と検査（packages/backend/src/server/oauth/OAuth2ProviderService.ts:446-451）は本書の範囲外で、#179 が持つ。
- **send**
  - User-Agent は `Misskey/${version} (${url})`。version は固定本家の version、url は設定ファイルの `url` の生の文字列を使う。url を環境変数で与えた場合の `(undefined)` も本家どおりにする。backend-next の設定は生の文字列も保持する（packages/backend/src/config.ts:274-275,352）。2026-11-03 にユーザーが当面の本家準拠を決定した。headers はオブジェクトの spread で合成する（HttpRequestService.ts:336-339）。キーが `User-Agent` と完全に一致すれば置き換わり、小文字の `user-agent` なら連結される点も本家どおりにする。
  - timeout は AbortController で実装し、本文の読み取りも打ち切る。
  - redirect は最大 20 回で、redirect 先ごとに agent を選び直す（:325-343）。
  - validator は ok のときだけ実行する（:346-354）。
  - 展開は既定で有効にする。
- **Activity の取得**（#195 への引き継ぎ）
  - Accept は `application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`。5000ms・256KiB で、本文を読む前に content-type を検証する（HttpRequestService.ts:257-278）。
  - signedGet は既定の 10MiB を使い、HTML の alternate link を 1 回だけたどる（packages/backend/src/core/activitypub/ApRequestService.ts:207-247）。これは最初の利用者の #195 に引き継ぐ。#160 は署名付き GET の組み立て（`createSignedGet`）だけを提供する。
- **download**
  - timeout は段階ごとに 30 秒、全体で 60 秒。retry は 0 回、http2 は使わず、unix socket は不可。
  - redirect の上限は got の既定の 10 回で、`beforeRedirect` のたびに agent を選び直す（packages/backend/src/core/DownloadService.ts:42-84）。
  - サイズの上限は `maxFileSize`。content-length と転送量の 2 段階で超過を検出する（:85-111）。
  - filename は元の URL の末尾を既定にし、content-disposition があればそちらを優先する。
  - got の HTTPError は StatusError に変換する（:113-121）。
  - 一時ファイル全般の後始末（本番だけ削除する）は #188 が決める（packages/backend/src/misc/create-temp.ts:8-15）。
- **設定キー**（本家と同じ名前・意味）
  - `proxy`、`proxySmtp`、`proxyBypassHosts`、`allowedPrivateNetworks`、`outgoingAddress`、`deliverJobConcurrency`、`maxFileSize`（packages/backend/src/config.ts:89-105,330-339）。
  - どれも既定値は undefined で、コード側で `?? []` 等として扱う。example.yml の bypass の例は、既定値にしない。
  - `outgoingAddressFamily` は本家でも読み込むだけで使っていないので、RuntimeConfig には加えない。キーの互換は #138 で照合する。
  - backend-next の loader は未知のキーを無視する。そのため、使う時点で読むキーを加えても、設定ファイルの互換は保てる。

## 最初の実装 PR と後続

- **最初の PR**
  - agent 群、private 判定、`send`、`getJson`、失敗クラス、User-Agent を入れる。
  - 設定は `proxy`・`proxyBypassHosts`・`allowedPrivateNetworks`・`outgoingAddress`・`deliverJobConcurrency` を読む。`allowedPrivateNetworks` の CIDR は起動時に検査し、不正なら `INVALID_CONFIG` にする（下記の承認済み差異）。
  - 最初の利用者（#160 の fake inbox への署名送信、または #195 の WebFinger）と同じ PR か、その直前の PR で通常起動に接続する。利用者のいない送信基盤を先に積まない。
  - #160 の最初の PR は `send` を署名付き送信に使うが、配送ジョブがまだないため通常起動からは呼ばなかった。#171 の最初の PR で、worker 子の配送ジョブから通常起動へ接続した（`src/composition/deliver-job.ts`）。HTTP 子は外向き HTTP を作らない。
  - `deliverJobConcurrency` は、#171 で deliver の Worker の並行度（`?? 128`）にも使う。
- **後続**
  - `getHtml` は #215 のメタデータ取得と一緒に入れる。
  - `download`・`downloadText`・`maxFileSize` は #188 の最初の URL 取得 PR で入れる。
  - adapter 用の agent の窓口は、#188・#177・#196 が必要になった時点で公開する。
  - `proxySmtp` は #179 の EmailService で nodemailer へ渡す（packages/backend/src/core/EmailService.ts:51-61）。
- **依存**
  - #195 の remote user 解決には、#216 に加えて #215 の鍵と #160 の GET の署名も要る（`signToActivityPubGet` の既定値は true。packages/backend/src/models/Meta.ts:721-723）。signedGet 本体は #195 が持つ。
  - #170 の暫定の 501 を外すには、#195 の解決処理が要る。#216 だけでは外せない。

## 監査行の割り当て（outbound-http 10 行）

| 行 | 割り当て |
| --- | --- |
| config:proxy・proxyBypassHosts・allowedPrivateNetworks・outgoingAddress | 最初の PR（キーの互換は #138 でも照合する） |
| config:proxySmtp | #179 |
| responsibility:drive-media-http:27・28、service:HttpRequestService | 最初の PR。Activity の検証と signedGet は #195（GET の署名は #160） |
| responsibility:drive-media-http:26、service:DownloadService | #188 の最初の URL 取得 PR |

misc-utils:30 のうち StatusError の型は #216 が定義する。同じ行のほかの例外型は、引き続き現在の担当が持つ。

## 比較と検証

この層は DB と Redis を使わない。そのため、#216 の完了条件にある実 DB/Redis の検証は、#160 と #195 の結合テストで代える。実装した PR で、対応表の該当行の status・実装・検証を更新する。#160 の分は `packages/backend-next/test/integration/ap-request.test.ts` で行った。`createFederationKeys` が DB の鍵を読み、`createOutboundHttpClient` で偽の inbox へ送り、保存した公開鍵で署名を検証する。

- **単体**（HTTP と DI なし）
  - agent 選択の真理値表（bypass、proxy、allowLocalAddress、http/https、3 種類の窓口）。
  - `range()` の全分類と `::ffff:` で写したアドレス、アドレスファミリーの違い。
  - User-Agent の置き換えと連結。
  - StatusError の分類（400、410、429、5xx）。
- **偽の外部サーバー**（127.0.0.1 で起動し、private 判定を有効にする）
  - IP リテラルと DNS 名の遮断・許可。
  - private 宛ての redirect と、bypass ホスト経由の redirect。
  - redirect の回数: send は 20 回と 21 回、download は 10 回と 11 回。
  - 別ドメインへの redirect と、https から http への変更で、authorization・cookie が削除されること。
  - 本文の読み取り中にも timeout が効くこと。
  - 256KiB・10MiB の上限。gzip の場合に、上限が圧縮前と展開後のどちらに効くか（send と download の両方）。
  - fake の CONNECT proxy 経由と、`outgoingAddress`。
  - download: content-length の超過と転送量の超過（失敗の例外と、書きかけのファイルが残るか）、content-disposition、非 2xx。
  - `lookup:false` のもとで /etc/hosts の名前を解決するか。
- **本家との比較**
  - 同じ fake サーバーに本家の HttpRequestService と DownloadService を向けた probe を走らせる。
  - 成功・失敗の種類、最終 URL、送ったヘッダーを JSON の期待値として残す。未検証の挙動は、この観測で固定する。

## 意図的差異

- **不正な `allowedPrivateNetworks` は起動時に `INVALID_CONFIG`**（2026-11-03 ユーザー承認）
  - 本家では、本番で接続したときに CIDR の parse 例外が発生する。この例外は destroy より前に起きるため、その接続は遮断されない。プロセスは未捕捉例外として記録して動き続ける（HttpRequestService.ts:46-51,64-66、packages/backend/src/boot/process-error-handler.ts:56-58）。
  - backend-next には未捕捉例外のハンドラがない。同じ実装にすると、子プロセスが落ちて全体が停止する。
  - 起動時に検出すれば、設定の誤りをその場で直せる。遮断も弱まらない。
  - 差異の台帳は [compatibility/outbound-http/intentional-differences.json](../superpowers/compatibility/outbound-http/intentional-differences.json) の H1。最初の実装 PR で記録し、検証した。

これ以外は提案しない。ライブラリの置き換えや、private 判定を本番以外でも常に有効にすることは行わない。

## metadataからのgetHtml利用（2026-11-10）

段階5の現在caller接続で、`OutboundHttp.getHtml(url, accept?, headers?, allowLocalAddress?)` を既存sendへ追加する。既定Acceptは`text/html, */*`、GET、5000msと本文読取、既定10MiBを使い、content-type検査は加えない。HTTP/Redis/DBの実取得とbuilt子の待機範囲は[metadata比較資料](../superpowers/compatibility/instance-metadata/README.md)に分離する。downloadと未接続の取得経路は既存担当へ残る。
