# SQL補助・共有宣言の利用者対応（#391）

[#178](https://github.com/tiramiss-community/tiramiss/issues/178) の有限な宣言監査。対象は対応表の `responsibility:misc-utils:28` / `responsibility:misc-utils:39`。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`、新実装の調査基点は `6af8cd5baab289e684266cde7c3955129320c8c3`（2026-11-18）。[GOALS](../../../backend-next/GOALS.md) と [BACKLOG](../../../backend-next/BACKLOG.md) の初期範囲を維持する。

[機械対応表](shared-contract-audit.json) に全18宣言、宣言位置・4入力ファイルのSHA-256、固定本家 `packages/backend/src/` 内の全単語参照（ファイル・行・原文。宣言行以外の同一ファイル内参照は `internalReferences`）、参照先ごとの担当、既存実装/fixtureと残比較を保存した。各 `ownerIssues` は GitHub の Issue 番号。元対応表の2行と監査A/B・runtime statusは履歴として保持し、この資料を現在の宣言別対応として重ねる。宣言の対応確定は各利用機能の実装完了を意味しない。#178・#177・#194・#199および全体#114は未完了。

## 宣言と残る比較

以下の `src/` は新実装 `packages/backend-next/` からの相対パス。全実参照の行番号はJSONにある。単語検索はimport・型使用・コメントも保存するので、これらを実呼出しと数えない。

| 宣言 | 固定本家の利用者 | 新実装と既存fixtureの確認範囲 | 残る比較と担当 |
| --- | --- | --- | --- |
| `safeForSql` | `hashtags/users`、`notes/search-by-tag` | 同名helper・検索API未移植 | 正規化後の拒否、単一tag/AND/OR配列、既定値・pagingを #499 / #497 |
| `sqlLikeEscape` | 下表の13ファイル（うち1ファイルはコメントのみ） | 同名helperなし。既存emoji読取等だけで本家の全検索を充足しない | 検索語の変換・case・LIKE/ILIKE・word分割・AND/ORを下表の利用者で比較 |
| `sqlStringEscape` | `core/chart/core.ts:506,507` | chart保存未移植 | SQL文字列/配列リテラルとhour/day保存を #273、その後の各chart系列で比較 |
| `notificationTypes` | UserProfile設定、通知schema、通知2 reader、同ファイル内grouped定義 | `src/modules/notification/model.ts` は note/reply/mention/quote/renote/pollEnded の6種。`test/integration/note-notifications.test.ts` 等に投稿条件/保存の既存比較 | 全20種の値域・設定とpayloadは #177 / #298、読取 #373、producer群 #436 / #437 / #441 |
| `groupedNotificationTypes` | NotificationService、NotificationEntityService、grouped reader | 上記投稿6種。grouped readerは未移植 | 元20種＋`reaction:grouped` / `renote:grouped`、group化条件とpayloadは #177 / #298 / #373 |
| `obsoleteNotificationTypes` | 通知2 reader。NotificationService/UserProfileにも未使用import | 旧2種のreader/移行は未移植 | `pollVote` / `groupInvited` の入力受理と除外を #373、移行 #442、型 #298 |
| `noteVisibilities` | Note / NoteDraft / Poll | `src/modules/note/create-contract.ts` / `create-input.ts` の4値。`test/integration/note-create.test.ts` に指定先・followers・Pollの補正後home保存等 | Note保存/閲覧の既存比較を継承。draft API/保存 #438 / #485 と投稿 #183 |
| `noteReactionAcceptances` | Note / NoteDraft | 作成入力/型に全5値。既存note-create fixtureにはnull / likeOnly等 | 全受付policy・remote条件は #184 / #306。draft保存 #438。入力enumの存在を全挙動比較に読み替えない |
| `mutedNoteReasons` | 宣言外参照0件 | 新helper不要 | word/manual/spam/otherが実保存/判定に必要ならmute機能 #182 / #417 と同時に扱う |
| `followingVisibilities` | UserProfileのenum/型 | `src/platform/database/local-follow-collections.ts` と `test/integration/local-follow-collections-http.test.ts` の方向別閲覧/現在設定反映 | public/followers/private の設定更新 #408、関係読取 #296、共通/本人詳細 #297 / #338 |
| `followersVisibilities` | UserProfileのenum/型 | 同上。別の設定列/方向として扱う | followingと独立した保存/自己・他者/認可を同じ担当で比較 |
| `userExportableEntities` | Notification型と通知schema。実producerは列挙値のliteralを使う | export job/通知は未移植 | 全9値を下表の #199 各jobと #177 / #441 のexportCompleted比較へ接続 |
| `userImportableEntities` | 宣言外参照0件。実import processorを下表へ対応 | 未使用helper不要。import jobは未移植 | 全6値を #199 各jobへ。固定本家にimportCompleted通知はなく、新要件にしない |
| `moderationLogTypes` | ModerationLogServiceの型制約 | `src/modules/audit/public.ts` は9種。role/note-delete/queue-admin/instance-adminの既存結合fixtureを参照 | 55種/57実producerをJSONへ全件対応。種別と実producerの比較を #194 と下表の機能担当が所有 |
| `ModerationLogPayloads` | ModerationLogServiceのinfo型 | `test/integration/moderation-log.test.ts` にinfo省略/JSON化/transaction/失敗伝播の検証 | 55 keyと種別の一致を静的確認。before/after・識別子・保存/失敗境界は各producerで比較 |
| `Serialized<T>` | CustomEmojiService、GlobalEventService、ReversiService、SystemWebhook。SystemAccountは未使用import | actor emoji cache / streamの既存wire表現とfixtureを継承 | Date/null/undefinedを各利用者で比較。#217、emoji #304 / #519、Reversi #474、systemWebhook #198。SystemAccount #215へ新汎用型を先行追加しない |
| `FilterUnionByProperty` | NotificationService、NotificationEntityService、通知2 reader | 投稿6種の限定union型 | compile-time選別に加えvariantごとのpayload/読取を #177 / #298 / #373 |
| `Awaitable<T>` | `server/api/stream/channel.ts` の `init` 返却型 | stream接続と既存receiver fixture | 同期/非同期/false返却による購読拒否をconnection protocol #189 / #432 |

## SQL利用者の担当

`safeForSql` は空文字と `_` を許し、NUL/BS/TAB/SUB/LF/CR/両quote/backslash/`%` を拒否する。`sqlLikeEscape` はbackslash/`%`/`_`をescapeする。`sqlStringEscape` は単引用符を二重化して引用し、`standard_conforming_strings` を前提にする。各helperの契約を混同せず、利用者の正規化・SQL構造・結果まで比較する。

| helper | 固定本家の呼出元（`packages/backend/src/`から） | 担当単位 |
| --- | --- | --- |
| safeForSql | `server/api/endpoints/hashtags/users.ts` | user検索 #499 |
| safeForSql | `server/api/endpoints/notes/search-by-tag.ts` | SQL note検索 #497 |
| sqlLikeEscape | `core/FlashService.ts` | **191-flash-lists #424**（title/summary、単一/複数語の検索） |
| sqlLikeEscape | `core/ChatService.ts` | chat #190 |
| sqlLikeEscape | `core/SearchService.ts` | SQL note検索 #497 |
| sqlLikeEscape | `core/UserSearchService.ts` | user検索 #499 |
| sqlLikeEscape | `core/CustomEmojiService.ts` | 管理emoji読取 #537 / 編集 #519、公開読取の既存 #304と境界照合 |
| sqlLikeEscape | `server/api/endpoints/admin/emoji/list-remote.ts` | 管理emoji読取 #537 |
| sqlLikeEscape | `server/api/endpoints/admin/emoji/list.ts` | importとSQLの2行ともコメント。実呼出し0件、読取 #537の境界で保持 |
| sqlLikeEscape | `server/api/endpoints/admin/show-moderation-logs.ts` | 監査読取 #532 |
| sqlLikeEscape | `server/api/endpoints/admin/show-users.ts` | 管理user読取 #534 |
| sqlLikeEscape | `server/api/endpoints/channels/search.ts` | channel catalog #505 |
| sqlLikeEscape | `server/api/endpoints/clips/notes.ts` | clip読取 #501 |
| sqlLikeEscape | `server/api/endpoints/federation/instances.ts` | instance読取 #361（#297 / #338の先行条件を維持） |
| sqlLikeEscape | `server/api/endpoints/hashtags/search.ts` | hashtag catalog #495 |
| sqlStringEscape | `core/chart/core.ts` | chart保存方式 #273、実利用は後続各系列の保存比較と同時に実装 |

未使用の汎用helperを新設してこの監査を閉じない。FlashのLIKE escapeもFlash検索と同じ利用者単位に含める。

## 監査種別と実producer

JSONの `moderationProducers` は全55種・57箇所を1件ずつ記録し、各producerに共通監査 #194 と機能担当を付けた。`ModerationLogPayloads` の55 keyも同じ集合である。以下は閲覧用の集約で、具体パス/行/複数producerはJSONを参照する。

| 実producer群 | 種別 | 実装・比較の担当 |
| --- | --- | --- |
| admin/update-meta、roles/update-default-policies、update-proxy-account | updateServerSettings（2箇所）、updateProxyAccountDescription | #448 / #415、監査 #551 / #547 |
| UserSuspendService、admin/update-user-note、reset-password、unset-mfa、DeleteAccountService、invite/create | suspend/unsuspend、updateUserNote、resetPassword、unsetMfa、deleteAccount、createInvitation | #535 / #370 / #394 / #341 / #543、監査 #548 |
| CustomEmojiService、DriveService、AvatarDecorationService、unset-user-avatar/banner | add/update/deleteCustomEmoji（deleteは2箇所）、deleteDriveFile、mark/unmarkSensitiveDriveFile、create/update/deleteAvatarDecoration、unsetUserAvatar/Banner | #519 / #188 / #541 / #370、監査 #549 |
| RoleService | assign/unassignRole、create/update/deleteRole | #313 / #414、監査 #547 |
| admin/queue | clear/promote/pause/resumeQueue | #163、監査 #551。現行4種の実装/比較を継承 |
| NoteDeleteService、AnnouncementService、admin/ad、PageService、flash/delete、gallery/posts/delete、ChatService | deleteNote、create/update/deleteGlobalAnnouncement、create/update/deleteUserAnnouncement、create/update/deleteAd、deletePage/Flash/GalleryPost/ChatRoom | #172 / #451 / #540 / #340 / #423 / #425 / #190、監査 #550 |
| admin/federation/update-instance | suspend/unsuspendRemoteInstance、updateRemoteInstanceNote | #362、監査 #551。現行3種の実装/比較を継承 |
| AbuseReportService | resolve/forwardAbuseReport、updateAbuseReportNote | #447 / #536、監査 #548 |
| SystemWebhookService、AbuseReportNotificationService | create/update/deleteSystemWebhook、create/update/deleteAbuseReportNotificationRecipient | #350 / #352、監査 #551 |

現行unionの9種は `updateRole` / `deleteNote` / queue4種 / instance3種。監査読取 #532、既存経路比較 #546 と監査payload比較 #547–#551の残範囲を保持する。追加種別は必ずそのproducerと同時に実装する。

## export/import値とjob

各値の本家processorパス、exportCompleted生成行はJSONにある。両集合が一致するとは扱わない。exportのclip/favorite/noteには対応するimport値がない。

| 値 | export processor / 担当（#199配下） | import processor / 担当（#199配下） |
| --- | --- | --- |
| antenna | ExportAntennas / #516 | ImportAntennas / #524 |
| blocking | ExportBlocking / #440 | ImportBlocking / #521 |
| clip | ExportClips / #517 | 対象外（import値にない） |
| customEmoji | ExportCustomEmojis / #518 | ImportCustomEmojis / #520 |
| favorite | ExportFavorites / #517 | 対象外（import値にない） |
| following | ExportFollowing / #440 | ImportFollowing / #521 |
| muting | ExportMuting / #440 | ImportMuting / #522 |
| note | ExportNotes / #517 | 対象外（import値にない） |
| userList | ExportUserLists / #516 | ImportUserLists / #523 |

exportCompletedの通知種別/`exportedEntity`/`fileId`と保存・公開は #177 / #441 が各export producerと比較する。各jobの入力、保存/通知開始順、部分失敗・通常retryは各 #199 子の責任で、共有定数監査から免除しない。

## 再検証と証明範囲

```sh
node docs/superpowers/compatibility/api-common/check-shared-contract-audit.mjs
node scripts/check-shipping.mjs --base 6af8cd5baab289e684266cde7c3955129320c8c3
```

最初のコマンドは4固定sourceのhash、全export宣言、全単語参照、定数値域、全監査種別/payload key/実producer、export/import値とprocessor・export通知生成行、担当欄、API参照元と全export/import processorのbacklog担当一致、既存実装/fixtureパスの固定Git木での存在を確認する。辞書・コメントを含む固定sourceの限定した字句走査であり、任意TypeScriptの意味解析器ではない。新実装全srcで対象18名の単語検索も実施し、同名宣言はなく、監査型へのコメント参照だけであることを確認した。名称の一致だけで移植有無を判断せず、上表の型/実装と既存fixtureのassertionを照合した。

これは静的な所在・担当・比較残件の監査であり、既存fixtureを今回再実行した結果や、新旧API/DB/workerの新たな実行比較を主張しない。過去のsource観測、PG通知保存の承認、G1–G8、`notes/create:partial` / `postingComplete:false` を維持する。未実装と未比較は各行の `remainingComparison` に残し、今回の有限監査だけを #391 の完了対象とする。
