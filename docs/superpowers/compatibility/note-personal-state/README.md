# favorite / thread mute (#481)

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の4 APIを通常HTTPへ接続する。親は #184、全体は #114。

| 操作 | Scope | 不存在 | 不可視 | 重複・再試行 |
| --- | --- | --- | --- | --- |
| favorites/create | write:favorites | NO_SUCH_NOTE | NO_SUCH_NOTE | ALREADY_FAVORITED |
| favorites/delete | write:favorites | NO_SUCH_NOTE | 解除可能 | NOT_FAVORITED |
| thread-muting/create | write:account | NO_SUCH_NOTE | 保存可能 | ALREADY_MUTING |
| thread-muting/delete | write:account | NO_SUCH_NOTE | 解除可能 | 何度でも204 |

認証、現在の凍結、scope、移行済アカウント（favorite作成のみ）、`misskey:id`、API別のerror UUIDを維持する。作成は本番Redisの1時間窓でfavorite20回 / thread mute10回、RoleのrateLimitFactorを使う。解除にレート制限はない。

threadIdがnullならNote IDを保存する。既存の通知reader/投稿eventは現在のthread mute行を読むため、HTTPでミュートしたthreadのmention/reply streamと通知保存を抑止し、解除で再開する。本人以外の状態は変更しない。NoteFavoriteはmanifestへ追加し、Git objectから同期した。既存のmigration・public.migrations履歴は変更しない。

ローカルの別作者のNoteをfavoriteすると、作者の`myNoteFavorited1`実績を保存する。本人・リモート作者では解除しない。実績は独立した非待機処理で、開始済み処理をruntime停止時に待つ。既存実績・`achievementEarned: never`を維持し、許可時は既存PG通知表にachievementを保存してmain streamへ発行する。通知の保存・発行失敗で確定済みのfavoriteや実績を取り消さず、再favoriteで実績通知を再試行しない。

新しい内部migrationはachievementにだけnote_id=nullを許し、既存note通知のtype/notifier/target制約を維持する。共有の保持件数・flushにも含める。downはachievement通知だけを削除して直前のschemaへ戻す。実績は本家UserProfileの正本へ保存する。

## 比較と検証

`source-probe.mjs`は4 endpoint callback、`NoteEntityService.isVisibleForMe`、`AchievementService.create`、`notes/state` callbackを固定Git blobから抽出して実行する。`observations.json`は26ケースの入力hashとsource blob/SHA-256を含む。Repository・時刻・ID・通知配送を明示的なdoubleに置き換える。full upstream serverを起動した比較ではない。

`test/integration/note-personal-state.test.ts`は同じ入力・期待値を通常のlistening HTTP/PGで比較する。保存・不可視・重複・解除再試行・DB失敗、本人別state材料、通知consumer、実績/通知、同時favorite、schema/up/down/保持/flushを確認する。Redis制限もproduction設定のlistening HTTP経由で検証する。`notes/state` API自体は #482、favorite一覧は #487の担当とし、ここではstateと同じ公開reader材料を比較する。

```sh
node docs/superpowers/compatibility/note-personal-state/source-probe.mjs --check
pnpm --filter backend-next test test/unit/note-personal-state test/unit/note/notification-policy.test.ts test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=55481 BACKEND_NEXT_TEST_REDIS_PORT=56481 pnpm --filter backend-next test:integration test/integration/note-personal-state.test.ts test/integration/note-notifications.test.ts test/integration/poll-ended-job.test.ts test/integration/migrations.test.ts
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
```

## 比較の限界と引き継ぎ

- 実績のread→updateを作者プロフィールの行ロック内で行い、別Noteへの同時favoriteでの実績重複通知・既存実績の上書きを防ぐ。本家の無ロックread/update競合まで再現するものではない。通常の結果は固定sourceと一致する。
- 通知保存は既存の承認済みPG保存方式を継承する。一般の通知一覧・未読・push・配信設定全体は #177 / #298 / #437の既存責任であり、このsliceで完成とは扱わない。achievement追加が必要な表現と通常producer/streamだけを実装する。
- `notes/state`/favorite一覧、reaction・投票・親#184と#114全体、完全停止切替は未完了。変更済みの共有入力の古いreceiptを今回の実測として書き換えない。
- 本番相当の通常データへの操作は行っていない。検証Composeは専用`/tmp/tiramiss-next481`、project `tiramiss-next481`、PG55481/Redis56481を使う。
