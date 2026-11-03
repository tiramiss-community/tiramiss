# ノート作成の AP 配送の本家比較資料

対象は [#171](https://github.com/tiramiss-community/tiramiss/issues/171) の最初の実装 PR。ノート作成から、Create/Announce の表現、宛先の選定、deliver queue への投入、配送ジョブの処理までを比べる。relay への配送と JSON-LD 署名は #171 の 2 番目の PR で比べる（2026-11-03 のユーザー決定）。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。

対象の本家コードは次のとおり。パスは `packages/backend/` から。

- 配送の分岐: `NoteCreateService.postNoteCreated` の AP 配送の区画（`src/core/NoteCreateService.ts:889-923`）と `renderNoteOrRenoteActivity`（:1022-1030）、pure Renote の判定 `isRenote`・`isQuote`（:950-965）
- 表現: `ApRendererService` の `renderNote`（`src/core/activitypub/ApRendererService.ts:357-495`）、`renderCreate`・`renderAnnounce`・`renderDocument`・`renderEmoji`・`renderHashtag`・`renderMention`・`addContext`
- 本文の HTML: `ApMfmService.getNoteHtml`（`src/core/activitypub/ApMfmService.ts:27-44`）と `MfmService.toHtml`（`src/core/MfmService.ts:273-437`）
- 宛先: `ApDeliverManagerService` の `DeliverManager.execute`（`src/core/activitypub/ApDeliverManagerService.ts:106-148`）
- 投入: `QueueService.deliver`・`deliverMany`（`src/core/QueueService.ts:148-225`）、queue の名前・prefix（`src/queue/const.ts`）
- Worker: `QueueProcessorService` の deliver Worker と `httpRelatedBackoff`（`src/queue/QueueProcessorService.ts:54-62, 265-301`）、`runQueueJob`（`src/queue/queue-job-runner.ts`）
- 処理: `DeliverProcessorService.process`（`src/queue/processors/DeliverProcessorService.ts:52-163`）と `FederatedInstanceService`（`src/core/FederatedInstanceService.ts`）

## 資料

| ファイル | 用途 |
| --- | --- |
| `mfm-html-cases.json` | 本文の MFM を `getNoteHtml` に通した HTML と `noMisskeyContent`。`toHtml` のすべての handler を通す |
| `render-cases.json` | 保存済みの投稿と関連の行を与えて `postNoteCreated` の配送の区画を動かした結果。activity の JSON 文字列、宛先と job、relay を呼んだか、待たれない失敗 |
| `recipient-cases.json` | `DeliverManager` に recipe と following の行を与えた結果。`deliverMany` へ渡る宛先の Map（順序つき）か例外 |
| `job-cases.json` | `deliverMany`・`deliver` の投入（名前・内容・設定）、queue の prefix、Worker の設定、失敗の記録、`httpRelatedBackoff` の表、BullMQ の再試行の判定 |
| `processor-cases.json` | `DeliverProcessorService.process` に配送先・送信の結果・meta・instance の行を与えた結果。戻り値か例外、instance の読み書き、Redis のキャッシュ、範囲外の呼び出し |
| `reference-ap-deliver.unit.ts` | 上の 5 つの JSON の `inputs` を本家に通し、`cases` と照合する probe |

各 JSON は `inputs`（入力表）と `cases`（本家の結果）を持つ。新実装のテストは `cases` を読み込み、値を手で複製しない。

## JSON の形

### `mfm-html-cases.json`

- `inputs.selfUrl`: 設定の `url`。hashtag と未知のメンションのリンクに使う。
- `inputs.mentionedRemoteUsers`: 投稿の `mentionedRemoteUsers` 列（JSON にする前の配列）。case に同名のキーがなければこれを使う。
- `inputs.cases[]`: `{ id, text, mentionedRemoteUsers?, extraHtml? }`。`text` は投稿の `text` 列（`null` を含む）。`extraHtml` がなければ `null`。
- `cases[]`: `{ id, nodeTypes, content, noMisskeyContent }` か、例外を投げた場合の `{ id, nodeTypes, error: { name, message } }`。`nodeTypes` は mfm-js 0.27.0 の解析結果に現れたノードの種類（入れ子を含む）。probe は全 case で 20 種類の handler をすべて通したことを確かめる。

### `render-cases.json`

- `inputs.selfUrl`・`inputs.now`: 設定の `url` と固定する時刻（投票の締切と絵文字の `updated` に効く）。ID の方式は `aidx`。
- `inputs.users[]`: 利用者の行（`id`・`username`・`host`・`uri`・`inbox`・`sharedInbox`）と、プロフィールの `url`（`profileUrl`）。
- `inputs.notes[]`: 返信先・Renote 先になる投稿の行。`inputs.files[]`・`inputs.polls`（投稿 ID ごと）・`inputs.emojis[]`（ローカルの絵文字）も行の形で持つ。
- `inputs.cases[]`: `{ id, note, followers, deletedBeforeRender, author }`。
  - `note`: 作成して保存した投稿の列。`mentionedRemoteUsers` は本家の `insertNote` と同じ組み立て（リモートの利用者を `mentions` の順に `{ uri, url, username, host }`）で作った文字列。
  - `followers`: 作者をフォローするリモートの利用者。following の行の `followerSharedInbox`・`followerInbox` は利用者の `sharedInbox`・`inbox` と同じにする。
  - `deletedBeforeRender`: 作成後、表現の前に消えた投稿。本家の入力 `data` には残り、表現の再読み込みでは見つからない。本家は migration `1753868431598-remove_note_constraints` で `note.replyId`・`note.renoteId` の外部キーを外したため、返信先・Renote 先だけが消えて投稿が残ることは実 DB でも起きる。作者の行（`note.userId`）は今も cascade で消えるため、`reply-author-missing` は実 DB では作れない。
  - `author`: 投稿の作者。
- `cases[]`: `{ id, reachedDeliver, activity, relay, directUserLookups, followingsQueries, addBulk, unhandledRejections }`。
  - `reachedDeliver`: activity を作り、宛先の選定に入ったか。
  - `activity`: `deliverMany` へ渡した activity の `JSON.stringify`。キーの順を含めて比べるため文字列のまま持つ。各 job の `content` はこれと同じ文字列（probe が確かめる）。
  - `relay`: `RelayService.deliverToRelays` を呼んだか。relay の中身は 2 番目の PR で比べる。
  - `directUserLookups`: 返信先・Renote 先の作者を direct へ足すために読み直した利用者 ID。
  - `followingsQueries`: followers の問い合わせ（TypeORM の演算子は `{ operator, value }` に直した）。
  - `addBulk`: `{ digest, jobs: [{ name, to, isSharedInbox }] }`。`null` は `addBulk` を呼ばなかった。
  - `unhandledRejections`: 待たれずに失敗した処理の例外のメッセージ。

本家の入力 `data` は、保存済みの列から組み立てる（`reply`・`renote` は `inputs.notes` の行、`files` は `fileIds`、`poll` は `hasPoll` と `inputs.polls`）。本家の `insertNote` は `text` を正規化した後の値、`cw`、`fileIds`、`hasPoll`、`replyId`、`renoteId` をそのまま保存するため、pure Renote の判定は保存済みの列でも同じ結果になる。

### `recipient-cases.json`

- `inputs.actorId`・`inputs.activity`: 配送する利用者と activity。
- `inputs.cases[]`: `{ id, recipes, followings, activity?, actorHost? }`。`recipes` は追加の順の `{ type: 'Followers' }` か `{ type: 'Direct', to: { inbox, sharedInbox } }`。`followings` は問い合わせが返す行の順。`activity: null` は activity なし、`actorHost` はリモートの actor。
- `cases[]`: `{ id, error?, followingsQueries, deliverMany }`。`deliverMany` は `{ user, activity, inboxes: [[to, isSharedInbox], ...] }`（Map の反復順）か、呼ばなかった場合の `null`。

### `job-cases.json`

- `inputs.inboxes`: `deliverMany` へ渡す Map の中身。`inputs.deliver[]`: `deliver` の引数。`inputs.configs[]`: `deliverJobConcurrency`・`deliverJobPerSec`・`deliverJobMaxAttempts` の組み合わせ。
- `cases.enqueue[]`: 設定ごとの投入。`deliverMany`（`addBulk` の引数）、空の Map、activity が `null` の場合、`deliver`（`add` の引数）。
- `cases.queues[]`: `baseQueueOptions` の結果と、接続に残る `keyPrefix`。
- `cases.workerOptions[]`: 設定ごとの deliver Worker の設定。`settings.backoffStrategy` は関数なので型だけを記録した。
- `cases.worker`: 登録したイベントの受け手、失敗した試行のログ・telemetry・元の例外を投げ直したか、各受け手のログ。
- `cases.workerNames`: 本家が作る Worker の一覧。
- `cases.backoff[]`: `Math.random` を固定したときの `httpRelatedBackoff(attemptsMade)` の値（ミリ秒）。
- `cases.retry[]`: BullMQ 6.3.11 の `Job.shouldRetryJob` に deliver Worker の設定を渡した結果。`attempts` と例外の種類ごとに、失敗した試行の `attemptsMade` と、再試行するか・待ち時間。

### `processor-cases.json`

- `inputs.now`・`inputs.selfHost`・`inputs.job`・`inputs.meta`: 固定時刻、自ホスト、ジョブの `user`・`content`・`digest`、meta の既定値。
- `inputs.cases[]`: `{ id, meta, instances, suspendedHostsCache?, steps }`。`instances` は instance 表の行。`suspendedHostsCache` は処理の前に停止ホストのキャッシュを埋めておく値。`steps` は同じ processor に順に通すジョブで、`{ to, isSharedInbox, failure, advanceMs? }`。`failure` は `delivery-cases.json`（[ap-request](../ap-request/README.md)）と同じ形。
- `cases[]`: `{ id, steps, instances }`。`instances` は全ジョブの後の instance 表。各 step は次を持つ。
  - `returned`（戻り値）か `thrown: { name, message, unrecoverable, original }`。
  - `signedPosts`: 送信の引数。`instanceServiceCalls`: `FederatedInstanceService` の `fetch`・`fetchOrRegister`・`update` の呼び出し。`db`: instance 表への読み書き。`redisSets`: Redis への `SET`。
  - `outOfScope`: チャートと `fetchInstanceMetadata` の呼び出し。この PR では移植しない（下記）。
  - `unhandledRejections`: 待たれずに失敗した更新の例外。

instance 表の stub は PostgreSQL と同じく `host` の一意制約を持ち、同じ host の 2 件目の INSERT を失敗させる。Redis の stub は `EX` を固定時刻で扱う。

## 観測した本家の挙動

コードを読むだけでは分かりにくかったもの。

### 本文の HTML

- 全体を `<p>` で包まない。`extraHtml` は末尾にそのまま足す。`extraHtml` が空文字列でも `null` ではないので `noMisskeyContent` は `false` になる。
- 改行を含む text は、行の間へ `'br'` を挟んでから `'br'` と等しい要素をすべて `<br />` にする。このため、ちょうど `br` の行も改行になる（`a\nbr\nb` → `a<br /><br /><br />b`）。改行のない `br` だけの本文や、`BR`・` br` の行はそのまま残る。
- `noMisskeyContent` は、最上位のノードがすべて `text`・`unicodeEmoji`・`emojiCode`・`mention`・`hashtag`・`url` のときだけ `true`。空の本文も `true`。
- `$[ruby 漢字]`（空白のない 1 語）と `$[ruby **a**]`（子が文字列でない 1 つ）は `TypeError` を投げる。表現全体が失敗し、その投稿は配送されない（`render-cases.json` の `mfm-ruby-crash`。relay も呼ばない）。
- `$[unixtime]` は、数字でない・範囲外なら `<i>` で包むだけ。子が文字列でなければ子を `<i>` で包む。
- link の URL を解釈できない（ポート 99999 など）と `[子](URL)` の文字列に戻す。IDN の URL は mfm-js が link と解釈しない。url ノードの `href` は WHATWG URL で正規化する（ホストの小文字化、既定ポートの除去）が、表示は元の文字列のまま。
- メンションは `mentionedRemoteUsers` と username・host を大小文字を無視して比べ、最初に一致した利用者の `url`、なければ `uri` を使う。`url` を解釈できなければリンクにせず acct の文字列だけを出す。一致しなければ `${url}/@user@host`（大小文字は元のまま）。自ホスト付きのローカルのメンション（`@alice@local.example`）も切り詰めない。
- 本文の hashtag は元の表記（大小文字そのまま）でリンクを作る。`tag` の Hashtag は保存済みの正規化した値を使う。

### 表現

- キーの順は `id, type, attributedTo, summary, content, _misskey_content, source, _misskey_quote, quoteUrl, published, to, cc, inReplyTo, attachment, sensitive, tag` で、投票があれば `type` を `Question` に置き換え、末尾に `endTime`（または `closed`）と `oneOf`（または `anyOf`）を足す。Create は `@context, id, actor, type, published, object, to, cc`、Announce は `@context, id, actor, type, published, to, cc, object`。
- `inReplyTo` は、返信でなければ `null`。返信先が表現の時点で見つからない・作者の行がない場合はキーごと出さない。
- 引用先が表現の時点で見つからないと、引用の項目（`_misskey_quote`・`quoteUrl`・`quote-inline`）を出さない。Create のまま、普通の投稿と同じ本文になる。pure Renote は入力 `data` の Renote 先から URI を作るため、Renote 先が消えていても Announce になる。
- `cw` が空文字列なら `summary` は `U+200B`。`cw` があれば `sensitive` は `true`。
- 投票の締切がちょうど現在時刻なら `endTime`（`<` で比べる）。投票の行がなければ普通の Note になる。
- 添付は `fileIds` の順に並べ、見つからないファイルは除く。`name` は `null` でも出し、`width`・`height` は無ければ出さない。
- `tag` は hashtag → メンション → 絵文字の順。メンションは本家の問い合わせ（`findBy` + `In`）の返却順で、`mentions` の順ではない（`public-mentions-db-order`）。絵文字は投稿の `emojis` の順で、`localOnly` と見つからない名前を除く。`updatedAt` がなければ `updated` は表現した時刻になる。`publicUrl` が空文字列なら `originalUrl` を使い、`type` がなければ `image/png`。
- ローカルの利用者へのメンションは `tag` に入るが、`to`・`cc` には入らない。
- 公開範囲が specified の pure Renote は `renderAnnounce` が例外を投げ、何も配送しない（relay も呼ばない）。例外は待たれずに捨てられる。

### 宛先

- Map の順は followers（問い合わせの返却順、同じ URL は最初の位置のまま値だけ後勝ち）→ direct（メンションの順 → 返信先の作者 → Renote 先の作者）。
- 返信先・Renote 先の作者は、入力 `data` の `userHost` が `null` でないときだけ利用者を読み直して direct に足す。
- direct は、その利用者の `sharedInbox` が Map にあれば足さない。Map の値が個人の inbox でも同じ（`direct-shared-inbox-from-individual-follower`）。`inbox` が `null` なら黙って足さない。足すときは常に個人の inbox で `isSharedInbox: false`。follower の shared inbox と同じ URL なら値を `false` に上書きする。
- followers の行に `sharedInbox` も `inbox` もなければ `inbox is null` を投げ、1 件も投入しない。relay の呼び出しはその前に済んでいる（`public-follower-without-inbox`）。ただし、これは問い合わせを stub にした場合の結果。本家の問い合わせは主キーを選ばないため、TypeORM 1.1.1 は選んだ 2 列がともに `null` の行を返さない。実 DB ではそのフォロワーは黙って飛ばされ、他の宛先には届く（新実装も同じ問い合わせで、結合テストで確かめた）。
- 宛先が空でも `addBulk([])` を呼ぶ。specified は followers を問い合わせない。localOnly・channel・リモートの作者の投稿は配送の区画に入らない。

### 投入と Worker

- job 名は `to.replace('https://', '').replace('/inbox', '')`。最初の一致だけを置き換えるため、`http://` は残り、`/inboxes` は `es` が残り、`/inbox/inbox` は 1 つだけ消える。
- 本文と digest は `deliverMany` で 1 回だけ作り、全 job で同じ。`attempts` は `deliverJobMaxAttempts ?? 12`（0 はそのまま、`null` は 12）。`concurrency`・`limiter.max` も `?? 128`。
- Worker は `active`・`completed`・`error`・`stalled` の受け手を登録し、`failed` は登録しない。失敗した試行ごとに `failed(<name>: <message>) id=… attempts=… age=… to=…` を記録して元の例外を投げ直す。
- `attempts: 12` では 11 回まで再試行する。待ち時間（揺らぎの前）は 1, 3, 7, 15, 31, 63, 127, 255, 480, 480, 480 分。揺らぎは 0〜20% の加算で、上限の後にも乗る。`UnrecoverableError` と、名前が `UnrecoverableError` の例外は再試行しない。

### 配送の処理

- 判定の順は、連合の許可 → 停止中のホスト → instance の取得 → 停止中のソフトウェア → 送信。skip ではチャートも instance も更新しない。
- ポート付きの宛先は DB 用のホストが `''` になる。`blockedHosts` と `specified` の照合に一致せず、instance は host `''` の行として登録される。停止中の host `''` の行があれば、ポート付きの宛先はすべて skip になる。`${host} is gone` の `host` はポート付きのまま。
- 自ホストは `federation: 'none'` でも許可される。
- `enableStatsForFederatedInstances` が `false` なら送信前は `fetch` だけで、未登録の host は Redis に `null` を保存する。失敗時は設定に関係なく `fetchOrRegister` で行を作る。成功時の `isNotResponding` の解除は、行がある場合だけ。成功しても `suspensionState` は戻さない。
- 失敗時の更新: 応答ありの行は `isNotResponding: true` と時刻。応答なしで時刻がない行は時刻だけ。応答なしで `suspensionState` が `none` のまま 7 日（`<=`）経った行は `autoSuspendedForNotResponding`。7 日に 1 ms 足りなければ更新しない。
- shared inbox の 410 では、上の更新と `goneSuspended` が並行に走る。登録済みの行なら両方残る。未登録の host（統計が無効）では `fetchOrRegister` が 2 つ同時に INSERT し、片方が一意制約で失敗する。この probe の順では `goneSuspended` が失われ、例外は待たれずに捨てられる（`fail-410-shared-unknown-stats-off`）。
- 停止中のホストの一覧は 1 時間ちょうどまではキャッシュを使う。自分で書いた `goneSuspended` も、それまでは skip にならない（`sequence-gone-then-cached-suspended-list`）。
- instance のキャッシュは Redis の `kvcache:federatedInstance:<host>`（`EX 1800`、ioredis の `keyPrefix` の前）に行全体の JSON を、未登録なら `null` を保存する。

## probe の実行

probe は固定コミットの本家で実行する。本リポジトリの旧 backend・新 backend の製品コードに追加するテストではない。

1. 固定 SHA の worktree を作り、依存を用意する（`pnpm install --frozen-lockfile`）。ルートの `built/meta.json`（`{"version": ...}`）が必要。`QueueProcessorService` がすべての processor を読み込むため、`misskey-js`・`misskey-reversi`・`misskey-bubble-game` を先にビルドする。
2. `packages/backend/test/unit/<任意のディレクトリ>/` へ、本ディレクトリの JSON 5 つと `reference-ap-deliver.unit.ts`（`.test.ts` に改名）をコピーする。
3. `packages/backend` で、`.node-version` の Node を使って `vitest run --config vitest.config.ts <コピー先>` を実行する。単体用の設定は DB を前提とする global setup を持つため使わない。
4. 入力表を変えたときは、`AP_DELIVER_PROBE_WRITE=1` を付けて実行して `cases` を再生成し、JSON を本ディレクトリへ戻す。その後、環境変数なしで再実行して一致を確かめる。

probe は re2 を差し替える（federation-base と同じ理由）。`postNoteCreated` は配送に関係しない依存をすべて何もしない値にして動かし、表現・宛先・投入は本家の `ApRendererService`・`ApMfmService`・`MfmService`・`ApDeliverManagerService`・`QueueService.deliverMany` を通す。DB の読み取りは stub で、メンションの利用者は表の順で返す。`DeliverProcessorService` は本家の `FederatedInstanceService`・`UtilityService` とつなぎ、instance 表と Redis だけを stub にする。Worker は `bullmq` の `Worker` を記録用のクラスへ差し替え、Redis へ接続しない。時刻は `Date` だけを固定する。待たれない処理の例外を記録する間だけ、Vitest の `unhandledRejection` の受け手を外す。

2026-11-03 に Node.js `v26.4.0` で記録し、5 件（HTML 86 件・表現と宛先 63 件・宛先の Map 24 件・投入と Worker（設定 4 通り・queue 2 件・backoff 3 表・再試行 9 表）・処理 54 件 60 ジョブ）とも一致した。Node.js `v24.20.0` でも同じ結果になった。2026-11-04 に、ちょうど `br` の行の 4 件を HTML へ足して再記録した（HTML 90 件）。Node.js `v26.4.0`・`v24.20.0` とも 5 件一致した。

## 新実装への接続

新実装のテストは各 JSON の `cases` を読み込む。パスは `packages/backend-next/test/` から。

| 資料 | 新実装のテスト | 比べること |
| --- | --- | --- |
| `mfm-html-cases.json` | `unit/mfm/note-html.test.ts` | 全 90 件。MFM → HTML の純関数と `noMisskeyContent` の判定。`content` は byte 単位、例外は名前とメッセージ |
| `render-cases.json` | `unit/federation/note-activity.test.ts`・`unit/federation/note-delivery.test.ts`・`integration/note-activity.test.ts` | 全 63 件。保存済みの列と関連の行からの activity（文字列で一致。メンションの `tag` だけは集合で比べる）、宛先と job の順・digest・本文、配送しない場合。結合テストは行を PostgreSQL へ入れて読み取りから通す（`reply-author-missing` など実 DB で作れない行を除く） |
| `recipient-cases.json` | `unit/federation/deliver-recipients.test.ts` | 23 件。Map の順と値、問い合わせの回数、`inbox is null`。`remote-actor` は作者の判定で配送の区画に入らないため除く |
| `job-cases.json` | `unit/job-queue/deliver.test.ts`・`integration/deliver-queue.test.ts` | 全件。job 名・内容・設定、queue の prefix、Worker の設定、backoff の表、再試行の判定（BullMQ の `Job.shouldRetryJob` に通す）。結合テストは実 Redis の BullMQ で、backoff の後の再試行と 4xx の停止を確かめる |
| `processor-cases.json` | `integration/deliver-processor.test.ts`（純関数は `unit/federation/deliver-job.test.ts`） | 全 54 件・60 ジョブ。実 PostgreSQL・Redis の台帳で、戻り値か例外、送信、instance の読み書きと最終の行、Redis のキー・TTL・JSON。`fail-410-shared-unknown-stats-off` は下記の差異のとおり `goneSuspended` も残る |
| [note/observations.json](../note/observations.json) | `processes/note-deliver.test.ts` | ビルド後の HTTP 子・worker 子を通し、C9-home・C9-followers・C9-specified・C9-localOnly の全件と、C9-public・C9-pure・C9-quote の `/inbox/shared` 分。ID・ポート・時刻を置き換えて本文が一致し、署名を `crypto.verify` で、Digest を本文で確かめる。`/inbox/relay` 分は 2 番目の PR で比べる |

## 意図的な差異

2026-11-03 のユーザー決定と #171 の設計・実装で決めたもの。

- **relay と JSON-LD 署名**: 最初の PR では配送しない。移行データに accepted の relay があっても、public の投稿は relay へ届かない。2 番目の #171 PR までの一時的な差異。
- **成功時の `fetchInstanceMetadata`**: 呼ばない。連合の共通土台の段階 5（#216 の getHtml と一緒に）までの一時的な差異。
- **チャート**: `apRequestChart`・`federationChart`・`instanceChart` を更新しない。#200 が扱う。
- **メンションの `tag` の順**: 本家は問い合わせの返却順で決まらない。新実装は保存した `mentions` の順にし、比較は集合で行う。
- **ローカルの絵文字**: 本家は Redis（30 分）とメモリ（3 分）のキャッシュから引く。新実装は DB から直接読む。選ぶ規則（ローカル・`localOnly` でない・`updatedAt` がなければ表現の時刻）は同じで、鮮度だけが違う。時刻は明示的に渡す。
- **表現の失敗**: 本家は specified の pure Renote・MFM の ruby の例外を待たない Promise で捨てる。新実装も配送しない結果は同じにし、投稿の後続処理の失敗（`note-post-save.failed`）として記録する。プロセス外へ例外を出さない。
- **後続処理の前に消えた投稿**: 新実装は保存済みの投稿を読み直すため、後続処理の前に消えた投稿は配送しない。本家は作成時のメモリ上の値から配送する。消えた投稿の扱いは削除の配送（#172）に任せる。
- **表現の前に消えたリモートの Renote 先**: pure Renote の Renote 先がリモートで、表現の前に行が消えた場合は `renderAnnounce: renote target is gone` を投げ、配送しない（後続処理の失敗として記録する）。本家はメモリ上の URI で Announce を送る。ローカルの Renote 先は `${url}/notes/<id>` で作れるため、本家と同じ Announce になる（`renote-deleted-before-render`）。
- **shared inbox の 410**: 新実装は不通の記録の後に `goneSuspended` を書く。未登録の host でも両方が残る。本家は並行に書き、初回登録の競合で `goneSuspended` を失うことがある（`fail-410-shared-unknown-stats-off`）。
- **同じ host の初回登録**: 新実装は `INSERT … ON CONFLICT DO NOTHING` の後に読み直し、並行する配送ジョブの初回登録が重なっても失敗しない。本家は一意制約の違反でジョブが送信前に失敗する（再試行で回復する）。
- **Meta の読み取り**: 配送ジョブごとに DB から読む。本家は更新の通知で保つメモリ上の Meta を使う。プロセス間の通知（#217）がまだないためで、管理者の変更が本家より早く効くだけ。
- **待たない instance の更新**: 本家と同じくジョブの結果を待たせないが、停止時には完了を待つ。失敗は `deliver.instance-update-failed` に記録する。消えた行の更新は本家の TypeError ではなく `INSTANCE_NOT_FOUND` になる。
- **Worker のログ**: 本家の `active`・`completed`・`stalled` の記録（debug）は移植しない。失敗した試行ごとに `job.failed` を、`to` と停止の理由とともに記録して元の例外を投げ直す。
- **Redis の再接続**: deliver の queue と Worker も #162 と同じく再接続せず、稼働中の切断で全体を止める。

## 未検証・範囲外

- **2 番目の #171 PR へ**: relay の一覧（10 分のキャッシュ）、`to` の補完、`attachLdSignature`（`RsaSignature2017`）、relay ごとの `deliver`。`job-cases.json` の `deliver` は本家の形の記録だけ。
- **#172・#176 へ**: Delete・Undo の表現と削除の配送。
- **#195 へ**: 未登録のリモートユーザーの解決、受信による instance の更新と自動解除。
- **観測していない**: 実 DB での following・user の問い合わせの返却順（stub は表の順）、`driveFileEntityService.getPublicUrl` のリモート・メディアプロキシの分岐（ローカルの投稿者の添付だけを扱う）、本家の Worker の実 Redis での動作（記録用のクラスで観測した）、本家の `HttpRequestService` を通した実送信（[ap-request](../ap-request/README.md) で比較済み）、`fetchOrRegister` の競合で失われる更新がどちらになるか（実 DB では INSERT の確定順で決まる）、`isKeyWordIncluded` など投稿作成の補正（[note](../note/README.md) の C4 で扱う）。
