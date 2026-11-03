# 連合の共通土台の本家比較資料

対象は [#215](https://github.com/tiramiss-community/tiramiss/issues/215)。契約の正本は[連合の共通土台の最小契約](../../../backend-next/federation-base-contract.md)。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。

## 資料

| ファイル | 用途 |
| --- | --- |
| `host-cases.json` | `toPuny`・`toPunyNullable`・`punyHost`、自ホストごとの `isSelfHost`・`getFullApAccount`・`isUriLocal`、絵文字名のホスト（`CustomEmojiService.parseEmojiStr` の host）、URI から DB 用のホストを取り出す `extractDbHost`（入力は `dbHostUris`） |
| `policy-cases.json` | 連合設定ごとの `isFederationAllowedHost`・`isBlockedHost`・`isSilencedHost`・`isMediaSilencedHost`、連合設定ごとの `isFederationAllowedUri`（入力は `uris`、case は `fn: 'isFederationAllowedUri'`）、`isDeliverSuspendedSoftware` |
| `reference-federation-base.unit.ts` | 上の JSON の `inputs` を本家の `UtilityService`・`CustomEmojiService` に通し、`cases` と照合する probe |

各 JSON は、`inputs`（入力表）と `cases`（本家の結果）を持つ。新実装のテストは `cases` を読み込み、値を手で複製しない。

自ホストには、通常の名前、IDN、ポート付き（`localhost:3000`）を含む。ポート付きの自ホストでは、本家の `toPuny` が `''` を返す。そのため `isUriLocal` は自 URI でも false になり、自ホスト名を書いた絵文字もリモート扱いになる。新実装はこの結果に揃え、意図的差異にしない。

`extractDbHost` も `toPuny(new URL(uri).host)` なので、既定でないポートを持つ URI（`https://remote.example:8443/inbox`、`https://[::1]:8443/x`）では `''` を返す。既定のポートは URL の解釈で消えるため、`:443` は通常のホストになる。その結果 `isFederationAllowedUri` は、ポート付きの URI を自ホストとも一覧のホストとも一致しない `''` として判定する。連合が `all` なら `blockedHosts` にあるホストでもポート付きなら許可し、`specified` なら `federationHosts` にあるホストでもポート付きなら拒否する。新実装はこの結果にも揃える。

## probe の実行

probe は固定コミットの本家で実行する。本リポジトリの旧 backend・新 backend の製品コードに追加するテストではない。

1. 固定 SHA の worktree を作り、依存を用意する（`pnpm install`、または同じ lockfile の `node_modules` を参照する）。
2. 3 ファイルを `packages/backend/test/unit/<任意のディレクトリ>/` へコピーし、`.unit.ts` を `.test.ts` に改名する。
3. `packages/backend` で、`.node-version` の Node を使って `vitest run --config vitest.config.ts <コピー先>` を実行する。単体用の設定は DB を前提とする global setup を持つため使わない。
4. 入力表を変えたときは、`FEDERATION_BASE_PROBE_WRITE=1` を付けて実行して `cases` を再生成し、JSON を本ディレクトリへ戻す。その後、環境変数なしで再実行して一致を確かめる。

probe は re2 を差し替える。対象の関数は re2 を使わず、ネイティブモジュールを `.node-version` の Node 向けに再ビルドせずに実行するためである。

2026-11-03 に Node.js `v26.4.0` で実行し、2 件とも一致した。Node.js `v24.20.0` でも同じ結果になった。同じ日に `extractDbHost`・`isFederationAllowedUri` の入力表を足して再生成し（#160）、Node.js `v26.4.0` と `v24.20.0` で一致を確かめた。既存の case は変わっていない。

## 新実装への接続

| 新テスト（`packages/backend-next/test/`） | 接続した期待値 |
| --- | --- |
| `unit/federation/host.test.ts` | `host-cases.json` の全件（`extractDbHost` を含む） |
| `unit/federation/policy.test.ts` | `policy-cases.json` の全件（`isFederationAllowedUri` を含む）。自ホストが none・blocked より優先されること |
| `integration/meta.test.ts` | 本家の `MetaService.fetch` と同じ Meta の選び方（id の大きい行）、行がない場合の id `'x'` の作成と同時呼び出し、`readFederationPolicy` |
| `unit/federation/keys.test.ts` | `genRsaKeyPair` の形式（RSA 2048・SPKI・PKCS#8）と生成した鍵での署名・検証、`UserKeypairService.fetcher` の PKCS#1→PKCS#8 変換、`ApRendererService.renderKey` の SPKI 化 |
| `unit/logger.test.ts` | `privateKey` を含むキーの伏せ字（log・`DiagnosticError` の details） |
| `integration/federation-keys.test.ts` | `SystemAccountService`: 5 表の同時作成と作成時の値、2 回目は再作成しないこと、途中失敗で全行が戻ること、同名ユーザーでの早期 return、`instance.actor`・`relay.actor` の移行済みデータ、同時の初回作成（片方が `user` の一意制約違反 23505 で失敗し、1 組だけ残る）、10 分のキャッシュ。`UserKeypairService`: `kvcache:userKeypair:v2:<userId>`（Redis 24 時間、値は TypeORM が読んだ `MiUserKeypair` の JSON と一致）、Redis の値の優先とメモリ 1 時間、行がない場合に否定キャッシュしないこと、PKCS#1 の変換と待たない DB 更新、その失敗が鍵を含まずに log に残ること |

鍵とシステムアカウントは Node の `crypto` と DB・Redis の状態だけで比較できるため、本家 probe は追加していない。Redis の値の形は、同じ本家 Entity を TypeORM で読んだ値の JSON と一致することで確かめた。

URI からホストを取り出す `extractDbHost` と `isFederationAllowedUri` は、最初の利用者の #160 で入れた。入力表も #160 で追加し、`host.test.ts`・`policy.test.ts` が全件を読む。
