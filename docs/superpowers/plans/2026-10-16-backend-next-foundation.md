# Backend Next 最小基盤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 旧バックエンドのビルドに依存せず、新バックエンドをDB・Redisと接続し、Supervisor配下で安全に起動・終了できる最小基盤を作る。

**Architecture:** `backend-upstream`は固定コミットから複製したEntity・マイグレーションを公開するライブラリとする。`backend-next`が設定、接続、マイグレーション実行、トランザクションとプロセスの寿命を所有する。HTTP・ワーカーを別プロセスとし、Supervisorは起動完了と終了を管理する。

**Tech Stack:** Node.js、TypeScript（ESM）、Hono / Node adapter、InversifyJS、TypeORM / PostgreSQL、ioredis、Vitest、ESLint。

**Spec:** [再設計の基本方針](../specs/2026-10-15-misskey-backend-redesign-design.md)の第6〜8節、第14節、第15.2.1節、第16.2節。

## Global Constraints

- `packages/backend`は変更しない。旧バックエンドのソース・ビルド成果物を新パッケージから参照しない。
- パッケージは`packages/backend-next`（`backend-next`）と`packages/backend-upstream`（`backend-upstream`）。依存はworkspace経由とする。
- 本家の初期基準は`8e07cf085adf7009583d234a208e30436f020e26`。作業ツリーではなく、このGitオブジェクトから取得する。
- 複製元の相対ディレクトリ構造・内容を維持する。Entityは`backend-upstream/entities`、マイグレーションクラス一覧は`backend-upstream/migrations`から公開する。
- Entityの初期範囲はRole、RoleAssignment、User、Meta、ModerationLog、AccessToken、Appと、依存するDriveFile、DriveFolder、`models/util/id.ts`。本家マイグレーションは全履歴。
- Node.js・TypeScriptと、TypeORM・BullMQ・ioredisなどの依存は、本家とのバージョン整合を優先する。新規依存の具体的バージョンは導入時に確認・固定する。
- `backend-next`は`tsc`で`built/`へESMを出力する。`backend-upstream`は実行可能なJSと型定義を提供する。
- マイグレーションは完全停止中の専用コマンドだけが実行する。本家→内部の順に適用し、履歴・実行設定を分ける。内部スキーマは`backend_internal`を使う。
- Supervisor配下にHTTP×1、ワーカー×1以上。子の異常終了時は全体を異常終了し、子だけを再起動しない。
- Redisは必須。起動失敗時のDBフォールバックは設けない。
- トランザクションは正常終了でcommit、例外でrollback。業務側へTypeORMの型を公開しない。
- RoleのAPI・認証・キャッシュ・業務ジョブ・定期ジョブ・後続処理の依頼記録は、この計画の実装対象に含めない。Roleは次の実装単位とする。
- commit・push・PR作成は別途の指示があるまで行わない。各タスクの区切りはテストと進捗記録で管理する。

## Review Focus

1. 未初期化DBや履歴欠落での起動検査が、テーブルを自動作成しないこと（Task 3）。
2. 初期化途中の失敗でも、先に開いたDB・Redis接続や待機中の再接続を残さないこと（Task 2）。
3. 起動完了前の子の終了・通知欠落・終了要求でも、Supervisorが無期限に待たず、起動成功を誤報しないこと（Task 6）。
4. HTTPで処理中の接続がある場合、受付停止後は期限まで処理を待ち、期限後はプロセスが終了すること（Task 5〜6）。
5. 既存DBのマイグレーション履歴を再利用し、未同期の本家テーブルを内部基盤の差分検査・適用で変更しないこと（Task 3）。

## ファイルの責務

| 配置 | 責務 |
| --- | --- |
| `packages/backend-upstream/upstream-sync.json` | 元コミット、複製対象、生成規則の記録 |
| `packages/backend-upstream/scripts/` | 同期・一致検査・公開入口生成 |
| `packages/backend-upstream/src/models/`、`migration/` | 本家由来の無改変ファイル |
| `packages/backend-upstream/exports/` | 複製領域外の公開入口 |
| `packages/backend-next/src/config/` | YAML読み込み・検証・必要な設定への変換 |
| `packages/backend-next/src/platform/` | DB・Redis・ログ・寿命管理・トランザクション実装 |
| `packages/backend-next/src/application/transaction.ts` | 基盤の型を含まないトランザクション契約 |
| `packages/backend-next/src/composition/` | 起動時のInversifyによる組み立て |
| `packages/backend-next/src/processes/` | HTTP・ワーカー・Supervisorの実行と制御 |
| `packages/backend-next/src/entrypoints/` | CLI、シグナル・終了コードの接続 |
| `packages/backend-next/test/` | 単体・実DB/Redis結合・実プロセスの検証 |

## Task 1: 複製ライブラリと独立ビルド

**Files:**
- Create: `packages/backend-upstream/{package.json,tsconfig.json,eslint.config.js,upstream-sync.json,README.md}`
- Create: `packages/backend-upstream/scripts/{sync.mjs,sync.test.mjs}`
- Generate: `packages/backend-upstream/src/models/{Role,RoleAssignment,User,Meta,ModerationLog,AccessToken,App,DriveFile,DriveFolder}.ts`、`src/models/util/id.ts`、`migration/*.js`
- Generate: `packages/backend-upstream/exports/{entities,migrations}.ts`
- Create: `packages/backend-next/{package.json,tsconfig.json,tsconfig.test.json,eslint.config.js,vitest.config.ts,vitest.integration.config.ts,vitest.process.config.ts}`
- Create: `packages/backend-next/test/package-imports.test.ts`
- Modify: `pnpm-workspace.yaml`、`package.json`のworkspace一覧、`pnpm-lock.yaml`

**Interfaces:**
- Produces: `backend-upstream/entities`が上記Entityクラスと`entities`配列を公開する。
- Produces: `backend-upstream/migrations`が`migrations`クラス配列を公開する。Entity入口からは再exportしない。
- Produces: `pnpm --filter backend-upstream sync`、`sync:check`、`build`、`typecheck`、`lint`、`test`。
- Produces: `pnpm --filter backend-next... build`で依存順にビルドできる。
- Produces: `backend-next`の`test`、`test:integration`、`test:process`。すべて`vitest run`を使い、単体・結合・実プロセスの対象を分ける。Task 1のimportテストは単体設定で実行する。

- [x] **Step 1: 同期の失敗テストを書く。** 一時Gitリポジトリの固定コミットからのコピー、作業ツリー改変の非混入、コピー先改変の検出、管理対象の追加・変更・削除、未登録依存で停止すること、公開入口の再現性を検証する。削除対象はmanifestの管理範囲に限定し、手書きファイルを削除しない。
- [x] **Step 2: `node --test packages/backend-upstream/scripts/sync.test.mjs`を実行し、同期処理未実装による失敗を確認する。**
- [x] **Step 3: 同期処理・package exports・ビルドを実装する。** `git show`等はシェル文字列結合をせず引数配列で実行する。manifestは上記10ファイルと全マイグレーションを管理し、外部依存も照合する。マイグレーションの`re2`・`tinycolor2`をライブラリ自身の依存にする。`allowJs`と宣言出力でJSマイグレーションも成果物に含める。複製ファイルへのlint自動修正は行わない。
- [x] **Step 4: パッケージimportの検証を追加する。** ビルド済み公開入口をNodeで読み込み、Entityのメタデータ構築と、Entity入口が`re2`などのマイグレーション依存を読み込まないことを確認する。TypeORMのdecorator metadataを出力し、循環するEntity参照を実行時にも確認する。
- [x] **Step 5: `sync:check`、上記Nodeテスト、両パッケージのbuild/typecheckと`package-imports.test.ts`を実行する。** 期待結果は全件成功、同期元との差分なし、旧backendのビルド不要。

## Task 2: 設定・ログ・接続と失敗時の解放

**Files:**
- Create: `packages/backend-next/src/config/{load-config,types}.ts`
- Create: `packages/backend-next/src/platform/{logger,resource-scope,connect-resources}.ts`
- Create: `packages/backend-next/src/platform/database/data-source.ts`
- Create: `packages/backend-next/src/composition/create-runtime.ts`
- Create: `packages/backend-next/test/unit/{config,resource-scope,logger}.test.ts`
- Create: `packages/backend-next/test/integration/resources.test.ts`
- Create: `packages/backend-next/test/fixtures/config.yml`

**Interfaces:**
- Produces: `loadConfig(options?: { configFile?: string; env?: NodeJS.ProcessEnv }): Promise<RuntimeConfig>`。設定全体はcompositionと入口だけで使う。
- Produces: `ResourceScope.defer(cleanup: () => Promise<void>): void`、`close(): Promise<void>`。登録の逆順で全cleanupを試し、二重解放しない。
- Produces: `createRuntime(config: RuntimeConfig): Promise<RuntimeResources>`。`RuntimeResources`は基盤内部の`dataSource`、用途別Redis接続、`logger`、`close(): Promise<void>`を持つ。
- Produces: JSON行ログの`Logger.info(event, fields?)`、`error(event, fields?)`。起動ログにprocess種別・PIDを含める。

- [x] **Step 1: 設定・解放・ログの失敗テストを書く。** `.github/misskey/test.yml`と同形式を読み、`MISSKEY_CONFIG_YML`、`NODE_ENV=test`、DBの既存環境変数fallback、Redisの`pass`・`db`・`prefix`を解釈する。不正なURL・ポート・期限を拒否し、無関係な既存設定は拒否しない。cleanupの一つが失敗しても残りを呼ぶ。パスワード・トークン・設定全体をログへ出さない。
- [x] **Step 2: `pnpm --filter backend-next test -- test/unit/config.test.ts test/unit/resource-scope.test.ts test/unit/logger.test.ts`で未実装の失敗を確認する。**
- [x] **Step 3: ローダーと基盤を実装する。** YAMLを直接読み、旧設定コンパイル・frontend manifest・旧builtには依存しない。新専用領域を`backendNext`とし、`workerCount`既定1、`startupTimeoutMs`既定30000、`shutdownTimeoutMs`既定30000を正の整数として検証する。既存`clusterLimit`は新しいワーカー数へ暗黙変換しない。HTTPのTCP/Unix socket設定を保持する。既存用途のRedis個別設定は元のfallbackに従う。
- [x] **Step 4: 実DB・Redis結合テストを追加し、接続成功、DB失敗、Redis失敗、Redis個別接続の失敗で先行リソースが閉じることを確認する。** 初期化には期限を設け、接続中の再試行をclose後も残さない。実際に利用しないRedis用途の接続はまだ作らない。
- [x] **Step 5: 単体3ファイルと`test/integration/resources.test.ts`を実行する。** 成功・失敗の双方でテストプロセスが未解放ハンドルにより残らないことを確認する。

## Task 3: 二系統マイグレーションと読み取り専用の起動検査

**Files:**
- Create: `packages/backend-next/src/platform/database/{migration-sources,migrate,check-migrations,check-schema}.ts`
- Create: `packages/backend-next/src/entrypoints/{migrate,check-migrations,check-schema}.ts`
- Create: `packages/backend-next/test/integration/migrations.test.ts`
- Modify: `packages/backend-next/package.json`

**Interfaces:**
- Consumes: `backend-upstream/{entities,migrations}`とTask 2のDB設定・Logger。
- Produces: `migrateDatabase(config: DatabaseConfig): Promise<void>`、`assertMigrationsApplied(config: DatabaseConfig): Promise<void>`、`assertSchemaMatches(config: DatabaseConfig): Promise<void>`。
- Produces: `migrate`、`check-migrations`、`check-schema`コマンド。起動検査は履歴、schema検査は定義の差分を検証する。

- [x] **Step 1: 使い捨てDBで失敗テストを書く。** 空DBから全履歴適用、二回目の再適用なし、既存の本家履歴を保持、内部履歴の分離、本家適用失敗時に内部側を進めないことを検証する。未初期化DB・履歴欠落時の起動検査前後でDB構造が変わらないことも検証する。
- [x] **Step 2: `pnpm --filter backend-next test:integration -- test/integration/migrations.test.ts`で未実装の失敗を確認する。** 接続先はテスト専用DBに限定し、既存の開発・本番DBへdrop/createしない。
- [x] **Step 3: 二つの実行設定を実装する。** 本家は既存の`public.migrations`とクラス名・timestampを維持する。内部は`backend_internal.migrations`。専用コマンドで内部スキーマを初期化し、内部マイグレーション一覧は空で開始する。本家の`MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY=1`に対応する`each`モードと通常の`all`モードを維持する。通常プロセスは`synchronize:false`、`migrationsRun:false`。
- [x] **Step 4: 起動検査を読み取り専用SQLで実装する。** 履歴と必要なクラス一覧を照合し、欠落はエラーにする。TypeORMの`showMigrations()`等はバージョンによって履歴テーブルを作成するため、読み取り専用と確認できないAPIを使わない。内部履歴だけが欠けている場合も起動を拒否する。
- [x] **Step 5: schema差分検査と保護テストを実装する。** 同期済みEntityの対象だけをTypeORMメタデータと照合し、差分があれば報告して失敗する。差分DDLは実行しない。未同期の本家テーブルを残し、内部適用前後の本家schemaが不変であることを確認する。既存履歴済みDBと全履歴から作ったDBの両方で検査する。
- [x] **Step 6: 結合テスト、`migrate`、`check-migrations`、`check-schema`を実行する。** 期待結果は適用後成功、未適用状態では起動検査のみ失敗、既存履歴・未同期テーブルの保持。

## Task 4: 例外を使うトランザクション実行契約

**Files:**
- Create: `packages/backend-next/src/application/transaction.ts`
- Create: `packages/backend-next/src/platform/database/transaction-runner.ts`
- Create: `packages/backend-next/test/unit/transaction-runner.test.ts`
- Create: `packages/backend-next/test/integration/transaction-runner.test.ts`

**Interfaces:**
- Produces: `TransactionRunner<Scope>.run<T>(work: (scope: Scope) => Promise<T>): Promise<T>`。公開契約にEntityManagerやDB例外型を含めない。
- Produces: 基盤内部の`createTransactionRunner<Scope>(dataSource: DataSource, bind: (manager: EntityManager) => Scope): TransactionRunner<Scope>`。Role実装時は`bind`で同じ接続の専用Repository群を組み立てる。

- [x] **Step 1: 失敗テストを書く。** 正常戻り値がcommit後に返る、callback例外がrollback後に伝わる、callback後までcommitを待つ、二操作が同じtx接続を使う、外部Repositoryを誤使用しない、並行runが別scopeになることを検証する。commit通信失敗を業務拒否・確定rollbackと断定しないことも検証する。
- [x] **Step 2: `pnpm --filter backend-next test -- test/unit/transaction-runner.test.ts`で未実装の失敗を確認する。**
- [x] **Step 3: TypeORMのトランザクションへ接続する。** callbackからの例外は情報を失わず伝える。自動再実行、Result判定、暗黙のネスト・グローバルな現在txは導入しない。scopeを共有キャッシュやDI singletonへ保存しない。
- [x] **Step 4: 実PostgreSQLで二つの更新の同時確定とrollbackを検証する。** テスト専用テーブルを一時schemaへ作り、業務用のEntity・ダミー永続テーブルは追加しない。
- [x] **Step 5: 単体・結合の両テストとtypecheckを実行する。** 成功値、元の例外、DB上の更新結果が期待どおりであることを確認する。

## Task 5: HTTP・ワーカーの単独起動と期限付き終了

**Files:**
- Create: `packages/backend-next/src/processes/{lifecycle,http,worker}.ts`
- Create: `packages/backend-next/src/entrypoints/{http,worker}.ts`
- Create: `packages/backend-next/test/unit/lifecycle.test.ts`
- Create: `packages/backend-next/test/processes/children.test.ts`
- Create: `packages/backend-next/test/fixtures/slow-http.ts`
- Modify: `packages/backend-next/src/composition/create-runtime.ts`、`package.json`

**Interfaces:**
- Consumes: Task 2のruntime、Task 3の起動検査。
- Produces: `startHttp(config: RuntimeConfig): Promise<RunningProcess>`、`startWorker(config: RuntimeConfig): Promise<RunningProcess>`。
- Produces: `RunningProcess.stop(): Promise<void>`。受付停止→実行中処理待機→resource closeの順。期限超過の強制終了はentrypointが担う。
- Produces: IPC通知`{ type: 'ready', role: 'http' | 'worker' }`。親がある場合だけ送信し、単独起動はIPCを要求しない。

- [x] **Step 1: 起動検査前にHTTPがlistenしないこと、初期化完了後だけreadyになること、複数回の終了要求で二重解放しないことの失敗テストを書く。**
- [x] **Step 2: `pnpm --filter backend-next test -- test/unit/lifecycle.test.ts`で未実装の失敗を確認する。**
- [x] **Step 3: HonoとNode adapterでHTTPを起動し、workerは接続・起動検査・終了待機だけの枠を実装する。** 業務ルートは未実装の404とし、独自の確認用API・ダミージョブは作らない。Inversifyはcompositionだけから利用する。`SIGTERM`・`SIGINT`を共通の終了処理へ接続する。
- [x] **Step 4: ビルド済みentrypointの実プロセステストを追加する。** TCPとUnix socket、DB/Redis停止、未適用履歴、起動直後の終了、正常終了、受付中のHTTP処理を待つ動作、期限超過の終了を確認する。遅いハンドラはテストfixtureだけに置き、製品の確認用ルートを追加しない。HTTP接続切断をUseCaseの取消へ結び付けない。
- [x] **Step 5: build後に`pnpm --filter backend-next test:process -- test/processes/children.test.ts`を実行する。** 単独起動・停止、失敗時の非0終了、期限後に子プロセスと接続が残らないことを確認する。

## Task 6: Supervisorによる起動と全体停止

**Files:**
- Create: `packages/backend-next/src/processes/{supervisor,protocol}.ts`
- Create: `packages/backend-next/src/entrypoints/supervisor.ts`
- Create: `packages/backend-next/test/unit/supervisor.test.ts`
- Create: `packages/backend-next/test/processes/supervisor.test.ts`
- Create: `packages/backend-next/test/fixtures/child-process.ts`
- Modify: `packages/backend-next/package.json`

**Interfaces:**
- Consumes: Task 5のentrypointとready通知、`backendNext`のプロセス数・期限。
- Produces: `runSupervisor(config: RuntimeConfig): Promise<number>`。全終了後の終了コードを返す。entrypointが`process.exitCode`へ設定する。
- Produces: `start`、`start:http`、`start:worker`。Supervisorからの停止指示はSIGTERM、期限超過はSIGKILL。

- [x] **Step 1: 子を差し替えた単体失敗テストを書く。** HTTP×1/worker×設定数、全ready後だけ全体ready、一つの異常終了で兄弟停止、起動中exit、ready未通知の期限超過、起動中SIGTERM、停止に応じない子の強制終了、開始失敗途中の子回収を検証する。停止要求前の予期しないexitはcode 0でも全体失敗とする。
- [x] **Step 2: `pnpm --filter backend-next test -- test/unit/supervisor.test.ts`で未実装の失敗を確認する。**
- [x] **Step 3: Nodeのchild_processでSupervisorを実装する。** exec文字列ではなくNode実行ファイル・引数配列を使い、全readyまで起動完了を出さない。Supervisorに業務用DB・Redis接続やDIコンテナを作らない。子の再起動ループは作らない。
- [x] **Step 4: 実プロセスで通常起動、正常停止、HTTP/workerどちらかのkill、ready期限超過、停止期限超過を検証する。** 各テストがPIDを管理し、失敗時もfinallyで子を回収する。短い期限はfixture設定とし、製品の既定値をテスト都合で変更しない。
- [x] **Step 5: build後に単体・`test:process -- test/processes/supervisor.test.ts`を実行する。** 全体終了コード、子の回収、ready通知の回数、子の再起動がないことを確認する。

## Task 7: 実行手順とCIでの受け入れ

**Files:**
- Create: `packages/backend-next/README.md`
- Modify: `packages/backend-next/vitest.{integration,process}.config.ts`（必要なテスト環境・timeoutの調整）
- Create: `.github/workflows/test-backend-next.yml`
- Modify: 両パッケージの`package.json`、必要な`.gitignore`のビルド成果物指定

**Interfaces:**
- Produces: `backend-next`の`build`、`start`、`start:http`、`start:worker`、`migrate`、`check-migrations`、`check-schema`、`typecheck`、`lint`、`test`、`test:integration`、`test:process`。
- Produces: 新パッケージだけで再現できるローカル手順と、同じコマンドを用いたCI。

- [x] **Step 1: CIとREADMEを追加する。** 既存workflowのNode/pnpm/actionの指定を踏襲し、PostgreSQL・Redisのテスト用serviceを使う。対象パスに新2パッケージ、workspace・lockfile・共通ESLint設定・当該workflowを含める。checkoutで固定元コミットが取得できるようにする。旧backendのbuildは実行しない。
- [x] **Step 2: `sync:check`→依存順build→typecheck/lint→単体→migrate→履歴/schema検査→結合→実プロセスの順で検証する。** Roleのテストを実装済みとして扱わない。テストはすべてrunモードとし、watchで待ち続けない。
- [x] **Step 3: READMEの手順を実行し、最小基盤の完成条件と照合する。** 設定読み込み、必須依存の確認、Supervisor起動、単独起動、正常停止、初期化失敗、子の異常終了を確認する。DB/Redisの使い捨てテスト環境と接続先を明記する。
- [x] **Step 4: `node scripts/check-shipping.mjs --base HEAD`を実行する。** 新パッケージが自動lint対象にならない場合は各package rootから変更ファイルへ`eslint --quiet`も実行する。SPDX・locale safetyを確認する。複製元のファイル内容を検査の都合で改変しない。
- [x] **Step 5: 変更一覧・実行した検証・未実装のRole段階を短く報告する。** 実行できなかった検証は理由を残し、成功扱いしない。

## 実装前の環境確認

- 調査時のNodeは`v24.20.0`、`.node-version`は`26.4.0`。Node 24はbackendのengines範囲内だが、新規依存も対応することを確認する。
- 調査時の`pnpm --version`は、指定された`pnpm@12.9.1`の準備先`/home/osamu/.local/share/pnpm/.tools/`へ書き込めず失敗した。実装開始時に書き込み可能な一時領域へpnpmのデータ保存先を指定するなど、リポジトリのpackageManager指定を変更せずに解決する。
- 既存node_modulesとmanifestのバージョンが一致するとは限らない。既存のリンクを流用して導入・検証済みと判断しない。
- 作業場所の確認は`using-git-worktrees`に従う。既存の未追跡`docs/`を失わず、設計書・この計画を実装先から参照できるようにする。

## 技術参照

- [TypeORM migration setup](https://typeorm.io/docs/migrations/setup/)：クラス配列、履歴名、実行モード。
- [TypeScript paths](https://www.typescriptlang.org/tsconfig/paths.html)：`paths`だけでは出力importを書き換えない。
- [Hono Node.js adapter](https://hono.dev/docs/getting-started/nodejs)：Node上のHTTP起動。

## 計画の自己確認

- 最小基盤の範囲はTask 1〜7で網羅し、Role・ジョブの具体処理は後続へ残した。
- コピー元の固定・依存境界・二系統migration・読み取り専用の起動検査・例外によるtx・プロセスの寿命を、それぞれの実装タスクとテストへ対応付けた。
- タスク間の公開名はInterfaces欄で固定し、TypeORMの型は基盤内部のfactoryに限定した。
- Review Focusの5項目には、所有タスクに具体的な検証を割り当てた。
- チェックボックスはローカルで実行済み。独立レビューの重要指摘3件は再現テストを追加して修正し、最終検証を実施した。GitHub Actionsのリモート実行とRole実装は対象外。
