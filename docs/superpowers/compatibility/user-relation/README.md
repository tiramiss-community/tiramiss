# users/relation (#296)

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `UserEntityService.getRelation/getRelations` と `users/relation` callback を比較した読取 slice。親 #182・全体 #114。関係更新と UserDetailed 全体は未完成のまま維持する。

通常製品入口 `createBackendHttpApp` から `POST /api/users/relation` を登録する。認証必須、app の scope は `read:account`。認証・停止状態・権限を入力検証より前に確認する。単一 `userId` でも `[relation]` を返し、配列入力は Map により最初の位置を保って重複を除く。空配列は `[]`、未知 ID は `following:null`・全 flag false となり、対象 User の存在確認を追加しない。

following/request/block は両方向を区別する。mute/renote-mute は viewer から対象への行だけを見る。期限切れ行でも保存されている間は true であり、この reader は削除や期限処理を行わない。本家の実返却に従って `following` には保存済み行の全 scalar 列を含め、`notify`・`withReplies`・hibernation・非正規化 host/inbox の値を保持する。Entity と relation property は公開しない。

`modules/user-relation/public.ts` の `UserRelationReader` が viewer ごとに取得し、`UserRelationMaterials` と `userRelationsFromMaterials` が取得と純粋変換を分ける。#180 は同じ取得済み材料を利用でき、変換に DB・HTTP・DI は不要。adapter は public `backend-upstream/entities` の登録済み Entity を使用する。本家の複数取得と同じく viewer の関係行を取得し、対象IDによる選択は純粋変換に集約する。上限のない配列入力をDBのINパラメータへ展開せず、65,536の一意な未知IDでも本家と同じ応答を返すことを実PG/HTTPで比較する。8 query は本家同様に独立した通常読取であり、同時更新の一貫した snapshot を追加保証しない。

## 比較と再実行

[corpus.json](corpus.json) と [observations.json](observations.json) は26件。4 viewer による単一・複数・重複・逆方向・未知・空・self と6件の入力エラーを含む。source probe は固定 Git object から method body と endpoint callback、paramDef、meta を AST で抽出・実行する。通常観測の Repository/query projection double と、実 PG に同じ literal body を適用する mode を区別する。完全な本家サーバー・全 User packer・本家認証基盤を起動した比較ではない。

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/user-relation.test.ts test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=55961 BACKEND_NEXT_TEST_REDIS_PORT=56961 docker compose -p sol2-relation-296 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=55961 BACKEND_NEXT_TEST_REDIS_PORT=56961 pnpm --filter backend-next test:integration test/integration/user-relation.test.ts test/integration/user-memo.test.ts test/integration/http-app.test.ts
node docs/superpowers/compatibility/user-relation/source-probe.mjs --check
node --test scripts/*-contract*.test.mjs
node scripts/check-shipping.mjs --base 11bd324e2827
BACKEND_NEXT_TEST_DB_PORT=55961 BACKEND_NEXT_TEST_REDIS_PORT=56961 docker compose -p sol2-relation-296 -f packages/backend-next/compose.test.yml down
```

Node 26.4.0 / pnpm 12.9.1。実行は全て `PATH=/tmp/tiramiss-s1-node26/bin:$PATH`。source Git object が別 checkout にある場合は `BACKEND_NEXT_UPSTREAM_PATH` で指定する。実 PG source 比較は integration test が専用 random DB の接続設定と corpus を probe の stdin へ渡し、通常 adapter と同じ登録済み Entity / TypeORM 接続を使って実行する。通常CIの既存 integration 入口にも含まれる。

通常 HTTP/PG の32件には、固定sourceとの26応答比較、native/app token・scope・suspension、following table 障害の500、材料取得後にDBが変わっても純粋変換できること、読取が行数・期限切れmuteを変更しないこと、多数一意IDの固定source直接比較を含む。近傍 module/composition unit は17件。最終測定と各 command/log SHA・入力 before/after は [current-evidence.json](current-evidence.json) を参照する。既存 pg client の同時query deprecation warning は観測されるが失敗ではない。

## 既存の測定入力

route登録と一覧期待値の2入力だけが既存 notes-pagination の測定対象に重なる。`scripts/notes-pagination-evidence.mjs` の既存 memo follow-up に、今回の厳密な current SHA →追加2行/文字列の除去→previous SHA を記録する。旧 receipt・seal・件数・log は変更しない。新 scope/cache・read上限は追加しない。memo/poll の synthetic composition test は既存版に相当する入力を明示して引き続き検証し、新 relation contract が通常currentの投影と任意変更拒否を確認する。

今回の32件とsource26件は relation の新測定であり、過去の notes/memo/poll の測定を新しい入力へ付け替えたとの主張ではない。関係更新、通知/stream/AP 副作用、UserDetailed 全体、#182/#180/#114 全体の完了を意味しない。

## 共有登録の有限な合成

R2 の製品測定は [r2-current-evidence.json](r2-current-evidence.json) に byte 不変で保持する。その後の Page 登録との共有 script 変更は `current-evidence.json` の R3 として、変更した script と共有2入力を固定し、関連する21契約を実行する。製品 code/test は R2 と同一であり、製品テストを再実行したとの記録にはしない。

既知の Page 単独、relation 単独、両者同居の2ファイルだけを正確な hash と逆 patch で識別する。両者同居は Page の差分だけを戻して既知の relation 単独となり、既存の relation/memo/poll の順に過去の不変 receipt へ渡す。任意の変更は拒否し、既存 read 上限と scope/cache 機構は変更しない。共通契約は3通りを実byteから再構成し、hash・anchor・未知変更拒否を検証する。実際に両製品を合成して通常HTTPを起動する確認は取りまとめ側の最終 head 合成に残す。

CodeRabbit Web follow-up: Page の前段が既存宣言済みの UserMemo 単独 input (`43aab6…`) を拒否する境界を修正した。既存 `current` hash だけを通し、UserMemo の既存 anchor で `a2f030…` へ戻す。旧R2/R3 receipt は byte 不変で、追加の共有 script 実測・RED/PASS・入力/ログ SHA は [memo-current-followup.json](memo-current-followup.json) に分けた。製品 code・登録順・canonical root snapshot は変わらない。
