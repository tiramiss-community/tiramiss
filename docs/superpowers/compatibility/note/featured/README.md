# 投稿Renoteによるfeatured producerの固定本家比較

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。`reference-featured.mjs` はGit blobからTypeScript ASTで実メソッドを抽出して実行し、50件の観測を `source-observations.json` に保存する。期待値の生成にbackend-nextは使わない。

## 再実行

repo rootから実行する。`UPSTREAM_ROOT` は固定SHAを参照できるGit repositoryを指定する。作業ツリーの内容は読まず、`git show <SHA>:<path>` で取得する。

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream \
OUTPUT_DIR=/tmp/tiramiss-featured-reference \
node docs/superpowers/compatibility/note/featured/reference-featured.mjs
cmp /tmp/tiramiss-featured-reference/source-observations.json \
  docs/superpowers/compatibility/note/featured/source-observations.json
```

2026-11-07実行: 50件成功。固定blobの識別子はJSONの `sources` に記録する。source全体の `NoteCreateService.postNoteCreated`、`NotificationManager`、`incRenoteCount`、`isRenote/isQuote`、`FeaturedService` の更新・window計算、`NoteDeleteService.delete` を実行する。Redis/repository・無関係なService・時刻・乱数・IDから日時への変換はdoubleである。実RedisのMULTI/TTL動作、実DB、HTTP server全体を本家と実行比較した証拠ではない。

## source契約と行根拠

以下はすべて固定SHAの `packages/backend/src/` 内。

- `core/NoteCreateService.ts:815–817`: Renote先があり、作成者自身の投稿でなく、作成者がbotでなければ元投稿の加算を開始する。引用も同じ。新規の通常投稿自体はfeaturedへ追加しない。silent分岐（836行）とpack（840行）より前にあるため、silentや後段のpack失敗でも加点は始まる。
- 同 `967–987`: 元投稿のrenoteCountのDB更新をawaitせず、`Math.random() < 0.3` かつ処理時刻からID由来の投稿日時までstrictに3日未満なら加点。future IDも条件を満たす。channel付きの元投稿は非replyならchannelランキングへ+5。channelなしは元投稿がpublic・local author・非replyならglobalとper-userへ各+5。作成するRenoteの公開範囲、localOnly、元channelのsensitive属性による追加除外はない。
- `core/FeaturedService.ts:12–17,27–45,91–109`: epochは `2023-01-01T00:00:00Z`。global/channelは3日、per-userは7日を単位に `floor((now-epoch)/window)`。通常Redis接続の `featuredGlobalNotesRanking:<window>`、`featuredInChannelNotesRanking:<channelId>:<window>`、`featuredPerUserNotesRanking:<userId>:<window>` に、それぞれ別MULTIで `ZINCRBY 5 <noteId>` と `EXPIRE <windowSeconds*3> NX` を送る。TTLはglobal/channel9日、per-user21日。再加点はscoreを増やし、初回expiryを延ばさない。
- 同 `34–45`: `exec()` rejectは更新Promiseをrejectするが、返った個々のcommand error配列は検査しない。`NoteCreateService.ts:979,983–984` は返ったPromiseをawaitしない。DB count rejectもランキング開始を止めない。同期のglobal wrapper throwだけはper-user開始と後段のpack/indexを止める。
- `core/NoteDeleteService.ts:63–128`: 通常/quiet・DELETE成功/失敗のいずれにもfeaturedの除去や減点はない。Renote削除による加点取消もない。閲覧側は `server/api/endpoints/notes/featured.ts:88–106` / `users/featured-notes.ts:81–98` で現在のNoteをDBから読むため、削除済みIDがRedisに残ることと削除済み本文を返すことは別。

sourceではランキングはdetachedであり、更新完了前にpostが戻る。新実装で開始済み処理を既存期限までdrainし診断することは、[投稿の最小契約](../../../../backend-next/posting-contract.md)の寿命・失敗記録に従う。再試行、永続依頼、加点の一度だけ成立、強いCreate/Delete順序や削除cleanupを新たに加えない。

## source観測と新実装テストの接続範囲

`observations[].input` が入力、`calls` の `zincrby` / `expire` と `state` がsource期待コマンド・score・TTLを示す。新実装のunitが直接照合するのは50件中39件（`input.mode === 'ok'` の33件と `ranking-window-*` の6件）。unitではsourceの時刻文字列IDをそのまま保ち、`createdAtFromId: Number` というID parser doubleを使う。実ID codecと通常HTTP経路は新実装のintegration/processで別に検証する。

次表は50件すべてのsource観測一覧であり、全件の新旧直接一致を示す表ではない。残る11件（pack失敗、repeat、failure4件、lifetime、delete4件）はsource側の境界証拠として保存し、新実装側は別のunit/実依存テストで診断・NX・count拒否・削除残存・drainを検証する。

| 観測ID | 比較する境界 |
| --- | --- |
| `post-*` 22件 | 通常/純Renote/引用、self/bot、remote actor、silent、作成側と元投稿側のvisibilityの区別、元投稿remote/reply/channel/sensitive/localOnly、pack失敗 |
| `sampling-*` 12件 | randomの0.3直前/一致/直後、ageが未来/3日直前/一致/直後 |
| `ranking-window-*` 6件 | epoch基準3日・7日の境界直前/一致/直後とキー、TTL |
| `ranking-repeat-increments-and-keeps-initial-expiry` | 2回加点で+10、EXPIRE NXコマンドと初回expiryの維持（harness内Redisモデル） |
| `failure-*` 4件 | count reject、exec reject、exec command error配列、同期wrapper throwによる後段への影響 |
| `lifetime-post-returns-before-ranking-exec` | execを保留してもpostは戻り、解放後に両ランキングへ反映する |
| `delete-no-cleanup-*` 4件 | quiet/通常、DB DELETE成功/失敗の全組み合わせでランキング更新なし |

上記39件の新実装policy/adapterをJSONへ直接照合し、実HTTP作成→実Redisのscore/TTL、削除後の残存、失敗診断・通常終了時のdrainは新実装側の実依存テストで別に検証する。source実行では想定したcount/exec rejectだけをharnessの `unhandledRejection` listenerへ記録する。これを新実装で未処理rejectionを残す要求にはしない。

## 残る範囲と再構築材料

この資料は投稿Renoteによる+5のproducerに限定する。`ReactionService.ts:214–229` のreactionによる+1、galleryのranking、hashtagのtrend、featured閲覧API、antennaと#174/#172/#176全体の完成を示さない。reaction側は#184、閲覧は#185、hashtag検索/トレンド閲覧は#186が後続の利用者となる。

ランキングはsampling・処理時刻のwindow・初回expiry・過去のRenote操作による派生状態であり、現在のNote/renoteCountだけから過去scoreを正確に復元できない。#132/#133では正確な履歴再現と現在材料からの近似を区別し、今回独自のreplayや永続履歴を足さない。
