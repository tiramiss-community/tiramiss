# 投稿タイムラインの通常更新（#174 第1slice）

## 目的と範囲

PR #229をマージしたdevelop `67bcdf50d2cfc62d0e17e1792af940c849b15009` から、固定本家 `8e07cf085adf7009583d234a208e30436f020e26` のRedis fanout timeline producerを通常投稿へ接続する。判断基準は [GOALS](../../backend-next/GOALS.md)、[ROADMAP](../../backend-next/ROADMAP.md)、[最小契約](../../backend-next/posting-contract.md)。親 #114/#127 の順序に従い、#174の必須依存 #170 はマージ済み。

今回移植するのはhome/local/user/list/channelの通常リスト更新（files/replies派生を含む）、既存Meta/YAML設定、休眠候補の抽出と更新。検索・antenna・hashtag・featured・role timeline等の更新は#174の後続、閲覧APIは#185/#186、role関連は#181/#189、チャートは#200、復元は#132/#133に残す。#174をcloseしない。

## 契約と選択

対象全体を一度に移植すると検索エンジン・antenna・タグ等の別契約を混ぜるため、今回利用できるRedis producerを一つのPRとする。独自永続依頼・再構築・tombstone・配送順序保証・新しい必須運用設定は追加しない。

- 本家 `NoteCreateService.ts:1067–1237` の宛先規則を純粋関数へ分離する。Followingはローカル・非休眠、listは本家のfollowers/specified/withReplies条件、channel followersは独自のフィルターを足さない。自分のspecified投稿のhome条件も本家の否定条件を維持する。
- `FanoutTimelineService.ts:53–70` と同じ `list:<name>`、3分のstrict境界、古いIDの末尾日時比較、recentだけ10%のLTRIMを使う。件数の半分を丸めず、その結果Redisが拒否する小数も隠さない。
- `redisForTimelines` は本家どおり未指定時 `redis`。channel上限は `perChannelMaxNoteCacheCount ?? 1000`。Metaは既存 `readMeta` で投稿後続ごとに読み、#217未接続のため独自キャッシュを作らない。
- 非channel投稿の10%で最大1000のローカル非休眠followerをFisher-Yates抽出し、最終活動がstrictに50日より古いUserとその全Followingを休眠化する。今回の投稿のリストには含め、次回から除外する。
- WebSocket接続時の活動時刻更新と休眠解除は#189/#180に残る。REST認証へ独自の解除を足さず、このproducerだけで休眠の全ライフサイクルを完成扱いしない。
- 本家の削除はfanout IDをpurgeしない（`NoteDeleteService.ts:111–116`）。削除後もIDが残ることを検証し、閲覧側の存在確認を置き換えない。
- 保存時のNoteを使い、保存後すぐ削除されても後続のリスト投入を勝手に省略しない。失敗はHTTP成功を取り消さず、開始した処理をdrainして記録する。

## 実装と検証の順序

1. routing/config/post-saveの回帰テストを先に追加し、未実装でREDを確認する。
2. `modules/note/timeline-plan.ts` に取得済みfactsからの宛先/件数と休眠sampleを実装し、Note公開契約から利用する。
3. `platform/database/note-timelines.ts` と `platform/timeline-cache.ts`、compositionでDB/Redisを接続する。ChannelFollowingだけ固定本家から機械同期する。
4. 通常runtimeへtimeline Redisの接続・障害通知・解放とpost-save処理を接続する。独立したcount/poll/通知/AP処理を省略しない。
5. 実HTTP/PG/Redisで各経路、disabled、別Redis prefix/db、休眠、削除後ID、失敗/drainを検証する。同期一致・schema差分0・型検査・unit・build・変更ファイルlint/SPDX/localeを確認し、独立レビューへ渡す。

## 検証記録

専用Composeプロジェクト `backend-next-derived174-test`、PG `55474`、Redis `56374`。ユーザー用の既存プロジェクトは変更しない。

| 検証 | 結果 |
| --- | --- |
| `pnpm install --frozen-lockfile --filter backend-next...`、基準build/unit | PASS、49 files / 1,707 tests |
| routing RED→GREEN | 未実装moduleのRED、9 tests GREEN |
| cache/config RED→GREEN | 未実装moduleとfallback未接続のRED、GREEN |
| 実HTTP/PG/Redis timeline RED→GREEN | 通常経路未接続で7 tests RED、最終10 tests GREEN |
| startup loss RED→GREEN | 接続消失後もstartedを返すRED、消失記録と最終ready検査後に15 resources tests GREEN |
| `node docs/superpowers/compatibility/note/timeline/reference-timeline.mjs /tmp/tiramiss-relay171-upstream` | PASS、固定Gitメソッドと新plannerの1,280 routingケース |
| `pnpm --filter backend-upstream sync:check` / `test` | PASS、一致 / 5 tests |
| `pnpm --filter backend-next... build` / `typecheck` | PASS |
| `pnpm --filter backend-next test` | PASS、51 files / 1,727 tests |
| `test:integration` timeline/resources/notification | PASS、3 files / 38 tests、schema差分0を含む |
| `test:integration` note-create-relations/note-delete | PASS、2 files / 111 tests |
| `test:process` timeline/delete/deliver/poll-ended | PASS、4 files / 12 tests |

実HTTP子のテストは投稿応答直後にSIGTERMを送り、正常終了後の専用RedisのIDを確認する。シグナル時に後続が必ず保留中だったとは主張しない。保留中のtimeline更新でcloseが待つことはgate付きpost-save単体テスト、開始済みold-ID直接更新はcache単体と失敗時の実Redisテストで別に確認する。

固定本家の1,280ケースはメソッド本体をGitオブジェクトから実行しRepository/Redisをdoubleへ置換したもの。本家全体の新しいHTTP/DB/Redis実測ではない。取得条件とage/trim/休眠境界は固定ソース由来の期待値で、新実装は実依存先でも確認した。

拡張結合テストの初回1件は、試験の `KEYS` patternにprefixが自動適用されると誤認して既存keyが残り、古いIDが末尾比較で除外されたfixture不備。物理prefixを指定して片付けるよう修正し、最終38件で通過した。製品側へ除外条件の変更は加えていない。既存のpg並行query deprecation warningは非致命で、今回の成功件数に失敗を隠していない。

Controllerの最終型検査、変更18ファイルのlint、SPDX（3,112ファイル）、locale safety、`git diff --check` はPASS。独立したsource/cache/runtime/全体レビューを実施し、起動中のRedis切断の指摘を実DB/RedisのRED→GREENで修正した。未解決のP1/P2はない。読み取り専用の並列facts取得は本家と同じ早期rejectで、接続解放はPG poolが待つため、新しい副作用のdrain保証とは区別する。

CHANGELOG候補: 新バックエンドの投稿後続処理へタイムラインキャッシュの更新を接続した。
