# 連合の共通土台の本家比較資料

対象は [#215](https://github.com/tiramiss-community/tiramiss/issues/215)。契約の正本は[連合の共通土台の最小契約](../../../backend-next/federation-base-contract.md)。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。

## 資料

| ファイル | 用途 |
| --- | --- |
| `host-cases.json` | `toPuny`・`toPunyNullable`・`punyHost`、自ホストごとの `isSelfHost`・`getFullApAccount`・`isUriLocal`、絵文字名のホスト（`CustomEmojiService.parseEmojiStr` の host） |
| `policy-cases.json` | 連合設定ごとの `isFederationAllowedHost`・`isBlockedHost`・`isSilencedHost`・`isMediaSilencedHost`、`isDeliverSuspendedSoftware` |
| `reference-federation-base.unit.ts` | 上の JSON の `inputs` を本家の `UtilityService`・`CustomEmojiService` に通し、`cases` と照合する probe |

各 JSON は、`inputs`（入力表）と `cases`（本家の結果）を持つ。新実装のテストは `cases` を読み込み、値を手で複製しない。

自ホストには、通常の名前、IDN、ポート付き（`localhost:3000`）を含む。ポート付きの自ホストでは、本家の `toPuny` が `''` を返す。そのため `isUriLocal` は自 URI でも false になり、自ホスト名を書いた絵文字もリモート扱いになる。新実装はこの結果に揃え、意図的差異にしない。

## probe の実行

probe は固定コミットの本家で実行する。本リポジトリの旧 backend・新 backend の製品コードに追加するテストではない。

1. 固定 SHA の worktree を作り、依存を用意する（`pnpm install`、または同じ lockfile の `node_modules` を参照する）。
2. 3 ファイルを `packages/backend/test/unit/<任意のディレクトリ>/` へコピーし、`.unit.ts` を `.test.ts` に改名する。
3. `packages/backend` で、`.node-version` の Node を使って `vitest run --config vitest.config.ts <コピー先>` を実行する。単体用の設定は DB を前提とする global setup を持つため使わない。
4. 入力表を変えたときは、`FEDERATION_BASE_PROBE_WRITE=1` を付けて実行して `cases` を再生成し、JSON を本ディレクトリへ戻す。その後、環境変数なしで再実行して一致を確かめる。

probe は re2 を差し替える。対象の関数は re2 を使わず、ネイティブモジュールを `.node-version` の Node 向けに再ビルドせずに実行するためである。

2026-11-03 に Node.js `v26.4.0` で実行し、2 件とも一致した。Node.js `v24.20.0` でも同じ結果になった。

## 新実装への接続

| 新テスト（`packages/backend-next/test/`） | 接続した期待値 |
| --- | --- |
| `unit/federation/host.test.ts` | `host-cases.json` の全件 |
| `unit/federation/policy.test.ts` | `policy-cases.json` の全件。自ホストが none・blocked より優先されること |
| `integration/meta.test.ts` | 本家の `MetaService.fetch` と同じ Meta の選び方（id の大きい行）、行がない場合の id `'x'` の作成と同時呼び出し、`readFederationPolicy` |

URI からホストを取り出す `extractDbHost` と `isFederationAllowedUri` は、最初の利用者（#160・#195）と同じ PR で入れ、そのときに入力表を追加する。
