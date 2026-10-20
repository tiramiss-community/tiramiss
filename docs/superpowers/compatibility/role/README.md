# Roleの本家比較資料

対象は[#116](https://github.com/tiramiss-community/tiramiss/issues/116)。契約の正本は[仕様書](../../specs/2026-10-17-role-compatibility-contract.md)。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。

## 資料

| ファイル | 用途 |
| --- | --- |
| `http-cases.json` | actor・対象API・入力差分・HTTP status・error code/id/message/kind・認証ヘッダー・入力エラーinfo。roleIdは投入した対象ロールのIDへ置換 |
| `intentional-http-cases.json` | 承認済みの仕様修正。本家での観測と新実装の期待値を区別 |
| `policy-defaults.json` | 本家の全39ポリシーのコード既定値。時間式は分の数値に展開 |
| `reference-role.e2e.ts` | 実HTTP・DB・Redisによる上記ケース、部分更新、監査before/after、無変更更新、Bearer優先の確認 |
| `reference-role.unit.ts` | 固定時刻・固定材料で本家の評価メソッドを実行する追加probe |

probeは参照checkoutの `packages/backend/test/` へコピーして実行する。本リポジトリの旧backendや新backendの製品コードに追加するテストではない。#117以降ではJSONの期待値と仕様書のケースを新実装のテストへ接続する。本家の型・Serviceを新実装の依存にしない。

追加unit probeは取得済み材料を仮実装で渡す。本家の計算処理は実物を呼び、計算結果のコピーを実行しない。HTTP probeは実トークンを認証し、サーバーと別接続で保存行・監査を読む。日時・生成ID・tokenをgolden値にせず、形式・関係・期待する結果をassertする。

## 後続Issueでの利用と更新

新しいセッションは[backend-nextの開発ガイド](../../../../packages/backend-next/AGENTS.md)から本資料へ到達できる。#116の調査を最初から繰り返す前に、[仕様書](../../specs/2026-10-17-role-compatibility-contract.md)と次の担当範囲を確認する。

| 後続Issue | 参照する資料 | 実装時に接続・検証すること |
| --- | --- | --- |
| [#117](https://github.com/tiramiss-community/tiramiss/issues/117) 評価・メモ化 | 仕様書§3–5、`policy-defaults.json`、`reference-role.unit.ts` | 既定値・期限・条件・集約・資格の入力と期待結果を新しい純粋関数の単体テストへ移す。固定時刻・メモ境界・更新後の無効化も検証する |
| [#118](https://github.com/tiramiss-community/tiramiss/issues/118) 更新・認可・監査 | 仕様書§2・5–7、`reference-role.e2e.ts`の部分更新・監査確認 | 保存パッチ、認可とscopeの拒否順、監査スナップショットをUseCase・実DBテストへ接続する。同時確定・rollback・並行更新は新設計の期待値で追加する |
| [#119](https://github.com/tiramiss-community/tiramiss/issues/119) 材料キャッシュ | 仕様書§5.4・7、Role詳細設計§6.2 | TTL・通知欠落・取得中の無効化・再接続・操作内メモとの接続を検証する。本家probeに新キャッシュ方式の検証があるとは扱わない |
| [#120](https://github.com/tiramiss-community/tiramiss/issues/120) 認証・HTTP | 仕様書§2・5・7、`http-cases.json`、`intentional-http-cases.json`、`reference-role.e2e.ts` | actorを新実装のテストデータへ対応付け、API名・roleIdを変換して同じ期待値でHTTPと保存結果を検証する。補足5件のassertionも引き継ぐ |
| [#121](https://github.com/tiramiss-community/tiramiss/issues/121) 総合検証 | 上記すべて、仕様書§7–8 | 同じ初期状態・操作で新旧を比較する。本家互換と意図的な差異を分け、障害・競合の検証結果とCI接続先を記録する |

JSONは本家側の既定値・応答と承認済みの差異を保持する共通の期待値。新実装のテストからファイルとして読み込めるようにし、実装ごとに値を手で複製して別々に更新しない。`http-cases.json`のactor名はprobeの初期データに対応する論理名であり、APIへ渡す値ではない。

TypeScript probeは固定コミットの本家を調査・再実行するためのもの。新実装へ本家Service・NestJS・ORM型のimportを持ち込まず、入力とassertionを新しい公開契約に対応付ける。後続Issueの成果物には、接続した新テストのファイル・コマンド・結果と、まだ接続していないケースを残す。本家用probeを置いただけで新実装の検証完了にはしない。

新実装と期待値が食い違ったら、まず固定コミットと仕様書を確認する。コード読解だけの事項や未収録ケースは必要な範囲を追加調査し、実行確認と区別して記録する。単に新実装を通すために期待値を書き換えない。本家の比較コミットを更新する場合は、#134の追従方針に沿って影響する期待値・probeを再確認し、対象SHA・実行結果・意図的な差異の採否を一緒に更新する。

`/tmp`の参照checkoutや実行ログは再利用の前提にしない。必要なソースは固定SHAから、手順は本資料から再構成する。通常の新実装CIは記録した期待値を使い、本家環境の再構築は初回比較・対象契約の変更・追加調査が必要な場合に行う。

## #117 評価処理と操作内メモの接続

新実装の公開入口は [`packages/backend-next/src/modules/role/public.ts`](../../../../packages/backend-next/src/modules/role/public.ts)。[評価設計](../../specs/2026-10-17-role-evaluation-design.md)に沿って、次のテストを通常のbackend-next単体テストへ接続した。

| 新テスト（`packages/backend-next/test/unit/role/`） | 接続した期待値 |
| --- | --- |
| `conditions.test.ts` | unit probeの条件全種類・空and/or・壊れた条件、作成日時と割り当て期限の等号、非連鎖、条件付きロールの既存割り当て |
| `policies.test.ts` | `policy-defaults.json`全39件、unit probeの優先順位・基本値・boolean/number/chat/ファイル型集約、匿名の上限免除、rootの通常ポリシー |
| `privileges.test.ts` | unit probeの未認証・root・管理者・モデレーター資格 |
| `evaluation-memo.test.ts` | 新設計の並行取得集約・失敗後の取得・依存単位の無効化・旧取得の遅い成功/失敗・終了・値の変更隔離 |
| `evaluation.test.ts` | 新設計の基準時刻・試行境界・材料共有・ユーザーと参照条件の分離・全材料の変更反映・取得中の無効化・終了後の未確定値の非公開 |

新たにコード読解で照合した異常値の範囲: priorityは厳密な1/2のみを特別扱いし、boolean候補は厳密なtrueのみ、数値候補はJavaScriptの数値変換を通す。欠けた/nullのentryは基本値の候補だが、entryが空objectなら数値はNaNになり得る。policies自体のnull、ファイル型配列の非文字列要素は例外になる。これらは固定SHAの `getUserPolicies` の読解に基づく新実装の回帰テストであり、本家で追加probeを再実行した結果とは区別する。未知の基本ポリシーキーは匿名の結果には残り、ログイン済みの集約結果には含まれない。

後続で使う際は、一つの操作に評価境界を作る。通常参照・トランザクションDB参照にはそれぞれ専用セッションを作り、同条件の再利用では同じセッションを渡す。各セッションは作成時の取得窓口へ固定される。トランザクション内のセッションはコールバックのfinally、境界は操作のfinallyでcloseする。許容できる通常参照メモは、トランザクションを開始しても破棄されない。

自操作で材料を変更したら、境界の `invalidate` に `roles` / `assignments`とuserId / `user`とuserId / `instance` を渡す。取得中に依存材料が変わると `EvaluationInvalidated`、終了後の取得には `EvaluationClosed` が返る。評価側からDB操作を自動再試行しない。必要な再評価は同じ境界・同じ基準時刻で明示的に行う。commit後の材料キャッシュ無効化は#118・#119で接続する。

検証環境: Node.js `v24.20.0`、pnpm `12.9.1`。2026-10-17の実行結果:

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter backend-upstream sync:check` | PASS |
| `pnpm --filter backend-next... build` | PASS |
| `pnpm --filter backend-next... typecheck` | PASS |
| `pnpm --filter backend-next test` | PASS、101件（新Role 84件、既存17件） |
| `node scripts/check-shipping.mjs` | PASS。変更TS15件のlint、SPDX、locale safety |
| 独立した読み取り専用レビュー | Critical / Importantなし。Role単体84件を再実行してPASS。既存の未接続表記と#117接続記録の矛盾を修正 |

今回の新テストはHTTP・DI・DB・Redisなしで実行する。既存の全体単体テストにはbackend-upstreamのビルドが必要なため、上記の依存順ビルドを先に行う。通常CIの既存 `test/unit/**/*.test.ts` に含まれる。

未接続: 本家HTTP期待値、認証・保存・監査、実DBトランザクション、材料キャッシュ・Redis通知、通知欠落の回復、新旧双方の統合比較。#118・#119、次に#120、#121で検証する。新実装の純粋評価・操作内メモの通過をRole初期実装全体の完了とは扱わない。

## #118 更新・認可・監査の接続

[実装計画](../../plans/2026-10-17-role-update.md)に沿って、Role公開入口の `createUpdateRole` と永続化アダプタ `createRoleUpdateTransactions` を追加した。既存の `TransactionRunner` に `roles`・`authorizationFacts`・`auditLogs` だけを束ねる。ロールと監査は本家テーブルへ保存し、Entity・migration・同期範囲は変更していない。

| 新テスト（`packages/backend-next/test/`） | 接続した期待値 |
| --- | --- |
| `unit/role/update-role.test.ts`（14件） | サスペンド→管理者資格→scope→対象の拒否順、自己昇格の拒否、条件付き管理者と期限等号、保存・監査・commit失敗時の非通知、commit後の無効化と通知失敗、操作内メモの破棄 |
| `unit/role/evaluation.test.ts`追加1件 | DB認可が使う `evaluation.atMs` とメモ化評価の時刻共有、破棄後の参照拒否 |
| `integration/role-update.test.ts`（14件） | 本家HTTP probeの部分更新・JSON全置換・明示null・無変更更新・全保存行の監査スナップショット。新設計の実DB CHECK失敗による同時rollback、行ロック待機下の異項目保持・同項目後勝ち・監査before/after連鎖、古い資格メモの不使用、条件付き資格・自己剥奪、終了したtx窓口の拒否、通知失敗後の保存維持 |

COMMIT結果不明の検証は二段階で行う。単体では既存TransactionRunnerのエラー伝播・非再試行を確認する。結合では実DBに更新と監査をcommitした後、実行窓口で応答喪失を模した例外を注入し、成功・確定rollbackのどちらにも読み替えず、再試行や通知を行わないことを確認する。実ネットワークのCOMMIT応答パケットを切断した試験とは区別する。

後続#119/#120の組み立てでは、次の契約を使う。

- `createUpdateRole({ transactions, changes, clock }).updateRole(actor, roleId, patch, evaluation)`。認可材料はtx内DBから都度取得し、純粋な評価へ `evaluation.atMs` を渡す。認可用の材料を通常参照メモへ登録しない。
- `RoleChanges.invalidateLocal({ kind: 'role-definitions-changed', roleId })` と `publish(event)`。UseCaseはcommit正常完了後に評価メモ、ローカル材料、他プロセス通知の順に無効化を依頼する。それぞれの失敗で確定済み更新を失敗へ戻さない。具体的な有限TTL、Redis購読・通知、通知障害の観測は#119で接続する。
- `createRoleUpdateTransactions(source, { createdAtFromId, newAuditId })`。ユーザーの条件評価日時と監査IDには、設定したID方式のcodecをcompositionから注入する。今回のテストは時刻を保持するaidx形式を注入し、全ID方式の実装・設定接続を済ませたとは扱わない。
- 入力検証・実トークン認証・HTTPエラー変換は#120。RolePatchアダプタは許可項目だけを保存し、未指定・undefinedを保持する。入力JSONの内部構造を正規化せず、監査にも保存した形を残す。

検証環境: Node.js `v24.20.0`、pnpm `12.9.1`、PostgreSQL `18`、Redis `8`。Compose project `role-118-test`、DB `55118`・Redis `56118`、ランダム名の専用DBへ本家全migrationを適用した。実行結果:

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter backend-upstream sync:check` | PASS |
| `pnpm --filter backend-next... build` / `typecheck` | PASS |
| `pnpm --filter backend-next test` | PASS、116件 |
| `BACKEND_NEXT_TEST_DB_PORT=55118 BACKEND_NEXT_TEST_REDIS_PORT=56118 pnpm --filter backend-next test:integration` | PASS、28件（Role更新14件を含む）。既存のmigration履歴・schema検査も含む |
| `node scripts/check-shipping.mjs --base HEAD` / `git diff --check` | PASS、変更TS13件のlint、SPDX、locale safety |

独立した読み取り専用レビューでImportant/Criticalなし。任意の追加テスト候補2点（ローカル無効化失敗後のpublish継続の明示assert、評価境界がtx中に閉じられた場合の成功維持）は[計画の実行結果](../../plans/2026-10-17-role-update.md#実行結果)に記録した。

BASELINE: migration実行時のpg非推奨警告は、スタックトレースから本家 `1651224615271-foreign-key.js` の同一接続上の `Promise.all` に由来すると確認した。同期対象は手編集していない。

未接続: 実HTTPの本家互換期待値、Redisの通知・TTL回復、ID方式の設定接続、新旧双方の総合比較。次は#119と#120、最後に#121で統合する。資格剥奪が認可後に行われた進行中操作を必ず取り消す保証は加えていない。結合テストでも、DB認可後に別接続から割り当てを削除した操作は成立することを確認している。

## 再実行

リポジトリ指定のNode.jsとpnpmを用い、参照側でlockfile通りに依存を導入する。

1. repo rootから固定コミットを新しい一時ディレクトリへ展開し、probeだけを追加する。`ROLE_PROBE_ROOT` は以降の同じシェルで使う。

   ```sh
   export ROLE_PROBE_ROOT="$(mktemp -d /tmp/tiramiss-role-116.XXXXXX)"
   git archive 8e07cf085adf7009583d234a208e30436f020e26 | tar -x -C "$ROLE_PROBE_ROOT"
   cp docs/superpowers/compatibility/role/reference-role.e2e.ts "$ROLE_PROBE_ROOT/packages/backend/test/e2e/role-contract.ts"
   cp docs/superpowers/compatibility/role/http-cases.json "$ROLE_PROBE_ROOT/packages/backend/test/e2e/role-http-cases.json"
   cp docs/superpowers/compatibility/role/reference-role.unit.ts "$ROLE_PROBE_ROOT/packages/backend/test/unit/RoleContract.ts"
   cp docs/superpowers/compatibility/role/policy-defaults.json "$ROLE_PROBE_ROOT/packages/backend/test/unit/role-policy-defaults.json"
   ```

2. **55116・56116・61116・62116が未使用であることを確認する。** 本家テストサーバーには起動時に指定ポートのプロセスを停止する処理がある。使用中ならこの実行を開始しない。自分が起動した専用コンテナ以外へ接続しない。

   次のコマンドはrepo rootで実行する。プロジェクト名も他セッションで使用していないものにする。既存の `misskey-infra` は使わない。

   ```sh
   python3 - <<'PY'
   import socket
   sockets = []
   for port in (55116, 56116, 61116, 62116):
       sock = socket.socket()
       sock.bind(('127.0.0.1', port))
       sockets.append(sock)
   print('probe ports are free')
   PY
   BACKEND_NEXT_TEST_DB_PORT=55116 BACKEND_NEXT_TEST_REDIS_PORT=56116 \
     docker compose -p role-116-reference -f packages/backend-next/compose.test.yml up -d --wait
   ```

3. 参照側の `.config/test.yml` を以下の値で作る。既存checkoutの設定をコピーしない。DBは専用Composeのtmpfs上。**本家テストはこのDBのschemaを削除・再作成する。** migration実行の検査とHTTPテストの検査は別に扱う。

   ```yaml
   url: 'http://127.0.0.1:61116'
   port: 61116
   setupPassword: role-116-test-only
   db:
     host: 127.0.0.1
     port: 55116
     db: backend_next_test
     user: postgres
     pass: foundation-test-only
   redis:
     host: 127.0.0.1
     port: 56116
   id: aidx
   proxyRemoteFiles: true
   ```

4. 参照rootへ移動し、依存導入・ビルド・設定変換を行う。元ソース・manifest・lockfileは変更しない。

   ```sh
   cd "$ROLE_PROBE_ROOT"
   pnpm install --frozen-lockfile --filter backend...
   pnpm build-pre
   pnpm --filter backend... build
   NODE_ENV=test pnpm --filter backend compile-config
   pnpm --filter backend build:e2e
   ```

5. 以下のブロックを**まとめて**実行する。最初に本家の `loadConfig()` で実際に使われるコンパイル済み設定を読み、専用の接続先か検査する。検査失敗時はサブシェルの `set -e` によりmigration・Vitestを起動しない。本家のglobal setupもDBのschemaを削除するため、probe本体の検査だけでは遅い。

   migrationは、手順2で新規作成した空の専用DBへ、テストを起動する前に全履歴を適用する。`exec typeorm` を使用し、検査後に設定を再コンパイルしない。その後の本家テストはschemaを削除・再作成するので、テスト後にmigrationを再実行する場合は専用Composeを終了し、手順2から空のDBを作り直す。同一の専用DBを使う本家テストを並行起動しない。

   ```sh
   (
   set -e
   export NODE_ENV=test
   node --input-type=module <<'JS'
   import { loadConfig } from './packages/backend/built/config.js';

   const config = loadConfig();
   if (
     config.db.host !== '127.0.0.1' ||
     config.db.port !== 55116 ||
     config.db.db !== 'backend_next_test' ||
     config.dbReplications ||
     config.redis.host !== '127.0.0.1' ||
     config.redis.port !== 56116 ||
     config.port !== 61116
   ) {
     throw new Error('Refusing to run outside the dedicated role-116 test configuration.');
   }
   console.log('Reference probe configuration: PASS');
   JS
   pnpm --filter backend exec typeorm migration:run -d ormconfig.js
   pnpm --filter backend exec vitest run --config vitest.config.unit.ts test/unit/RoleService.ts
   pnpm --filter backend exec vitest run --config vitest.config.unit.ts test/unit/RoleContract.ts
   pnpm --filter backend exec vitest run --config vitest.config.e2e.ts test/e2e/role-contract.ts
   pnpm --filter backend exec eslint --quiet test/e2e/role-contract.ts test/unit/RoleContract.ts
   )
   ```

   検査後は設定ファイルを変更・再コンパイルせずに実行する。probe本体の設定検査は補助であり、Vitest起動前の検査の代わりにしない。

   `role-contract.ts` の初期データをSQLで投入した後、本家形式の `roleCreated` / `userRoleAssigned` を専用Redisへ送る。本家のキャッシュが既に温まっている場合にも投入状態を反映するため。これを新実装の更新通知の契約と混同しない。ロール作成・割り当てAPI全体を今回の検証対象へ広げない。

6. 終了後、元repo rootに戻って、自分が起動したプロジェクトだけを片付ける。

   ```sh
   BACKEND_NEXT_TEST_DB_PORT=55116 BACKEND_NEXT_TEST_REDIS_PORT=56116 \
     docker compose -p role-116-reference -f packages/backend-next/compose.test.yml down
   ```

## 2026-10-17の実行記録

環境: Node.js `v24.20.0`、pnpm `12.9.1`、PostgreSQL `18`、Redis `8`。参照checkout: `/tmp/tiramiss-role-116-reference`。Compose project: `role-116-reference`。ポートは上記の専用値。

| 検査 | 結果 |
| --- | --- |
| 参照ソースの同一性 | PASS。元ソース・既存テスト・manifest・lockfile等1110ファイルのGit blob hashが固定コミットと一致 |
| lockfile固定の `pnpm install --frozen-lockfile --filter backend...` | PASS |
| 依存順ビルド、`build:e2e`、設定変換 | PASS |
| 専用DBへの本家migration全履歴の適用 | PASS。HTTPテストは別途schemaを再作成するため、HTTP検証の保存状態をmigration互換検査とは扱わない |
| 本家 `test/unit/RoleService.ts` | PASS、47件 |
| 追加 `RoleContract.ts` | PASS、36件 |
| 追加HTTP `role-contract.ts` | PASS、33件（HTTPケース28件と補足5件） |
| probeのESLint | PASS。参照package rootから変更probe2ファイルへ `eslint --quiet` |

記録する期待値はJSONとprobeのassertion。認証情報・生成トークンや一時的な実行時間を含む生ログはコミットしない。本家は監査保存完了を待たないため、HTTP204の直後に監査が存在することは要求せず、到達をpollしてスナップショットを確認する。

## 後続の判定

本家側の期待値を固定し、#117の純粋評価・操作内メモの単体検証へ接続した段階。Role全体の新旧一致をPASSとはしていない。#118の更新・認可・監査は上記の実装・検証へ接続した。#119の材料キャッシュ・Redis通知も下記の実装・検証へ接続した。次は#120のHTTP接続、#121の新旧比較と意図的な差異の総合検証を揃える。

本家の監査FK削除連鎖など、コード読解のみの確認は仕様書で区別する。追加probeの通過を全API・全異常データの網羅的な検証とは扱わない。非文字列トークンは500msのクライアント打ち切りまで応答しないことを確認し、400を完了させる新実装の期待値とは別にする。

## #119 材料キャッシュとRedis通知の接続

[実装計画](../../plans/2026-10-20-role-material-cache.md)に沿って `RoleMaterialCache`、`openRoleMaterials`、実DB材料アダプタを追加し、runtimeの接続・終了へ組み込んだ。設定と後続への組み立て手順は[backend-next README](../../../../packages/backend-next/README.md#role材料キャッシュ119)を参照。

| テスト | 新設計の期待値 |
| --- | --- |
| `unit/role/material-cache.test.ts` | DB取得開始からのTTL、参照/遅い完了による非延長、並行取得集約、返却値の変更隔離、ユーザー別LRU、取得中の追い出し、旧取得の遅い成功/失敗による再登録防止 |
| `unit/config.test.ts` | TTLと件数の既定値/設定値、非正数・非有限値・非整数の拒否 |
| `integration/role-materials.test.ts` | 独立した実Redis接続によるプロセス相当の通知、通知欠落後TTL回復、業務上の割り当て期限の独立評価、取得中の通知、再接続時の両キャッシュ破棄、prefix分離、Redis障害/終了時の参照拒否 |
| 同テストのACK競合 | 実Redisのsubscribe応答を呼出側へ返す時点だけ遅延注入し、確認前の参照拒否・close後の遅延完了を検証。実ネットワークの応答パケット遅延試験とは区別する |
| `integration/role-update.test.ts`追加 | 実DB commit後のローカル材料/操作内メモ/別接続への反映、実Redis発行接続喪失でも更新と監査が保存されること |
| `integration/resources.test.ts`追加 | 専用pubsub発行接続、半開きで応答しないTCP接続でも起動期限後の解放待ちを引き延ばさないこと |

#119は本家と意図的に異なるキャッシュ方式を検証しており、本家HTTP probeの再実行で同方式が検証されたとは扱わない。#120では通常参照のRoleFactsReaderへruntime材料を渡し、Role更新UseCaseへ `roleMaterials.changes` を接続する。ユーザー/設定の材料取得・ID codec・HTTP認証/エラー変換は後続。#121でHTTPから全体をつなぎ、本家期待値と意図的な差異を総合検証する。

2026-10-20、Node.js v24.20.0 / pnpm 12.9.1での検証結果:

| 検証 | 結果 |
| --- | --- |
| `pnpm --filter backend-upstream sync:check` | PASS |
| `pnpm --filter backend-next... build` / `typecheck` | PASS |
| `pnpm --filter backend-next test` | PASS、130件 |
| `pnpm --filter backend-next test:integration` | PASS、38件 |
| `pnpm --filter backend-next test:process` | PASS、15件 |
| `node scripts/check-shipping.mjs --base develop` | PASS、変更TS12件のlint・SPDX・locale safety |
| 別エージェントの独立レビュー2回 | 起動期限超過1件と文書2件を修正し再レビュー。Critical / Important / Minorの未解消指摘0件。レビュアーも単体20件・結合28件を独立実行してPASS |

DB/Redisは専用Composeプロジェクト `role-119-test`、公開ポート55119/56119を使用。本家migration由来のpg並行query非推奨警告は#118でも記録した既存の警告で、管理対象migrationは変更していない。API/schema変更なしのためmisskey-js再生成・migration/schema差分検査は対象外。
