# Role timelineの通常producer比較資料

[#174](https://github.com/tiramiss-community/tiramiss/issues/174)の通常投稿からRole cache投入・packed publicationまでを接続するslice。契約は[投稿の最小契約](../../../../backend-next/posting-contract.md#通常roleタイムラインproducer174)、作業手順は[計画](../../../plans/2026-11-07-note-role-timeline-174.md)。Role閲覧API、WS channel/consumer、#174全体の完成ではない。

## 固定sourceと再実行

本家 `8e07cf085adf7009583d234a208e30436f020e26` のGit blobを `git show` から読む。`reference-role-timeline.mjs` はTypeScript ASTから対象メソッド/クラスを個数検査付きで抽出し、そのままtranspileして実行する。新実装を期待値生成に使用しない。`source-observations.json` は独立source実行229ケースの固定観測であり、7つのblob IDも含む。

```sh
# UPSTREAM_ROOT: 固定コミットを含む本家Git checkout。
# TypeScriptはこのrepositoryの依存を使う。必要ならREPOSITORY_ROOTを指定する。
UPSTREAM_ROOT=/path/to/misskey OUTPUT_DIR=/tmp/role-timeline-reference \
  node docs/superpowers/compatibility/note/role-timeline/reference-role-timeline.mjs
cmp docs/superpowers/compatibility/note/role-timeline/source-observations.json \
  /tmp/role-timeline-reference/observations.json
```

OUTPUT_DIR省略時は新しい一時ディレクトリを作る。抽出したraw sourceは出力先の `sources/` に保存し、製品やrepoへ複製しない。実行時にGC intervalを止め、clock/randomを制御する。sourceのdetached rejectionを一時的な `unhandledRejection` handlerで観測するが、これはharnessであり製品の処理ではない。

実行対象は元の `RoleService.evalCond/getUserAssigns/getUserRoles/addNoteToRoleTimeline/onMessage`、`MemoryKVCache/MemorySingleCache`、`CacheService.findUserById`、`FanoutTimelineService.push`、`GlobalEventService.publish/publishRoleTimelineStream`、完全な `NoteCreateService.postNoteCreated` と `NotificationManager`、`incNotesCountOfUser`、`NoteDeleteService.delete`。Repository/Redis/packer/webhook/APなどの協力先は計測用doubleであり、本家full server/HTTP/実PG/実Redis比較とは区別する。

| source観測 | 件数 | 新実装での接続/確認 |
| --- | ---: | --- |
| 完全postNoteCreatedのvisibility/locality/channel/localOnly/silent/pack失敗 | 128 | created-eventsの同一packed参照・開始順・pack失敗/非同期失敗のunit、実HTTPの全visibility/channel/fanout無効。新silent入力・remote作成経路は追加しない |
| 所属/期限/重複/conditional/非連鎖/順序 | 16 | `role-timelines.test.ts`が固定JSON16件を直接読み、公開selectorのIDsとproducerの投入数/順を比較。実DBの重複・expiry等号も別確認 |
| Boolean User事実 | 10 | 実DB adapterの全User属性mapping/次投稿への変更反映、既存Role条件unit |
| count閾値 / ID作成時刻 | 18 / 6 | 既存Role条件unit、実DBの全count mappingと厳密な作成境界。count加算の完了順を条件にしない |
| recent/old ID、tail、random境界 | 24 | 既存timeline-cache unitを回帰。Role producerの古い直接更新drainと実Redisの強制trim0..999 |
| producer寿命/失敗 / 完全postの失敗境界 | 8 / 6 | publication拒否でも後続Role/flush、古い直接更新・publicationのdrain、同期例外で未送信停止、AP/index等継続unit |
| source cache動作 / 実count更新との競合 | 4 / 4 | 下記の意図的差異を記録。既存材料cacheのexpiry再評価・Role更新API無効化を実依存で確認 |
| 削除境界 / Global wire | 4 / 1 | 保存直後削除・遅延snapshotの実HTTP、host-topic実subscriberと実HTTP子終了 |

229ケース全部が新実装の直接fixture比較という意味ではない。直接fixture比較は所属16件であり、残りは上表の既存/新テスト・読解による対応と差異の記録。WS clientへの配送とread側の公開判定は本sliceでは実装/実行しない。

## source契約と差異

`getUserRoles`は定義取得順に、期限がnullまたは厳密に現在時刻より先の割り当てIDへ一致した定義を返し、その後conditional一致を連結する。割り当てたconditionalも一致すると二度返す。role公開/探索可否、note visibility、channel、localOnly、fanout設定はproducerのgateではない。各roleの `push(roleTimeline:<id>, note.id, 1000, pipeline)` → publication開始の順を維持し、空roleでもpipelineを実行する。

元のproducerは古いID直接更新、publication、pipeline.execをawaitしない。新実装は開始済み処理を既存post-saveの診断/終了待機へ集める。非同期失敗でも他role・webhook/通知/AP/searchの準備は続く。同期準備例外は本家同様に後続roleと未送信pipelineを止め、開始済みの直接更新/publicationだけdrainする。HTTP保存成功は取り消さず、新queue/retry/永続台帳は作らない。

sourceのconditional Userは5分cacheであり、加算はdetached UPDATEから始まる。source probeはcold cacheのcount更新前後とwarm cacheの古い値を、元の両メソッドを使って再現する。新実装は承認済み[Role評価/材料cache契約](../../../specs/2026-10-17-role-compatibility-contract.md#54-評価境界とキャッシュの接続)と[既存#119の差異](../../role/README.md)を維持し、post-create段階の現在UserをDB取得する。認可時のauthorや閉じた評価sessionを再利用しない。notesCount加算とRole評価の完了順は保証せず、sourceの実スケジューラやwarm/cold結果との完全同値は主張しない。

## 実装と実依存検証

製品入口は `src/composition/posting-role-timelines.ts`、`src/platform/database/role-timelines.ts`、`src/modules/note/created-events.ts`、`src/platform/posting-stream.ts`。既存Role公開selector・材料cache・timeline専用Redis・pubsub・終了待機を利用し、新schema/dependency/API/channelは追加しない。manual-only定義ではUser lookup不要。

2026-11-07、開始base `7d606dec1f95c110b90203a9ea05d1a71744e00c`。専用Compose `backend-next-role234`、PG55480/Redis56380、テストごとのDB/prefixを使用した。

| 検証 | 結果 |
| --- | --- |
| 初回created-events RED | 26件中3失敗、Role開始/失敗/待機が未接続。新producer import不在も別記録 |
| 同期例外drain RED→GREEN | 6件中1失敗→6件成功 |
| Role producer/created-events focused unit | 2 files / 48 PASS（所属source fixture16件を含む） |
| Role条件、timeline cache/plan、post-saveを含む近傍unit | 6 files / 112 PASS |
| 実HTTP handler＋実PG＋専用timeline Redis＋host subscriber | `test/integration/note-role-timelines.test.ts` 11 PASS |
| build後の通常HTTP子、投稿直後SIGTERM、cache/全packed publication/exit0 | `test/processes/note-role-timelines.test.ts` 1 PASS |
| `pnpm --filter backend-next... build` / `typecheck` | PASS |
| 固定source probe再生＋JSON cmp | 229 PASS / 一致 |
| controllerによる全単体suite | 61 files / 2119 PASS |

実依存suiteでpgの既存並行query deprecation warningを観測した（失敗なし）。SPDX/変更ファイルlint/locale/diff検査の最終結果は計画の実装・検証結果に記録する。

実HTTPでは全visibility、private/unexplorable role、user探索無効、fanout無効、channel、conditional重複、期限等号、現在User変更、既存Role更新APIの材料無効化を確認する。WRONGTYPEでも他roleとpublication、HTTP成功・PG保存・安全な失敗ログを確認する。終了待機はunitで遅いRole処理/publication/古いID直接処理を制御し、実HTTP子では通常compositionと資源寿命を確認する。

## 再構築・残作業

本家 `NoteDeleteService.delete` にRole purgeはなく、Role IDは削除後もcacheに残る。保存snapshotから遅れたpost-saveもcache/publicationへ進む。強いCreate/Delete順序、tombstone、deleteイベント、backfillは追加しない。

#132/#133には、現在のNote/User/Role/assignment、capped Redis一覧だけから過去の割り当て・期限・条件一致を復元できないことを引き継ぐ。現在材料による再評価は現在所属に基づく近似であり、投稿当時の履歴復元とは別。履歴材料が別途必要で、再構築によるpublication再送は行わない。

antenna/hashtag/featured等#174、Role閲覧API #181/#185、Role WS channel/consumer #189、投稿全体の縦断/最終削除連携#176/#172は残る。consumerでは本家のRole公開/探索可否・note public・mute/block等の判定が必要になるが、その条件をproducerへ移さない。
