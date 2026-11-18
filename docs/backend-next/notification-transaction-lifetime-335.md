# 通知保存能力の transaction 寿命（#335）

対象: #335、親 #177、全体 #114。基点は `6af8cd5baa`。既存の投稿通知と pollEnded の保存能力だけを対象にする。

`createNotificationTransactions` の binder が共通 runner の `assertActive` を使い、callback 終了時に save 能力を失効させる。`PostNotificationPersistence` の active/unreleased transaction 検査、受信者別 advisory lock、保持と flush の SQL は変更しない。

## 確認した境界

- 実 PG transaction の callback が戻った後、COMMIT/ROLLBACK 開始前も DB transaction は有効だが、持ち出した save は拒否する。修正前はこの2ケースが保存に成功して失敗した。
- commit/rollback 完了後、別 transaction の実行中も古い save は拒否し、新しい scope の save は成功する。rollback は元の例外オブジェクトを保持する。
- 投稿の `createPostingNotifications` と pollEnded の `createPollEndedHandler` で実 scope を取得し、保存後の配信時には save が失効していることと、確定した保存・別受信者への保存を確認する。投稿テストは既存の HTTP 投稿と後続の composition を使う。pollEnded テストは通常 handler を直接呼び、既存の producer/worker テストも同時に実行する。
- 既存の受信者別保持、並列追加、flush/save 直列化、保持削除の rollback に加え、flush 削除の rollback と元例外の保持を確認する。

## 固定本家との比較範囲

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `packages/backend/src/core/NotificationService.ts`（`createNotification`、Redis Stream への `xadd`、受信者別 `flush`）と `packages/backend/src/queue/processors/EndedPollNotificationProcessorService.ts` の source を参照した。本家は Redis 保存で transaction 専用 save 能力を公開していないため、この寿命境界は承認済み PG 保存に必要な内部契約として検証する。本家 full server/PG/Redis を今回起動して比較した意味ではない。

保存先の PG と受信者別 advisory lock による保持/flush の直列化は従来の意図的差異を維持する。通知の条件、ID・時刻、配信タイミング、payload、保持数は変更しない。全通知種別、一覧・未読・全既読、Push、Redis 通知移行は #177 の他の子 Issue に残る。通知 transaction 以外の共通 runner 適用は対象外で、完了済み #251 の判定は変更しない。

## 検証（2026-11-18）

Node `24.20.0` / pnpm `12.9.1`。独立 worktree に filtered frozen install を行い、専用 Compose project `backend-notify335`（PG `55435` / Redis `56385`）を使用した。共有 node_modules 経由の install/rebuild は行っていない。

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter backend-upstream build` | PASS |
| `pnpm --filter backend-next build` / `typecheck` | PASS |
| `pnpm --filter backend-next test test/unit/transaction-runner.test.ts test/unit/notification test/unit/note/created-events.test.ts` | PASS: 3 files / 51 tests |
| `BACKEND_NEXT_TEST_DB_PORT=55435 BACKEND_NEXT_TEST_REDIS_PORT=56385 pnpm --filter backend-next test:integration test/integration/notification.test.ts test/integration/poll-ended-job.test.ts test/integration/note-notifications.test.ts test/integration/transaction-runner.test.ts` | PASS: 4 files / 52 tests |
| `node scripts/check-shipping.mjs --base 6af8cd5baa` | PASS: 変更 TS 4 files の quiet lint、SPDX、locale safety |
| `git diff --check` | PASS |

初回 offline install は pnpm metadata cache 不足で失敗し、通常の frozen install で解消した。初回 typecheck で新しい pollEnded テストの未使用 composition stub が不足し、fixture を補って解消した。PG の既存 client.query 並行利用 deprecation warning は出るが、テスト失敗・skip はない。全体 unit/integration/process と本家 full server 比較は今回の検証範囲外。最新 head の CI・Web レビューは PR で別途追跡する。
