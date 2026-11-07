# 投稿 user webhook の比較と引き継ぎ

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。根拠は [NoteCreateService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteCreateService.ts)、[UserWebhookService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserWebhookService.ts)、[QueueService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[processor](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/UserWebhookDeliverProcessorService.ts)。

作成者の note とローカル受信者の mention/reply/renote を接続する。mention は受信者視点、他は匿名 skipHide + reaction pair cache で pack する。mention/reply は各 thread mute を確認し自己宛ても許し、renote は他者のローカル原作者のみ（引用を含む）。同一受信者の mention と reply は別イベント。固定本家に削除 webhook はない。

フック設定は初回取得時に active 行を読み、その後は host channel の `internal` envelope にある `webhookCreated` / `webhookUpdated` / `webhookDeleted` の全行で更新する。接続が続いている間のDBだけの変更は反映されない。#197 は保存後に同じ通知を発行し、この契約を再利用する。queue は URL・secret・payload・eventId・時刻を投入時に保持し、後の無効化や削除は既存ジョブを取り消さない。secret は JSON body ではなく `X-Misskey-Hook-Secret` ヘッダーで送信し HMAC は使わない。attempts 4、HTTP backoff、成功7日/30件・失敗7日/100件、worker 64並行・毎秒64件、標準HTTP timeout 5秒。4xx（429除く）は停止、それ以外と通信失敗は通常再試行する。

**差異 W1（PR #231レビュー対応）**: 固定本家は購読再接続時にも設定cacheを保持する。通知を取り逃した無効化・削除が再起動まで反映されないため、新実装は2回目以降の`ready`でcacheを破棄し、次のenqueueでactive行を読み直す。再接続や設定通知より前に開始した取得結果は採用せず、再取得失敗時にも古い設定へ戻さない。取得中に設定通知を受けた場合の古い結果の上書きも防ぐ点は、初回取得にも適用する。初回接続と通常のcache hitは遅延取得のまま。切断中の配送や投入済みjobの取消保証を追加するものではない。単体テストで取得競合・再取得失敗、実Redis/PGで購読接続の強制切断後の無効化・削除・secret変更を検証する。

`UPSTREAM_ROOT=/path/to/fixed-upstream node docs/superpowers/compatibility/user-webhook/source-probe.mjs` は指定 repository の固定 Git object からメソッド本文を抽出実行する（作業ツリーは参照しない）。DB・queue・HTTP を doubles にした本家側だけの probe であり、新旧の完全な HTTP 比較ではない。新実装は unit と実PG/Redis・fake HTTP、および実HTTP/worker process で別途検証する。管理 API・投稿以外のイベントは #197、system webhook は #198、全投稿フローの縦断は #176 に残る。
