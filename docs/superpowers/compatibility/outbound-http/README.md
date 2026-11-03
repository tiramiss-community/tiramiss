# 外向き HTTP と SSRF 対策の本家比較資料

対象は [#216](https://github.com/tiramiss-community/tiramiss/issues/216) の最初の実装 PR。契約の正本は[外向き HTTP と SSRF 対策の最小契約](../../../backend-next/outbound-http-contract.md)。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。

## 資料

| ファイル | 用途 |
| --- | --- |
| `unit-cases.json` | `getAgentByUrl` の真理値表、`isPrivateIp` と `ipaddr.range()`（`::ffff:` の写像とアドレスファミリーの違いを含む）、不正な CIDR で本家が投げる例外、`StatusError` の分類、`loadConfig` の `userAgent` と外向き HTTP の設定キー |
| `http-cases.json` | 偽の外部サーバーへ本家の `HttpRequestService.send`・`getJson` を向けた結果。成功・失敗の種類と message、最終 URL、サーバーが受け取ったヘッダー・本文・接続元アドレス、proxy が受けた CONNECT |
| `intentional-differences.json` | 外向き HTTP の意図的差異の台帳。H1（不正な `allowedPrivateNetworks` を起動時に `INVALID_CONFIG`）だけを持つ |
| `reference-outbound-http.unit.ts` | 上の 2 つの JSON の `inputs` を本家に通し、`cases` と照合する probe |

偽サーバーと case の実行器は [packages/backend-next/test/helpers/outbound-http-fakes.ts](../../../../packages/backend-next/test/helpers/outbound-http-fakes.ts) の 1 か所に置き、probe と新実装のテストが同じものを使う。各 JSON は `inputs`（入力表）と `cases`（本家の結果）を持つ。新実装のテストは `cases` を読み込み、値を手で複製しない。

## 偽の外部サーバー

- **名前解決**: `dns.promises.Resolver.prototype` の `resolve4`/`resolve6` を差し替える。cacheable-lookup は生成時にこれを束縛するので、本家と新実装の agent に手を加えずに、`*.outbound.test` を 127.0.0.x へ向けられる。表にない名前（`localhost` を含む）は見つからない扱いにする。
- **アドレス**: 127.0.0.1 を private 宛て、127.0.0.2 を公開アドレスの代役とし、既定で `allowedPrivateNetworks: [127.0.0.2/32]` を与える。private 判定は本家では `NODE_ENV=production`、新実装では composition の `checkPrivateAddress` で有効にする。127.0.0.0/8 の複数アドレスへの bind と `outgoingAddress: 127.0.0.3` は Linux を前提にする。
- **https**: `openssl` で一時的な自己署名証明書を作り、`tls.setDefaultCACertificates` で既定の信頼先へ足す。agent に `ca` を渡すと本家と違う設定になるため。
- **proxy**: CONNECT だけを受ける HTTP proxy。宛先の名前は同じ DNS 表で解決する。

## 観測した本家の挙動

コードを読むだけでは分かりにくかったもの。新実装は差異にせず揃えている。

- **User-Agent**: headers の合成はオブジェクトの spread なので、キーが `User-Agent` と完全に一致すれば置き換わる。`user-agent`・`USER-AGENT` では既定値と指定値の両方が送られる。`getJson` に `accept` を小文字で渡した場合も、`Accept` が 2 つ送られる。
- **`outgoingAddress`**: 直接の接続では接続元が変わる。proxy 経由では効かない（hpagent が CONNECT の接続に `localAddress` を渡さない）。
- **サイズ上限**: 展開後の大きさに効く。gzip で展開後がちょうど上限なら、圧縮後が上限を超えても成功する。展開後が 1 byte 超えれば失敗する。`send` 自体は成功し、本文の読み取り（`text()`・`json()`）で `max-size` の FetchError になる。
- **timeout**: 応答ヘッダー前なら `send` が、本文の途中なら読み取りが `AbortError: The operation was aborted.` で失敗する。
- **redirect**: 20 回までは追い、21 回目で `maximum redirect reached at: <21 回目の redirect を返した URL>`（type `max-redirect`）になる。redirect 先ごとに agent を選び直すので、proxy 経由から bypass ホストへの redirect は private 判定で遮断され、bypass ホストから proxy 経由への redirect は判定されない。
- **redirect 時のヘッダー**: `Authorization`・`Cookie` は同じホストとサブドメインへは残り、別ドメイン・親ドメイン・プロトコルの変更（https→http と http→https の両方）では削除される。それ以外のヘッダーは残る。303 では GET に変わり本文と `content-length` は消えるが、`Content-Type` は残る。307 では POST と本文を保つ。
- **名前解決**: `lookup:false` のため `/etc/hosts` へ戻らない。DNS が答えない `localhost` は、`allowLocalAddress` でも `cacheableLookup ENOTFOUND localhost` で失敗する（native の agent も同じ lookup を使う）。
- **`proxyBypassHosts`**: `url.hostname` との完全一致。bypass に名前だけを書いた場合、同じ宛先の IP リテラルは proxy 経由になり判定されない。`allowLocalAddress` は proxy があると効かず、proxy 経由になる。
- **失敗の形**: 遮断は `FetchError`（type `system`）で、message は `request to <URL> failed, reason: Blocked address: 127.0.0.1`。JSON として読めない本文は `SyntaxError` をそのまま送出する（message は V8 の文言）。

## probe の実行

probe は固定コミットの本家で実行する。本リポジトリの旧 backend・新 backend の製品コードに追加するテストではない。

1. 固定 SHA の worktree を作り、依存を用意する（`pnpm install`、または同じ lockfile の `node_modules` を参照する）。ルートの `built/meta.json`（`{"version": ...}`）が必要。
2. `packages/backend/test/unit/<任意のディレクトリ>/` へ、本ディレクトリの JSON 2 つと `reference-outbound-http.unit.ts`（`.test.ts` に改名）、上記の `outbound-http-fakes.ts` をコピーする。
3. `packages/backend` で、`.node-version` の Node を使って `vitest run --config vitest.config.ts <コピー先>` を実行する。単体用の設定は DB を前提とする global setup を持つため使わない。`openssl` が必要。
4. 入力表を変えたときは、`OUTBOUND_HTTP_PROBE_WRITE=1` を付けて実行して `cases` を再生成し、JSON を本ディレクトリへ戻す。その後、環境変数なしで再実行して一致を確かめる。

probe は re2 を差し替える（federation-base と同じ理由）。また、本家の `loadConfig` が読む `built/._config_.json` だけを `node:fs` のモックで与え、固定本家の作業ツリーを書き換えない。

2026-11-03 に Node.js `v26.4.0` で記録し、2 件（unit 374 件・http 66 件の観測）とも一致した。Node.js `v24.20.0` でも同じ結果になった。

## 新実装への接続

| 新テスト（`packages/backend-next/test/`） | 接続した期待値 |
| --- | --- |
| `unit/outbound-http/rules.test.ts` | `unit-cases.json` の `agentByUrl`・`isPrivate`・`invalidNetworks`・`statusError` の全件 |
| `unit/config.test.ts` | `unit-cases.json` の `config` の全件（本家が `null` のまま持つ値は `undefined` と比べる）、`invalidNetworks` の入力に対する H1、`upstream-sync.json` と同じ commit に version を固定していること |
| `unit/outbound-http/fake-servers.test.ts` | `http-cases.json` の全件。加えて、validator が 2xx のときだけ動くこと（本家の probe には含めていない） |

## 未検証・範囲外

契約の検証項目のうち、この PR で扱わないもの。

- **後続の PR へ**: `download`・`downloadText`（redirect 10/11 回、content-length と転送量の超過、書きかけのファイル、content-disposition、非 2xx）と、その gzip 上限は #188。`getHtml` は #215 のメタデータ取得。adapter 用の agent の窓口（`agentPairFor`・`defaultAgents`）は #188・#177・#196。Activity の取得と content-type の検証は #195。
- **観測していない**: IPv6 の宛先への実接続（分類は単体で比較）、実 DNS での `/etc/hosts` の扱い（偽の DNS で「DNS が答えなければ戻らない」ことだけを固定）、DNS rebinding、CacheableLookup の TTL、agent の `keepAlive`・`maxSockets`・`lifo` の値（コードの読解だけ）、https の proxy・proxy 認証、proxy 経由の timeout。
