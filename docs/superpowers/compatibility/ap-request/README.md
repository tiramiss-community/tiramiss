# AP の署名付き HTTP と配送結果の分類の本家比較資料

対象は [#160](https://github.com/tiramiss-community/tiramiss/issues/160) の最初の実装 PR。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。対象の本家コードは `ApRequestCreator`・`ApRequestService.signedPost`（`src/core/activitypub/ApRequestService.ts:43-185`）と、`DeliverProcessorService.process` の失敗の分類（`src/queue/processors/DeliverProcessorService.ts:141-161`）。

## 資料

| ファイル | 用途 |
| --- | --- |
| `test-only-keypair.json` | probe とテストだけで使う RSA 2048 の鍵（SPKI の公開鍵・PKCS#8 の秘密鍵）。秘密ではなく、どの環境の鍵にも使わない |
| `signing-cases.json` | `createSignedPost`・`createSignedGet` に、固定の時刻・鍵・URL・本文・`digest`・`additionalHeaders` を与えた結果 |
| `delivery-cases.json` | `DeliverProcessorService.process` に、`signedPost` の結果（成功・`StatusError`・その他の例外）と送信先を与えたときの分類 |
| `inbox-cases.json` | 偽の inbox へ本家の `signedPost` を向けた結果。inbox が受け取った要求、送信の例外、その例外の分類 |
| `reference-ap-request.unit.ts` | 上の 3 つの JSON の `inputs` を本家に通し、`cases` と照合する probe |

偽の inbox は [packages/backend-next/test/helpers/outbound-http-fakes.ts](../../../../packages/backend-next/test/helpers/outbound-http-fakes.ts) の `/inbox/<status>`・`/inbox/stall` と `runInbox` で、外向き HTTP の偽サーバーと同じものを使う。各 JSON は `inputs`（入力表）と `cases`（本家の結果）を持つ。新実装のテストは `cases` を読み込み、値を手で複製しない。

## JSON の形

### `signing-cases.json`

- `inputs.now`: 固定する時刻（ISO 8601）。本家は `new Date().toUTCString()` を使うので、`Date` だけを差し替える。
- `inputs.keyId`: 署名に使う keyId。鍵は `test-only-keypair.json` の `privateKeyPem`。
- `inputs.cases[]`: `{ id, method: 'POST', url, body, digest?, additionalHeaders }` または `{ id, method: 'GET', url, additionalHeaders }`。`digest` がない case は本家が本文から計算する。`additionalHeaders` には `__proto__` と文字列でない値を含む case がある（`JSON.parse` は `__proto__` を自前のキーとして作る）。
- `cases[]`: `inputs.cases` と同じ順の `{ id, expected: { request: { url, method, headers }, signingString, signature, signatureHeader } }`。URL を解釈できない case は `{ id, error: { name, message, code } }`。`headers` は小文字のキーで、署名後に `host` を消した状態。

`signature` は byte 単位で比べられる。RSASSA-PKCS1-v1_5 と SHA-256 の署名は決定的で、本家の slacc の出力は `node:crypto` の `sign('sha256', ...)` と一致する。probe は成功した全 43 件でこれも確かめる。

### `delivery-cases.json`

- `inputs.inboxes[]`: `{ to, isSharedInbox }`。
- `inputs.failures[]`: `signedPost` の結果。`{ id, kind: 'none' }` は成功。`{ id, kind: 'status', statusCode, statusMessage? }` は `HttpRequestService.send` と同じく `new StatusError(`${statusCode} ${statusMessage}`, statusCode, statusMessage)` を投げる。`{ id, kind: 'error', name, message, props? }` は `Object.assign(new Error(message), { name }, props)` を投げる。
- `cases[]`: `inboxes` × `failures` の全組み合わせで、`{ to, isSharedInbox, failure, expected }`。`failure` は `inputs.failures` の要素そのもの。`expected` は次のどちらか。
  - `{ returned: 'Success', goneSuspended: false }`
  - `{ thrown: { name, message, unrecoverable, original }, goneSuspended }`。`unrecoverable` は BullMQ の `UnrecoverableError` か、`original` は `signedPost` が投げた例外そのものを投げ直したか、`goneSuspended` は instance を `goneSuspended` にする更新を要求したか。

新実装の分類は BullMQ の型を持たない値を返す。比べるときは、`unrecoverable: true` を「止める」、`unrecoverable: false` かつ `original: false` を「`message` の Error で再試行」、`original: true` を「元の例外のまま再試行」と読む。`kind: 'status'` は新実装の `OutboundStatusError` を同じ引数で作る。

### `inbox-cases.json`

- `inputs.selfUrl`・`inputs.userId`: keyId（`${selfUrl}/users/${userId}#main-key`）を作る値。User-Agent は偽サーバーの `probeUserAgent`。
- `inputs.now`: 固定する時刻。timeout を含むため、`Date` だけを固定し timer は実時間で動かす。
- `inputs.cases[]`: `InboxCase`（`{ id, url, object, digest? }`）。`url` の `{public}` などは偽サーバーの `expand` で実際の URL に置き換える。`object` は文字列ならそのまま、それ以外は JSON にして送る。
- `cases[]`: `inputs.cases` と同じ順の `{ id, error?, received, delivery }`。
  - `error`: 送信が投げた例外の要約（`name`・`message`・`type`・`code`・`statusCode` など）。成功ならない。
  - `received[]`: 偽サーバーが受け取った要求（redirect の途中も含む）。`{ listener, method, path, headers, body, verified }`。`headers` は `accept`・`content-length`・`content-type`・`date`・`digest`・`host`・`signature`・`user-agent` だけを小文字のキーで持つ。ポートは `{port:<名前>}`、`signature` ヘッダーの署名値は `{signature}` に置き換える（Host のポートで値が変わるため）。
  - `verified`: 受信した値のままで検証した結果。`signature` は、受信した method・path と `signature` ヘッダーの `headers` に並ぶ受信ヘッダーから署名文字列を組み立て、`test-only-keypair.json` の公開鍵で `crypto.verify` した結果。`digest` は受信した本文の SHA-256 と `Digest` ヘッダーの一致。ヘッダーがなければ `null`。
  - `delivery`: `error` の元の例外（成功なら成功）を `delivery-cases.json` と同じ方法で分類した結果。`personalInbox`（`isSharedInbox: false`）と `sharedInbox`（`true`）の 2 つ。`message` のポートも置き換える。

新実装のテストは、`runInbox` に新実装の `signedPost` を渡して `observation`（`{ id, error?, received }`）を比べ、返る `failure.error` を新実装の分類に通して `delivery` と比べる。署名の暗号学的な検証と Digest の照合は `verified` に含まれ、成功した送信では両方 `true` になる。

## 観測した本家の挙動

コードを読むだけでは分かりにくかったもの。

- **ホストの扱い**: `request.url`・`Host`・`(request-target)` は WHATWG URL で正規化した値を使う。ホストは小文字かつ punycode になり、既定のポートは消え、`/a/../` や `\` は解決される。fragment は `request.url` に残るが、`(request-target)` と送信される path からは消える。空の `?` は両方に残る。userinfo（`user:pass@`）も `request.url` に残る。
- **`additionalHeaders`**: キーを小文字にして既定値を上書きする。同じ名前が大小違いで複数あれば最後が勝つ。`__proto__` と文字列でない値（数値・null・真偽値・オブジェクト）は捨てる。`Date` に数値を渡すと捨てられ、既定の日付が残る。`host` を上書きすると署名文字列の `host` も変わるが、返す `headers` からは消える。`Signature` は署名後に上書きされる。
- **`digest`**: 渡された値は本文と照合しない。空文字列もそのまま使う（`??` のため）。
- **redirect**: `signature`・`date`・`digest` は redirect 先へもそのまま送られ、別ホストへの 307 でも送られる。redirect 先では署名の検証が失敗する（`verified.signature: false`）。302 は本文のない GET に変わるが、`content-type`・`digest`・`signature` は残る。どちらも最終の応答が 2xx なら `Success` になる。
- **分類のホスト**: `${host} is gone` の `host` は `new URL(to).host`。`toPuny` は通さないが、URL の解釈で小文字・punycode になり、ポートは残る（例: `https://Remote.Example:8443/inbox` → `remote.example:8443 is gone`、`https://ëxample.jp/inbox` → `xn--xample-ova.jp is gone`）。
- **分類の条件**: 410 で `goneSuspended` を要求するのは `isSharedInbox` のときだけ。個人の inbox の 410 は `410 Gone` で止めるだけ。`statusMessage` が空なら `499 `（末尾に空白）、ないなら `410 undefined` になる。429 と 4xx 以外（300・304・5xx・599）は `Error` で再試行する。408 は止める。
- **`StatusError` の判定**: `instanceof` で判定する。`name: 'StatusError'` と `statusCode: 410` を持つだけの普通の `Error` は、元の例外のまま再試行になる。
- **応答本文**: `signedPost` は応答本文を読まない。204 も 2xx として成功する。

連合の許可（`isFederationAllowedUri`）がポート付きの URI をどう扱うかは [federation-base の資料](../federation-base/README.md)に記録した。

## probe の実行

probe は固定コミットの本家で実行する。本リポジトリの旧 backend・新 backend の製品コードに追加するテストではない。

1. 固定 SHA の worktree を作り、依存を用意する（`pnpm install --frozen-lockfile`）。ルートの `built/meta.json`（`{"version": ...}`）が必要。
2. `packages/backend/test/unit/<任意のディレクトリ>/` へ、本ディレクトリの JSON 4 つと `reference-ap-request.unit.ts`（`.test.ts` に改名）、上記の `outbound-http-fakes.ts` をコピーする。
3. `packages/backend` で、`.node-version` の Node を使って `vitest run --config vitest.config.ts <コピー先>` を実行する。単体用の設定は DB を前提とする global setup を持つため使わない。
4. 入力表を変えたときは、`AP_REQUEST_PROBE_WRITE=1` を付けて実行して `cases` を再生成し、JSON を本ディレクトリへ戻す。その後、環境変数なしで再実行して一致を確かめる。

probe は re2 を差し替える（federation-base と同じ理由）。slacc は本家の単体用の環境と同じく `init(1)` してから使う。`DeliverProcessorService` は、配送前の判定がすべて通る状態（連合は `all`、停止中のホストなし、統計・チャートなし、instance の取得は `null`）の stub で作り、`signedPost` だけを差し替える。`HttpRequestService` は外向き HTTP の probe と同じく `NODE_ENV=production` で private 判定を有効にする。

2026-11-03 に Node.js `v26.4.0` で記録し、3 件（署名 46 件・分類 104 件・inbox 24 件）とも一致した。Node.js `v24.20.0` でも同じ結果になった。

## 新実装への接続

| 新テスト（`packages/backend-next/test/`） | 接続した期待値 |
| --- | --- |
| `unit/federation/http-signature.test.ts` | `signing-cases.json` の全件。`signature` を byte 単位で比べ、公開鍵で `crypto.verify` する |
| `unit/federation/delivery-result.test.ts` | `delivery-cases.json` の全件。読み替えは `test/helpers/ap-delivery.ts` |
| `unit/federation/signed-post.test.ts` | `inbox-cases.json` の全件。受信した要求（`verified` の署名・Digest の検証を含む）と、timeout・DNS・遮断を含む分類 |
| `integration/ap-request.test.ts` | 実 DB/Redis。`createFederationKeys` が読む保存済みの鍵（PKCS#1 を含む）で `createApRequest` の `signedPost` が署名し、保存した公開鍵で偽の inbox が検証できること。共有 inbox の 410 と、鍵の行がない場合の分類 |

新実装の対象は `packages/backend-next/src/modules/federation/` の `http-signature.ts`・`signed-post.ts`・`delivery-result.ts` と、`src/composition/ap-request.ts`。#160 の最初の PR では通常起動から呼ばなかった。#171 の最初の PR で、worker 子の配送ジョブから呼ぶようにした（[ap-deliver](../ap-deliver/README.md)）。

## 未検証・範囲外

- **後続の PR へ**: 配送前の判定（連合の許可・停止中のホスト・停止中のソフトウェア）と instance の状態の更新（`isNotResponding`・7 日の自動停止・`goneSuspended` の書き込み）は、#171 の最初の PR で [ap-deliver](../ap-deliver/README.md) の `processor-cases.json` と比べた。配送の成功・失敗によるチャートは #200、成功時の `fetchInstanceMetadata` は連合の共通土台の段階 5（#216 の getHtml と一緒に）で比べる。本 probe では `goneSuspended` を要求したかだけを記録し、その他の更新は記録しない。`signedGet` の応答処理（HTML の alternate、content-type の検証、`assertActivityMatchesUrl`）は #195。
- **観測していない**: https の inbox への送信と proxy 経由の送信（外向き HTTP の資料で agent の選択として比較済み）、timeout が本文の読み取り中に起きる場合（`signedPost` は本文を読まない）、`getUserKeypair` の失敗（分類だけを `keypair-missing` の入力で比較）、受信側の `@peertube/http-signature` による検証（`crypto.verify` で代える）、IDN の宛先への実際の送信（偽の DNS が持たない名前のため、署名だけを比較）。
