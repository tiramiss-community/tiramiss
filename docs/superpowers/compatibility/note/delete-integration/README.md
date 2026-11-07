# 投稿削除の連携比較（#172、#176 の削除部分）

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。この資料は、既存の認可・DB・AP・stream と #174/#175 の producer を、削除へ接続した結果を確認するための独立した source oracle。#176 の全投稿フローや本家 HTTP サーバー全体の比較完了を示さない。

## 再生する source と境界

[`reference-delete-integration.cjs`](reference-delete-integration.cjs) は固定 Git object を取得し、TypeScript AST から次の実装を抽出して実行する。新実装から期待値を作らない。

- **完全な `NoteDeleteService` class**。`delete`、`deliverToConcerned`、mention/返信/Renote の宛先照会 helper を含む。
- **完全な `SearchService` class**。登録/解除の判定・document 生成・SDK 呼出を実行する。検索 API は呼び出さない。
- **完全な `postNoteCreated` と `NotificationManager`**。`index`、`isRenote`、`isQuote`、`incRenoteCount`、`saveReply`、`createMentionedEvents`、`renderNoteOrRenoteActivity` も元の完全な method body を使う。
- `create` 内の、保存済み Note を `setImmediate(...).then(() => postNoteCreated(...))` へ渡す**元の statement**と shutdown field。harness の wrapper 内で実行し、scheduler double で開始を保留する。`create` 全体・実保存の実行ではない。
- **完全な `EndedPollNotificationProcessorService` class**。削除済み Note の再読取で処理を終え、投票者照会・通知へ進まないことを確認する。

Repository、packer、AP renderer、各 producer、SDK/engine、scheduler、時計、乱数は **double**。通常TL/Role TL/antenna/hashtag/featured/notification の `state` は harness の模擬保存先であり、完全な削除 class/AST の callback 不在を補足するもの。模擬配列の残留だけで実 Redis/PG の保持や FK cascade を証明しない。API/DB/Redis/Meili/AP の実依存検証とは区別する。`search-add-accepted`/`search-delete-accepted` は SDK double の返答であり、Meili task の適用を再現しない。固定時計と sample=0 を使い、開始済み Promise は `finally` で必ず解放する。本家の detached rejection は harness だけが捕捉する。

下記の遅延作成成功 2 ケースは **non-poll Note (`hasPoll: false`、`data.poll` なし)** と成功する packer double を使う。その成功を条件に後続が進むことを測定し、実際の Poll/Vote 取得・描画は実行しない。保存済み Note snapshot があっても、後の collaborator 読取が成功する保証にはならない。削除で Poll がなくなった場合の準備失敗は、新実装の既存 `test/integration/note-notifications.test.ts` の回帰テストで別に扱う。

```sh
UPSTREAM_ROOT=/path/to/fixed-upstream OUTPUT_DIR=/tmp/delete-integration-reference \
  node docs/superpowers/compatibility/note/delete-integration/reference-delete-integration.cjs
cmp docs/superpowers/compatibility/note/delete-integration/observations.json \
  /tmp/delete-integration-reference/observations.json
```

`REPOSITORY_ROOT` は別配置から TypeScript を解決する場合に指定できる。省略した出力先は新しい一時ディレクトリ。標準出力は出力先と `cases: 17` を返す。

[`observations.json`](observations.json) は実行結果そのもの。各 source の Git blob ID と UTF-8 SHA-256、完全な削除 class にある全 call target の AST 一覧、17 ケースの呼出順と模擬保存結果を持つ。`NoteDeleteService` は blob `1b945277b7590bf89fcdaaf5c56ec16513a59d6a`、SHA-256 `f27dfc26664f39f9ade3366f46411ffe6ff5c189e5d97fb371dda5c3bf7d240c`。`NoteCreateService` は blob `05e98541844d7f14e91263a78a03c9ec0139a89d`、SHA-256 `cbae284975c937d89c0030b5f3cf47de373555c1ce34b65de81bcf495e93f4fe`。

## source で観測した削除の順序

固定 `NoteDeleteService.ts` 63–127 行は、返信数減算を await → deleted stream → local/non-localOnly の AP 表現と配送開始 → chart と remote instance count 開始 → search 解除開始 → DB DELETE を await → 他人削除の作者照会と監査開始、の順。AP 宛先の direct branch、remote count、search は DELETE の完了条件ではない。direct 宛先照会の継続は DB DELETE と交差する。

| fixture id | source の観測 | 新実装への比較要点 |
| --- | --- | --- |
| `success` | reply -1、stream、AP、search 解除が DELETE 前。成功後のみ moderator audit。その後、独立した poll worker の再読取は Note なしで終了 | 同じ投稿を使い、実HTTP→DB/Redis stream/search/AP queue と audit を比較する。processor の missing-Note 分岐と実 Poll/Vote 描画を区別する |
| `db-delete-reject` | Note が残り、reply -1・stream・開始済み AP/search は残る。audit なし | DB trigger 拒否で先行更新の独立性を確認する。rollback の期待値にしない |
| `reply-decrement-reject` | stream/AP/search/DELETE/audit の開始前に失敗 | await する準備の失敗と detached 処理の失敗を区別する |
| `stream-throws` / `render-throws` | 同期 collaborator throw は以後を停止。reply 減算は残る | 同期 throw の注入ケース。通常の Redis publish Promise rejection と同一視しない |
| `unindex-reject-independent` | search の detached rejection と物理削除成功が両立 | 新実装では既存 diagnostic/drain を確認。本家の unhandled rejection 自体は再現しない |
| `local-only` / `remote-author` | AP は開始しない。remote は instance registration 後 -1 を開始 | chart の未移植 #200 と、実装済み instance counter を区別する |
| `pure-renote-undo` / `pure-renote-missing-original` | 元 Note があれば Undo/Announce、なければ Delete/Tombstone | 既存 AP fixture と実配送を使い、元 Note の有無を比較する |
| `pure-renote-original-query-reject` | **deleted stream の後**に元 Note 照会が拒否。Note は残り、AP/search/DELETE/audit は始まらない | 元 Note の取得を認可用 snapshot の準備時へ前倒しすると、失敗時の stream が変わる。外部観測可能な境界として比較する |
| `quiet-delete` | reply 減算/search/DELETE/audit は残り、stream/AP/chart/instance count は省く | source 内部入口の確認。HTTP に新しい quiet option を追加しない |

元 Renote の照会は `delete` 80–83 行で行われる。元 Note の照会失敗を削除前 stream の前へ移すことは、強い Create/Delete 順序を避ける判断とは別問題。`pure-renote-original-query-reject` はこの実際の境界を固定するためのケースであり、並行削除の新しい保証を定義しない。

## 作成後続との交差

| fixture id | 実行した固定 source の結果 |
| --- | --- |
| `create-pack-reject-then-delete` | pack より前の hashtag/user/reply/renote/featured/TL/antenna/poll job は始まる。Role/webhook/search/channel は始まらない。後の削除で先行 producer を取り消さない |
| `create-mention-reject-then-delete` | global pack 後の created stream・Role TL・作者の note webhook は開始済み。mention の pack 失敗で後続通知/AP/channel/search は開始しない。削除で開始済み webhook を取り消さない |
| `create-pack-held-until-after-delete` | non-poll 入力の pack 待機中に削除が完了する。成功する packer double の解放後、created stream/Role/webhook/通知/AP/channel/search が始まる。実 Poll/Vote lookup・描画の成功を示さない |
| `scheduled-post-created-held-until-after-delete` | non-poll 入力で元 `create` の schedule statement が返った後、後続開始を保留して削除を完了する。成功する packer double を条件に、解放後の完全な `postNoteCreated` が各 producer を開始する。実 Poll/Vote lookup・描画は対象外 |
| `create-search-add-held-until-after-delete` | SDK add を保留したまま DELETE と SDK delete を完了できる。解放された add は削除後に返り、模擬索引へ document が再び残る |

遅延作成成功 2 ケースは poll job を投入しない。削除済み poll の worker の no-op は `success` の通常 `hasPoll: true` fixture を削除した後、独立した processor 呼出で確認する。Repository double が Note なしを返す分岐だけを実行し、実 Poll/Vote 行・FK cascade・queue cancellation を証明しない。

これらは tombstone/世代/取消台帳/新しい通常 retry/強い順序の追加根拠にしない。HTTP 成功後の実依存拒否と、既存の診断・終了待機を別に確認する。作成 webhook が削除後に配送され得ることと、削除 webhook があることを混同しない。

## 除去するもの・残すもの

完全な固定削除 class と `deleteCallTargets` の AST 一覧には、削除 webhook、通知削除、TL ID 除去、hashtag 減算、featured 減点/除去、user/renote/channel count 減算、子 Note の再帰削除がない。source の仕事は上の順序表に挙げたもの。これらの cleanup を新機能として追加しない。

`Note.ts` 38–55 行は reply/renote の `createForeignKeyConstraints: false` を持ち、migration `1753868431598-remove_note_constraints.js` の `up` は両 self-FK を削除する。対象 Note の削除で返信・Renote を連鎖削除しない。Poll/PollVote/NoteReaction の Note FK による CASCADE は別の DB 責務。source hash は fixture に含めるが、この probe は cascade SQL を実行しない。

新実装の既存 `test/integration/note-delete.test.ts` は Poll/PollVote/NoteReaction cascade、参照を保持した子 Note、reply のみ減算、user/channel/renote count 保持を実 PG で確認する。通常TL、Role TL、antenna、hashtag、featured、search、stream、webhook の各 slice の実依存テストを、今回の同一投稿による削除連携の結果と照合する。通知は承認済みの PG 保存先を維持し、削除後も行が残ることを比較する。本家の通知保存先をこの模擬 state で再検証したとは扱わない。

#172 の完了判定は、認可/DB/AP に加えて接続済み producer の削除結果と必要な source 失敗境界の比較を含む。#176 の実トークン HTTP→通常 worker→全副作用の最終縦断、#200 の chart、#177 の通知 API/既読/push/移行、#185/#186 の閲覧、#132/#133 の保守はこの資料だけでは完成しない。

## 新実装の実依存検証

[`note-delete-integration.test.ts`](../../../../../packages/backend-next/test/processes/note-delete-integration.test.ts) の新規3ケースは、通常のbuilt HTTP/worker、実PG・通常Redis・専用timeline Redis・Meili・WebSocketとfake AP/webhook受信先を使う。前2ケースが、同じpublic mention/hashtag/poll投稿の作成・show・保存・通知・home/main WS・通常TL・検索登録・署名付きAP Create・note/mention webhookから、第三者拒否とmoderator削除へ進む。

| 新実装のケース | 確認した結果 |
| --- | --- |
| DELETE成功 | 204、Note/Poll不存在、showエラー、deleted WS、署名付きAP Delete、適用済みMeili解除。他人削除監査は成功後だけ増える |
| 実PGのBEFORE DELETE trigger拒否 | 500とNote/Poll/show残存、監査不増加。それでも先行deleted WS・AP Delete・Meili解除は残る |
| held unindex submissionが503 | ローカル204と物理削除を保つ。HTTP子の終了は保留中submissionを待ち、解放後にexit 0。DELETE要求1回、構造化search診断1件、task pollingなし |

前2ケースでは、第三者拒否の前後と削除前後で、通常TL ID・PG通知の全行・hashtag行・Redis unique/HLL/ranking値・既存webhook受信が保持されることも確認する。source JSONへ直接照合するのは`success` / `db-delete-reject`の6状態（`noteExists`、`searchDocumentExists`、`ordinaryTimeline`、`hashtags`、`notifications`、`webhooks`）とdeleted/follower activity種別だけ。その他のassertionは実保存・受信結果に対する独立検証であり、17ケース全体を新実装へ直接照合したという意味ではない。Role TL/antenna/featuredの全routingや作成後続との全交差は、既存sliceの比較と上のsource証拠を維持する。

元Renote照会の時点差は、[`delete-note.test.ts`のunit回帰](../../../../../packages/backend-next/test/unit/note/delete-note.test.ts)と[実PG/Redisを使うHTTP handler回帰](../../../../../packages/backend-next/test/integration/note-delete.test.ts)を先に失敗させてから修正した。照会失敗は`Repository.findOneBy`への選択的spyで元投稿だけを拒否し、他の照会を実PGへ通す。DBサーバーのSELECT拒否や完全な実HTTP子での照会障害を再現したものではない。元投稿をdeleted stream後の該当AP準備だけで読むことで、失敗時の既発行streamとlocalOnly/remote/拒否時の照会省略を確認した。これらのunit回帰はsourceと同じ境界をassertし、source JSONの直接比較は行わない。

最終実行はunit 66 files / 2,410 tests、関連integration 5 files / 41 tests、新規と既存note-delete process 2 files / 5 testsがPASS。既存webhook/WSを含む先行process回帰3 files / 5 testsとはnote-delete2件が重複する。source再生成17ケースは独立したbyte比較と再レビューが成功した。製品の独立レビューもSpec PASS / Quality APPROVEで指摘なし。完了判定とコマンドは[実装計画](../../../plans/2026-11-07-note-delete-integration-172.md)を参照する。

今回の証拠は#172の削除連携と#176の削除に絞った先行確認。#176全体には、必須依存#124の#163–#165（通常queue管理・保持・残payload引継ぎ）、C群全体・停止再開・暫定501を含む未対応台帳の照合が残る。
