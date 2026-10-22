# backend-next

Misskeyバックエンド再設計の実行基盤とRole初期実装。
既存トークンで `admin/roles/show` と `admin/roles/update` を利用できる。
その他のAPIと業務ジョブは後続の実装範囲。

## Role実装に着手するとき

#116の成果物は[Role互換性契約](../../docs/superpowers/specs/2026-10-17-role-compatibility-contract.md)と[本家比較資料](../../docs/superpowers/compatibility/role/README.md)にある。比較資料にはJSONの期待値、再実行できるTypeScript probe、固定した本家コミットと実行結果を保存している。

#117–#121では[後続Issueでの利用と更新](../../docs/superpowers/compatibility/role/README.md#後続issueでの利用と更新)に従い、担当する期待値を新実装のテストへ接続する。本家probeの通過は本家側の確認結果であり、新実装のテスト成功とは扱わない。

## ビルドと起動

リポジトリが指定するNode.jsとpnpmを用いる。

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-upstream sync:check
pnpm --filter backend-next... build
```

本家形式の`.config/default.yml`を読み込む。`NODE_ENV=test`では`test.yml`、
`MISSKEY_CONFIG_YML`では`.config/`基準のファイル名または絶対パスを指定できる。
旧backendの設定コンパイルやビルドは不要。

```yaml
backendNext:
  workerCount: 1
  startupTimeoutMs: 30000
  shutdownTimeoutMs: 30000
```

サービスを完全停止した状態で、先にマイグレーションを適用する。
既存MisskeyのDB・データは事前にバックアップし、稼働中の旧backendへ接続して適用しない。

```sh
pnpm --filter backend-next migrate
pnpm --filter backend-next check-migrations
pnpm --filter backend-next start
```

`migrate`は本家の`public.migrations`を引き継ぎ、全履歴の未適用分を実行した後、
`backend_internal`とその独立した履歴、投稿の依頼・初期仕事・取消世代・論理容量テーブルを初期化する。
本家の`MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY=1`指定も引き継ぐ。
起動時は適用状況を確認するだけで、履歴やschemaを自動作成しない。

SupervisorはHTTP×1、worker×指定数を起動し、全子のreadyを待つ。
子の予期しない終了時は兄弟も停止して異常終了し、自動再起動しない。
`SIGTERM`/`SIGINT`では受付を止め、処理・接続の終了を期限まで待つ。
期限超過は異常終了する。HTTP接続切断を業務取消として扱わない。

プロセスを外部管理する場合は`start:http`、`start:worker`を使う。
各子は独自のDB・Redis接続を持つ。Redisなしの縮退運転はしない。
ログはstdoutへのJSON行で、設定全体や認証情報を出力しない。

## 検証

テスト専用のPostgreSQL・Redisを使う。既存の`misskey-infra`とは別のComposeプロジェクトであり、
コンテナ名・ネットワーク・ポートを共有しない。データはtmpfsに置く。

```sh
docker compose -p backend-next-test -f packages/backend-next/compose.test.yml up -d --wait
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next... lint
pnpm --filter backend-next test
pnpm --filter backend-next test:integration
pnpm --filter backend-next test:acceptance
pnpm --filter backend-next test:process
docker compose -p backend-next-test -f packages/backend-next/compose.test.yml down
```

既定ポートはPostgreSQL `55432`、Redis `56379`。
`BACKEND_NEXT_TEST_DB_PORT` / `BACKEND_NEXT_TEST_REDIS_PORT`で変更できる。
結合・プロセステストは専用DBに接続し、`backend_next_<ランダムID>`のDBだけを作成・削除する。
本番設定は読み込まない。

`check-schema`は検証用DBで使う。同期したEntityの対象に限って定義差分を検出し、DDLは実行しない。
本家の未同期Entityに対応するテーブルを削除対象として扱わない。

本家のコピーを更新する場合は`backend-upstream/README.md`を参照。
アーキテクチャと後続のRole実装範囲は`docs/superpowers/specs/`に記載する。

## Role材料キャッシュ（#119）

各HTTP/workerプロセスの起動時に、Role定義全件とユーザー別手動割り当てのメモリキャッシュ、専用Redis購読を作る。Redisに材料の値は保存しない。実効ポリシーは複数操作間でキャッシュせず、操作内のRoleEvaluationだけでメモ化する。

```yaml
backendNext:
  roleCache:
    rolesTtlMs: 30000
    assignmentsTtlMs: 30000
    assignmentsMaxEntries: 10000
```

上記は既定値。各値は正のsafe integerを指定する。期限は単調時計でDB取得開始から数え、参照で延長しない。割り当ては取得中の項目を含むLRUで件数制限する。業務上の割り当て失効はRoleEvaluationの基準時刻で別に判定する。

`runtime.roleMaterials` の `readRoles` / `readAssignments` を通常参照のRoleFactsReaderに渡し、ユーザー属性・インスタンス設定は操作内で取得する。`changes` は `createUpdateRole` に渡すRoleChangesであり、UseCaseがcommit後に操作内メモ・自プロセスの材料を無効化し、Redis通知を試みる。更新認可は引き続きtx内DB材料を使う。HTTP・認証・ID codecとの組み立ては#120で接続済み。

発行・購読とも `redisForPubsub`（省略時は `redis`）へ接続する。channelは `<prefix>:backend-next:role-materials:v1`。プロセス間で同じ接続先とprefixを使う。通知には `{ kind: 'role-definitions-changed', roleId }` だけを載せ、受信側はRole全件を破棄する。割り当て・ユーザー・設定の更新APIはまだなく、それらの通知契約は各書き込み機能の追加時に接続する。

購読切断・再接続時に両材料を破棄し、subscribe応答の確認までは通常参照をエラーにする。通知だけが欠落した場合は期限後の次の参照でDBから取得する。無効化・追い出し済みの取得が完了してもキャッシュへ戻さない（開始済みの呼び出しにはその取得値を返せる）。接続切断や購読世代変更をまたぐ取得はエラーにする。再接続できるのは購読接続で、稼働後に発行接続が予期せず終了した場合は既存の停止経路へ障害を通知し、受付停止・期限付きの受理済み処理待機を経て子プロセスを異常終了する。Supervisorも兄弟プロセスを停止する。再起動は運用側で行う。通常のリソース解放による切断は異常終了にしない。Redis操作失敗によるDBへの縮退は行わず、commit後の通知失敗は更新の失敗へ変換しない。

## Role HTTP API

`POST /api/admin/roles/show` はモデレーター以上、`POST /api/admin/roles/update` は管理者の資格を要求する。JSON本文の `i`、または大文字小文字を区別する `Authorization: Bearer <token>` を使う。Bearerがあれば本文へ再試行しない。16文字のnative token、既存AccessTokenのhash/token、Appに設定されたscopeを認証する。AccessTokenはshowで `read:admin:roles`、updateで `write:admin:roles` が必要。資格・scopeの判定はUseCaseで入力検証より先に行う。

showはロールと有効な手動割り当て人数を取得した後、DBにアクセスせず表示形へ変換する。updateは同一トランザクションで最新DBの認可・更新・監査を確定し、成功時は204・空本文。接続切断を取消へ結び付けず、送信失敗でも更新を再実行しない。非文字列token（null/未指定以外）は、合意済みの修正として400・空本文で完了する。

本家設定 `id`（`aid` / `aidx` / `meid` / `meidg` / `ulid` / `objectid`）をIDの日時復元と監査ID生成へ渡す。大文字小文字は正規化し、未知の方式は起動時に拒否する。未指定時は `aidx`。移行先では既存DBと同じ方式を設定する。

受け入れ比較の固定期待値は[Role比較資料](../../docs/superpowers/compatibility/role/README.md)を参照。`test:acceptance` は実トークンHTTP・保存/監査・次操作のポリシー評価・通知前停止とTTL回復を検証する。既存の `test:integration` はDB/Redisの障害・競合、`test:process` は起動停止・切断を担い、3つとも専用CIの必須step。固定期待値の変更もCIを起動する。本家比較と意図的差異・検証範囲は比較資料の#121受け入れ表を参照。

## 投稿フローの後続設計

Role の次は [投稿フロー詳細設計](../../docs/superpowers/specs/2026-10-21-note-flow-design.md)（#126）を参照する。作成・取得・削除・配送の所有範囲、比較ケース、#123/#124 へ渡す実ジョブ条件、#127 の実装分割をまとめている。設計の存在は投稿 API・実ジョブの実装完了を意味しない。

[実ジョブの保存・再開・形式変更の契約](../../docs/superpowers/specs/2026-10-21-job-persistence-design.md)（#123）は、AP 配送とローカル通知を題材に、PostgreSQL の正本、投入/実行 claim、削除との競合、有限な試行・保持・容量、形式移行と #124 の受け入れ条件を定める。基盤実装は #124、投稿 API への接続と本家比較は #127 で行う。


## 投稿の永続依頼：J1 保存（#124）

`modules/post-work/public` は `PostWorkRequests.append` と AP 展開・ローカル通知の型付き依頼を公開する。
`platform/database/post-work/append` の `withPostWorkRequests(manager, callback)` を、呼び出し元が所有する transaction 内で使う。
組み立て側で同じ manager に結び付けた業務更新窓口と requests を UseCase の scope へ渡す。UseCase に manager は渡さない。
以下は adapter の組み込み形であり、投稿 UseCase/HTTP の実装は #127 で接続する。

```ts
await source.transaction(manager =>
  withPostWorkRequests(manager, requests => requests.append(confirmedPostWork)));
```

callback が終了すると新しい append は拒否し、開始済みの append が全て終わってから呼び出し元へ戻る。
append の失敗を callback が catch した場合も、scope 全体は失敗する。業務更新と同様に append を await する。
adapter 自身は commit・enqueue・自動再試行をしない。COMMIT 応答不明のときも投稿を再作成せず、
既知の requestId/eventId で保存結果を確認する。不在を一回読んだだけで rollback とは断定しない。

初期形式は schemaVersion=1。AP は Create/Announce（世代1）、Delete/Undo（世代2）の固定 activity ID・
JSON 本文と direct actor ID を受け、followers/relay 集合の固定は後続の実行時に行う。
公開範囲・localOnly・channelId は作成時の確定値で、削除でも広げない。
通知は候補 recipientId と reply/mention/quote/renote/note の組を受け、対象別の初期 item を同時保存する。
本文中に秘密鍵・認証 token を渡さない。AP 全表現・署名・通知条件の本家互換性は N4/N6 の検証対象。

`(eventId, kind, noteGeneration)` が同じ依頼は、完全な immutable 内容と hash を照合し、
既存 requestId を返す。新しい requestId で同じ仕事を増やさず、item の進捗・回数・期限を上書きしない。
本文廃棄後、内容不一致、requestId の別業務キーへの再利用、削除後の新たな世代1依頼は拒否する。
既存依頼の照合は削除後にも可能だが、世代を戻したり新しい item を生成したりしない。

内部の4テーブルは `note_work_state` / `work_request` / `work_item` / `work_capacity`。
独自 migration に up/down があり、通常起動は未適用を拒否する。`check-schema` は内部定義の差分も読み取り専用で検出する。
100万行・20 GiB の論理予約に対して、通常は90%、削除は100%まで同一 transaction の条件付き更新で確保する。
各行に算定版と予約 bytes を保存し、容量行自身の baseline も含める。依頼全体は UTF-8 で最大2 MiB。
これは物理ディスク上限ではない。J1 の結合テストでは代表・最大本文の実 relation サイズと比較するが、全運用条件を保証しない。

この段階では依頼は保存されるだけで実行されない。J2 は BullMQ・dispatch/実行 claim・recipient/通知成立記録・実 worker、
J3 は管理操作・清掃・物理容量監視・形式移行/運用の検証へ進む。受理入口はまだ HTTP に公開せず、
清掃による容量の解放もまだないため、J1 だけで運用可能なジョブ基盤や #124 全体の完了とは扱わない。

## 投稿の投入アダプタ：J2a（#124）

`platform/database/post-work/dispatch` の `PostWorkDispatchStore` と `scanPostWork` は、
J1の確定済みitemを最大100候補/回・候補ごとのtransactionで投入claimし、
`platform/jobs/bullmq-dispatch` の `BullmqDispatch` へ渡す。
AP展開/ページ・通知は `postLocal`、AP送信は `deliver`。展開のclaimはdeliverのpauseも確認する。
物理queueのprefixは旧backendと分け、Redisの `keyPrefix` は指定しない。

投入claimは30秒、開始未確認の再投入は60秒後。seqはclaimごとに増加する。
各queueの未解放予約は最大10000件で、DBの行/bytes枠も同時に予約する。
満杯の候補は `capacity_wait` として30秒待ち、後続候補の走査を続ける。
投入回数は `attempt_count` を増やさない。保存したdispatch行は枠解放後もDB容量へ課金する。

BullMQは6.3.11へ固定し、インストールされた `addStandardJob` Luaの前に
queue世代・token・Redis時刻による絶対期限の検査を挿入する。
検査と追加は同じRedis原子操作であり、通常の `add` の前に別操作で確認する方式ではない。
tokenの期限はDB予約時刻+60秒から延長しない。DB/Redisの時計差が5秒超なら投入を拒否する。
Redisに保存するdataはworkId/kind/schemaVersion/dispatchSeq/queueGenerationのみで、固定本文はDBから読む。
BullMQ更新時にはこの内部スクリプト境界を再レビューするまで起動を拒否する。

`reconcilePostWork` は期限切れ予約を最大100件ずつ照合する。
先にtokenを失効させ、entryの欠落/終了または除去を確認できたときだけDBのqueue枠を一度解放する。
activeや応答不明では予約を残す。照合時刻を更新し、古いactive100件で後続の照合を止めない。
DB確定前にenqueue応答が失われても、元のworkIdを保持したまま次のseqで回収する。

**自動起動と実行UseCaseにはまだ接続していない。** `initialize(queue,generation)` は呼出側が
DBと照合した世代を使う低層操作であり、Redis全喪失後に同じ世代で再初期化してはならない。
worker起動前の世代切替/旧予約の照合は下記J2bの回復入口を使う。5秒周期の走査、実行claim/lease/試行予算、
固定宛先・fake inboxへの配送、通知結果の同時確定、プロセス寿命への接続をJ2bで段階実装する。
初期ローカル仕事のDB実行権は下記J2b1を参照。
管理操作・清掃・形式移行などのJ3と合わせて、#124全体の完了条件を検証する。

## Redis消失後の起動調停（#124 / J2b）

`platform/database/post-work/recovery` の `recoverPostWork(source, transport)` は、将来の
worker/HTTPのready、consumer、scanner開始より前に呼ぶ起動入口。現在のプロセス起動にはまだ接続しない。
専用PostgreSQL接続のsession advisory lockで並行初期化を直列化し、正常なgateが両queueにあれば
世代を維持する。gate欠落/旧世代では両queueのDB世代を進め、`recovery_pending`を同じtransactionで保存する。
そのcommit後にRedis gateを観測値とのCASで進める。未知/未来のgateやCAS不一致は起動失敗とする。

回復中は投入/ローカル実行claimを開始しない。旧世代の未解放予約はtoken期限に関係なく最大100件/回で
照合し、Redis token失効とentry除去/終了の確認後だけ既存の条件付きreleaseでqueue枠を返す。
全予約の照合と両gateの再確認が終わってから、両queueのpendingを同時に解除する。
active entry・Redis応答不明・DB障害では起動失敗にし、予約をゼロ扱いしない。
古いworkerの有効な業務実行lease、累積試行数、元の期限、保存行/bytesへの課金は変更しない。

途中停止後はDBのpending世代を再利用して再開し、成功済みreleaseは二重計上しない。
専用DB接続は失敗時も破棄するため、poolへadvisory lockを持ち帰らない。
遅延した旧世代のenqueueはRedis gateで拒否される。古いcompleted/failed履歴や未知entryは業務結果と扱わず、
将来のconsumerも必ずDBのenvelope/世代/保存形式検証を通す。
この入口自体は稼働中Redis障害の監視・停止経路や既存起動期限への接続を行わず、
通知/AP業務処理・実workerの寿命への接続と併せて後続J2で実装する。#124全体は未完了。

## ローカル仕事の実行権：J2b1（#124）

`platform/database/post-work/local-execution` の `PostWorkLocalExecutionStore` は、初期の
`ap.expand` と `notification.create` の DB 実行権を扱う。投入とは別の claim であり、
保存済み dispatch・queue 世代・kind/版・request/item の本文/hash/対象を照合する。
無関係な envelope や解放済み予約は保存状態を変えない。保存形式が壊れていれば隔離して確認対象にする。
`ap.send` と `ap.expand.page` は後続 adapter の担当であり、この adapter では実行権を取得しない。

request の解析・正規化・hash 検証は queue 制御行をロックする前に行う。
同じ store 内では直近の最大4依頼、保存元 JSON/メタデータ合計4 MiBまでの検証結果を再利用し、
対象を Map で参照する。保存元の本文・hash・固定メタデータが変われば再検証し、item の
本文/hash・対象・期限は毎回照合する。再利用する request は深く凍結し、claim 経由の変更を防ぐ。
この上限は保存元データのサイズであり、解析後のオブジェクトや索引を含むヒープ使用量の上限ではない。
DB からの本文取得と同一内容の文字列比較は残る。queue 制御は共有ロックで読むため、
claim 同士の読み取りを妨げず、pause/世代変更や投入claimの排他ロックとは調停する。

ロック順は note 状態→item→queue 制御。実行可能な claim だけが累積試行回数を一回増やし、
60秒の lease と増加する epoch を取得する。ローカル仕事は合計8試行まで。
pause・未来の item 時刻/依頼の not-before・有効 lease 中の重複では試行を消費しない。
削除された投稿の未開始作成仕事は cancelled にする。AP 展開は deliver の pause も確認する。
`renew` は既存の owner/epoch/有効 lease/期限を確認し、ロック待ち中に失効した lease を復活させない。

業務結果の adapter は、呼出側が所有する同じ transaction の
`withLocalWorkCompletion(manager, claim, work)` 内で DB 結果を書き、outcome を返す。
先に note/item をロックして実行権と取消を検査し、callback 後も owner/epoch/lease/期限を
条件付き更新で再確認する。失敗例外は transaction 境界まで伝播させ、結果と進捗をともに rollback する。
DB 外への送信をこの callback に入れない。`finish` は業務結果の書込みを伴わない進捗更新用。
COMMIT 応答不明で同じ callback を自動再実行せず、後続の成立記録から確認する。

retry は DB 時刻から指数 backoff（60秒から最大1時間、0–20%加算 jitter）を保存し、
8試行または元の期限に達する場合は exhausted にする。終端時は全子 item を確認して
依頼を settled/needs_attention に集約する。`expire` は期限/予算切れで有効 lease のない
ローカル item を最大100件/回で終端化する。投入 scanner が除外する期限切れもこの窓口で回収する。

この段階では通常 worker は起動・停止の枠だけで、ジョブを実行しない。J2b の残りは、
本家 Note の保存 fixture、通知の実保存と成立記録、宛先固定/ページ/host lease と実配送、
Redis 世代回復、BullMQ worker・5秒走査/10秒 lease 更新・プロセス寿命への接続。
通知条件/AP 表現の全移植は引き続き N4/N6、管理・清掃は J3 で扱い、#124 は完了にしない。
