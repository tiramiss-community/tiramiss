# 投票終了ジョブの本家比較資料

対象は [#162](https://github.com/tiramiss-community/tiramiss/issues/162) の最初の実装 PR。通常 worker へ最初に接続する実ジョブとして、本家の `endedPollNotification` を比べる。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。

対象の本家コードは次のとおり。

- 投入: `NoteCreateService.postNoteCreated` の投票終了ジョブの投入（`src/core/NoteCreateService.ts:819-834`）
- queue の名前・接続・prefix: `src/queue/const.ts`
- Worker の設定と失敗時の記録: `QueueProcessorService`（`src/queue/QueueProcessorService.ts:500-521`）と `runQueueJob`（`src/queue/queue-job-runner.ts`）
- 処理: `EndedPollNotificationProcessorService.process`（`src/queue/processors/EndedPollNotificationProcessorService.ts:36-58`）
- 通知の作成: `NotificationService.createNotification`（`src/core/NotificationService.ts:80-170`）。通知元のない場合の受信判定と、Redis への保存まで

## 資料

| ファイル | 用途 |
| --- | --- |
| `processor-cases.json` | 投稿・投票・プロフィールを与えて本家の処理を動かした結果。どの受信者へ `createNotification` を呼び、どの受信者の通知が保存されたか |
| `job-cases.json` | 投入の名前・内容・設定（固定時刻での遅延を含む）、queue の接続と prefix、Worker の設定、処理が失敗したときの記録 |
| `reference-poll-ended.unit.ts` | 上の 2 つの JSON の `inputs` を本家に通し、`cases` と照合する probe |

各 JSON は `inputs`（入力表）と `cases`（本家の結果）を持つ。新実装のテストは `cases` を読み込み、値を手で複製しない。

## JSON の形

### `processor-cases.json`

- `inputs.noteId`: ジョブの `noteId`。
- `inputs.cases[]`: `{ id, note, votes, profiles, storeFailsFor? }`。
  - `note`: `{ userId, hasPoll }`。`null` は投稿がない。
  - `votes[]`: 投票の行の順に `{ userId, userHost }`。同じ利用者の複数の行は複数選択の投票を表す。
  - `profiles`: 利用者 ID ごとの `{ userHost, notificationRecieveConfig }`。キーがない利用者はプロフィールがない。
  - `storeFailsFor`: 通知の保存（本家では Redis の `XADD`）を失敗させる受信者。
- `cases[]`: `inputs.cases` と同じ順の `{ id, result, queries, createNotificationCalls, stored, unhandledRejections }`。
  - `result`: `{ returned: true }` か、例外を投げた場合の `{ thrown: { name } }`。
  - `queries`: 本家が投稿と投票を読んだ呼び出し。投票は `vote.user` を inner join し、`user.host IS NULL` で絞る。並び順は指定しない。
  - `createNotificationCalls`: `createNotification` の引数を呼び出し順に並べたもの。
  - `stored`: 保存された通知を順に並べたもの。`id`・`createdAt` は `{id}`・`{createdAt}` に置き換えた。
  - `unhandledRejections`: 待たれずに失敗した通知の作成の例外。

### `job-cases.json`

- `inputs.now`: 固定する時刻。`inputs.polls[]`: 投稿の投票（`expiresAt` の有無と値）。`inputs.redisForJobQueue[]`: 本家の `convertRedisOptions` を通した後の形の接続設定。
- `cases.enqueue[]`: 投票ごとの `endedPollNotificationQueue.add` の引数 `[name, data, opts]`。投入がなければ空。
- `cases.queues[]`: `baseQueueOptions` の結果。`connectionKeyPrefix` は接続設定に残る `keyPrefix`（JSON に `undefined` が残らないため別に記録した）。
- `cases.worker`: `endedPollNotification` の Worker の設定、登録したイベント、処理が失敗したときのログ・`captureMessage`・元の例外を投げ直したか。
- `cases.workerNames`: 本家が作る Worker の一覧。

## 観測した本家の挙動

- **投入**: 期限のある投票だけを投入する。名前と `data.noteId` は投稿の ID。`delay` は後続処理を始めた時点の時刻から期限までの差で、期限を過ぎていれば負の値のまま渡す（BullMQ はすぐに実行する）。`removeOnComplete` は `{ age: 604800, count: 30 }`、`removeOnFail` は `{ age: 604800, count: 100 }`。`attempts`・`backoff`・`jobId` は指定しない。投入は `silent` の分岐より前にあり、`silent` でも同じ。
- **queue**: prefix は `<redisForJobQueue.prefix>:queue:endedPollNotification`。接続設定から `keyPrefix` を外し、他の値（`prefix` を含む）はそのまま渡す。
- **Worker**: 設定は接続・prefix・`metrics: { maxDataPoints: 10080 }`・`autorun: false` だけ。`concurrency`・`limiter`・再試行の設定はない。イベントの受け手は登録しない。失敗した試行は `failed(<name>: <message>) id=<jobId>` で記録し、telemetry へ送り、元の例外を投げ直す。
- **受信者**: 投稿の作者を先頭に、ローカルの投票者を投票の行の順に並べ、重複を除く。作者がリモートなら作者には通知しない。リモートの投票者は SQL で除かれ、プロフィールも読まない。
- **受信設定**: 通知元がないため、`notificationRecieveConfig.pollEnded.type` が `never` のときだけ通知しない。`following`・`list` などの条件は判定しない。他の種類の設定は関係しない。
- **通知の形**: `{ id, createdAt, type: 'pollEnded', noteId }`。`notifierId` のキーを持たない。
- **失敗**: 受信者のプロフィールがないとジョブは `EntityNotFoundError` で失敗する。それまでの受信者への通知は作られる。通知の保存の失敗は待たれずに捨てられ、ジョブも他の受信者への通知も止めない。
- **投稿がない・投票がない**: 何もせずに完了する。

## probe の実行

probe は固定コミットの本家で実行する。本リポジトリの旧 backend・新 backend の製品コードに追加するテストではない。

1. 固定 SHA の worktree を作り、依存を用意する（`pnpm install --frozen-lockfile`）。ルートの `built/meta.json`（`{"version": ...}`）が必要。`QueueProcessorService` がすべての processor を読み込むため、`misskey-js`・`misskey-reversi`・`misskey-bubble-game` を先にビルドする。
2. `packages/backend/test/unit/<任意のディレクトリ>/` へ、本ディレクトリの JSON 2 つと `reference-poll-ended.unit.ts`（`.test.ts` に改名）をコピーする。
3. `packages/backend` で、`.node-version` の Node を使って `vitest run --config vitest.config.ts <コピー先>` を実行する。単体用の設定は DB を前提とする global setup を持つため使わない。
4. 入力表を変えたときは、`POLL_ENDED_PROBE_WRITE=1` を付けて実行して `cases` を再生成し、JSON を本ディレクトリへ戻す。その後、環境変数なしで再実行して一致を確かめる。

probe は re2 を差し替える（federation-base と同じ理由）。`NotificationService` は本物を使い、Redis の `XADD` を記録する stub と、`pack` が `null` を返す stub で配信の手前で止める。投票の SQL は呼び出しを記録し、`user.host IS NULL` の結果だけを stub で再現する。`postNoteCreated` は投入に関係しない依存をすべて何もしない値にして動かす。Worker は `bullmq` の `Worker` を記録用のクラスへ差し替え、Redis へ接続しない。

2026-11-03 に Node.js `v26.4.0` で記録し、2 件（処理 11 件・投入 6 件と queue 2 件・Worker 1 件）とも一致した。Node.js `v24.20.0` でも同じ結果になった。

## 新実装への接続

| 新テスト（`packages/backend-next/test/`） | 接続した期待値 |
| --- | --- |
| `unit/notification/poll-ended.test.ts` | `processor-cases.json` の全件。保存した受信者と順序、例外の有無、保存の失敗が他の受信者を止めないこと |
| `unit/job-queue/ended-poll-notification.test.ts` | `job-cases.json` の投入・queue・Worker。新実装の差（再接続しない接続設定と起動期限）を除いて一致すること |
| `integration/poll-ended-job.test.ts` | 実 DB/Redis。投票の SQL（リモートの除外・複数選択）、遅延ジョブの実行と通知の保存、1 回だけの試行と失敗の保持、接続の喪失の報告 |
| `processes/poll-ended.test.ts` | 通常起動の HTTP 子と worker 子。投稿から通知まで、停止中に期限を過ぎたジョブの再開、実行中のジョブを待つ停止、接続の喪失による全体停止 |

新実装は `packages/backend-next/src/modules/notification/poll-ended.ts`（処理）、`src/platform/job-queue/`（queue・Worker）、`src/platform/database/poll-ended.ts`（読み取りと保存）、`src/composition/poll-ended-job.ts`。

## 意図的な差異

- **再接続**: 本家の queue の接続は ioredis の既定で再接続し続ける。新実装は他の必須 Redis 接続と同じく再接続せず（`retryStrategy` は `null`）、稼働中の切断を子プロセスの異常終了とし、Supervisor が全体を止める。起動は既存の起動期限で区切る。
- **停止**: 本家の通常の停止（シグナル）は Worker を閉じず、実行中のジョブは BullMQ の stalled 検査で戻る。新実装は取得の停止→実行中のジョブの完了→接続の解放の順に止め、既存の停止期限を超えたら異常終了する。期限を超えて止めたジョブは本家と同じく stalled 検査で戻る。
- **通知の保存先**: 本家は Redis の `notificationTimeline:<userId>` へ保存する。新実装は承認済みの `backend_internal.notification` へ保存し、`notifier_id` を `NULL` にする（受信者ごとに 1 transaction）。
- **'error' の受け手**: 本家はこの Worker にイベントの受け手を登録しない。新実装は `error` を記録する受け手を登録する（受け手がないとプロセス外へ例外が出るため）。
- **失敗の記録**: 本家のログは例外の名前とメッセージ、telemetry へ送る。新実装はキュー名・ジョブ ID・名前・試行回数と、例外の名前・コードを JSON 行で記録する（メッセージは接続情報を含みうるため出さない）。telemetry は未接続。

## 未検証・範囲外

- **#173・#177・#189 へ**: 通知の配信（`publishMainStream('notification')`）、2 秒後の未読通知と push、通知の `pack`、Redis の既存通知との統合は扱わない。新実装の通知は DB に保存されるだけで、まだ API から読めない。
- **#184 へ**: 投票 API がないため、通常起動では投票者は既存のデータにしかいない。
- **#163・#164・#165 へ**: 管理 API・QueueStats、保持期間の設定、既存 Redis のジョブの互換の検証。
- **#171 へ**: AP 配送の queue・Worker（12 回の試行、`httpRelatedBackoff`、limiter、concurrency 128）は、この PR の queue・Worker の上に #171 の配送と一緒に接続して比べる。
- **観測していない**: 実 Redis での本家の Worker の動作（Worker は記録用のクラスで観測した）、本家の stalled 検査の時間、`trackPromise` の本番での動作（`NODE_ENV=test` のときだけ追跡する）。
