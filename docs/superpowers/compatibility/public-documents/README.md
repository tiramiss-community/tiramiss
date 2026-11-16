# 公開文書 #552

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `GET /manifest.json`・`GET /robots.txt`・`GET /opensearch.xml` を通常 HTTP 構成へ接続する。対象は #552、親は #196、全体は #114。SPA・SSR・静的配布は含めない。

`source-probe.mjs` は固定コミットの `ClientServerService.manifestHandler` と3つのルート callback を TypeScript AST で抽出し、実際に listen した Fastify へ HTTP リクエストする。サービス全体・上流 DB は起動しない。Meta と config は `corpus.json` の明示値で、Fastify は固定本家 checkout の実インストール版 `5.12.5`、採取環境は Node `26.4.0`。JSON.parse の例外が Fastify と同じ Error realm へ属するよう、VM にホストの JSON intrinsic を渡す。

`observations.json` は17設定・51応答の本文、status、Content-Type、Cache-Control と元ソース・corpus の SHA-256 を保存する。欠落値、空文字、個別の名前・アイコン・theme、XML/JSON の特殊文字、visitor 公開範囲、object/array/string/number/boolean/null の override、不正 JSON、空白だけの override、予約キーを含む。

| 契約 | 維持した挙動 |
| --- | --- |
| Manifest | name/shortName/theme/icons は空文字も既定値へ落とす。JSON override は上位の enumerable property だけを浅く展開し、配列・primitive を拒否しない。成功時 `application/json; charset=utf-8`、`max-age=300`。不正 JSON は上流 Fastify と同じ500 JSON・cache無し。 |
| Robots | 通常11個の Disallow。`ugcVisibilityForVisitor === 'none'` だけ `/@` と `/notes` を追加する。`text/plain; charset=utf-8`、cache無し。 |
| OpenSearch | `name ?? 'Misskey'` なので空文字を保持する。名前や URL は本家と同じ直接補間。`application/opensearchdescription+xml`、cache無し。 |
| Meta | 既存 `resources.meta.fetch` を限定した材料型へ渡す。新しいキャッシュや DB アダプタを追加しない。warm cache は未通知の DB 更新を即座に読まず、既存 `metaUpdated` の after と明示 reload を反映する。 |

新実装の単体18件と、既存 composition13件が成功。結合19件は専用 PostgreSQL/Redis と `createBackendHttpApp`・実 listen HTTP を使い、51応答を同じ fixture と本文単位で比較する。空の Meta からの既定行作成と、保存値・cache・Redis 通知の区別も確認する。通常 CI の unit/integration glob に入るため、workflow の変更は不要。

Meta 設定3行は公開文書からの参照を比較済みだが、管理APIの読み書きは #194 に残るため `partial`。3つの HTTP 行と責任行はこの有限契約を `verified` とする。アイコンや検索画面そのものの配布、共通 X-Frame-Options/HSTS・登録順・一般エラーページは #554/#563 等の範囲であり、この比較の主張に含めない。OpenSearch の特殊文字を独自に escape する変更はしていない。

## 再実行

```sh
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-upstream node docs/superpowers/compatibility/public-documents/source-probe.mjs --check
pnpm --filter backend-next test test/unit/public-documents.test.ts test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=55552 BACKEND_NEXT_TEST_REDIS_PORT=56552 pnpm --filter backend-next test:integration test/integration/public-documents.test.ts
node --test scripts/public-documents-contract.test.mjs scripts/joint-drive-meta-contract.test.mjs
```

実行前に `backend-upstream` を build し、README に従って専用 Compose project を起動する。今回の project は `backend-next-public-documents-552`、PostgreSQL `55552`、Redis `56552`、予備 pubsub Redis `56553`。ユーザーの infra は使わない。source probe の `--write` は固定本家の再調査時にだけ実行する。

## 今回の証跡と過去の証跡

`current-evidence.json` は実行ログの SHA-256 と、最後の freeze 時に採取した10入力の SHA-256 を結ぶ。入力採取は実行後であり、実行前後のハッシュ採取や commit 済み revision の測定とは主張しない。`measuredWorkingTree: true`、`inputCapture: at-final-freeze`、`upstreamFullServerMeasured: false` を明記する。build/typecheck、unit31件、integration19件、source51 HTTP と同期検査は全て成功した実ログを記録する。型検査で visitor 設定を本家と同じ union 型へ限定した修正は出力ロジックを変えない。

`predecessor.json` は基点 `0927918fe987cae2fcbf2b69bdb58ee6c5ca734a` の composition2ファイルを保持する。新 reader は独立した公開呼出しで10現在入力と証跡の seal を検査してから、その2ファイルだけを基点の表示へ戻す。既存 `joint-drive-meta-evidence.mjs` の末端1か所へ接続し、古い receipt・ログ・seal は更新しない。同期 invocation の scope 以外へ検証結果をキャッシュしない。同一の同期 scope 内で検証結果を再利用するときは、要求した path と JSON 証跡・利用可能なログの変更を検査する。要求していない TypeScript 入力は、次の独立した公開呼出しで再検査する。新契約テストは全10入力の変更、前像を現在値として渡すケース、後続呼出しでの変更、同一 scope で要求 path が変わるケース、証跡とログの改変を拒否する。

CHANGELOG 候補: 新バックエンドで manifest・robots・OpenSearch の公開文書を利用可能にした。

台帳の9契約行・6監査行の `evidenceRevision` は、実装・検証ファイルの存在を固定する checkpoint `53cbed00ee1117c7880589391c87f3b7c9c6fb14` を指す。これは実行後に作成した通常コミットであり、そのコミットを対象に実測したという意味ではない。HTTP3行の正本は `domains.json` の overrides、監査6行の正本は `audit-items.json` に置き、`contracts.json` と `contracts.md` は generator で生成する。
