# notes一覧と共通ページング（#305）

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `QueryService.makePaginationQuery` と `/api/notes` を移植する有限の比較。親 #185、全体 #114。基点は `2fb256cd889200912cf68258e757f5e39429e495`。共通の純粋な `PaginationPlan`、Note固有の取得窓口、通常HTTP composition、既存Note描画を接続した。業務へQueryBuilder・Entity・Hono・DIを渡さない。

## 契約

- ID cursorが一つでもあれば日時cursorを両方無視する。両ID、until単独、両日時、既定は降順、since単独だけ昇順。境界は厳密な `>` / `<`。逆転・同一境界の結果は空。
- 日時は設定済みID方式の通常generatorへ渡す。本家と同じく0はcursorなし。時刻から最小/最大IDを作る独自の丸めは追加しない。generatorの通常の未来時刻clamp・ランダム/カウンタsuffixに従うため、同一ミリ秒の厳密な境界は指定ID方式/生成状態に依存する。日時のPG比較は行の中間時刻を使い、ID境界は行自身を使う。
- `limit`は既定10、1–100の整数。常にpublicかつlocalOnly=false、作者のinner joinが成立するNoteだけを取得する。`local:true`、reply/renote/withFiles/pollのtrueとfalseをDB上でlimitより前に適用する。
- guestのUGC noneは空、localはlocal作者に限定。認証した一覧選択ではこのguest filterを使わない。本家は `packMany(notes)` にmeを渡さないため、認証済みでも描画はguestとして行う。requireSigninToViewContentsは一覧から除外せず本文等を隠す。
- 本家notesはTL共通mute/block/suspended filterを呼ばない。その振る舞いを維持する。全TL向けfilterの移植・他の一覧・検索DSLは対象外。
- 選択したrootをplain NoteFactsとして保持し、後続取得のためにrootを再照会しない。既存の参照graph/材料集合読込と純粋renderを利用する。読取のみで新しい永続状態・migration・queueは作らない。

## sourceの直接比較と限界

[observations.json](observations.json) は固定3ファイルのraw SHA-256、schema、13 cursor・18条件観測を保持する。[source-probe.mjs](source-probe.mjs) はGit objectから文字どおりのpagination/UGCメソッド・notes callback/schemaをAST抽出し実行する。callbackのarrowだけを同じbodyのfunctionへ変えて依存をbindする。sourceそのものを書き換えて期待値を作らない。

通常のsource確認はquery recorderとpackMany doubleを使う。unitは記録済み13 cursorを消費し、通常CIは本家checkoutやnetworkを要求しない。専用integrationの追加modeは同じ実PG行へsource callbackとQueryServiceを実行し、132入力（22入力×UGC3種×認証2種）で通常HTTP応答のID列・順序と比較する。source側は実TypeORM QueryBuilderと同期済み本家Entityを使い、packManyだけをID投影へ置き換える。本家Nest/Fastify全体やNoteEntityService本体を起動した比較ではない。

Note JSONは既存rendererを利用し、同じ実行で既存notes/showのJSON比較も回す。最初のSELECTでroot userとreply/renote/replyUser/renoteUserをjoinする。関連Noteのplain snapshotとroot authorを操作専用readerへ保持し、材料取得時の後続DB変更から選択を守る。ID指定された参照作者は本家UserEntityService.packManyの補完順に従い、現存する後補完行が同一IDのroot snapshotより優先される。ORM snapshotはDB adapter内に閉じる。既存の承認済み参照予算D7（64階層/256 Note・循環は500）と認証入力の既知差異は[Note比較資料](../note/README.md)を引き継ぐ。本家Meta cacheと新実装DB readerの鮮度同等性、同一ミリ秒の異なるgenerator状態、全ID方式でのupstream full server比較は今回証明しない。

## 再実行

repo rootで依存を当該worktreeにinstallし、`backend-upstream`からbuildする。[検証環境](../../../../packages/backend-next/README.md#検証)に従い専用PG/Redisを準備する。並行作業ではCompose名とportを分ける。テストはrandom DBを作成・削除するため共有DBへ接続しない。

```sh
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/shared/pagination.test.ts test/unit/note/list-notes.test.ts test/unit/composition/http-app.test.ts
pnpm --filter backend-next test:integration test/integration/notes-list.test.ts test/integration/note-show.test.ts test/integration/http-app.test.ts
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-git-objects node docs/superpowers/compatibility/notes-pagination/source-probe.mjs --check
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-git-objects pnpm --filter backend-next test:integration test/integration/notes-list.test.ts
```

2026-11-17実測: R1のsource 13+18観測、専用unit26件、実HTTP/PGのnotes12件（132入力の直接PG比較を含む）と近傍3ファイル40件が成功。専用Compose `bn-notes305`、PG55505/Redis56505を使用した。配布re2 binaryのGLIBC_2.38不一致は同worktree内のsource buildで解消。pgの同一client同時query deprecation警告は既存材料集合取得から出るが失敗はない。最終検証は後続の検証記録を参照する。

#305の実装はnotes一覧と共通cursorの範囲に限定する。QueryService全filter責任行はpartialを維持し、#185/#114、notes/create partial・postingComplete:false、投稿全体や停止切替の完成は主張しない。

## #305の測定と過去証跡の有限な引継ぎ

[current-evidence.json](current-evidence.json) は凍結した15入力のbefore/after SHA、実行command/environment/exit/count/log SHAを記録する。fresh build・typecheck・全unit4944件・近傍実HTTP/PG43件・source13+18件が成功し、入力driftはない。host logが利用できるときは実byteを照合し、無いときに再実行したと扱わない。

[predecessor.json](predecessor.json) は基点2fb256cdに対するnote-routes.ts・Note public.ts・note-reader.ts・note-authors.ts・composition HTTP unitの5ファイルだけを正確な逆patchで保持する。前二つの追加公開とroute一覧期待値が既存actor-emoji-cache/avatar-images/url-previewの測定入力に含まれるため、直近validatorへこの有限な投影を接続する。旧receipt・seal・当時の測定件数はbyte不変である。これは#305製品の新測定であり、actor/avatar/previewを再測定したとの主張ではない。

joint-drive-metaの既存closureは同じ元readerへ既存bindEvidenceCurrentReaderで結び付ける。公開された既知のhistorical viewだけから元のcurrent identityを得るためであり、未知の注入readerをambient filesystem readerへ置き換えない。current mutation・historical bytesをcurrentとして渡す入力・同一scope内のrequested drift・別reader・optional log/receipt改竄・無関係pathのpass-throughは専用mutationと既存近傍試験で確認する。共有scope機構と既存read上限を変更しない。

R1の測定は[r1-current-evidence.json](r1-current-evidence.json)と[r1-predecessor.json](r1-predecessor.json)へ履歴として保持する。R1はrootだけをsnapshot化しjoined作者/参照の競合を未対応だったため、独立レビューで修正を要求された。現在版の互換性判定には使わない。R2は選択直後のbarrierで作者とreply/renoteを更新または削除する2ケース、同一作者のID後補完が勝つ1ケースを追加し、固定notes callbackのjoined projectionとUserEntityService.packManyのID補完prefixを実PGへ直接実行して比較する。prefix抽出はUserEntityService全packerの実行を意味しない。
