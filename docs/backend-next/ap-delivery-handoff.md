# AP配送の業務規則と削減後の引き継ぎ

#171/#160/#162で実際のAP表現・署名HTTP・通常BullMQを接続するための入力。#162 の通常 BullMQ は投票終了ジョブで接続済み、#171 の最初の PR でノート作成の配送を接続し、第2sliceで既存 accepted relay と作者鍵の JSON-LD 署名を追加した（下記）。
未使用の配送実装は追加しない。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。

- [NoteCreateService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteCreateService.ts)のローカル作者かつ非localOnlyの配送分岐を起点にする。remote mention・reply作者・renote作者がdirect候補、public/home/followersがfollowers対象、publicがrelay対象。channel等の入力補正と最新の連合条件も接続時に照合する。
- [ApDeliverManagerService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApDeliverManagerService.ts)はfollowersを先に処理し、Followingの非正規化sharedInboxを優先、なければindividual inboxをMapへ登録する。両方nullなら例外になるのは問い合わせをstubにした場合だけ。本家の問い合わせは主キーを選ばないため、実DBではTypeORMが2列ともnullの行を返さず、そのフォロワーは飛ばされて他の宛先には届く（[比較資料の宛先](../superpowers/compatibility/ap-deliver/README.md#宛先)）。directはsharedInboxが既登録なら省略、individual inboxがnullなら省略し、それ以外はindividual inboxへ登録する。同じURLでは後のMap更新が優先される。
- [RelayService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/RelayService.ts)はaccepted relayへ別copyのactivityを配送する。to欠落時のPublic補完とLD署名があり、followers/directの集合へ単純に統合・重複排除しない。
- [QueueService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)の通常add/addBulk、AP既定12試行・backoff・履歴と、配送processorの停止host/連合条件/結果分類をその機能の実装時に比較する。永続snapshot/page/host leaseは初期前提にしない。

撤去した旧snapshotはdirect inbox欠落を全体拒否し、relayを同じ集合へ統合していた。
そのテストを本家互換性のoracleとして流用しない。新実装の比較には[固定N0観測](../superpowers/compatibility/note/README.md)と上記ソースを使い、追加の失敗・重複・連合条件を検証する。
旧protocolの設計根拠は[宛先固定設計](../superpowers/specs/2026-10-23-ap-recipient-snapshot-design.md)、実行コードはPR #212マージ時点までのGit履歴に残る。宛先規則の記録だけでAP配送の実装・互換性検証を完了扱いにしない。

## #160 の最初の PR で入れたもの

2026-11-03 のユーザー決定で、#160 の最初の PR は署名と結果の分類だけを持つ。通常起動からは呼ばず、BullMQ も追加しない。本家との比較は[比較資料](../superpowers/compatibility/ap-request/README.md)を参照。

- `src/modules/federation/http-signature.ts`: 本家の `ApRequestCreator`（`createDigest`・`createSignedPost`・`createSignedGet`）。時刻は引数で渡す。署名は `node:crypto` の RSASSA-PKCS1-v1_5 SHA-256 で、本家の slacc と byte 単位で一致する。
- `src/modules/federation/signed-post.ts`: 本家の `signedPost`。`createSignedPostSender` が `readUserKeypair`・`send`・自 URL・時計を受け取る。組み立ては `src/composition/ap-request.ts` の `createApRequest`。
- `src/modules/federation/delivery-result.ts`: 本家の `DeliverProcessorService` の失敗の分類（:141-161）。成功は `'Success'`、止める失敗は message と `hostGone`、再試行は投げる例外を返す。BullMQ の型は持たない。
- `extractDbHost`・`isFederationAllowedUri`（[連合の共通土台](federation-base-contract.md)）。

配送を接続する PR（#171）に残るもの:

- 配送前のスキップ判定（連合可否 → 停止中のホスト（1 時間キャッシュ）→ 配信停止ソフトウェア）と `'skip (...)'` の結果。
- インスタンス台帳と状態の更新（`isNotResponding`・7 日の自動停止・`hostGone` による `goneSuspended` の書き込み）。[連合の共通土台](federation-base-contract.md)の段階 3。
- 分類の結果を BullMQ の `UnrecoverableError` と通常の再試行へ写すこと、12 回の試行・`httpRelatedBackoff`・limiter・concurrency 128。#162 の queue・Worker の上に、#171 の配送と同じ PR で接続して本家と比べる。
- 配送の成功・失敗によるチャートの更新は #200、成功時の `fetchInstanceMetadata` は連合の共通土台の段階 5。
- signedGet 本体（HTML の alternate・content-type の検証・`assertActivityMatchesUrl`）は #195。#160 は署名付き GET の組み立てだけを持つ。

## #162 の最初の PR で入れたもの

2026-11-03 のユーザー決定で、#162 の最初の PR は本家の投票終了ジョブで通常の BullMQ の Queue/Worker を接続した（[比較資料](../superpowers/compatibility/poll-ended/README.md)、[投稿の最小契約](posting-contract.md#通常ジョブ162)）。AP の deliver queue・Worker、webhook、試行回数・backoff・limiter はこの PR に入れず、#171 の配送と一緒に比べて接続する。#162 の「AP slice は #160 の署名 HTTP と偽の inbox まで通す」も #171 へ移した。

- 接続は本家と同じく `redisForJobQueue` の設定から `keyPrefix` を外し、queue ごとに `<prefix>:queue:<queue名>` の prefix を使う（`src/platform/job-queue/connection.ts`）。deliver も同じ関数で作る。
- Redis の接続は再接続しない（`retryStrategy` は `null`）。稼働中に Queue・Worker の接続を失うと子を異常終了し、Supervisor が全体を止める。本家は BullMQ の既定の `retryStrategy`（1〜20 秒の指数待ちで無期限）で再接続し続ける（意図的な差異）。
- Worker は `autorun: false` で作り、接続の準備を待ってから `run()` を始める。停止は `close()`（取得の停止→実行中のジョブの完了→接続の解放）で、既存の停止期限を超えたら異常終了する。期限を超えて止めたジョブは本家と同じく stalled 検査で戻る。
- 役割固有の接続の喪失は `startManagedProcess` の `reportFailure` へ渡す。deliver の Worker も同じ経路を使う。

## #171 の最初の PR で入れたもの

2026-11-03 のユーザー決定で、#171 の最初の PR は relay を除くノート作成の配送を通常起動へ接続した。本家との比較は[比較資料](../superpowers/compatibility/ap-deliver/README.md)を参照。

- **表現**: `src/modules/mfm/`（本家の `MfmService.toHtml`・`ApMfmService.getNoteHtml`）と `src/modules/federation/note-activity.ts`（`renderNote` の dive=false の経路・`renderCreate`・`renderAnnounce`・`@context`）。材料は `src/platform/database/note-activity.ts` が投稿の ID から読み直す。
- **配送の分岐と宛先**: `src/modules/federation/note-delivery.ts` と `deliver-recipients.ts`。投稿の後続処理の 3 つ目の仕事として HTTP 子で動く。ローカルの作者で localOnly でない投稿だけを配送する。followers・direct の規則は上の DeliverManager のとおりで、inbox のないフォロワーも本家と同じく飛ばす。
- **投入**: `src/platform/job-queue/deliver.ts`。job 名・`data`・`attempts`（`deliverJobMaxAttempts ?? 12`）・backoff・履歴は本家と同じ（[投稿の最小契約](posting-contract.md#通常ジョブ162)）。
- **処理**: worker 子が投票終了と同じ子で deliver の Worker も動かす。`src/modules/federation/deliver-job.ts` が本家 `DeliverProcessorService` の順にスキップ判定・送信・instance の更新を行い、結果の写像（`UnrecoverableError`・再試行）は platform が持つ。
- **インスタンス台帳**: [連合の共通土台](federation-base-contract.md)の段階 3（`src/platform/instance-ledger.ts`、`src/modules/federation/instance.ts`）。
- **通常起動への接続**: 鍵（`createFederationKeys`）・外向き HTTP（`createOutboundHttpClient`）・署名付き送信（`createApRequest`）・Meta の連合設定は worker 子の配送ジョブから使う。HTTP 子は表現・宛先の読み取りと deliver queue への投入だけを持つ。
- **設定**: `deliverJobPerSec`・`deliverJobMaxAttempts` を本家と同じ名前・既定値で読む。キーの互換の照合は #138。

本家と異なる点（理由は比較資料の「意図的な差異」）:

- 表現の失敗（specified の pure Renote・MFM の ruby の例外）は、何も配送しない結果は同じで、投稿の後続処理の失敗として記録する。本家は待たない Promise で捨てる。
- 後続処理の前に消えた投稿は配送しない。Renote 先がリモートで、表現の前に消えた pure Renote も配送しない。本家は作成時のメモリ上の値から配送する。
- shared inbox の 410 では、不通の記録と `goneSuspended` を順に書く。同じ host の初回登録が重なっても失敗しない。本家は並行に書き、未登録の host では競合で片方を失う。
- 配送ジョブは Meta をジョブごとに DB から読む。本家は更新の通知で保つメモリ上の値を使う（プロセス間の通知は #217）。

残るもの:

- relay 登録・受信・actor・一般の remote context 取得は #195。既存 accepted relay への作成配送は第2sliceで実装（下記）。
- 配送の成功・失敗によるチャートの更新は #200。成功時の `fetchInstanceMetadata` は連合の共通土台の段階 5（#216 の `getHtml` と一緒に）。
- Delete・Undoの表現と削除配送は#172の最初のsliceで接続（下記）。stream等との縦断確認は#176。
- note-authors による instance 表の直接読みを `fetchInstance` へ置き換えることと、`packInstanceState` は最初の利用者の PR へ回した。


## #171 第2slice: 既存 accepted relay

public 作成の呼び出し側だけで relay を選び、共有 sender 自体は公開範囲を制限しない。表現・direct 作者の読み取りが成功した後、relay を開始してから followers/direct を開始する。双方と全 relay 投入を独立に開始し、全結果を待って既存 `note-post-save.failed` へ返す。一件の失敗は元の例外、複数は `AggregateError`。本家は relay / add を待たず、同期 throw で以降の relay を省く点が異なる。この差異は失敗観測と既存 drain のためで、再投入・永続依頼・強い保証を追加しない。

`MiRelay.findBy({ status: 'accepted' })` は順序指定なし。プロセス内10分 cache は空配列も保存し、600000ms は有効、600001ms で再取得。取得成功後に時刻を記録し、失敗は cache せず、同時 miss はまとめない。登録の変更通知や無効化は追加しない。

別の deep copy に falsy `to` のみ Public を補い（`[]` を維持）、作者鍵で一回署名する。relay システムアカウントは使わない。relay は個別 `Queue.add`、`isSharedInbox: false` で、ordinary と URL が同じでも別 job。本文と digest は投入時に固定され、通常の12試行・backoff・保持を維持する。HTTP 成功条件は保存のまま、既存の post-save drain → queue close → 接続解放を維持する。PKCS#1 鍵の DB 書き換えは既存の best effort のまま drain 保証外。

署名は固定本家の3 contextだけを同梱し、未知 URL を network 取得せず拒否する。jsonld 9 の既定 RDFC-1.0 / safe mode を維持。options / document の N-Quads SHA256 hex を結合した128文字を UTF-8 として RSA/SHA256 署名する。固定本家 probe の4 crypto vector と独立検証、43 relay 活動の単体テストが成功。C9全9配送・実queueのretry/410・cache・relay SELECTロック中の停止は、PR #227のcontroller最終検証で結合150件/process3件が成功した。過去workerのlocalhost EPERMは最終状態ではない。実測一覧は[実装計画](../superpowers/plans/2026-11-06-ap-relay-171.md)。

## #172: Delete/Undoの配送

削除前に対象Noteの列・元Renoteの存在/URI・作者を読み、local作者かつ `!localOnly` のとき表現を1回生成する。DeleteはランダムUUID、UndoはローカルAnnounce IDなら `/undo`、本家のホスト判定でローカルでなければUUIDを使う。外側の `to/cc` は省略し、relayのコピーだけにPublicを補完して作者鍵で署名する。moderatorの削除でも鍵は投稿作者。

本家と同じくfollowers、relay、concerned directを別枝にする。public以外のDeleteもfollowers/relayへ送る。directは保存済みremote mention URI、Renote作者と、削除投稿へのremote返信/Renote作者。direct内はinboxで重複排除するが、followersのsharedInboxとの横断排除はしない。channelもlocalOnlyの値で判断し、remote作者の削除は配送しない。

pure RenoteはCW・返信・添付・投票の有無も判定し、元投稿ありはUndo、消失はDelete。specifiedのpure Renoteで元投稿ありは本家renderer同様に例外となり、ローカル削除に進まない。配送開始はDELETEより前で、DB削除が失敗しても既に始まった配送を取消しない。監査はDELETE成功後に開始し、双方とも既存終了期限まで追跡する。C10/F8・原文HTTP/Digest/LD署名・停止drainと固定本家failure probeの範囲は[実装計画](../superpowers/plans/2026-11-07-note-delete-172.md)に記録する。
