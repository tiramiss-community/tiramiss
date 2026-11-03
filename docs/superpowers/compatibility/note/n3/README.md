# 投稿の関連入力の本家実測（N3 / #170）

[#170](https://github.com/tiramiss-community/tiramiss/issues/170)（添付・投票・返信/Renote/引用・channel・指定宛先・MFM抽出）について、固定本家 **`8e07cf085adf7009583d234a208e30436f020e26`** の `notes/create` を実際に動かした追加の実測。N0（[../README.md](../README.md)）の `C3`/`C6`/`C7`/`C8` で測っていない挙動のうち、HTTP応答・保存列・countに関わるものを対象にした。設計判断は[投稿の最小契約「関連入力（#170）」](../../../../backend-next/posting-contract.md)に従う。

N0の `http-cases.json`・`observations.json`・`reference-note.e2e.ts` は変更していない。本資料は新実装の検証結果ではない。新実装のテストへ接続した時点で、下の「新実装への接続先」を埋める。

## ファイル

| ファイル | 内容 |
| --- | --- |
| [http-cases.json](http-cases.json) | 102件のHTTP入力。`id`・`group`・`actor`・`params` はN0と同じ形。`$name` は probe の初期データか先行ケースの論理ID。追加キーは `setup`（`sensitive`=sensitiveWords `['needle']`、`prohibited`=prohibitedWords `['forbidden']`。ケースの後で空に戻す）、`watch`（収束後に読むNote/channelのcount）、`exactExpiresAt`（期限を正規化せずに残す）、`allowServerError`（500を許すケース） |
| [observations.json](observations.json) | 上記102件の正規化済み実測。各ケースに `status`・`body`・`wwwAuthenticate`・`delta`（Note/Poll増分）・`saved`。`saved` はN0の項目に加えて `threadId`・`replyUserId`・`replyUserHost`・`renoteUserId`・`renoteUserHost`・`renoteChannelId`・`attachedFileTypes`・`mentionedRemoteUsers`（DBの文字列のまま）と、Pollの `noteVisibility`・`userId`・`userHost`・`channelId`。`watch` 付きは `counts`、`exactExpiresAt` 付きは `exactExpiresAt` を持つ |
| [reference-note-n3.e2e.ts](reference-note-n3.e2e.ts) | 本家テストサーバーへのprobe。N0と同じく別接続のDBで保存値を読み、JSONと照合する |
| [reference-note-n3.config.mjs](reference-note-n3.config.mjs) | 本家e2e設定の上書き（対象ファイルだけN0と違う）。globalSetupはN0の [reference-note.setup.ts](../reference-note.setup.ts) をそのまま使う |

## 初期データ

probe の `beforeAll` で作る。ユーザーはsignupで `probe_<name>`（root, alice, bob, carol, botter, blocker, blockee, suspended, limiter）。

- `botter` は `isBot=true`、`suspended` は `isSuspended=true`（どちらも最初の認証付きリクエストより前にDBで設定）。`limiter` には `mentionLimit=2`（priority 1）のRoleを割り当て、`i` の `policies.mentionLimit` が2になるまで待つ。
- 登録済みリモートユーザー `rwithurl@remote.example`（`user_profile.url` あり）と `rnourl@remote.example`（url null）。ホストはポートなし、`lastFetchedAt` は現在時刻。リモートノート `remoteNote`（`rwithurl` の public）。
- alice は bob をフォロー（DB）。`blocker` が alice をブロックし、alice が `blockee` をブロックする（`blocking/create`）。
- aliceのDriveFile `aliceImage`（image/png）・`aliceVideo`（video/mp4）はDBへ直接入れたfactsで、Drive uploadの実測ではない。
- channel（作成者bob）: `chClosed`（allowRenoteToExternal=false）、`chOpen`・`chArchived`・`chCount`（true）。`chArchived` は `chArchivedNote` を投稿した後でアーカイブする。
- Note: bobの public/home/followers/specified(alice宛)/localOnly、pure Renote `bobPure`、specified の pure Renote `bobPureSpecified`（宛先なし・localOnly）、aliceの followers/specified(bob宛)、bobだけをMFMでメンションしたcarol宛の specified `aliceSpecifiedMention`、各channelのノート、count観測用の `count*`。

## 正規化と収束待ち

N0と同じ規則（ID字段の論理名置換、日時字段の `$time`、設定originの `$origin`）に、`threadId`・`replyUserId`・`renoteUserId`・`renoteChannelId` をID字段として、`lastNotedAt` を日時字段として加えた。500の `error.info.e.id`（ApiCallServiceがリクエストごとに作るUUID）は形式をassertしてから `$uuid` にする。静的なエラーUUID・本文・null/省略・配列順は保持する。`exactExpiresAt` は応答とDBの値が入力の絶対時刻と一致することをassertし、ISO文字列のまま残す。

本家は保存後のcount加算を応答前に待たない。probeは成功した各作成の後に、(1) actorの `notesCount` がDBのNote件数に一致するまで待ち、(2) channel付きなら `lastNotedAt` が作成時刻以上になるまで待ち、(3) 返信先・Renote対象・channel・`watch` 対象のcountが500ms変化しなくなるまで待つ。次のケースはその後に送る。このため応答の入れ子の `repliesCount`/`renoteCount` は「今回の加算前の値」で決定的になり、`counts` は収束後の値になる。`counts` は有限時間の観測であり、加算が二度と起きないことの証明ではない。

## 入力と実測の一覧

**添付・投票**

| id | actor | 入力 | 結果 |
| --- | --- | --- | --- |
| `N3-FP-poll-no-text` | alice | {poll: {choices: [a, b]}} | 200 text=null poll(multiple=false, expiresAt=null) poll.noteVisibility=public |
| `N3-FP-whitespace-file` | alice | {text:    , fileIds: [$aliceImage]} | 200 text=null attachedFileTypes=[image/png] |
| `N3-FP-whitespace-poll` | alice | {text:  \n , poll: {choices: [a, b]}} | 200 text=null poll(multiple=false, expiresAt=null) poll.noteVisibility=public |
| `N3-FP-multiple` | alice | {text: multi, poll: {choices: [a, b, c], multiple: true}} | 200 poll(multiple=true, expiresAt=null) poll.noteVisibility=public |
| `N3-FP-future-absolute` | alice | {text: future, poll: {choices: [a, b], expiresAt: 4102444800000}} | 200 poll(multiple=false, expiresAt=あり) poll.noteVisibility=public |
| `N3-FP-expires-zero` | alice | {text: zero, poll: {choices: [a, b], expiresAt: 0}} | 200 poll(multiple=false, expiresAt=null) poll.noteVisibility=public |
| `N3-FP-prohibited-choice` | alice | {text: ok, poll: {choices: [has forbidden word, b]}} | 400 CONTAINS_PROHIBITED_WORDS |
| `N3-FP-missing-file-and-renote` | alice | {fileIds: [$missing], renoteId: $missing} | 400 NO_SUCH_FILE |
| `N3-FP-files-17` | alice | {text: x, fileIds: [a00000000000000000000000, a00000000000000000000001, a00000000000000... | 400 INVALID_PARAM #/properties/fileIds/maxItems |
| `N3-FP-files-duplicate` | alice | {text: x, fileIds: [$aliceImage, $aliceImage]} | 400 INVALID_PARAM #/properties/fileIds/uniqueItems |
| `N3-FP-media-empty` | alice | {text: x, mediaIds: []} | 400 INVALID_PARAM #/properties/mediaIds/minItems |
| `N3-FP-attached-types` | alice | {text: types, fileIds: [$aliceVideo, $aliceImage]} | 200 attachedFileTypes=[video/mp4, image/png] |
| `N3-FP-poll-sensitive-home` | alice | {text: needle poll, poll: {choices: [a, b]}} | 200 visibility=home poll(multiple=false, expiresAt=null) poll.noteVisibility=home |
| `N3-FP-poll-channel` | alice | {text: channel poll, channelId: $chOpen, poll: {choices: [a, b]}} | 200 localOnly channelId=$chOpen poll(multiple=false, expiresAt=null) poll.noteVisibility=public,channelId=$chOpen |
| `N3-FP-poll-specified` | alice | {text: specified poll, visibility: specified, visibleUserIds: [$bob], poll: {choices: [... | 200 visibility=specified visibleUserIds=[$bob] mentions=[$bob] poll(multiple=false, expiresAt=null) poll.noteVisibility=specified |
| `N3-FP-choices-11` | alice | {text: x, poll: {choices: [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10]}} | 400 INVALID_PARAM #/properties/poll/properties/choices/maxItems |
| `N3-FP-choice-empty` | alice | {text: x, poll: {choices: [, b]}} | 400 INVALID_PARAM #/properties/poll/properties/choices/items/minLength |
| `N3-FP-choice-51` | alice | {text: x, poll: {choices: [ccccccccccccccccccccccccccccccccccccccccccccccccccc, b]}} | 400 INVALID_PARAM #/properties/poll/properties/choices/items/maxLength |
| `N3-FP-expired-after-zero` | alice | {text: x, poll: {choices: [a, b], expiredAfter: 0}} | 400 INVALID_PARAM #/properties/poll/properties/expiredAfter/minimum |

**返信・Renote**

| id | actor | 入力 | 結果 |
| --- | --- | --- | --- |
| `N3-RR-renote-other-followers` | alice | {renoteId: $bobFollowers} | 400 CANNOT_RENOTE_DUE_TO_VISIBILITY |
| `N3-RR-renote-own-followers` | alice | {renoteId: $aliceFollowers} | 200 text=null visibility=followers |
| `N3-RR-renote-own-specified` | alice | {renoteId: $aliceSpecified} | 400 CANNOT_RENOTE_DUE_TO_VISIBILITY |
| `N3-RR-renote-blocked` | alice | {renoteId: $blockerNote} | 400 YOU_HAVE_BEEN_BLOCKED |
| `N3-RR-quote-blocked` | alice | {renoteId: $blockerNote, text: quote} | 400 YOU_HAVE_BEEN_BLOCKED |
| `N3-RR-reply-blocked` | alice | {replyId: $blockerNote, text: reply} | 400 YOU_HAVE_BEEN_BLOCKED |
| `N3-RR-renote-blocking` | alice | {renoteId: $blockeeNote} | 200 text=null |
| `N3-RR-reply-blocking` | alice | {replyId: $blockeeNote, text: reply} | 200 threadId=$blockeeNote mentions=[$blockee] |
| `N3-RR-reply-specified-public` | alice | {replyId: $bobSpecified, text: reply} | 400 CANNOT_REPLY_TO_SPECIFIED_VISIBILITY_NOTE_WITH_EXTENDED_VISIBILITY |
| `N3-RR-reply-specified` | alice | {replyId: $bobSpecified, text: reply, visibility: specified, visibleUserIds: [$carol]} | 200 visibility=specified threadId=$bobSpecified visibleUserIds=[$carol, $bob] mentions=[$bob, $carol] |
| `N3-RR-reply-own-specified` | alice | {replyId: $aliceSpecified, text: reply, visibility: specified} | 200 visibility=specified threadId=$aliceSpecified visibleUserIds=[$alice] |
| `N3-RR-reply-home` | alice | {replyId: $bobHome, text: reply} | 200 visibility=home threadId=$bobHome mentions=[$bob] |
| `N3-RR-reply-followers` | alice | {replyId: $bobFollowers, text: reply, visibility: home} | 200 visibility=followers threadId=$bobFollowers mentions=[$bob] |
| `N3-RR-renote-home` | alice | {renoteId: $bobHome} | 200 text=null visibility=home |
| `N3-RR-quote-home` | alice | {renoteId: $bobHome, text: quote} | 200 visibility=home |
| `N3-RR-reply-localonly` | alice | {replyId: $bobLocal, text: reply} | 200 localOnly threadId=$bobLocal mentions=[$bob] |
| `N3-RR-renote-localonly` | alice | {renoteId: $bobLocal} | 200 text=null localOnly |
| `N3-RR-reply-and-renote` | alice | {replyId: $bobPublic, renoteId: $bobOther} | 200 text=null threadId=$bobPublic mentions=[$bob] |
| `N3-RR-reply-and-renote-missing` | alice | {replyId: $missing, renoteId: $missing} | 400 NO_SUCH_RENOTE_TARGET |
| `N3-RR-renote-whitespace` | alice | {renoteId: $bobWhitespaceTarget, text:    } | 200 text=null |
| `N3-RR-quote-pure` | alice | {renoteId: $bobPure, text: quote} | 400 CANNOT_RENOTE_TO_A_PURE_RENOTE |
| `N3-RR-reply-invisible-pure` | alice | {replyId: $bobPureSpecified, text: reply} | 400 CANNOT_REPLY_TO_A_PURE_RENOTE |
| `N3-RR-bot-renote` | botter | {renoteId: $countBotRenote} | 200 text=null $countBotRenote: replies=0 renote=0 |
| `N3-RR-bot-reply` | botter | {replyId: $countBotReply, text: bot reply} | 200 threadId=$countBotReply mentions=[$bob] $countBotReply: replies=1 renote=0 |
| `N3-RR-self-reply` | alice | {replyId: $countSelfReply, text: self reply} | 200 threadId=$countSelfReply $countSelfReply: replies=1 renote=0 |
| `N3-RR-self-quote` | alice | {renoteId: $countSelfQuote, text: self quote} | 200 $countSelfQuote: replies=0 renote=0 |
| `N3-RR-other-quote` | alice | {renoteId: $countOtherQuote, text: other quote} | 200 $countOtherQuote: replies=0 renote=1 |
| `N3-RR-other-pure` | alice | {renoteId: $countOtherPure} | 200 text=null $countOtherPure: replies=0 renote=1 |
| `N3-RR-thread-first` | alice | {replyId: $bobThreadRoot, text: thread 1} | 200 threadId=$bobThreadRoot mentions=[$bob] |
| `N3-RR-thread-nested` | bob | {replyId: $N3-RR-thread-first, text: thread 2} | 200 threadId=$bobThreadRoot mentions=[$alice] |
| `N3-RR-reply-remote` | alice | {replyId: $remoteNote, text: reply remote} | 200 threadId=$remoteNote mentions=[$rwithurl] mentionedRemoteUsers保存 |
| `N3-RR-renote-remote` | alice | {renoteId: $remoteNote} | 200 text=null |
| `N3-RR-renote-null-no-text` | alice | {renoteId: null} | 400 INVALID_PARAM #/then/required |
| `N3-RR-renote-empty-text` | alice | {renoteId: $bobPublic, text: } | 400 INVALID_PARAM #/properties/text/minLength |
| `N3-RR-renote-duplicate` | alice | {renoteId: $bobWhitespaceTarget} | 200 text=null |
| `N3-RR-renote-quote` | alice | {renoteId: $N3-RR-other-quote} | 200 text=null |
| `N3-RR-reply-mentioned-only-specified` | bob | {replyId: $aliceSpecifiedMention, text: reply, visibility: specified} | 400 CANNOT_REPLY_TO_AN_INVISIBLE_NOTE |

**channel**

| id | actor | 入力 | 結果 |
| --- | --- | --- | --- |
| `N3-CH-missing` | alice | {text: x, channelId: $missing} | 400 NO_SUCH_CHANNEL |
| `N3-CH-null` | alice | {text: x, channelId: null} | 200  |
| `N3-CH-closed-internal-renote` | alice | {renoteId: $chClosedNote, channelId: $chClosed} | 200 text=null localOnly channelId=$chClosed renoteChannelId=$chClosed |
| `N3-CH-open-external-renote` | alice | {renoteId: $chOpenNote} | 200 text=null localOnly renoteChannelId=$chOpen |
| `N3-CH-reply-adopt` | alice | {replyId: $chOpenNote, text: reply} | 200 localOnly channelId=$chOpen threadId=$chOpenNote mentions=[$bob] |
| `N3-CH-reply-other-channel` | alice | {replyId: $chOpenNote, text: reply, channelId: $chClosed} | 200 localOnly channelId=$chOpen threadId=$chOpenNote mentions=[$bob] |
| `N3-CH-reply-outside-with-channel` | alice | {replyId: $bobPublic, text: reply, channelId: $chOpen} | 200 threadId=$bobPublic mentions=[$bob] |
| `N3-CH-reply-archived` | alice | {replyId: $chArchivedNote, text: reply} | 200 localOnly channelId=$chArchived threadId=$chArchivedNote mentions=[$bob] $chArchived: notes=2 users=2 |
| `N3-CH-sensitive-skip` | alice | {text: needle, channelId: $chOpen} | 200 localOnly channelId=$chOpen |
| `N3-CH-renote-home` | alice | {renoteId: $bobHome, channelId: $chOpen} | 200 text=null visibility=home localOnly channelId=$chOpen |
| `N3-CH-count-note` | bob | {text: first, channelId: $chCount} | 200 localOnly channelId=$chCount $chCount: notes=1 users=1 |
| `N3-CH-count-pure` | alice | {renoteId: $N3-CH-count-note, channelId: $chCount} | 200 text=null localOnly channelId=$chCount renoteChannelId=$chCount $chCount: notes=2 users=2 |
| `N3-CH-count-reply` | alice | {replyId: $N3-CH-count-note, text: reply} | 200 localOnly channelId=$chCount threadId=$N3-CH-count-note mentions=[$bob] $chCount: notes=3 users=2 |
| `N3-CH-quote-closed-external` | alice | {renoteId: $chClosedNote, text: quote} | 400 CANNOT_RENOTE_OUTSIDE_OF_CHANNEL |

**指定宛先・メンション**

| id | actor | 入力 | 結果 |
| --- | --- | --- | --- |
| `N3-MN-visible-missing` | alice | {text: x, visibility: specified, visibleUserIds: [$bob, $missing]} | 200 visibility=specified visibleUserIds=[$bob] mentions=[$bob] |
| `N3-MN-specified-empty` | alice | {text: x, visibility: specified} | 200 visibility=specified |
| `N3-MN-visible-order` | alice | {text: x, visibility: specified, visibleUserIds: [$carol, $bob]} | 200 visibility=specified visibleUserIds=[$carol, $bob] mentions=[$carol, $bob] |
| `N3-MN-dedupe` | alice | {text: @Probe_Bob @probe_bob} | 200 mentions=[$bob] |
| `N3-MN-missing-local` | alice | {text: @probe_nobody hi} | 200  |
| `N3-MN-suspended` | alice | {text: @probe_suspended hi} | 200 mentions=[$suspended] |
| `N3-MN-remote` | alice | {text: @rwithurl@remote.example @rnourl@remote.example} | 200 mentions=[$rwithurl, $rnourl] mentionedRemoteUsers保存 |
| `N3-MN-remote-visible` | alice | {text: x, visibility: specified, visibleUserIds: [$rnourl]} | 200 visibility=specified visibleUserIds=[$rnourl] mentions=[$rnourl] mentionedRemoteUsers保存 |
| `N3-MN-limit-boundary` | limiter | {text: @probe_bob @probe_carol} | 200 mentions=[$bob, $carol] |
| `N3-MN-limit-over` | limiter | {text: @probe_bob @probe_carol @probe_alice} | 400 CONTAINS_TOO_MANY_MENTIONS |
| `N3-MN-limit-dedupe` | limiter | {text: @probe_bob @Probe_Bob @probe_carol} | 200 mentions=[$bob, $carol] |
| `N3-MN-limit-self` | limiter | {text: @probe_limiter @probe_bob @probe_carol} | 400 CONTAINS_TOO_MANY_MENTIONS |
| `N3-MN-limit-reply-boundary` | limiter | {replyId: $bobPublic, text: @probe_carol} | 200 threadId=$bobPublic mentions=[$carol, $bob] |
| `N3-MN-limit-reply-over` | limiter | {replyId: $bobPublic, text: @probe_carol @probe_alice} | 400 CONTAINS_TOO_MANY_MENTIONS |
| `N3-MN-limit-visible-boundary` | limiter | {text: @probe_alice, visibility: specified, visibleUserIds: [$bob]} | 200 visibility=specified visibleUserIds=[$bob] mentions=[$alice, $bob] |
| `N3-MN-limit-visible-over` | limiter | {text: @probe_alice, visibility: specified, visibleUserIds: [$bob, $carol]} | 400 CONTAINS_TOO_MANY_MENTIONS |
| `N3-MN-noextract-reply` | alice | {replyId: $bobPublic, text: @probe_carol, noExtractMentions: true} | 200 threadId=$bobPublic mentions=[$bob] |
| `N3-MN-cw-choice` | alice | {text: body, cw: @probe_bob, poll: {choices: [@probe_carol, b]}} | 200 mentions=[$bob, $carol] poll(multiple=false, expiresAt=null) poll.noteVisibility=public |
| `N3-MN-visible-duplicate` | alice | {text: x, visibility: specified, visibleUserIds: [$bob, $bob]} | 400 INVALID_PARAM #/properties/visibleUserIds/uniqueItems |

**ハッシュタグ・絵文字**

| id | actor | 入力 | 結果 |
| --- | --- | --- | --- |
| `N3-HE-case-dup` | alice | {text: #Foo #foo} | 200 tags=[foo, foo] |
| `N3-HE-cw-choice` | alice | {text: #texttag :textemoji:, cw: #cwtag :cwemoji: #texttag, poll: {choices: [#choicetag... | 200 tags=[texttag, cwtag, choicetag] emojis=[textemoji, cwemoji, choiceemoji] poll(multiple=false, expiresAt=null) poll.noteVisibility=public |
| `N3-HE-over-32` | alice | {text: #t01 #t02 #t03 #t04 #t05 #t06 #t07 #t08 #t09 #t10 #t11 #t12 #t13 #t14 #t15 #t16 ... | 200 tags=[t01, t02, t03, t04, t05, t06, t07, t08, t09, t10, t11, t12, t13, t14, t15, t16, t17, t18, t19, t20, t21, t22, t23, t24, t25, t26, t27, t28, t29, t30, t31, t32] |
| `N3-HE-length` | alice | {text: #aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa... | 200 tags=[bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] |
| `N3-HE-fullwidth` | alice | {text: #ＡＢＣ #１２３ #Ｆoo} | 200 tags=[abc, 123, foo] |
| `N3-HE-only-hashtags-off` | alice | {text: #tag :emo: @probe_bob, noExtractHashtags: true} | 200 mentions=[$bob] emojis=[emo] |
| `N3-HE-emoji-case-dup` | alice | {text: :Blob: :blob: :Blob:} | 200 emojis=[Blob, blob] |
| `N3-HE-inline-code` | alice | {text: `#code :code: @probe_bob` #real} | 200 tags=[real] |
| `N3-HE-nfkc-expanding` | alice | {text: #㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿㍿... | 500 INTERNAL_ERROR |

**エラーの優先順**

| id | actor | 入力 | 結果 |
| --- | --- | --- | --- |
| `N3-ORD-reply-before-expired` | alice | {replyId: $missing, text: x, poll: {choices: [a, b], expiresAt: 1000}} | 400 NO_SUCH_REPLY_TARGET |
| `N3-ORD-expired-before-channel` | alice | {text: x, poll: {choices: [a, b], expiresAt: 1000}, channelId: $missing} | 400 CANNOT_CREATE_ALREADY_EXPIRED_POLL |
| `N3-ORD-channel-before-prohibited` | alice | {text: forbidden, channelId: $missing} | 400 NO_SUCH_CHANNEL |
| `N3-ORD-prohibited-before-mentions` | limiter | {text: forbidden @probe_bob @probe_carol @probe_alice} | 400 CONTAINS_PROHIBITED_WORDS |


`$chArchived` の notes/users=2/2 は、アーカイブ前のbobの1件と今回のaliceの返信の合計。`$chCount` は空のchannelから bobの投稿→aliceのchannel内pure Renote→aliceのchannelId なし返信の順に進めた値。表は索引で、正本は `observations.json`。

## 調査要約との食い違い・補足

- **配送対象の specified pure Renote**: 要約（RR-32の訂正、RR-44）は「public/home対象へ specified の pure Renote は作成できる」「pure RenoteはAnnounceで配送する」とだけ書く。初回の記録で `bobPureSpecified` を localOnly なしで作ると、保存後の `postNoteCreated` で `ApRendererService.renderAnnounce` が `renderAnnounce: cannot render non-public note` を投げ、応答の外で unhandled rejection になってVitestが中断した。このためfixtureを localOnly にした。この入力のHTTP応答・保存値は記録していない（#171の配送側の判断材料）。
- **動画の thumbnailUrl**: 要約F16（訂正後）は「動画は thumbnailUrl ?? 外部動画サムネイルURL」とする。実測の `N3-FP-attached-types` では video/mp4 の `thumbnailUrl` が null だった。`VideoProcessingService.getExternalVideoThumbnailUrl` は `config.videoThumbnailGenerator` が未設定なら null を返すため、設定依存。
- **visibleUserIds の順**: 要約V3どおり保証はない。`N3-MN-visible-order` では入力順の `[carol, bob]` で保存されたが、bobの行は投稿のたびに `notesCount` 更新で書き換わっており、PostgreSQLの物理順に依存した結果と考える（ID順でもない）。新実装の期待値にこの順を固定するかは別に決める。
- 推測とされていた挙動は実測で確認した: `'#Foo #foo'`→`['foo','foo']`、`'#１２３'`→`'123'`、NFKCで伸びるタグ（`'#'+'㍿'×128`）は `value too long for type character varying(128)` の500 INTERNAL_ERROR（Note/Poll増分0）、空白のみtext+renoteIdはpure Renote、自分のspecifiedへのspecified返信は `visibleUserIds=[自分]`・mentionsなし、アーカイブ済みchannelのノートへの返信はそのchannelに保存されcountも加算、`expiresAt:0` は期限なし、bot のRenoteはrenoteCountを加算しないがbotの返信はrepliesCountを加算。

## 測っていないもの

- 未登録リモートユーザーへのメンション（WebFinger・createPerson）。指示により対象外（#195）。
- `lastFetchedAt` が古いか null の登録済みリモートへのメンション（再同期で通信する。#195）。ポート付き自ホスト名 `@user@127.0.0.1:61167` へのメンション（要約R2訂正によりWebFingerの経路に入るため）。
- 配送対象の specified pure Renote のHTTP応答（上記。Vitestが中断するため）。
- Poll insert失敗時の rollback、Note insertの重複キー、pack失敗。本家ソースへの障害注入が必要で、本家を改変しない方針のため。
- Renote元channel行の消失（b060f9a6）。`Note.channel` が CASCADE で、行を消すと元ノートも消えるため到達できない。
- 同じユーザーの同時投稿によるchannel usersCountの取りこぼし。結果が決定的でないため。
- 作成直後の `notes/show`、実在するカスタム絵文字の描画、画像以外の isSensitive/orientation/webpublicUrl を持つファイルの描画、投票終了job・通知・stream・TL・webhook・AP（#171/#173–#175）。
- `replyId`/`renoteId` の形式不正、空白だけの選択肢、負の `expiresAt`、停止中ユーザーを `visibleUserIds` に入れた場合、ブロックしている相手へのメンション、`user.updatedAt` の更新値。

## 再実行（隔離環境のみ）

N0の[再実行手順](../README.md#再実行隔離環境のみ)と同じ方式。Compose projectは `note-170-reference`、ポートはN0と同じ55167/56167（DB/Redis）・61167/62167/63167（HTTPほか）。`.config/test.yml` はN0のREADMEの値で作る。**ポートとproject名が他で使われていないことを先に確かめる。**

```sh
export NOTE_SOURCE_ROOT="$PWD"
export NOTE_REFERENCE_ROOT="$(mktemp -d /tmp/tiramiss-note-170.XXXXXX)"
git archive 8e07cf085adf7009583d234a208e30436f020e26 | tar -x -C "$NOTE_REFERENCE_ROOT"
N=docs/superpowers/compatibility/note
cp $N/n3/reference-note-n3.e2e.ts "$NOTE_REFERENCE_ROOT/packages/backend/test/e2e/note-contract-n3.ts"
cp $N/n3/http-cases.json "$NOTE_REFERENCE_ROOT/packages/backend/test/e2e/note-n3-http-cases.json"
cp $N/n3/observations.json "$NOTE_REFERENCE_ROOT/packages/backend/test/e2e/note-n3-observations.json"
cp $N/reference-note.setup.ts "$NOTE_REFERENCE_ROOT/packages/backend/test/note-setup.ts"
cp $N/n3/reference-note-n3.config.mjs "$NOTE_REFERENCE_ROOT/packages/backend/note-contract-n3.config.mjs"
BACKEND_NEXT_TEST_DB_PORT=55167 BACKEND_NEXT_TEST_REDIS_PORT=56167 \
  docker compose -p note-170-reference -f packages/backend-next/compose.test.yml up -d --wait
```

参照側で依存を入れてビルドし（`pnpm install --frozen-lockfile --filter backend...`、`pnpm build-pre`、`pnpm --filter backend... build`、`NODE_ENV=test pnpm --filter backend compile-config`、`pnpm --filter backend build:e2e`）、N0のREADMEの設定検査（`Dedicated configuration: PASS`）を通してから実行する。

```sh
cd "$NOTE_REFERENCE_ROOT"
NODE_ENV=test pnpm --filter backend exec vitest run --config note-contract-n3.config.mjs test/e2e/note-contract-n3.ts
pnpm --filter backend exec eslint --quiet test/e2e/note-contract-n3.ts test/note-setup.ts
```

期待値を更新するときだけ `NOTE_PROBE_RECORD=1` を付ける。失敗したsuiteの部分goldenは保存しない。成功した記録の出力を `n3/observations.json` へコピーし、記録なしで必ず再生する。probeは専用RedisをFLUSHDBし、DB schemaを再作成する（N0と同じ）。連続実行では61167にTIME_WAITが残ることがあるので、ポート検査が通るまで待つ。終了後は自分が起動した `note-170-reference` だけを停止する。

```sh
cd "$NOTE_SOURCE_ROOT"
BACKEND_NEXT_TEST_DB_PORT=55167 BACKEND_NEXT_TEST_REDIS_PORT=56167 \
  docker compose -p note-170-reference -f packages/backend-next/compose.test.yml down
```

## 実行記録

2026-11-03、Node.js 24.20.0 / pnpm 12.9.1 / PostgreSQL 18.6 / Redis 8.10.2、専用Compose `note-170-reference`。固定本家を新しい一時ディレクトリへ `git archive` で展開し、依存の導入・ビルド・設定コンパイル・e2eビルドを行い、設定検査はPASS。

- 初回の記録: `bobPureSpecified` の配送で本家が unhandled rejection を出して中断（上記）。fixtureを localOnly に変更。
- 87件で記録1回（89テストPASS）→ 記録なしで再生2回（コメントだけを日本語化した前後。いずれも89テストPASS、goldenは変化なし）。
- 15件を追加して102件で記録（104テストPASS、約54秒）→ 記録なしで再生（104テストPASS、約56秒、goldenは変化なし）。先の87件の観測は102件の記録でも同一だった。
- 参照側でprobeのeslint PASS。元repoで `node scripts/check-spdx.mjs`（SPDX: OK）と `node --test scripts/note-contract-*.test.mjs`（8件PASS）。

## 新実装への接続先

新実装のテストへ接続したら、接続先・コマンド・結果を記入する。空欄を新実装での一致へ読み替えない。

| 領域 | ケース | 接続先テスト | コマンド・結果 |
| --- | --- | --- | --- |
| 添付・投票 | `N3-FP-*` | `packages/backend-next/test/integration/note-create-relations.test.ts` | `BACKEND_NEXT_TEST_DB_PORT=… BACKEND_NEXT_TEST_REDIS_PORT=… pnpm --filter backend-next test:integration test/integration/note-create-relations.test.ts`。`N3-FP-poll-specified` 以外は2026-11-03 #170段階2、全件は同日の段階3でPASS |
| 返信・Renote | `N3-RR-*` | 同上 | 同上（`N3-RR-reply-specified` は段階3で接続） |
| channel | `N3-CH-*` | 同上 | 同上（段階2） |
| 指定宛先・メンション | `N3-MN-*` | 同上 | 同上（段階3）。`N3-MN-visible-order` は、本家も新実装も宛先を順序なしの `findBy(In)` で取得し入力順を保証しないため、`visibleUserIds`・`mentions` を集合として比べる（実測値は変えない） |
| ハッシュタグ・絵文字 | `N3-HE-*` | 同上 | 同上（段階3）。`N3-HE-nfkc-expanding` は本家どおり正規化前の長さで判定し、保存時のDBエラーで500 `INTERNAL_ERROR` になる。`error.info.e`（DBエラーの文言とリクエストごとのUUID）は動的な内部情報なので比較から除く。代わりに本家の記録が `QueryFailedError` であることと、新実装のログに出た例外が同じく `QueryFailedError`（PostgreSQL の 22001、長さ超過）であることを確かめる |
| エラーの優先順 | `N3-ORD-*` | 同上 | 同上（段階2） |

接続したケースは probe と同じ順に送り、各ケースの後で保存後処理の完了を待ってから、HTTP応答・Note/Poll増分・保存列・`watch` のcountを `observations.json` と照合する。成功したケースは、作成直後の `notes/show` が作成応答に今回の返信先 `repliesCount`・Renote対象 `renoteCount` の加算を足した値と一致することも確かめる。初期データは probe と同じく `notes/create` で作る（指定宛先を持つ `bobSpecified`・`aliceSpecified`・`aliceSpecifiedMention` を含む）。段階2で `N3-MN-limit-reply-boundary` の加算をDBに再現していた処理は、段階3でそのケースが保存されるようになったため撤去した。

測っていない未登録リモートユーザーへのメンションは、新実装では#195まで保存前に501 `NOT_IMPLEMENTED`を返す（`packages/backend-next/test/integration/note-create.test.ts` で確認）。
