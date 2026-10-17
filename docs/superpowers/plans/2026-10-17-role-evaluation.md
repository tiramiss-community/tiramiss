# Role Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development if the user selects delegation. Implement task-by-task; steps use checkbox syntax for tracking.

**Status:** 2026-10-17 実装・検証完了。独立レビューでCritical/Importantなし。ユーザー指示によりPR作成へ進む。

**Goal:** #117の純粋なRole評価と操作内メモ化を、#118・#119が利用できる契約と単体テスト付きで実装する。

**Architecture:** Role業務モデルと純粋関数を独立させ、評価境界が基準時刻・参照セッション・無効化を所有する。参照セッションは取得窓口ごとに材料と計算中のPromiseを保持し、依存の変更・終了後に古い値を公開しない。

**Tech Stack:** TypeScript、Vitest。既存のbackend-next設定を利用し、依存追加なし。

**Spec:** [Role評価設計](../specs/2026-10-17-role-evaluation-design.md)。互換性は[#116の契約](../specs/2026-10-17-role-compatibility-contract.md)と[比較資料](../compatibility/role/README.md)に従う。

## Global Constraints

- 比較コミットは `8e07cf085adf7009583d234a208e30436f020e26`。旧backendのソース・成果物へ依存しない。
- 純粋関数はIO・現在時刻・キャッシュ・AsyncLocalStorage・ORM・HTTP・DIに依存しない。
- 新規TSにはSPDXヘッダーを付ける。locale、migration、Entity、依存、CHANGELOGは変更しない。
- commit・PR・外部送信はユーザーの明示指示後に行う。実装完了時には未commitで検証結果を引き継ぎ、その後PR作成の指示を受けた。
- 評価境界をまたぐ結果キャッシュ、DB・Redisアダプタ、UseCase・HTTP接続は後続Issueで扱う。
- 各タスクは失敗テスト→失敗確認→実装→成功確認で進める。未実装importによる初回失敗は確認後、振る舞いの失敗も確認する。

## Review Focus

1. 失敗した旧Promiseが、無効化後の新Promiseを消さないこと（Task 3）。
2. 取得元・呼び出し元がネストしたJSONや配列を書き換えても、メモが変わらないこと（Task 3–4）。
3. ロール変更前に対象でなかったユーザーも、条件の変更後は再評価されること（Task 4）。
4. 参照セッションを終了した直後に取得が完了しても、値が外へ出ないこと（Task 3–4）。
5. 任意の保存JSONを正常値へ無断で正規化せず、固定本家の評価結果・例外と照合すること（Task 1–2）。

## ファイル構成

製品コードは `packages/backend-next/src/modules/role/`、単体テストは `packages/backend-next/test/unit/role/` に置く。

| ファイル | 責務 |
| --- | --- |
| `model.ts` | ユーザー属性、割り当て、評価用ロール、設定材料、実効ポリシー、資格の型 |
| `condition.ts` | 保存条件式の評価 |
| `applicable-roles.ts` | 割り当て失効と条件付きロールの選択 |
| `policy-defaults.ts` | 固定本家のコード既定値とポリシーキーの分類 |
| `policies.ts` | ポリシーの集約 |
| `privileges.ts` | 管理者・モデレーター資格 |
| `evaluation-memo.ts` | セッション内Promiseの保持・世代・破棄・コピー。Role内部専用 |
| `evaluation.ts` | 時計、評価境界、取得窓口、参照セッション、依存の無効化 |
| `public.ts` | 後続Issue向け公開入口。内部メモ実装は公開しない |

## Task 1: 条件・適用ロール・資格

**Files:** 上記 `model.ts`、`condition.ts`、`applicable-roles.ts`、`privileges.ts`。テストは `conditions.test.ts`、`privileges.test.ts`。テスト共通の固定材料は同ディレクトリの `fixtures.ts`。

**Interfaces:**

- `UserRoleFacts`: userId、host、createdAtMs、5種のboolean属性、followersCount/followingCount/notesCount。
- `RoleAssignment`: id、userId、roleId、expiresAtMs。
- `EvaluationRole`: id、target、condFormula: unknown、policies: 保存JSON、isAdministrator、isModerator。
- `evaluateCondition(formula: unknown, user: UserRoleFacts, assignedRoles: readonly EvaluationRole[], atMs: number): boolean`。
- `selectApplicableRoles(roles: readonly EvaluationRole[], assignments: readonly RoleAssignment[], user: UserRoleFacts, atMs: number): readonly EvaluationRole[]`。ユーザーに属する割り当てを対象とする。
- `evaluatePrivileges(userId: string | null, rootUserId: string | null, roles: readonly EvaluationRole[]): { isAdministrator: boolean; isModerator: boolean }`。

- [x] 条件全種類のテーブルテストを書く。probeと同じ時刻・属性で、作成10秒の等号は両条件false、11秒のcreatedLessThanと9秒のcreatedMoreThanはtrue。空and=true、空or=false、未知条件=false、壊れたand=false、壊れた条件のnot=trueを確認する。
- [x] `pnpm --filter backend-next test test/unit/role/conditions.test.ts` でFAILを確認する。
- [x] 固定SHAの `RoleService.ts` のevalCond・getUserRolesをGitオブジェクトから確認し、関数と型を実装する。条件付きロールの選択は有効な割り当てだけを条件の材料にする。
- [x] 割り当て期限null・atMs−1・atMs・atMs+1、他ユーザーの割り当て、条件付きロールへの既存割り当て、非連鎖、入力非変更のテストを追加してFAIL→PASSを確認する。
- [x] 未認証、root、管理者、モデレーター、一般ユーザーの資格テストを先に追加し、`privileges.ts` の実装後に両テストファイルのPASSを確認する。

## Task 2: 本家互換のポリシー集約

**Files:** `policy-defaults.ts`、`policies.ts`、`model.ts`、`policies.test.ts`。

**Interfaces:**

- `DEFAULT_POLICIES`: 比較JSON全39キーと一致するコード既定値。
- `RolePolicies`: 既知キーの実効値。保存値の入力型と区別する。
- `evaluatePolicies(input: { userId: string | null; roles: readonly EvaluationRole[]; basePolicies: 保存JSON; uploadLimitBytes: number }): RolePolicies`。

- [x] 比較JSONをファイルとして読む既定値テストと、probeの集約テストを書く。基本容量55、priority1の999とpriority2の200→200、priority2/useDefault→55、priority3の999とpriority1の200→200を含める。
- [x] `pnpm --filter backend-next test test/unit/role/policies.test.ts` でFAILを確認する。
- [x] 固定SHAの既定値と各キーの実際の集約を確認して実装する。priority2→1→全候補、booleanの厳密true、数値最大、チャットの順序、trim済みファイル型の出現順和集合、サイズ上限のfloorを維持する。
- [x] 匿名は上限・trimを通さない、ログイン済みロールなしは通す、rootは特別値にならない、欠けたキーは基本値を候補とするテストを追加してFAIL→PASSを確認する。
- [x] null・未知キー・壊れたポリシーentryの扱いを固定ソースと照合する。契約に記録済みの正常化だけを行い、追加で確認した異常値は比較資料へ根拠を記録する。
- [x] Roleの純粋関数テストをまとめて実行しPASSを確認する。

## Task 3: 操作内Promiseと無効化の競合制御

**Files:** `evaluation-memo.ts`、`evaluation-memo.test.ts`。

**Interfaces:** Role内部の `EvaluationMemo` は材料・結果キー、依存タグ、非同期取得関数を受けて値を返す。`invalidate(tags)` と `close()` を持つ。`EvaluationInvalidated` と `EvaluationClosed` を区別する。

- [x] 手動でresolve/rejectできるPromiseを使い、同一キーの並行取得が1回、別キーは別取得、取得失敗後の次の参照は再取得となるテストを書く。
- [x] `pnpm --filter backend-next test test/unit/role/evaluation-memo.test.ts` でFAILを確認する。
- [x] 依存タグの世代を記録し、取得完了時も世代と終了状態を検査する。無効化された取得は `EvaluationInvalidated`、終了した取得は `EvaluationClosed` を返す。古いエントリの削除は現在のエントリと同一の場合に限る。
- [x] 旧取得中に無効化→新取得→旧成功/旧失敗の両方をテストし、新取得を壊さず旧呼び出しを失敗させることを確認する。
- [x] close後の新規参照・取得中close・取得元と戻り値のネストした変更隔離をテストしてFAIL→PASSを確認する。所有値と公開値はstructuredCloneで分ける。
- [x] メモのテスト全件のPASSを確認する。

## Task 4: 評価境界とRole参照セッション

**Files:** `evaluation.ts`、`public.ts`、`evaluation.test.ts`。

**Interfaces:**

- `RoleFactsReader`: `readRoles()`、`readAssignments(userId)`、`readUserRoleFacts(userId)`、`readInstanceRoleFacts()`。各戻り値はPromiseで、Task 1–2の業務型を返す。
- `createRequestEvaluation(clock: () => number)`、`createAttemptEvaluation(startedAtMs: number)` が `RoleEvaluation` を返す。
- `RoleEvaluation.openSession(reader: RoleFactsReader, uploadLimitBytes: number): RoleEvaluationSession`。呼び出すたびに独立した取得条件を表すセッションを作る。同じ操作では同じセッションを明示的に再利用する。
- `RoleEvaluation.invalidate(change)` のchangeは `roles`、`assignments/userId`、`user/userId`、`instance` の判別可能なunion。配下の全セッションへ伝える。
- `RoleEvaluation.close(): void`、`RoleEvaluationSession.close(): void`。
- セッションは `getEffectivePolicies(userId: string | null): Promise<RolePolicies>`、`getPrivileges(userId: string | null): Promise<RolePrivileges>` を公開する。

- [x] リクエストは初回評価時だけ時計を読む、試行は指定開始時刻を使う、時計が進んでも同境界の期限判定は揃うテストを書く。
- [x] `pnpm --filter backend-next test test/unit/role/evaluation.test.ts` でFAILを確認する。
- [x] Task 3のメモで材料取得と結果をまとめ、Task 1–2の純粋関数へatMsと所有する材料を渡す。匿名ではユーザー材料を取得せず、未認証資格はfalseとする。実効ポリシーと資格が必要とする材料は共有する。
- [x] 同一ユーザー並行取得、別ユーザー、通常参照とDB参照の別セッション、別トランザクション、別操作・試行の分離をテストしてFAIL→PASSを確認する。
- [x] 設計§5.1の4種の無効化をテーブルテストにする。ロール変更前に未適用だったユーザーの再評価、別ユーザーの属性・割り当て材料の再利用も確認する。
- [x] 取得中の無効化は例外、再評価は同じatMs、新しい境界は新しい時刻となること、セッション終了後に未commit相当の値が通常参照へ混ざらないことをテストしてFAIL→PASSを確認する。
- [x] 戻り値変更の隔離を公開APIからも検証する。セッションcloseで他のセッションは利用可能、境界closeで全セッションが終了することを確認する。
- [x] `public.ts` では業務型・評価関数・境界・例外だけを公開し、全RoleテストのPASSを確認する。

## Task 5: 互換性資料と検証

**Files:** `docs/superpowers/compatibility/role/README.md`、Role評価設計書、本計画書。

- [x] probeの各ケースと新テストの対応を点検し、不足があれば担当タスクのテストへ追加する。比較資料に接続したファイルと未接続のHTTP・保存・共有キャッシュ検証を記録する。
- [x] `pnpm --filter backend-upstream sync:check` を実行する。同期対象を変更していないことを確認する。
- [x] `pnpm --filter backend-next... build` と `pnpm --filter backend-next... typecheck` を実行しPASSを確認する。
- [x] `pnpm --filter backend-next test test/unit/role` を実行し全件PASSを確認する。既存設定で新テストが通常CI対象に含まれることも確認する。
- [x] 完了前のレビューを行い、認可への誤利用、破棄後の遅い取得、依存の無効化漏れを確認する。必要な修正に近いテストだけ再実行する。
- [x] `node scripts/check-shipping.mjs` と `git diff --check` を実行する。実行コマンドと結果を比較資料へ反映する。設計書の状態と計画チェックを実態に合わせる。
- [x] ブランチ・worktree、未commitであること、実装した契約、検証結果、次の#118・#119への接続事項をユーザーへ報告する。
