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

## 現在の接続範囲

作業基点 `6246c3605a` の backend-next には `deliver` / `endedPollNotification` / `userWebhookDeliver` の3業務 producer・Worker が接続済みで、それぞれ本家の7日・30/100設定を job ごとに渡している。全10名の管理 handle は #163 で接続済み。管理 handle の存在は system / postScheduledNote / inbox / db / relationship / objectStorage / systemWebhookDeliver の7業務 Worker・producer が完成したことを意味しない。

#164 では現在接続する3 queue の実際の保持を検証する。未移植機能を空 handler や新しい周期 worker で埋めない。将来追加する producer は本資料の該当行を利用し、その機能の実仕事から保持を検証する。既存 job の opts を上書きする migration、無設定 job に7日を強制する Worker fallback は追加しない。#165 の残 payload・定期 job・完全停止引継ぎの確認、#124/#176 全体、7業務 queue の機能完成を本資料だけで完了扱いしない。

## 実 Redis / BullMQ で必要な検証

以下は source probe から分離した実依存検証の recipe である。専用 Redis と一意の test prefix を使い、実接続のある3 queue の実 producer options / Worker adapter と #163 の照会窓口を使う。短縮ポリシーの単独テストだけで、本番の7日・30/100設定との一致を示したことにしない。

1. **件数**: 実 Worker で31件を成功、101件を最終失敗させ、待機中の処理完了を `finishedOn` / `getJob` で確認してから、それぞれ最新30件・100件が残ることと最古 job / logs が消えることを確かめる。結果値・失敗理由・stack・opts が残ることも管理照会で見る。同じ queue の異なる job 名を混ぜ、名前別の上限と誤認しない。
2. **7日と lazy cleanup**: 完了・失敗させた test job の終端 sorted-set score と `finishedOn` だけを test の Redis 接続で7日より前へ backdate する。読み取り・pause/resume・時刻経過だけでは消えないことを確認する。その後、同じ queue の同じ終端状態へ次の job を移し、期限超過履歴が消え、期間内履歴が残ることを確認する。成功だけ進めても failed 履歴が清掃されるとは仮定しない。タイマーの固定待ちに頼らず、十分な境界幅を持たせる。実行時刻ちょうどの閾値を試す場合は BullMQ の transition 時刻も制御する。
3. **retry**: 一時失敗後の backoff/delayed と、最終失敗の failed を区別する。最終失敗から #163 の retry を実行し、成功へ移った job は completed に残り、他の失敗履歴・成功履歴の上限がそれぞれ働くことを確かめる。retention により既に消えた ID は取得できない。poll は source どおり attempts 未指定なので、通常自動 retry を追加しない。
4. **未完了の保護**: 同じ queue に wait、pause 中に投入した paused、未来の delayed、処理を gate で止め lock を保つ active を用意する。別 job の成功/最終失敗を使って保持清掃を発生させる。全 sentinel の ID・payload・状態が残り、resume / gate 解放後に実行できることを確認する。active の lock を故意に失わせる stalled 検査とは混ぜない。
5. **無設定・上書きの境界**: `removeOnComplete` / `removeOnFail` のない legacy test job は、source にない Worker fallback で消さない。ただし同じ終端集合の他 job が持つ count/age 清掃から保護されるとは限らないため、別 test prefix で単独挙動と混在挙動を分ける。`true` / `false` / 数値 / object は BullMQ の job opts として尊重されることを確認する。これらの投入口を業務 API に新設しない。
6. **管理と終了**: 清掃後の counts / jobs / show-job / logs を #163 の通常管理窓口で確認する。手動 clear の破棄は別ケースへ分ける。開始済み job を待機して Worker を閉じ、Queue を解放する。正常停止と Redis 接続喪失の既存 process 検証を再利用し、保持のために独立の周期プロセスや shutdown clean を追加しない。

実依存検証の件数・実行結果は #164 の実装/検証記録へ別途残す。この source fixture の24観測を実 Redis テスト件数に加算しない。
