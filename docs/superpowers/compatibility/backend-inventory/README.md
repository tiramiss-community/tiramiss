# バックエンドの公開契約と移植対応表

[#129](https://github.com/tiramiss-community/tiramiss/issues/129) の棚卸し。全体の入口は [#114](https://github.com/tiramiss-community/tiramiss/issues/114)、未移植領域の取りまとめは [#128](https://github.com/tiramiss-community/tiramiss/issues/128)。

この表は固定版の入口を漏れなく担当へ割り当てるための資料。個々の入力・出力・エラー・永続化・副作用を本家と実行比較した結果の代用ではない。詳細仕様と比較 fixture は各担当 Issue で追加する。

## 監査基準

- 本家: `8e07cf085adf7009583d234a208e30436f020e26`。`backend-upstream/upstream-sync.json` と同じ SHA。fork の現在の `packages/backend` からは列挙しない。
- 新実装: `6f62cb897d2a03e8fd7727eadf45c20d8bfcf206`（PR #213 マージ後）。判定と根拠はこの地点に固定する。
  - 行の `implementation`/`verification` は `domains.json` の `implementationCommit` の木で存在を検査する。#216 の最初の PR で外向き HTTP の行の根拠を参照できるよう `224416b352fa474a37fb286cd4838d8818947fc8` へ、#215 段階 2 の PR で連合の共通土台の行の根拠も参照できるよう、両方を含む `36cad9edcbfd2b990d36b2f6645b677b1e54f0e4` へ、#160 の最初の PR で AP の署名・配送結果の分類の行の根拠も参照できるよう `02612df99fe3c529fc692d76b3bd37498a2e0e1a` へ、#162 の最初の PR で投票終了ジョブと通常 worker の行の根拠も参照できるよう `00c6b5b75ddcf4bb9e5e79291e2f54a9dd4933e4` へ、同じ PR で queue 接続のコメントを直した `ae30e864a06baf64a793d10ab6fb844ee3821502` へ、#171 の最初の PR でノート作成の AP 配送の行の根拠も参照できるよう `d9b718359e583fd9e33711c8321fc06b83c06b53` へ、同じ PR で MFM の `br` の行・起動中の投入口の接続の喪失を直した `47c9c75dd6b5fc9527c3976b86364b06c46f3a04` へ進めた。#172の削除sliceで追加した実装・検証の根拠を参照できるよう `ba51607ba514de5fe2e4a1bf574575d5f0d42fa9` へ進めた。監査の判定（`audit`）はこの更新で変えていない。
- 対象: 登録 API と非 API HTTP、WebSocket、AP 受信/公開/送信、業務保存・副作用、job/周期処理、CLI/運用。fork 固有機能は対象外。固定本家の機能を一括で見送らない。

## 現在の到達点

Role 初期対象の `admin/roles/show` と `admin/roles/update` は、新実装・本家比較資料・HTTP/受け入れテストに接続済み。これを `verified`（検証根拠あり）とする。他の Role API は未実装。根拠は [Role 比較資料](../role/README.md)、[#115](https://github.com/tiramiss-community/tiramiss/issues/115) と #116–#121。

`notes/show` は固定本家の観測 JSON と照合済みで `verified`。`notes/create` は #170 のローカル部分（添付・投票・返信/Renote・channel・指定宛先・MFM 抽出）まで実装した `partial` で、未登録リモートユーザー宛てのメンションは #195 まで保存前に 501 で拒否する。PG 通知保存と起動・migration の基盤は `partial`。旧 PG ジョブ基盤と AP 宛先 snapshot/page/host lease は PR #212/#213 で撤去したため、AP 送信とジョブ管理は `not_implemented` に戻した。**通常 worker は本家の投票終了ジョブ（`endedPollNotification`、#162）と AP 配送ジョブ（`deliver`、#171）を実行する。** 投票終了ジョブの投入・queue と Worker の設定・受信者の選定と PG への保存は本家 probe と比較して `partial` にした（[比較資料](../poll-ended/README.md)）。 #160 の最初の PR で、AP の署名・署名付き送信・配送結果の分類を本家と比較して `partial` にした。#171 の最初の PR で、ノート作成の Create/Announce の表現・宛先の選定・deliver queue と Worker・配送前の判定・インスタンス台帳を通常起動へ接続し、本家 probe と note の C9（relay を除く）と比較して `partial` にした（[比較資料](../ap-deliver/README.md)）。relayとJSON-LD署名は#171の2番目のPR #227で接続済み。Delete/Undoは#172の下記sliceで接続した。 部分実装から公開機能全体の完成を推測しない。

それ以外の入口は `not_implemented`（未実装）。これは見送りではなく、担当 Issue による設計・実装・比較が必要な状態。今回の検査は棚卸しの整合性検査であり、各 HTTP/連合機能の比較テストを再実行して `verified` を付けたものではない。

## #172 sliceと固定監査表の照合（2026-11-07）

生成表の `implementationCommit` を削除sliceの実装コミット `ba51607ba514de5fe2e4a1bf574575d5f0d42fa9` へ進め、下記8行を `partial` として同期した。validatorはこの固定Git treeで実装・検証ファイルの存在を検査する。削除stream等の未接続を含むため、領域全体の完成とは扱わない。

| 契約ID/対象 | 現在の実装と比較 | 残る範囲 |
| --- | --- | --- |
| `api:notes/delete` | `http/note-delete-api.ts` と `modules/note/delete-note.ts`。実トークンHTTP・C10認可/監査/DB・production rateを `test/integration/note-delete.test.ts` で検証 | 削除stream/通知、TL/検索、webhook、チャート |
| `ap-render:renderDelete` / `ap-render:renderUndo` | `modules/federation/note-deletion.ts`。C10 Delete/Undo/fallbackとF8を `test/processes/note-delete.test.ts` で原文署名・Digestも比較 | AP受信/actor公開は#195 |
| `ap-send-site:NoteDeleteService.deliverToConcerned -> deliverToFollowers` / `-> deliverToUsers` | followersとconcerned directを独立投入。remote返信/Renote作者の実DB照会とqueue jobsも比較 | 強い取消/順序/固定宛先台帳は保留#161 |
| `responsibility:notes-core:30` | Delete/Undo表現と配送先決定を接続。relayは作者鍵LD署名付きで別投入 | 残る縦断連携は#176 |
| `service:NoteDeleteService` / `responsibility:notes-core:29` | 認可/物理削除/返信数/監査/配送の部分実装。DELETE失敗境界を固定本家probeで比較 | stream#173、TL/検索#174、webhook#175、チャート#200 |

実装ファイルは `packages/backend-next/src/`、試験は `packages/backend-next/` からの相対パス。[計画と実測](../../plans/2026-11-07-note-delete-172.md)、[削除比較資料](../note/README.md#172-削除sliceの追加検証2026-11-07)を参照する。

## 列挙した範囲

| 単位 | 件数 | 根拠と数え方 |
| --- | ---: | --- |
| api | 438 | endpoint-list.ts の登録名。440 .ts のうち2件は test なので除外。全438 handlerとの集合一致を検査。 |
| http | 84 | server 内 fastify の明示登録。/api、/oauth、/oauth/token、/healthz の mountを記録。API共通の動的登録2経路も含む。 |
| stream-channel | 19 | Connection.getChannelConstructor の19種と実handlerファイル。 |
| stream-command | 10 | 接続操作と別名。チャネル内の書込も別途追跡。 |
| ap-inbound | 14 | ApInboxService.performOneActivity のdispatch。Collectionの展開/検証も領域の責任に含む。 |
| job | 35 | QueueProcessorService の全35文字列dispatch。importのDB phase/relationship4操作も別に列挙。 |
| processor | 36 | 全36processorファイル。dispatchと重複するので足し算して機能数にしない。 |
| schedule | 9 | QueueService の9定期登録とcron式。遅延archive/poll/予約は各processor/領域で扱う。 |
| cli | 3 | boot/cli.ts のhelp/ping/reset-captcha。migration等は運用能力でも追跡。 |
| capability | 39 | 領域の正本・副作用とqueue外timer/WS書込/static配信の明示的な確認単位。内部の全関数一覧ではない。 |

### 監査で追加した行

[網羅性監査](../../../backend-next/coverage-audit.md)（2026-11-03）で、上の機械列挙に現れない本家の機能・責務 1432 行を [audit-items.json](audit-items.json) に追加し、担当領域を割り当てた。種別は service・packer・entity・config・env・Meta 設定・stream/internal イベント・通知種別・webhook イベント・ロールポリシー/条件・モデレーションログ種別・AP の表現/送信箇所・queue 名/投入メソッド・timer・`responsibility`（暗黙の責務）など。

- 監査時の判定（割り当て前）: 計画あり 1075 / 曖昧 341 / 計画なし 15 / 意図した後回し 1。対応表では計画あり以外に「（監査: 曖昧）」等を付ける。担当を割り当てたことは、その領域 Issue が中身を調査・実装することを意味し、移植済みを意味しない。
- 機械列挙の行と違い、`--check` は再列挙しない。上流の場所・担当領域・判定値・重複を検査する。本家更新時は [#135](https://github.com/tiramiss-community/tiramiss/issues/135) の記録と合わせて人が見直す。
- 横断的で既存領域に収まらない責務は、新しい 3 領域（連合の共通土台・外向きHTTPとSSRF対策・プロセス間イベントとキャッシュ同期）へ分けた。本家設定キー・環境変数・観測（Sentry/telemetry）・既存データ形式の互換は #138 に寄せた。Meta 設定・通知種別・stream イベントは、効き先または発行する機能の領域に置いた。

**687行は独立した機能数でも PR 数でもなく、完成率の分母にしない。** 同じ機能が API・stream・job・共通能力の複数行に現れる。監査行を含む全行も同様。残作業は下表の31領域と各 Issue の完了条件で判断する。将来の本家更新で対象集合も変わる。

全契約は生成された [対応表](contracts.md)、機械可読版は [contracts.json](contracts.json)。保存・副作用・実装・検証・既知差異は [domains.json](domains.json) にまとめ、各行の `domain` から引く。行の `source` と本家 SHA が本家参照、`issue` が担当、`implementation`/`verification` が新実装と根拠、`differences` が明示した差異を表す。

## 担当領域

| 領域 | 監査時点 | 担当 / 連携 |
| --- | --- | --- |
| [API共通契約](#domain-api-common) | 未実装 | [#178](https://github.com/tiramiss-community/tiramiss/issues/178) |
| [ログイン・認証情報・アプリ認可](#domain-identity) | 未実装 | [#179](https://github.com/tiramiss-community/tiramiss/issues/179) |
| [ユーザー・設定・クライアントregistry](#domain-accounts) | 未実装 | [#180](https://github.com/tiramiss-community/tiramiss/issues/180) |
| [Role全API・割り当て変更](#domain-roles) | 初期2 APIは検証根拠あり、領域は未完了 | [#181](https://github.com/tiramiss-community/tiramiss/issues/181) / #115, #116, #117, #118, #119, #120, #121 |
| [follow・block・mute・関係管理](#domain-social) | 未実装 | [#182](https://github.com/tiramiss-community/tiramiss/issues/182) |
| [投稿初期フロー](#domain-notes) | 部分実装 | [#127](https://github.com/tiramiss-community/tiramiss/issues/127) / #167, #168, #169, #170, #171, #172, #173, #174, #175, #176 |
| [投稿周辺参照・下書き・予約](#domain-notes-extra) | 未実装 | [#183](https://github.com/tiramiss-community/tiramiss/issues/183) / #127 |
| [reaction・投票・favorite・thread mute](#domain-engagement) | 未実装 | [#184](https://github.com/tiramiss-community/tiramiss/issues/184) |
| [TL・アンテナ・一覧閲覧](#domain-timeline) | 未実装 | [#185](https://github.com/tiramiss-community/tiramiss/issues/185) / #132, #133, #174 |
| [検索・ハッシュタグ](#domain-search) | 未実装 | [#186](https://github.com/tiramiss-community/tiramiss/issues/186) / #132, #133, #174 |
| [list・clip・channel](#domain-collections) | 未実装 | [#187](https://github.com/tiramiss-community/tiramiss/issues/187) |
| [通知・未読/既読・push](#domain-notifications) | 部分実装 | [#177](https://github.com/tiramiss-community/tiramiss/issues/177) / #155, #173, #139 |
| [Drive・ファイル配信・外部保存](#domain-drive) | 未実装 | [#188](https://github.com/tiramiss-community/tiramiss/issues/188) / #130, #170, #139 |
| [WebSocket接続・購読・状態変更](#domain-stream) | 未実装 | [#189](https://github.com/tiramiss-community/tiramiss/issues/189) |
| [chatメッセージ・room](#domain-chat) | 未実装 | [#190](https://github.com/tiramiss-community/tiramiss/issues/190) |
| [pages・Play・gallery](#domain-content) | 未実装 | [#191](https://github.com/tiramiss-community/tiramiss/issues/191) |
| [Reversi・bubble game](#domain-games) | 未実装 | [#192](https://github.com/tiramiss-community/tiramiss/issues/192) |
| [instance公開情報・emoji・announcement](#domain-discovery) | 未実装 | [#193](https://github.com/tiramiss-community/tiramiss/issues/193) |
| [管理・モデレーション・設定](#domain-moderation) | 未実装 | [#194](https://github.com/tiramiss-community/tiramiss/issues/194) |
| [AP受信・remote解決・actor公開](#domain-federation) | 未実装 | [#195](https://github.com/tiramiss-community/tiramiss/issues/195) / #160, #171 |
| [投稿AP送信・宛先](#domain-ap-outbound) | 未実装 | [#124](https://github.com/tiramiss-community/tiramiss/issues/124) / #159, #160, #161, #162, #171, #172 |
| [HTML・feed・preview・公開配布経路](#domain-web) | 未実装 | [#196](https://github.com/tiramiss-community/tiramiss/issues/196) |
| [user webhook設定・全イベント配送](#domain-user-webhook) | 未実装 | [#197](https://github.com/tiramiss-community/tiramiss/issues/197) / #163, #175 |
| [system webhook設定・配送](#domain-system-webhook) | 未実装 | [#198](https://github.com/tiramiss-community/tiramiss/issues/198) |
| [import/export・移動/削除・保守ジョブ](#domain-maintenance) | 未実装 | [#199](https://github.com/tiramiss-community/tiramiss/issues/199) / #130, #139 |
| [charts・retention・統計](#domain-analytics) | 未実装 | [#200](https://github.com/tiramiss-community/tiramiss/issues/200) / #132, #133 |
| [ジョブ管理・照会・制御](#domain-queue) | 未実装 | [#163](https://github.com/tiramiss-community/tiramiss/issues/163) / #124, #162, #164, #165 |
| [起動・migration・CLI・配布](#domain-operations) | 部分実装 | [#138](https://github.com/tiramiss-community/tiramiss/issues/138) / #113, #135, #136, #137, #139, #162, #166 |
| [連合の共通土台（システムアカウント・鍵・ホスト判定・排他）](#domain-federation-base) | 未実装（監査で追加） | [#215](https://github.com/tiramiss-community/tiramiss/issues/215) / #195, #124, #160, #171 |
| [外向きHTTPとSSRF対策](#domain-outbound-http) | 未実装（監査で追加） | [#216](https://github.com/tiramiss-community/tiramiss/issues/216) / #160, #188, #195, #196, #197, #198 |
| [プロセス間イベントとキャッシュ同期](#domain-process-events) | 未実装（監査で追加） | [#217](https://github.com/tiramiss-community/tiramiss/issues/217) / #119, #178, #189 |

## 対応順と依存の扱い

1. 投稿は #167（比較契約）・#168（show）・#169（基本作成）まで完了。次は #170（関連入力）。既存トークンによる参照は全ログイン/トークン発行の移植を待たせない。
2. 実配送は #160（署名 HTTP）と #162（通常 worker。投票終了ジョブで接続済み）の上に、必要な実仕事（#171/#172）と合わせて接続する。#171 の最初の PR でノート作成の配送（relay を除く）を接続した。縦断比較は #176。#159/#161/#166 は追加保証として保留し、初期完成の依存にしない。
3. 次にユーザーの取得と関係 facts、一覧/TL、通知/streamを接続すると、投稿→閲覧→通知まで使える範囲を増やせる。公開情報・ユーザー参照・検索の設計は独立した部分から進めてよい。
4. Drive の外部保存やアカウント削除等は #130 の機能別回復設計を先に切り出す。#130を全参照 API の一括 blocker にしない。派生状態の通常更新は #174、正本/再構築は #132/#133、TL/検索の閲覧は各領域が所有する。
5. 認証発行、social graph、AP inboundは、狭い facts・署名/remote解決・個別activityを下位 Issue に分ける。親領域同士の全完了を相互に要求する循環を作らない。
6. #135/#136（本家追従）と #138（配布/観測）は並行準備し、全対象の成立後に #139（完全停止切り替え/残ジョブ/Redis移行）を最終検証する。

各領域 Issue は詳細設計・下位分割・実装・受け入れまでを追う取りまとめ。Issue を作成しただけ、または仕様を列挙しただけでは、その領域を完成にしない。新たな必須依存は該当する下位 Issue と親の順序へ同時に反映する。

## 検査・更新

```sh
node --test scripts/backend-contract-inventory.test.mjs
node scripts/backend-contract-inventory.mjs --check
```

`--check` は固定 Git オブジェクトと TypeScript AST から再列挙し、snapshot と生成表の一致、handler 全集合、未分類・重複、担当 Issue の設定、参照ファイル、部分実装/検証済みの証拠有無を検査する。Node/TypeScript はルートの既存依存を使う。ネットワーク接続や旧 backend のビルド・起動は不要。全履歴と指定 SHA の Git オブジェクトが必要。

1. 本家更新の評価では先に #135 の記録で固定 SHA と差分の意味を確認する。`domains.json` の SHA を黙って進めない。
2. 新規入口は既存領域へ責任を割り当てるか Issue を追加する。HTTP の動的 path/mount/Accept 分岐、channel内部の書込、coreのqueue外timer・外部保存/通信も読む。列挙スクリプトは業務の意味を自動判定しない。
3. 実装が増えたら新実装監査 SHA を明示的に更新し、個別 contract の status と実装/比較テスト/意図的差異を記録する。ファイルが存在するだけで verified にしない。
4. 監査行（`audit-items.json`）は手で編集する。担当を変えるときは `domain` を、実装したら `status`/`implementation`/`verification` を更新し、`audit` は監査時の値のまま残す。
5. `node scripts/backend-contract-inventory.mjs --write` で両形式を更新し、差分をレビューして再度 `--check` を通す。対応 Issue と親の進捗も更新する。CIでもNodeテストと整合性検査を実行する。

## 領域ごとの保存・副作用・根拠

<a id="domain-api-common"></a>

### API共通契約

登録/GET可否/multipart/共通認証・scope・制限・error/metadata公開。Role個別のgateだけで全API互換としない。

- 担当: [#178](https://github.com/tiramiss-community/tiramiss/issues/178).
- 正本/保存: 本家User/App/AccessToken/Meta / Redis rate limit。
- 副作用: 共通エラー・認可・入力検証順。
- 本家: [ApiServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/ApiServerService.ts)、[ApiCallService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/ApiCallService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-identity"></a>

### ログイン・認証情報・アプリ認可

signup/signin/passkey/2FA/メール検証/password reset/App/native token/MiAuth/OAuth/招待を含む。

- 担当: [#179](https://github.com/tiramiss-community/tiramiss/issues/179).
- 正本/保存: User/Profile/App/AccessToken/招待/認証状態。
- 副作用: メール・認可redirect・token発行・失効。
- 本家: [SigninApiService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/SigninApiService.ts)、[SignupApiService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/SignupApiService.ts)、[OAuth2ProviderService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/oauth/OAuth2ProviderService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-accounts"></a>

### ユーザー・設定・クライアントregistry

ユーザー表示/プロフィール/個人設定/registry/achievement/メモ等。ログイン発行とアカウント削除・移動は別の所有者。

- 担当: [#180](https://github.com/tiramiss-community/tiramiss/issues/180).
- 正本/保存: User/Profile/registry/achievement/関連設定。
- 副作用: profile更新通知・AP表現/更新・キャッシュ無効化。
- 本家: [UserEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/UserEntityService.ts)、[UserService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-roles"></a>

### Role全API・割り当て変更

初期show/updateと区別してcreate/delete/list/assign/unassign/default policies/公開Role参照を移植する。

- 担当: [#181](https://github.com/tiramiss-community/tiramiss/issues/181).
- 正本/保存: Role/RoleAssignment/ModerationLog。
- 副作用: 同時監査・材料cache無効化・資格/ポリシー反映。
- 本家: [RoleService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/RoleService.ts)。
- 新実装: [public.ts](../../../../packages/backend-next/src/modules/role/public.ts)、[role-api.ts](../../../../packages/backend-next/src/http/role-api.ts)。
- 検証根拠: [role-acceptance.test.ts](../../../../packages/backend-next/test/integration/role-acceptance.test.ts)。
- 既知差異: ロール更新と監査を同時確定。HTTPの既知差異はdocs/superpowers/specs/2026-10-17-role-compatibility-contract.mdとcompatibility/role/README.mdを参照。

<a id="domain-social"></a>

### follow・block・mute・関係管理

follow/request/取消・承認・reject、block/mute/renote mute、期限・AP関係activity。remote解決と循環しないsliceで実装。

- 担当: [#182](https://github.com/tiramiss-community/tiramiss/issues/182).
- 正本/保存: Following/FollowRequest/Blocking/Muting/RenoteMuting。
- 副作用: 関係count・通知・AP Follow/Accept/Reject/Undo/Block・期限処理。
- 本家: [UserFollowingService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserFollowingService.ts)、[UserBlockingService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserBlockingService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-notes"></a>

### 投稿初期フロー

notes/create/show/deleteと関連入力・純粋出力。

- 担当: [#127](https://github.com/tiramiss-community/tiramiss/issues/127).
- 正本/保存: Note/Poll/count。
- 副作用: 通知・AP・stream・TL/検索・webhookの後続処理開始。
- 本家: [NoteCreateService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteCreateService.ts)、[NoteDeleteService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteDeleteService.ts)、[NoteEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/NoteEntityService.ts)。
- 新実装: [create-note.ts](../../../../packages/backend-next/src/modules/note/create-note.ts)、[show-note.ts](../../../../packages/backend-next/src/modules/note/show-note.ts)、[note-writer.ts](../../../../packages/backend-next/src/platform/database/note-writer.ts)、[note-reader.ts](../../../../packages/backend-next/src/platform/database/note-reader.ts)。
- 検証根拠: [note-create.test.ts](../../../../packages/backend-next/test/integration/note-create.test.ts)、[note-show.test.ts](../../../../packages/backend-next/test/integration/note-show.test.ts)。
- 既知差異: 保存と後続開始を分け、独自依頼との同時保存はしない（docs/backend-next/posting-contract.md）。notes/showの参照予算D7。

<a id="domain-notes-extra"></a>

### 投稿周辺参照・下書き・予約

初期create/show/delete以外のchildren/conversation/reply/renote/state/bulk show/翻訳、下書きと予約時刻・取消を実装する。

- 担当: [#183](https://github.com/tiramiss-community/tiramiss/issues/183).
- 正本/保存: Note/NoteDraft/予約内容/関連状態。
- 副作用: 予約投稿・翻訳HTTP・遅延取消/再認可。
- 本家: [NoteDraftService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteDraftService.ts)、[PostScheduledNoteProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/PostScheduledNoteProcessorService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-engagement"></a>

### reaction・投票・favorite・thread mute

reactionの追加/削除、投票・推薦、favorite、thread mute、unrenote等の操作と公開契約。

- 担当: [#184](https://github.com/tiramiss-community/tiramiss/issues/184).
- 正本/保存: Reaction/PollVote/NoteFavorite/NoteThreadMuting。
- 副作用: count・通知・AP Like/Undo・stream・buffer反映。
- 本家: [ReactionService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ReactionService.ts)、[PollService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PollService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-timeline"></a>

### TL・アンテナ・一覧閲覧

home/local/hybrid/global/user-list/Role/antenna/mentions/featuredとcursor/可視性。通常更新/再構築は別責任。

- 担当: [#185](https://github.com/tiramiss-community/tiramiss/issues/185).
- 正本/保存: Note/関係facts/アンテナ設定 / Redis TL cache。
- 副作用: 一覧paging・アンテナ設定/候補・stream公開条件。
- 本家: [FanoutTimelineService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/FanoutTimelineService.ts)、[AntennaService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/AntennaService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-search"></a>

### 検索・ハッシュタグ

Note/User/タグ検索・タグ一覧/トレンド等の入力・cursor・可視性。検索データ通常更新/再構築とは別の閲覧契約。

- 担当: [#186](https://github.com/tiramiss-community/tiramiss/issues/186).
- 正本/保存: Note/User/Hashtag / MeilisearchまたはDB検索。
- 副作用: 検索結果と公開範囲・検索記録/制限。
- 本家: [SearchService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/SearchService.ts)、[HashtagService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/HashtagService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-collections"></a>

### list・clip・channel

リスト/clip/channelの管理・membership・favorite/follow/mute、公開条件・一覧/TLを含む。

- 担当: [#187](https://github.com/tiramiss-community/tiramiss/issues/187).
- 正本/保存: UserList/Clip/Channel/所属・関係行。
- 副作用: count・公開可否・stream・TL候補更新 / clip updatedは先頭即時と3秒静穏後の末尾通知、削除時timer取消。
- 本家: [ChannelEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/ChannelEntityService.ts)、[ClipEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/ClipEntityService.ts)、[ClipService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ClipService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-notifications"></a>

### 通知・未読/既読・push

PG保存と分けて全通知条件、一覧/grouping/cursor/未読/既読/flush/設定、Service Worker push、旧Redis移行を追跡する。

- 担当: [#177](https://github.com/tiramiss-community/tiramiss/issues/177).
- 正本/保存: 本家Redis通知/未読 / 新PG notification。
- 副作用: stream・push配信・遅延未読処理。
- 本家: [NotificationService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NotificationService.ts)、[PushNotificationService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/PushNotificationService.ts)。
- 新実装: [persistence.ts](../../../../packages/backend-next/src/platform/database/notification/persistence.ts)、[poll-ended.ts](../../../../packages/backend-next/src/modules/notification/poll-ended.ts)。
- 検証根拠: [notification.test.ts](../../../../packages/backend-next/test/integration/notification.test.ts)、[poll-ended-job.test.ts](../../../../packages/backend-next/test/integration/poll-ended-job.test.ts)。
- 既知差異: 本家Redis StreamからPG保存へ変更（ユーザー承認済み）。effect/容量課金への依存はPR #213で撤去。閲覧/既読/移行は#177。pollEndedは#162で通知元なしのPG保存まで接続（配信は#173）。

<a id="domain-drive"></a>

### Drive・ファイル配信・外部保存

upload/URL取得/移動/削除・folder/容量/添付参照・ファイルproxy/thumbnail/cacheを含める。

- 担当: [#188](https://github.com/tiramiss-community/tiramiss/issues/188).
- 正本/保存: DriveFile/Folder/count / filesystemまたはobject storage。
- 副作用: 外部保存・画像処理・参照更新・清掃/回復。
- 本家: [DriveService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/DriveService.ts)、[FileServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/FileServerService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-stream"></a>

### WebSocket接続・購読・状態変更

接続/auth/heartbeat/再接続、19channel、10接続操作と別名、note購読、channelごとのWS書込とevent payloadを扱う。

- 担当: [#189](https://github.com/tiramiss-community/tiramiss/issues/189).
- 正本/保存: 認証/関係facts / Redis PubSub / chat既読/game状態。
- 副作用: stream配信・通知既読・chat read・game ready/settings/cancel/putStone等。
- 本家: [StreamingApiServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/StreamingApiServerService.ts)、[Connection.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/stream/Connection.ts)、[GlobalEventService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/GlobalEventService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-chat"></a>

### chatメッセージ・room

DM/room作成・参加/招待・mute・履歴/検索・既読・reaction・添付とWS eventを扱う。

- 担当: [#190](https://github.com/tiramiss-community/tiramiss/issues/190).
- 正本/保存: ChatMessage/Room/Invitation/membership/既読。
- 副作用: 通知・push・WS・添付整合・時刻駆動 / chatUser.readとchatRoom.readの別の既読更新。
- 本家: [ChatService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ChatService.ts)、[chat-user.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/stream/channels/chat-user.ts)、[chat-room.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/stream/channels/chat-room.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-content"></a>

### pages・Play・gallery

pages/flash/Play/galleryの作成・更新・削除・閲覧・like・検索とpage-push。

- 担当: [#191](https://github.com/tiramiss-community/tiramiss/issues/191).
- 正本/保存: Page/Flash/GalleryPost/Like/添付参照。
- 副作用: like通知・embed/OGP・stream等。
- 本家: [PageEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/PageEntityService.ts)、[FlashEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/FlashEntityService.ts)、[GalleryPostEntityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/entities/GalleryPostEntityService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-games"></a>

### Reversi・bubble game

match/invitation/game状態/verify/surrender/ranking/registerとWS game操作、期限・並行操作を扱う。

- 担当: [#192](https://github.com/tiramiss-community/tiramiss/issues/192).
- 正本/保存: ReversiGame/ranking/ユーザー記録。
- 副作用: WS・game timer・終了/放置処理。
- 本家: [ReversiService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/ReversiService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-discovery"></a>

### instance公開情報・emoji・announcement

meta/ping/server-info/ユーザー数、emoji/avatar decoration、announcement/promo/pinned users等の公開取得・個人既読を含む。

- 担当: [#193](https://github.com/tiramiss-community/tiramiss/issues/193).
- 正本/保存: Meta/Emoji/Announcement/Ad/Decoration。
- 副作用: 公開JSON・cache・announce既読・nodeinfo/host-meta。
- 本家: [NodeinfoServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/NodeinfoServerService.ts)、[WellKnownServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/WellKnownServerService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-moderation"></a>

### 管理・モデレーション・設定

他領域で所有しないadmin API：ユーザー制御/通報/設定/emoji/ad/announce/監査/DB状態・メール送信等。

- 担当: [#194](https://github.com/tiramiss-community/tiramiss/issues/194).
- 正本/保存: Meta/ModerationLog/AbuseReport/管理対象。
- 副作用: 監査・配信停止・メール・キャッシュ/公開設定反映。
- 本家: [update-meta.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/update-meta.ts)、[AbuseReportService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/AbuseReportService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-federation"></a>

### AP受信・remote解決・actor公開

inbox全activity・検証/remote actor/Note解決・照会、AP actor/object/outbox/followers等とWebFinger/relay/instance管理を扱う。

- 担当: [#195](https://github.com/tiramiss-community/tiramiss/issues/195).
- 正本/保存: remote User/Note/関係/instance/relay / inbox進捗。
- 副作用: 署名/文書取得・HTTP・受信副作用・AP応答・federation cache。
- 本家: [ActivityPubServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/ActivityPubServerService.ts)、[ApInboxService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApInboxService.ts)、[ApResolverService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApResolverService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-ap-outbound"></a>

### 投稿AP送信・宛先

投稿のAP本文・宛先選定・署名送信・Delete/Undo。署名HTTP(#160)・通常worker(#162)・投稿表現(#171/#172)で接続する。永続宛先台帳・host lease・結果不明の追跡は保留(#159/#161)。

- 担当: [#124](https://github.com/tiramiss-community/tiramiss/issues/124).
- 正本/保存: 本家相当の通常BullMQ deliver queue。
- 副作用: 外部AP HTTP・本家相当のretry/backoff。
- 本家: [ApDeliverManagerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApDeliverManagerService.ts)、[ApRequestService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApRequestService.ts)。
- 新実装: [note-delivery.ts](../../../../packages/backend-next/src/modules/federation/note-delivery.ts)、[deliver-job.ts](../../../../packages/backend-next/src/modules/federation/deliver-job.ts)、[deliver.ts](../../../../packages/backend-next/src/platform/job-queue/deliver.ts)、[deliver-job.ts（composition）](../../../../packages/backend-next/src/composition/deliver-job.ts)。
- 検証根拠: [note-deliver.test.ts](../../../../packages/backend-next/test/processes/note-deliver.test.ts)、[deliver-queue.test.ts](../../../../packages/backend-next/test/integration/deliver-queue.test.ts)、[deliver-processor.test.ts](../../../../packages/backend-next/test/integration/deliver-processor.test.ts)。
- 既知差異: 旧PG宛先snapshot/page/host leaseはPR #212/#213で撤去。本家の業務規則はdocs/backend-next/ap-delivery-handoff.mdに残す。#171の最初のPRでノート作成の配送（relayを除く）を接続。relay・LD署名は#171の2番目のPR、チャートは#200、成功時のfetchInstanceMetadataは#215段階5。意図的な差異はdocs/superpowers/compatibility/ap-deliver/README.md。

<a id="domain-web"></a>

### HTML・feed・preview・公開配布経路

AcceptによるAP/HTML分岐、SPA/OGP/embed/feed/robots/OpenSearch/sw/manifest/assets/tarball、URL preview/RSS等を扱う。

- 担当: [#196](https://github.com/tiramiss-community/tiramiss/issues/196).
- 正本/保存: 公開Note/User/コンテンツ/設定 / preview cache。
- 副作用: HTML/feed・外部URL取得・配布・ブラウザcache制御。
- 本家: [ClientServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/ClientServerService.ts)、[FeedService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/FeedService.ts)、[UrlPreviewService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/web/UrlPreviewService.ts)、[ServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/ServerService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-user-webhook"></a>

### user webhook設定・全イベント配送

hook管理6API/テスト、投稿に加えfollow/unfollow/followed/reaction等の全イベント、secretの実行時取得、有限配送/unknownを扱う。投稿sliceは#175を再利用する。

- 担当: [#197](https://github.com/tiramiss-community/tiramiss/issues/197).
- 正本/保存: UserWebhook / 固定依頼・配送進捗。
- 副作用: userWebhookDeliver HTTP・署名・retry。
- 本家: [UserWebhookService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UserWebhookService.ts)、[Webhook.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/models/Webhook.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-system-webhook"></a>

### system webhook設定・配送

system hook管理・test・対象業務eventと固定依頼/署名配送をuser hookと区別する。

- 担当: [#198](https://github.com/tiramiss-community/tiramiss/issues/198).
- 正本/保存: SystemWebhook/対象関連 / 固定依頼・結果。
- 副作用: systemWebhookDeliver HTTP・署名・retry/unknown。
- 本家: [SystemWebhookService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/SystemWebhookService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-maintenance"></a>

### import/export・移動/削除・保守ジョブ

エクスポート/インポート、account移動/削除、期限mute/announcement archive/remote cleanup等。保存/外部の部分完了を機能別に設計。

- 担当: [#199](https://github.com/tiramiss-community/tiramiss/issues/199).
- 正本/保存: 各業務正本 / 再開cursor/取消・清掃進捗。
- 副作用: exportファイル・関係/AP・削除・期限処理・有限回復。
- 本家: [QueueService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[QueueProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/QueueProcessorService.ts)、[DeleteAccountProcessorService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/queue/processors/DeleteAccountProcessorService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-analytics"></a>

### charts・retention・統計

chart各系列/retention/statsと集計/tick/resync/clean、履歴的countと復元不能な期間を扱う。

- 担当: [#200](https://github.com/tiramiss-community/tiramiss/issues/200).
- 正本/保存: chart系列/retention/履歴集計 / buffer。
- 副作用: 定期集計・flush・保持清掃。
- 本家: [ChartManagementService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/ChartManagementService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-queue"></a>

### ジョブ管理・照会・制御

本家queue単位の照会・制御・retry・QueueStats・履歴/清掃を通常BullMQ公開APIで移植する。

- 担当: [#163](https://github.com/tiramiss-community/tiramiss/issues/163).
- 正本/保存: BullMQ/Redisのqueue状態 / ModerationLog。
- 副作用: pause/resume/retry/promote/remove/clean・監査。
- 本家: [QueueService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)、[show-job.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/api/endpoints/admin/queue/show-job.ts)。
- 新実装: [connection.ts](../../../../packages/backend-next/src/platform/job-queue/connection.ts)、[ended-poll-notification.ts](../../../../packages/backend-next/src/platform/job-queue/ended-poll-notification.ts)、[deliver.ts](../../../../packages/backend-next/src/platform/job-queue/deliver.ts)。
- 検証根拠: [poll-ended-job.test.ts](../../../../packages/backend-next/test/integration/poll-ended-job.test.ts)、[deliver-queue.test.ts](../../../../packages/backend-next/test/integration/deliver-queue.test.ts)。
- 既知差異: 独自PG実行基盤（依頼/claim/復旧）はPR #212/#213で撤去。#162で通常BullMQのQueue/Workerを投票終了ジョブから接続し、#171でdeliver queue（本家と同じjob名・data・試行・backoff・保持・Worker設定）を足した。Redis接続は再接続せず、稼働中の切断を子の異常終了にする（本家はBullMQの既定のretryStrategyで1〜20秒の指数待ちにより無期限に再接続）。管理API・QueueStatsは未実装。

<a id="domain-operations"></a>

### 起動・migration・CLI・配布

Supervisor/HTTP/worker・設定/DB/Redis・migration/check・CLI・healthz・配布/監視と完全停止切り替えを扱う。本家設定キー・環境変数の互換、観測（Sentry/telemetry）の扱い、DB接続・ID形式など既存データ形式の互換もここで判断する。

- 担当: [#138](https://github.com/tiramiss-community/tiramiss/issues/138).
- 正本/保存: 本家public履歴/独自履歴 / 設定・接続。
- 副作用: 起動終了・CLI・観測・リリース判定。
- 本家: [cli.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/boot/cli.ts)、[HealthServerService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/HealthServerService.ts)。
- 新実装: [supervisor.ts](../../../../packages/backend-next/src/processes/supervisor.ts)、[lifecycle.ts](../../../../packages/backend-next/src/processes/lifecycle.ts)、[migrate.ts](../../../../packages/backend-next/src/platform/database/migrate.ts)。
- 検証根拠: [children.test.ts](../../../../packages/backend-next/test/processes/children.test.ts)。
- 既知差異: 本家/独自migration分離、通常起動時自動migrationなし、完全停止切り替え。通常workerは投票終了ジョブ（#162）とAP配送ジョブ（#171）だけを実行する。他の業務handlerと配布の統合は未完了。物理容量停止(#166)は保留。

<a id="domain-federation-base"></a>

### 連合の共通土台（システムアカウント・鍵・ホスト判定・排他）

システムアカウントの遅延生成と鍵、ユーザー鍵/公開鍵と鍵形式、ホスト名の正規化と自ホスト判定、連合許可・ブロック・サイレンス・配信停止ソフトウェアの判定、連合インスタンス情報の取得・状態更新・自動停止、APオブジェクト単位の排他。AP受信(#195)・署名送信(#160)・投稿AP(#171)の先行契約。

- 担当: [#215](https://github.com/tiramiss-community/tiramiss/issues/215).
- 正本/保存: SystemAccount/UserKeypair/UserPublickey/Instance / Metaの連合設定 / Redis lock/キャッシュ。
- 副作用: 鍵生成・インスタンス状態更新・配送スキップ/自動停止。
- 本家: [SystemAccountService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/SystemAccountService.ts)、[UtilityService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/UtilityService.ts)、[FederatedInstanceService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/FederatedInstanceService.ts)、[FetchInstanceMetadataService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/FetchInstanceMetadataService.ts)、[distributed-lock.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/misc/distributed-lock.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 監査行: 32 行（うち監査時に計画あり以外 25 行）。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-outbound-http"></a>

### 外向きHTTPとSSRF対策

AP取得/配送・リモートファイル取得・URLプレビュー・webhook・Web Pushが共有する外向きHTTP。プライベートアドレス遮断とallowedPrivateNetworks、proxy/proxyBypassHosts/outgoingAddress、サイズ・時間・redirect制限。

- 担当: [#216](https://github.com/tiramiss-community/tiramiss/issues/216).
- 正本/保存: 設定（proxy/allowedPrivateNetworks/outgoingAddress）。
- 副作用: 外部HTTP・名前解決・一時ファイル。
- 本家: [HttpRequestService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/HttpRequestService.ts)、[DownloadService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/DownloadService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 監査行: 10 行（うち監査時に計画あり以外 9 行）。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。

<a id="domain-process-events"></a>

### プロセス間イベントとキャッシュ同期

GlobalEventのRedis pub/sub形式、internalイベントの発行と購読、CacheService・Metaキャッシュ・Redis/メモリ二層キャッシュとTTL。各機能のキャッシュ自体は機能の領域が持ち、通知と反映の契約をここで揃える。Roleの無効化通知(#119)を一般化する。

- 担当: [#217](https://github.com/tiramiss-community/tiramiss/issues/217).
- 正本/保存: Redis pub/sub / Redis/メモリキャッシュ。
- 副作用: 他プロセス・接続中streamへの状態反映。
- 本家: [GlobalEventService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/GlobalEventService.ts)、[CacheService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/CacheService.ts)、[cache.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/misc/cache.ts)、[MetaService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/MetaService.ts)。
- 新実装: 未実装。
- 検証根拠: 未接続。担当 Issue で固定本家との比較 fixture と受け入れを追加。
- 監査行: 50 行（うち監査時に計画あり以外 38 行）。
- 既知差異: この棚卸しで新たな差異は採用していない。実装時の差異は個別に記録する。
