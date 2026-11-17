# 公開 Role と UserDetailed 向け材料 #295

親 #181、全体 #114。固定本家 `8e07cf085adf7009583d234a208e30436f020e26`。

`roles/list` は認証と `read:account` を要求し、公開かつ探索可能なロールを repository の取得順で返す。本家には ORDER BY がないため、displayOrder 順へ並べ替えない。`roles/show` は認証不要で公開ロールを取得し、非公開・未知を同じ `NO_SUCH_ROLE` とする。探索不可でも公開なら show で取得できる。

既存 admin show と公開 API は `createRoleShowReader` / `roleResponse` を共有する。期限なし・基準時刻より後の手動割当だけを数え、等号は失効する。条件ロールに一致するユーザーの総数を計算しない。欠落または null の policy を本家の既定値で補完し、既存設定と未知キーを保持する。取得完了後の `roleResponse` は DB を読まない。

`userRoleMaterials` は既存の条件評価・割当選択を使う純粋関数で、UserDetailed の roles フィールドに必要な公開ロールの8項目を displayOrder 降順で返す。同値は手動割当、条件ロールの入力順を保ち、本家同様に重複を除去しない。`createRoleShowReader.readUserRoles(userFacts, atMs)` はこの材料を DB から取得する狭い入口である。UserDetailed 全体の実装・組み立ては #297、roles/notes と所属ユーザー一覧は別 Issue に残る。

[source-probe.mjs](source-probe.mjs) は固定 Git オブジェクトの endpoint callback、Role pack/packMany、getUserRoles/getUserAssigns/evalCond、UserEntityService の roles 式を抽出して実行する。隔離 DB に全 migration を適用し、実 TypeORM/PostgreSQL と listening Fastify を使う。clock と fresh cache、isLocalUser、Ajv とエラー包装を明示的に束縛する。本家アプリ全体・Nest DI・認証・共有キャッシュの再現ではない。認証と scope は新実装の実トークン HTTP と既存 Role acceptance で確認する。

[corpus.json](corpus.json) が同一入力、[observations.json](observations.json) が本家の実行結果である。source hash と corpus hash を記録し、成功レスポンス・割当件数・条件ロールの成立を probe 自身でも検査する。新実装の `role-public.test.ts` はその応答全体と UserDetailed 材料を直接比較し、通常 `createBackendHttpApp` と listening Role HTTP の両方へ接続する。認証必須・scope・凍結・入力形・期限の前後/等号・query failure の500と非書込を検査する。query failure は repository 窓口への明示的な障害注入であり、実 PG のパケット切断試験ではない。

```sh
PATH=/tmp/tiramiss-s1-node26/bin:$PATH BACKEND_NEXT_TEST_DB_PORT=15795 node docs/superpowers/compatibility/role-public/source-probe.mjs
PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next test test/unit/role test/unit/http/endpoint-access.test.ts test/unit/composition/http-app.test.ts
PATH=/tmp/tiramiss-s1-node26/bin:$PATH BACKEND_NEXT_TEST_DB_PORT=15795 BACKEND_NEXT_TEST_REDIS_PORT=16795 pnpm --filter backend-next test:integration test/integration/role-public.test.ts test/integration/http-app.test.ts
PATH=/tmp/tiramiss-s1-node26/bin:$PATH BACKEND_NEXT_TEST_DB_PORT=15795 BACKEND_NEXT_TEST_REDIS_PORT=16795 pnpm --filter backend-next test:acceptance
node --test scripts/role-public-contract.test.mjs scripts/notes-pagination-contract.test.mjs
```

専用 Compose は `sol3-role295`（PG15795/Redis16795/Meili17795）。独立 node_modules、Node26.4.0 / pnpm12.9.1 で実測する。実測コマンド・結果・前後の入力一致は [current-evidence.json](current-evidence.json) を参照。

共有 route assertion の追加は `scripts/notes-pagination-evidence.mjs` の有限 projection で正確な追加 byte だけを除去する。従来 receipt の hash・成功数・測定内容は変更せず、未知 byte の差分は拒否する。過去証跡の成功を今回の再測定へ読み替えない。
