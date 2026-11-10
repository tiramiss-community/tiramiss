# 通常 queue の保持・清掃比較資料（#164）

固定本家 `misskey-dev/misskey@8e07cf085adf7009583d234a208e30436f020e26` の契約を保存する。旧 fork、旧 PG 実行台帳、通知本体の保持は対象外。[queue-admin](../queue-admin/README.md) の管理 API 比較を置き換えない。

## Source の実際の設定

| 対象 | 完了履歴 | 失敗履歴 | 設定場所 |
| --- | --- | --- | --- |
| 通常 producer（全10 queue の単発仕事） | `{ age: 604800, count: 30 }` | `{ age: 604800, count: 100 }` | 各 job の `opts` |
| system の9定期 job | `{ age: 604800 }` | `{ age: 604800 }` | `upsertJobScheduler` の template `opts` |
| 全10 Queue constructor | 指定なし | 指定なし | `defaultJobOptions` なし |
| 全10 Worker constructor | 指定なし | 指定なし | Worker に retention fallback なし |

`age` は秒、`delay` はミリ秒。通常仕事には成功30件・失敗100件と7日の両条件を渡す。件数は job 名別ではなく queue の終端状態別である。定期 job のコメントは、高頻度 job によって低頻度 job のログが消えることを避けるため count を指定しないと説明している。system の単発 `archiveAnnouncement` には通常の count もあるため、system 全体を常に age だけとみなさない。

`QueueService` の32 producer メソッドを実行し、単発・bulk と helper 経由の opts を採取する。別サービスからの `endedPollNotification` 投入は `NoteCreateService.postNoteCreated` の poll 条件ブロック全体、`postScheduledNote` 投入は `NoteDraftService.schedule` 全体を実行する。後者は未来の有効な予約だけを投入する。relationship の private helper は末尾の `...opts` で保持値自体も置換できるが、既存公開 producer から渡すのは delayed unfollow の delay だけである。これを外部 API の保持設定機能として扱わない。

system scheduler は `immediately: false` で以下を登録する。constructor は登録 promise を待たず、`getJobSchedulers().then(...)` で現在の9定義にない key を削除する。これは古い scheduler 定義の整理であり、完了・失敗履歴の周期清掃ではない。

| job | cron pattern |
| --- | --- |
| tickCharts | `55 * * * *` |
| resyncCharts / cleanCharts / aggregateRetention / clean / bakeBufferedReactions | `0 0 * * *` |
| checkExpiredMutings | `*/5 * * * *` |
| checkModeratorsActivity | `30 * * * *` |
| cleanRemoteNotes | `0 4 * * *` |

source の BullMQ `queue.clean` 呼び出しは `QueueService.queueClear` の手動操作だけで、周期実行はない。単一状態には `clean(0, 0, state)`、`*` には completed / wait / active / paused / prioritized / delayed / failed を並行で渡す。管理者が明示する破棄と、通常の終端履歴保持は別の操作である。認可・非待機204・監査・実制御の既存比較は queue-admin の資料を参照する。

定期 `clean` の handler は user IP（90日）、未使用 antenna の停止、期限切れ Role assignment、古い Reversi game を扱う。`cleanCharts` は chart、`cleanRemoteNotes` は remote note の保守であり、これらを queue 履歴のために新規接続しない。個別保守は #199、通知本体は #177 の担当である。

## 実行と直接比較

```sh
node docs/superpowers/compatibility/queue-retention/reference-queue-retention.cjs /path/to/pinned-upstream --check
```

必要な TypeScript は比較先 repository の root 依存から読む。`REPOSITORY_ROOT` で依存のある checkout を選べる。`UPSTREAM_ROOT` も利用可能。source は作業ファイルを読まず、毎回 `git show <固定SHA>:<path>` で得る。期待値を更新する場合は `--check` を外し `OUTPUT=/tmp/queue-retention.actual.json` で候補を出し、固定 SHA・diff・理由を確認する。既存 JSON を通常の検証中に上書きしない。

[observations.json](observations.json) は24観測、8 source の blob ID / SHA-256、TypeScript 6.0.3、本家 BullMQ 6.3.11 を記録する。主な比較入口は次のとおり。

| 観測 ID | 新実装への比較内容 |
| --- | --- |
| `all-queue-constructors` | 全10名・prefix・constructor に default 保持設定がないこと |
| `all-worker-options` | 全10 Worker の保持 fallback がないこと。metrics は10080、全て autorun false |
| `all-queue-service-producer-options` | `expected.producers` の producer / queue / method / jobs[].opts。payload は省略 |
| `poll-ended-delay-5000` | 投票終了の delay と job opts |
| `scheduled-note-future` | 予約投稿の delay と job opts（未移植機能の引継ぎ用） |
| `system-scheduler-constructor` | 9 template の age-only 設定、cron、古い scheduler key の削除 |
| `manual-clear-*` | 手動 clear の7状態。詳細 API 契約は既存 queue-admin 資料 |
| `system-clean-data-threshold-*` | application data の保守内容。queue 清掃の追加根拠にしない |
| `workers-start` / `workers-onApplicationShutdown` / `queue-dispose-after-pending-drain` | 全10 Worker の run/close、pending drain 後の全10 Queue close |
| `source-retention-and-clean-site-scan` | backend TS の retention30箇所、defaultJobOptions0箇所、queue.clean8箇所（全て手動 clear） |

probe は本家 module、完全な AST method、完全な Worker option expression、poll の条件ブロックを実行する。Queue / scheduler / repository / query / logger / Reversi / clock / digest / UUID / decorator / backoff function / pending drain は明示的な double。Worker の processor callback は実行しない。Nest DI、本家 full server、Redis、BullMQ の保持アルゴリズム、実 worker・API・socket の成功を証明しない。source scan の `queue.clean` は receiver 名一致なので、それだけを全清掃の網羅証明にせず、固定 source の他の `.clean(` 呼び出しも手で確認した（chart 保守のみ）。

## 現在の接続範囲と実依存検証（2026-11-08）

検証根拠をコミット `2549ec263662c10cdd238448482f325c1693c035` に固定した。backend-next の `deliver` / `endedPollNotification` / `userWebhookDeliver` の3業務 producer・Worker は、それぞれ本家の7日・成功30件/失敗100件を job ごとに渡す。全10名の管理 handle は #163 で接続済みである。#164 はこの現在の接続範囲の通常保持と全10名の管理履歴・終端清掃を検証した。製品コードの不一致は見つからず、変更は比較資料・テスト・文書のみとなった。

### 実際の保持動作

`age: 604800` は厳密な7日後の期限ではない。同じ queue が同じ completed / failed 状態へ次の job を移すときに、経過時間と件数に基づいて履歴を削除する。読み取りや Worker 再開だけでは古い履歴は消えず、完了による清掃は失敗履歴を、失敗による清掃は完了履歴を削除しない。件数と age は job 名別でなく queue の終端集合全体に働く。

Queue の `defaultJobOptions` と Worker の保持 fallback は追加していない。保持 opts のない legacy job はそのまま完了しても残るが、同じ終端集合へ後から入る別名の policy 付き job の清掃対象にはなり得る。管理 handle は既存 job の opts を変更しない。system 定期 job の age-only policy と単発 job の30/100 policyも、同じ集合でそれぞれの終端遷移に従う。

自動保持と `clear(completed)` / `clear(failed)` は未完了 job を残す。管理者が明示する非終端状態の clear や `clear('*')` は本家どおり破棄操作であり、未完了 job の保護操作ではない。削除後は job / logs / 一覧から消え、既存 `show-job` は missing-job の500を返す。統計の累積完了・失敗数は履歴削除で減らない。

### 検証の根拠と境界

[直接比較の単体テスト](../../../../packages/backend-next/test/unit/job-queue/retention.test.ts) は、実際の3 producer の opts と全10 Queue / Worker の共通設定を source 観測に直接照合する。新規28件と近傍3ファイルを合わせた97件が成功した。比較に渡す実値の保持設定を一時的に `true` へ変えた negative control は3件が失敗し、復元後の最終実行は成功した。製品コードを変更して失敗を作ったものではない。

[実 Redis の保持テスト](../../../../packages/backend-next/test/integration/queue-retention.test.ts) の8件は、3種類の実 producer / Worker adapter と実 BullMQ 6.3.11 / Redis を使う。handler callback だけが成功・最終失敗・一時失敗を制御する。通知保存・AP配送・webhook送信の業務全体をこの callback で検証したとは扱わず、既存の各業務テストを引き継ぐ。

- 各 queue で異なる job 名の31成功・101最終失敗を処理し、実際に保存された7日・30/100 opts、30/100の残存、削除 hash / logs と残存する結果・試行・失敗情報を確認した。同時刻の job の挿入順は仮定しない。
- Worker 停止中に test fixture の終端 ZSET score と hash の `finishedOn` だけを7日±60000msへ backdate した。再開・読み取り後の残存と、次の同状態遷移による期限超過分だけの削除を3 queueで確認した。厳密な閾値一致や7日間の実待機を測定したとは扱わない。
- 無設定 legacy job の残存と、後続の policy 付き job による同じ終端集合の清掃、別 queue / prefix の同ID jobの隔離を確認した。
- 実 deliver Worker の通常12試行/backoffで delayed retry を観測した。自動清掃と終端 clear 後も、retry・paused waiting・prioritized・未来 delayed・lockを保つactiveは残る。retryをpromoteし、同ID・2試行目の成功と失敗情報の残存を確認した。gateは必ず解放してWorker停止を待つ。

[管理HTTPの追加10件](../../../../packages/backend-next/test/integration/queue-admin.test.ts) は全10 selectorの実 Redis 履歴を `show-job` / `jobs` / `queue-stats` で確認する。test用Workerで作った完了・失敗履歴をそれぞれclearし、逆の終端履歴・logsと未完了job、別queue/prefixを残す。failed-only clear前にも新しいcompleted履歴を作り、両方向の独立性を確認した。既存の認可・非待機204・`clear('*')`・実配送retry・停止の検証も保持している。7つの未接続業務 handler を実行した証明ではない。

| 実行コマンド（repo root） | 結果 |
| --- | --- |
| `node docs/superpowers/compatibility/queue-retention/reference-queue-retention.cjs /path/to/pinned-upstream --check` | PASS、24 source観測・8 source・32 producerメソッド |
| `pnpm --filter backend-next test test/unit/job-queue/retention.test.ts test/unit/job-queue/deliver.test.ts test/unit/job-queue/ended-poll-notification.test.ts test/unit/job-queue/user-webhook.test.ts` | PASS、4 files / 97 tests |
| `BACKEND_NEXT_TEST_DB_PORT=55486 BACKEND_NEXT_TEST_REDIS_PORT=56386 pnpm --filter backend-next test:integration test/integration/queue-retention.test.ts test/integration/queue-admin.test.ts` | PASS、2 files / 49 tests（追加18件） |
| `pnpm --filter backend-next... build` / `pnpm --filter backend-next... typecheck` | PASS |
| `node scripts/check-shipping.mjs --base 6246c3605a5d150c61ba8b4f965db651f70c7138` | PASS、変更3 testのquiet lint・SPDX 3195 files・locale safety |

実依存検証には専用 PostgreSQL `55486` / Redis `56386` と一意のtest prefixを使った。sourceの24観測と実テスト件数を足し合わせない。本家 full server、Nest DI、全10業務 handler、長期間のwall-clock expiryを検証したとの主張はしない。起動・停止処理は変更せず、#162/#163の既存process検証を引き継ぐ。schema/API定義も変更していないためmigration検査・旧backend向け型再生成は対象外である。

## 後続の所有者

| queue / データ | 現在と残る担当 |
| --- | --- |
| `deliver` | 業務接続・保持検証済み。他機能のAP producerは各担当 |
| `endedPollNotification` | 業務接続・保持検証済み。PG通知本体の保持・閲覧・既読・push・移行は #177 |
| `userWebhookDeliver` | 投稿の業務接続・保持検証済み。他イベントと設定管理は #197 |
| `system` | 管理のみ。保守・単発announcement archiveは #199、chart/集計/bufferは #200。実scheduler導入時に9定期jobのage-only optsと古いscheduler定義の整理を移植する |
| `postScheduledNote` | 管理のみ。予約投稿のproducer/handlerは #183 |
| `inbox` | 管理のみ。受信producer/handlerは #195 |
| `db` | 管理のみ。import/export・account削除は #199 |
| `relationship` | 管理のみ。関係処理のproducer/handlerは #182 |
| `objectStorage` | 管理のみ。削除/storage handlerは #188、remote保守は #199 と調整 |
| `systemWebhookDeliver` | 管理のみ。producer/handlerは #198 |
| 既存Redis payload / scheduler | consume/drain/変換・rollback/backupの確認は #165、完全停止切替は #139 |
| 運用情報 | #138 がage/count、lazy清掃、履歴と累積統計、明示clearの説明を利用する |

#164 の現行完了条件はsource調査・現在の通常保持接続・実Redisと管理照会・通知/保守の引継ぎを対象とし、上の証拠で満たす。次は #165 の実payload互換・残仕事引継ぎを進める。将来追加するproducerは本資料の該当source policy（保持しない設定も含む）をその機能の実仕事へ移植する。管理handleだけを根拠に3 producerのcount値を全queueへ一律適用しない。#124 / #176全体、#177 / #199等の機能完了には換算しない。

## #255 runtime consumer validation (2026-11-10)

The three migrated producers and fresh separately owned worker runtimes retain per-job age/count options, absent constructor fallback, 30/100 trimming and lazy cleanup. Controlled callbacks remain retention evidence, separate from real business-handler tests.

The parent's separate serial queue integration run passed **185 tests / 10 files, 0 failed/pending** (Node v26.4.0, pnpm 12.9.1; isolated `backend-next-255`, PostgreSQL `55455`, Redis `56395`). The earlier overlapping run had 184 passes / 1 globalSubscriber interference failure; it is not recorded as PASS. [Current runtime paths, exact commands and artifact receipt](../queue-runtime/README.md) distinguish these new consumers from the unchanged frozen source observations. No new pinned-source run is claimed.

Initial process validation has **57 passed / 4 failed / 8 files**; only the new queue-runtime cases fail. Final process gate PASS: the unchanged seven process files passed 43 cases; the corrected new file passed all 18 cases in a separate execution. Remaining seven handlers, nine schedulers, #139 cutover and existing feature owners are unchanged.
