# 投票推薦 #489

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`、作業基点は `7f64bd8f5996791f9cfe47b9aec124a988c3182d`。対象は親#184の `POST /api/notes/polls/recommendation` のみ。親#184・全体#114や投稿機能の完了は主張しない。投票更新、TL共通filterの一律適用、cache設計は対象外。

通常HTTPは `note-routes.ts` → `poll-recommendation-http.ts` → 専用moduleの公開入口へ接続する。UseCaseが資格・凍結・read:account判定を入力検証より先に行い、DB adapterがPoll選択とNote再取得を行う。描画は既存の集合読取・純粋renderへviewerを渡す。

本家と同じく、local・本人以外・public・期限なし/現在時刻より後・未投票・mute対象外をPollの非正規化列から選ぶ。期限の等号は除外し、期限切れmute行も行が残っている間は除外する。`excludeChannels`既定false、`poll.noteId DESC`、limit既定10/最大100、offset既定0。Noteを改めて `id DESC` で取得し、選択後に削除されたNoteは返さない。localOnly、block、作者の凍結などのTL追加filterを持ち込まない。offsetは本家schemaに下限がなく、負数はPGエラー/HTTP500になる挙動も維持する。

## 比較と限界

- `source-probe.mjs` はGit objectのendpoint callback/schema/metaをASTから抽出する。同一PGに本家callbackを実行し、packManyのID doubleを新実装の通常listening HTTP結果と9入力で直接比較した。保存されるNote/Poll/PollVote/Muting全列の前後も一致する。
- `auth-source-probe.mjs` は本家ApiCallServiceの未資格gateとApiError constructorを抽出する。そのstatus/bodyを通常HTTPの未認証結果と比較する。
- `source-observations.json`、`pg-observations.json`、`auth-observations.json` はそれぞれの観測。時刻は `2026-11-17T00:00:00.000Z` に固定する。PG観測のIDはfixture内の添字へ正規化し、異なる実行の乱数suffixを混同しない。
- full upstream server/認証器/Note packer全体の直接比較ではない。認証・認可・入力エラー、viewer付きNote/Poll描画、Note再取得時の削除競合は新実装の実HTTP/PGで検証する。既存Note読取のD7 64階層/256 Note・循環500とMeta/cacheの既知境界を引き継ぐ。

## 実行

独立node_modulesへ `pnpm install --frozen-lockfile --filter backend-next...` を実行する。専用Composeは `sol-poll489`、PG61432、Redis61379。ユーザー用 `misskey-infra` は使わない。通常HTTPは動的port。設定とmigrationは `packages/backend-next/README.md` に従う。

```sh
BACKEND_NEXT_TEST_DB_PORT=61432 BACKEND_NEXT_TEST_REDIS_PORT=61379 docker compose -p sol-poll489 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-upstream sync:check
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/note/recommend-polls.test.ts test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=61432 BACKEND_NEXT_TEST_REDIS_PORT=61379 BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-git-objects pnpm --filter backend-next test:integration test/integration/poll-recommendation.test.ts test/integration/notes-list.test.ts test/integration/note-show.test.ts
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-git-objects node docs/superpowers/compatibility/poll-recommendation/source-probe.mjs --check
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-git-objects node docs/superpowers/compatibility/poll-recommendation/auth-source-probe.mjs --check
node --test scripts/*-contract*.test.mjs
node scripts/check-shipping.mjs --base 7f64bd8f5996791f9cfe47b9aec124a988c3182d
```

`POLL_RECOMMENDATION_WRITE_EVIDENCE=1` は実測時だけPG観測を保存する。通常CIでは観測ファイルを書き換えない。上記source環境変数なしのintegrationではsource直接比較1件が明示skipとなるため、その実行だけで本家比較成功とは扱わない。

## 実測と失敗履歴

全ログ: `/tmp/sol-delivery-20261117/poll489/`。`current-evidence.json` が最終R3の入力hash・実行コマンド・結果・ログhashを持つ。`r2-current-evidence.json` はR2時点の25入力と実測をそのまま保持する。R2からR3へ製品runtimeは不変で、未認証source観測とそのHTTP検証、projection診断の互換修正を加えた。

R2: sync/build/typecheck・全単体4,947・実PG/HTTP56・sourceがPASS、実測前後の入力driftなし。R3: sync/build/typecheck・近傍単体21・未認証比較を追加した実PG/HTTP57・両sourceがPASS、27入力の実測前後driftなし。R2の全単体件数を変更後のfixtureの再測定へ読み替えない。

失敗はログに保持した。意図したTDD missing-moduleとprojection未実装のRED以外に、単体fixtureのreactionCount/旧reaction名期待で2回、既存composition一覧の新route期待不足で1回、共有proofの固定hashで1回、整形lintで1回、projectionの診断prefixを旧negative testが拒否して1回。fixture2修正・route期待1修正・有限projection1追加・整形1修正・診断prefix1修正の6修正段階。製品runtimeの不一致による実PG/HTTP失敗はない。

## 共有proofの保守

既存#305 R3のreceipt・seal・測定値は不変。`predecessor.json` と `scripts/notes-pagination-evidence.mjs` の有限projectionは今回の `note-routes.ts` の3追加と共有composition testの2追加だけを、current hash・厳密byte anchor・最終歴史hashでR3 bytesへ戻す。古い実測を今回コードへ付け替えない。root negative testは今回ファイルの任意drift、歴史bytesをcurrentとして渡す操作、receipt改ざんを拒否する。cache・検証scope・上限の変更はない。

並行#294との合成は、memo追加→poll-only bytes→#305 R3の順に有限projectionを通す。#294担当が既知combined hashのsynthetic検証を所有し、取りまとめ担当が実合成bytesを照合する。各PR単独の成功から合成成功を主張しない。

CHANGELOG候補: backend-nextで未投票のローカル公開投票を推薦するAPIを追加。
