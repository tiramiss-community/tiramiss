# Role更新・認可・監査 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** #118の更新・認可・監査を同一トランザクションで成立させ、失敗と並行更新を実DBで検証する。

**Architecture:** 既存TransactionRunnerにRoleUpdateScopeを束ねる。UseCaseはDBから取得した変更前の資格を純粋評価し、対象行のFOR UPDATE、指定項目の保存、監査追記を行う。commit確認後に操作内メモと材料キャッシュを無効化し、通知失敗は更新結果から切り離す。

**Tech Stack:** TypeScript、TypeORM、PostgreSQL、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-17-role-compatibility-contract.md` §2・5–7、`2026-10-16-role-policy-update-design.md` §3・7。

## Global Constraints

- 本家比較元は `8e07cf085adf7009583d234a208e30436f020e26`。backend-upstreamの管理ファイルは編集しない。
- 業務型へORM・HTTP・DIの型を公開しない。旧backendへ依存しない。
- サスペンド→管理者資格→credentialGrant→対象の順序。更新で得る資格・資格キャッシュを認可に使用しない。
- 未指定保持、明示null消去、JSON全置換。無変更でもupdatedAtと監査を更新し、lastUsedAtは保持。
- 自動再試行なし。COMMIT結果不明は成功・確定rollbackと区別し、通知しない。
- HTTPとRedis実装は#120・#119。今回は接続用の狭い契約を提供する。
- commit・PR・外部送信は依頼されていないため行わない。クリーンな作業ツリーから専用ブランチを作り同じcheckoutで実施する。

## Review Focus

- rootでもサスペンド・scope拒否を免除しない（Task 1）。
- 条件付き管理者、期限切れ、自己昇格の拒否を既存純粋関数に接続する（Task 1・2）。
- 同一項目の後勝ち、異なる項目保持、監査beforeの連鎖をロック競合下で確認する（Task 2）。
- 監査は保存行の全フィールドとISO日時を保持し、表示補完を混ぜない（Task 2）。
- commit後の通知・観測処理の失敗で確定済み更新を失敗扱いにしない（Task 1・2）。

## Task 1: 業務契約と更新UseCase

**Files:** `src/modules/role/{update-contract,update-role,errors}.ts`、`src/modules/audit/public.ts`、`src/modules/role/{evaluation,public}.ts`（すべてpackages/backend-next基準）、`test/unit/role/update-role.test.ts`。

**Interfaces:** `RoleDefinition`、許可項目だけの`RolePatch`、`RoleActor`、`RoleUpdateScope`。`createUpdateRole({transactions,changes,clock}).updateRole(actor,roleId,patch,evaluation): Promise<void>`。`changes.invalidateLocal(event)`と`changes.publish(event)`で#119へ接続。監査側は独立したRoleUpdateSnapshot/RoleUpdateAuditを公開しRoleモジュールへ依存しない。`RoleEvaluation.atMs`は既存の初回評価時刻を読み取るgetter。

- [x] UseCaseのテストを書く。拒否順、自己昇格拒否、条件付き資格と失効、scope、対象なし、保存失敗・監査失敗・commit不明時の非通知、commit後だけ無効化、通知失敗の成功維持、操作内メモの再評価をassertする。
- [x] `pnpm --filter backend-next test test/unit/role/update-role.test.ts`。Expected: 未実装の公開契約でFAIL。
- [x] 上記契約・識別可能な業務例外・純粋評価による認可・更新UseCaseを実装する。時刻は更新と監査で同じclock値を渡す。HTTP入力検証は後続へ残し、更新アダプタでも許可項目に絞る。
- [x] 同じテストを実行する。Expected: PASS。

## Task 2: 同一接続の永続化アダプタと実DB検証

**Files:** `src/platform/database/role-update.ts`、`src/platform/database/role-mapping.ts`、`src/platform/database/role-authorization-facts.ts`、`src/platform/database/role-update-audit.ts`、`test/integration/role-update.test.ts`。

**Interfaces:** `createRoleUpdateTransactions(source, {createdAtFromId, newAuditId}): TransactionRunner<RoleUpdateScope>`。ID方式は#120の設定接続から注入できるcodecにし、日時列を作らない。RoleRepositoryは`getForUpdate`・`savePatch`。User/Meta/Role/Assignmentを同じEntityManagerで読む。監査IDは`newAuditId(occurredAtMs)`で生成する。

- [x] 専用Compose（project `role-118-test`、DB55118/Redis56118）を起動し、ランダム専用DBへ本家全migrationを適用するテストを書く。部分更新・null消去・JSON置換・無変更更新・全監査スナップショットをassertする。
- [x] 実DBのCHECK制約でロール保存・監査保存をそれぞれ失敗させ、ロールと監査が両方残らず通知されないことをassertする。
- [x] 実ロック待機を確認しながら更新を重ね、異なる項目の保持、同一項目の後勝ち、監査のbefore/after連鎖をassertする。別接続で資格変更してからのDB認可拒否、自己資格変更の操作前認可も確認する。
- [x] `BACKEND_NEXT_TEST_DB_PORT=55118 BACKEND_NEXT_TEST_REDIS_PORT=56118 pnpm --filter backend-next test:integration test/integration/role-update.test.ts`。Expected: アダプタ未実装でFAIL。
- [x] ORMの変換・行ロック・許可項目だけのUPDATE RETURNING・監査INSERTを実装する。全能力を同じmanagerへ束ね、終了後の利用を拒否する。
- [x] 同じ結合テストと型検査を実行する。Expected: PASS。

## Task 3: 接続記録と出荷前検証

**Files:** 本計画、`docs/superpowers/compatibility/role/README.md`、必要なら契約書の実装接続注記。

- [x] 比較probeの部分更新・監査のassertionが新テストへ接続されたことと、未接続のHTTP・キャッシュを記録する。
- [x] `pnpm --filter backend-upstream sync:check`、`pnpm --filter backend-next... build`、`pnpm --filter backend-next... typecheck`、`pnpm --filter backend-next test`。Expected: PASS。
- [x] 専用Composeでbackend-next結合テストを実行する。Expected: PASS。
- [x] 全変更をレビューし、認可順・同一接続・JSON保存・commit後の失敗境界・ID注入契約を確認する。
- [x] `node scripts/check-shipping.mjs` と `git diff --check`。Expected: PASS。専用Composeを停止し、ブランチ・未commit・検証結果・後続#119/#120を報告する。

## 実行結果

2026-10-17、`feat/backend-next-role-update-118`、既存checkout内で実装。commit・PR・外部更新は行っていない。Task 1は未実装入口でFAILを確認後、UseCase単体14件PASS。Task 2も未実装アダプタでFAILを確認後、Role結合14件PASS。最終検証は単体116件・結合28件、依存順build/typecheck、sync:check、変更TS13件のlint、SPDX、locale safety、diff --checkがPASS。

独立した読み取り専用レビューでImportant/Criticalなし。軽微な追加テスト候補として「ローカル無効化が失敗してもpublishを試みることの明示assert」「tx中に評価境界が閉じられてもcommit済み結果を成功扱いにするケース」が挙がった。両経路は実装で個別に捕捉しており、今回は任意の追加カバレッジとして記録のみとする。

本家migration由来のpg非推奨警告はBASELINE。プロセス系テストは起動・終了・Supervisorを変更しないため未実行。実HTTP、Redis購読・TTL、ID方式の設定接続は#119/#120、総合互換検証は#121へ残す。対応関係と具体的な接続方法は[比較資料](../compatibility/role/README.md#118-更新認可監査の接続)を参照。
