# #578 の限定 worker イベントログ

基準は develop `fe1a8106c3b3d5aba8ddf57de5e28e37e4e0e6ca`、本家は `8e07cf085adf7009583d234a208e30436f020e26`。本 slice は通常 worker の `deliver`・`userWebhookDeliver` と `endedPollNotification` のログ登録差だけを扱う。#578・親 #138 は未完了のまま残る。

## 実装と固定本家との比較

`QueueProcessorService.ts` の deliver（295行）、user webhook（372行）、poll（504行）の constructor block と helper、`queue-job-runner.ts`、`LogManager.getDefaultLevel` を Git の固定コミットから取得し、TypeScript で変換して実行した。[reference-worker-logging.cjs](reference-worker-logging.cjs) は Worker と telemetry を明示した double に置き換える。結果は [observations.json](observations.json) の source SHA-256・イベント登録・11出力に保存する。本家 full server・本家 Redis/PG の測定ではない。

| 経路 | 本家 | 新実装の出力 |
| --- | --- | --- |
| deliver / userWebhook active | debug、job ID、attemptsMade + 1、最大試行数、経過時間、配送先 | `job.active` と同じ項目 |
| deliver / userWebhook completed | debug、同じ +1、結果、配送先 | `job.completed` と同じ項目 |
| deliver / userWebhook worker error | error | `job.worker-error`、queue、安全な Error 情報 |
| deliver / userWebhook stalled | warn、job ID | `job.stalled`、queue、job ID |
| deliver / userWebhook の試行失敗 | error、増分なしの attemptsMade、配送先、再送前にも出力 | `job.failed`、job ID、同じ試行数・最大数・経過時間・配送先 |
| endedPollNotification | lifecycle listener なし、processor の失敗だけ error | 既存 `job.failed` だけを維持 |

mokuroku の実 Worker 作成直後、消費開始前に監視を取り付ける。公開 hook には stalled と completed result がないため、既存の `ObservedQueueManager` 境界で BullMQ の実イベントを利用する。元の processor 例外・結果と再試行方針は維持する。ログの sink やシリアライズが失敗しても、全3 processor の元の例外と lifecycle イベントの後続 listener を妨げない。Worker の error は manager と listener からの二重出力を避け、queue・cleanup・接続終了などの別診断は維持する。

本家の completed の `attemptsMade + 1` も保持する。現在の BullMQ は成功直前にもカウンタを増やすため、2試行で成功した completed ログは `3/2` となる。新実装の通常プロセス試験でもこの値を確認した。

既存の JSON logger を使用し、debug/warn の出力口を追加する。固定本家の既定に合わせて `NODE_ENV=production` は debug を出力せず、それ以外は debug を出力する。info/warn/error は維持する。明示的な logging 設定・verbose/quiet の適用は #578 に残す。queue が構造化した分類、process/pid がプロセス識別となる。本家の文章・Error message/stack・poll payload をそのまま複製しない既存の診断方針を維持する。追加した配送先ログでは path を含む配送先全体から origin（scheme・host・port）だけを残し、HTTP(S)以外と不正URLは固定値にする。本文・Webhook secret・配送先を含む生の deliver jobName を出力しない。deliver の停止理由は `remote-gone` / `delivery-rejected` の分類のみを記録し、任意の remote status text は出力しない。BullMQ に返す元の例外 message は維持する。経過時間は数値の `ageMs` であり、本家の文字列単位整形とは別形式。

## 検証

- 固定 source の登録差・level・試行数と processor の同一例外再送出を、新実装の source 比較3件で直接照合する。URL安全化の4件と実 Worker 作成境界の単体試験を含む近傍113件が成功。
- PG/Redis・通常 `built/entrypoints/worker.js` の8件で、deliver / webhook の500→204再試行成功と400終了、poll の失敗だけの出力を確認する。実HTTPへ送った回数、Redisのjob結果・attemptsMade、stdoutのlevel・配送先・job ID・process/pid、停止成功を検査する。
- プロセス試験は待ち時間だけを固定25msへ短縮する。本番の custom backoff は変更せず、既存 deliver の固定本家比較で検証する。worker error は通常 worker の実 Worker への注入でも単一出力と停止しないことを確認する。stalled は単体のイベント境界への注入比較であり、実Redis障害・lock失効をこの8件で再現した意味ではない。
- build/typecheck・変更ファイル lint・SPDX・locale safety が成功。実行ログ・JSON結果・入力hashは [runtime-evidence.json](runtime-evidence.json) に記録する。PG の既存 query deprecation warning は成功結果と分けて扱う。

再現例（専用の検証依存を使う）:

```sh
node docs/superpowers/compatibility/worker-logging/reference-worker-logging.cjs /path/to/pinned-upstream
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/job-queue/runtime.test.ts test/unit/job-queue/user-webhook.test.ts test/unit/job-queue/deliver.test.ts test/unit/job-queue/ended-poll-notification.test.ts test/unit/job-queue/worker-logging-source.test.ts test/unit/logger.test.ts test/unit/composition/queue-workers.test.ts
pnpm --filter backend-next test:process test/processes/worker-logging.test.ts
node --test scripts/worker-logging-contract.test.mjs
```

`runtime-evidence.json` は変更した11既存ファイルの測定済み successor と変更前の差分を固定する。`readPreAliasKey` を経由する過去の資料だけへ変更前のbytesを渡し、過去の件数・receipt・測定範囲を更新しない。最初のレビュー前の R1 記録は `runtime-evidence-r1.json` にバイト同一で保存し、R2 は別の実行ログを参照する。未知のbytesはそのまま元の検査へ渡す。新しい検査は現在の入力と実測を別途照合し、記録・入力・raw logの改変を拒否する。

## 残る #578

明示的な logging 設定、verbose/quiet/domain/off、pretty/json 選択、API/client/chart の各設定、bootstrap・環境・マシン情報、未処理拒否/例外、長大値・期限付きflushは本 slice の完了範囲に含めない。全体の設定別互換性や #135 の logging 関係行の昇格・#578 close を主張しない。既存の実行3 queue以外のworker移植は各担当に残る。


## 既存試験のログ期待値の追補（PR #631）

CI で既存 `deliver-queue.test.ts` の2件が、変更前の完全URL・HTTP status text をログへ求めて失敗した。ログの期待値だけを origin と `delivery-rejected` に合わせ、実HTTPの配送先、503の待ち時間・再試行・成功、404の元の `failedReason`・試行数は保持する。N7の terminal AP 404 の通常Supervisor試験にも同じ分類の期待値を適用した。Webhook結合試験に古いログ期待値はなかった。

[追補の入力・実測](integration-followup.json)は配信/Webhook結合11件とN7の対象process1件を記録する。processの他7件は名前による選択でskipしたもので、全N7の再実測を主張しない。R2の16入力・113/8件・runtime recordは変更しない。

Meta cache CI fixtureの既存hash検査で配信試験の差分による失敗を再現した。現在の配信試験の正確なhashだけを認識してR2時点のbytesを復元し、その後は元のMeta cache検査と履歴復元へ渡す。元のreceipt・期待hash・測定結果は書き換えない。未知のbytesは元の検査で拒否され、追補も現在の2試験・R2記録・raw logとJSON結果の改変を拒否する。
