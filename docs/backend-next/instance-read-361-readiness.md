# #361 の先行条件の訂正（2026-11-15）

[#361](https://github.com/tiramiss-community/tiramiss/issues/361) は **waiting / OPEN** とする。固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の3入口は UserLite ではなく UserDetailedNotMe を返す。`federation/following` は閲覧者本人であるローカル followee も返せるため、共通詳細表示 [#297](https://github.com/tiramiss-community/tiramiss/issues/297) と本人分岐 [#338](https://github.com/tiramiss-community/tiramiss/issues/338) の材料が必要である。2026-11-14 の「既存UserLite材料を再利用できる」だけを根拠とする ready 判定を訂正する。

これは作業選定の訂正であり、APIの実装・互換性検証・Issueの閉鎖ではない。調査時の実装基準は PR #590 の merge `fa57cedcd7923e02144eedc4fbec50bbda8b333d`。`backlog.json` の元の棚卸し・provenance・counts・parents・nativeDependencies は履歴として保持し、末尾の `currentCorrections` を現在の選定へ重ねる。GitHub本文・Relationshipsはこの変更では更新していない。

## 入口ごとの依存

| 対象 | 固定本家の処理・返却 | 完了に必要な材料 |
| --- | --- | --- |
| `federation/instances` | Instanceのfilter/sort/offset、`packMany` | Instance、Meta、閲覧者のmoderator判定。User詳細は不要 |
| `federation/show-instance` | `toPuny(host)` による単一取得、欠損はnull | 同上 |
| `federation/stats` | Instance上位2集合、Followingのremote host件数、Instance pack | 同上とFollowing集計 |
| `GET /api/v1/instance/peers` | 保存済み `suspensionState = 'none'` のhostだけ | Instanceだけ。softwareSuspended・blocked・notRespondingを追加除外しない |
| `federation/users` | host完全一致＋ID/date paging、UserDetailedNotMe | 共通詳細表示 #297 |
| `federation/followers` | `followeeHost = host`＋paging、**followee**を詳細表示 | 共通詳細表示 #297 |
| `federation/following` | `followerHost = host`＋paging、**followee**を詳細表示 | 共通詳細表示 #297、本人分岐 #338 |
| Instance pack | software停止・host規則・日時・moderator限定のmoderationNote | 取得済みInstance/Meta/Role材料からの変換 |

根拠は固定本家の [instances](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/federation/instances.ts#L79)、[show-instance](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/federation/show-instance.ts#L42)、[stats](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/federation/stats.ts#L82)、[peers](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/ApiServerService.ts#L146)、[users](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/federation/users.ts#L52)、[followers](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/federation/followers.ts#L54)、[following](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/federation/following.ts#L54)、[Instance pack](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/InstanceEntityService.ts#L32)。

4つのInstanceだけの入口と純粋packは独立して準備・実装できる。しかし、それだけでは現在の #361 の全対象を閉じられない。今回、新Issueへの分割や部分実装の登録は行わない。

## UserLiteで代用できない理由

[FollowingEntityService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/FollowingEntityService.ts#L95) は、両relation入口の `populateFollowee: true` を UserDetailedNotMe へ接続する。`federation/following` の条件は follower のhostであり、followeeのhostには制約がない。「remote.testのユーザー → ローカル閲覧者本人」の既存Followingが1件あれば、remote.testを照会する閲覧者に本人分岐が返る。これは不正データを必要としない。

[UserEntityService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/UserEntityService.ts#L424) はschema名の `NotMe` で本人を除外せず、`schema !== 'UserLite'` と `meId === user.id` で分岐する。

| 材料・処理 | 既存所有者・条件 |
| --- | --- |
| Profile、関係に応じたfollowers/following count、public Role/policy、memo | #297。先行のPage #293・memo #294・Role #295・relation #296を再利用 |
| pinned Notes/Page | #297。既存Note readerを利用し、Pageは #293。匿名時の `packMany` は空のpin mapを渡す点も比較対象 |
| moderator向けMFA情報 | #297。UserSecurityKeyの有無の読取。キー登録API全体を待たない |
| movedTo、alsoKnownAs | #297。前者は `resolvePerson`、後者は保存済み `fetchPerson`。HTTP inboxやMove実行全体を前提にしない |
| 本人向け設定・未読・announcement・chat・保留request・固定値 | #338。#297・通知既読材料 #336・announcement読取 #337が既存の先行条件 |

実装基準の [note-authors.ts](../../packages/backend-next/src/platform/database/note-authors.ts) はUserLite材料までであり、この共通詳細表示は存在しない。UserMemo/UserSecurityKeyは [公開Entity一覧](../../packages/backend-upstream/exports/entities.ts) にもない。必要な同期は所有する機能と一緒に行い、#361内へ別の詳細packerを作らない。

`movedTo` は [resolvePerson](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/models/ApPersonService.ts#L673) により未登録actorを取得・保存し得る。aliasの [fetchPerson](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/models/ApPersonService.ts#L231) は保存済み取得である。さらに [Page pack](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/PageEntityService.ts#L65) は旧contentの変換・書戻しを開始する。従って全照会の「DB書込は常に0」を新しい契約にしない。#361のpeers保存不変の条件を維持し、詳細表示の既存副作用は共通契約で比較する。本人antenna未読は固定本家ではfalseの固定値であり、antenna全体を新たな依存にしない。

## 最小の依存と現在の選定

2026-11-15に #293/#294/#295/#296/#297/#338 はすべてOPEN、#361もOPENであることと本文を確認した。完全なconsumer要件として `361 → 297, 338` を記録する。Relationships用の推移縮約では既存の `338 → 297` があるため、追加は `361 → 338` の1辺で足りる。#180/#182/#191/#195の親全体への依存や、inbox・users/show入口・キー登録APIへの依存は追加しない。#297からPage→UserLiteを使う既存の方向も変更しない。

元snapshotの318単位・ready69/waiting247/investigate2・葉依存749・native544は当時の記録である。この1件の補正だけを適用するとready68/waiting248/investigate2、葉依存751となる。nativeの候補は元の544辺へ338向け1辺を追加する。これは全catalogueの現在のOPEN/実装状態を再集計した件数でも、GitHubへ公開済みの依存件数でもない。

S1の現在の選定では、#272/#323/#324/#325/#362のCLOSEDを確認済み。PR #589（Emoji、merge `8a791b003313d9178bede0af0a234a9b1f67521e`）、#590（instance管理、merge `fa57cedcd7923e02144eedc4fbec50bbda8b333d`）、#591（CI並列化、merge `7f54d231d19a332f96e662369cdaa58ae652d048`）はMERGEDである。#361の前提が揃う間、独立した #377/#560 のURL previewとagentを同一PRで進められる。親 #114/#195 と投稿partialの状態は維持する。GitHub #114冒頭の「次は#325」は調査時点で残っており、ここで訂正したのはリポジトリ文書の現在の入口である。

## 再開時の完了判定

1. #297の共通詳細材料と#338の本人材料を公開契約から利用できることを確認する。#338全体の管理状態だけでなく、#361が必要とする `includeSecrets:false` の本人分岐を比較する。
2. 6 APIとpeersについて実トークンHTTP/PGで入力・認証・ページ境界・欠損・不正・停止・保存を比較する。Relationの両方向とlocal本人followeeを含める。
3. Instanceの全sort/filter・hostの正規化の違い・software停止と保存停止の違い・moderationNoteの可視性を確認する。
4. 独立source資料と新実装の実測を分ける。QueryServiceは使用するpagination分岐だけを証明し、広いservice行や歴史的証跡を一括昇格しない。
5. #361自身の全受入条件が揃ってから閉じ、親の残作業とinventoryの有限行を更新する。
