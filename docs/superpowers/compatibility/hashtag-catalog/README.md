# Hashtag catalog #495

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の hashtags/list・search・show と HashtagEntityService の公開描画を移植する。通常 HTTP の composition へ登録し、既存 Hashtag の6件数だけを読む。producer・Entity・migration・membership 配列は変更しない。

show は NFKC＋小文字化する。search は小文字化のみで、SQL LIKE の `%`・`_`・`\` を文字として前方検索し、mentionedLocalUsersCount 降順の offset/limit を適用する。負 offset は入力スキーマで禁止されず、PostgreSQL エラーが HTTP 500 になる。本家どおり list の `+` は降順、`-` は昇順で、attached の3条件は独立した AND。件数同順位の二次順序は保証しない。

`corpus.json` の53入力を `source-probe.mjs` が固定 Git source から抽出した literal endpoint callback・paramDef・packer・normalizer・SQL escape で実行する。DB は専用 PostgreSQL 上に毎回作成・削除し、同期済み本家 Entity と TypeORM を使う。`observations.json` はソース hash と corpus hash、出力/エラーを記録する。Nest DI・本家 HTTP サーバー全体・本家認証 gate の実測ではない。

`test/integration/hashtag-catalog.test.ts` は別の DB と通常 composition の listening HTTP で同じ53入力を比較し、全保存列の不変、公開 gate（匿名・凍結済 native・scope のない access token）、不正 token、GET/CORS/不正JSON、既存 Note/profile producer の行、DB 不在を確認する。source は handler/schema/PG の比較、HTTP共通 gate は新実装の近接検証として区別する。

実行例（専用 Compose project と未使用 port を選ぶ）:

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-next... build
BACKEND_NEXT_TEST_DB_PORT=55495 BACKEND_NEXT_TEST_REDIS_PORT=56495 docker compose -p backend-next-495 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=55495 node docs/superpowers/compatibility/hashtag-catalog/source-probe.mjs --check
pnpm --filter backend-next test test/unit/hashtag-catalog.test.ts test/unit/note/hashtags.test.ts test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=55495 BACKEND_NEXT_TEST_REDIS_PORT=56495 pnpm --filter backend-next test:integration test/integration/hashtag-catalog.test.ts test/integration/note-hashtags.test.ts
node --test scripts/hashtag-catalog-contract.test.mjs
BACKEND_NEXT_TEST_DB_PORT=55495 BACKEND_NEXT_TEST_REDIS_PORT=56495 docker compose -p backend-next-495 -f packages/backend-next/compose.test.yml down
```

実測は `current-evidence.json` に対象入力 hash と各ログ hash を保持する。近傍単体82件、通常HTTP/PG57件、既存producer実PG29件、source再現53件が成功。source の `--write` は意図した期待値更新時だけ実行する。通常 CI は保存済み期待値を読むためソース Git object・本家server・source用DBを要求しない。

`predecessor.json` と `scripts/hashtag-catalog-evidence.mjs` は composition の2ファイルから今回の追加バイトだけを、実測入力が一致する場合に除去する。旧 chart/notes/Page/Role/Drive 等の receipt は元の測定の履歴として保持し、現在の製品測定へ書き換えない。無関係な drift と過去 receipt の破損は既存検査で拒否する。

利用者一覧 #499、trend #496、producer の再実装、検索全体・親 #186 の完成は対象外。旧 backend API 定義を変更しないため misskey-js 型再生成は不要。
