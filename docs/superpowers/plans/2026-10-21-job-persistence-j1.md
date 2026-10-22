# Durable post work J1 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for implementation and superpowers:requesting-code-review for an independent final review. Steps use checkbox syntax for tracking.

**Goal:** 投稿と同じ transaction に AP/通知依頼・初期仕事・取消世代・論理容量を保存し、再生成で進捗を壊さない J1 を実装する。

**Architecture:** 業務向け `PostWorkRequests.append` を、呼び出し元の EntityManager に結び付けた adapter で提供する。独自状態は backend_internal、immutable 内容は canonical JSON と SHA-256 の両方で比較する。業務 UseCase が transaction を所有し、adapter は commit・自動再試行しない。

**Tech Stack:** TypeScript / TypeORM / PostgreSQL / Vitest。

**Spec:** ../specs/2026-10-21-job-persistence-design.md (§3, §4.1, §6.2, J1)。J2/J3 と投稿 N タスクの完成はこの PR に含めない。#124 は閉じない。

## Global Constraints

- 100万行 / 20 GiB の論理容量。通常作成は90%、削除・取消は100%まで。初期 payload 最大2 MiB。
- charged_bytes = align1024(4 × (base_bytes + variable_bytes))。各行に式版と予約額を保存する。
- request の業務キーは (eventId, kind, noteGeneration)、item は (requestId, kind, targetKey)。hash 一致だけで内容一致としない。
- 世代は作成1、削除2。note 状態→request/item→容量の順で調停する。削除で大量の item を更新しない。
- adapter は transaction 外・終了後には使えず、失敗を握りつぶして transaction を継続させない。COMMIT 応答不明を rollback と断定せず、業務を自動再実行しない。
- 物理容量監視と清掃・recipient/effect/dispatch の保存・管理操作・BullMQ/worker は J2/J3。J1 の入口を HTTP に公開せず、リリース可能と扱わない。

## Review Focus

- 同じ業務キーへの異なる requestId、異なる業務キーへの同じ requestId、hash 衝突相当の不一致。
- create/delete の並行と、削除後に遅れた create/通知 append が世代を戻すこと。
- 容量枠の並行確保、rollback、重複再利用、削除用10%の侵食。
- payload 廃棄後の再生成、終端/試行済みの初期化、異常な値の永続化。
- COMMIT の成立後に応答だけを失う障害と、transaction scope の持ち出し。

## Task 1: Typed requests and validation

**Files:** Create `src/modules/post-work/{public,request,prepare}.ts`, `test/unit/post-work.test.ts` (package root: packages/backend-next)。

**Interfaces:** Produces `PostWorkRequest` (AP 展開 / 通知の discriminated union)、`PostWorkRequests.append(request): Promise<{requestId:string}>`、`preparePostWork(request)` (canonical immutable JSON、初期 target、固定24h期限、課金)。キュー名・再試行API・DB型を公開しない。

- [x] AP/通知の有効値、JSONキー順、未知kind/版、operation/世代、重複対象、UTF-8サイズ、2 MiB、非有限時刻、曖昧な複合targetのテストを先に書く。
- [x] `pnpm --filter backend-next test -- test/unit/post-work.test.ts` が未実装で失敗することを確認する。
- [x] 厳格な入力検証と canonical JSON、初期itemと課金計算を実装する。エラーは InvalidPostWorkRequest / WorkPayloadTooLarge / WorkCapacityExceeded / WorkRequestConflict。
- [x] 同コマンドが通ることを確認する。

## Task 2: Internal schema and transaction-bound append

**Files:** Create `src/platform/database/post-work/{schema,migrations,append}.ts`, `test/integration/post-work.test.ts`; modify `src/platform/database/migration-sources.ts`, `test/integration/migrations.test.ts`。

**Interfaces:** Consumes prepared request。Produces `withPostWorkRequests(manager, callback)` (active transaction と callback の寿命内のみ)、4つの内部テーブル (note_work_state, work_request, work_item, work_capacity)。独自EntitySchemaはschema検査に登録する。migration up/downは凍結したDDL、公開schemaを変更しない。

- [x] 実DBで同一接続の業務書込み+依頼の原子性、rollback、異なるrequestIdのcanonical解決、immutable不一致、進捗保持、本文廃棄後拒否、並行create/delete、容量競合、削除枠、transaction外/終了後拒否をテストする。
- [x] `pnpm --filter backend-next test:integration -- test/integration/post-work.test.ts` の失敗を確認する。
- [x] bounded列/JSON、unique/FK/check/保持・走査索引、baseline容量行と up/down/登録を実装する。note 行を先にロック、同一キーの既存行を完全照合し、新規分だけ容量を条件付き確保する。例外時はtransaction全体を失敗にする。
- [x] COMMIT応答喪失を実DB接続へのfault injectionで検証する。成立済みの依頼を別接続で照会し、再実行しない。
- [x] migrate→check-migrations→check-schema、down→up、公開schema/履歴不変と制約違反を検証する。

## Task 3: Handoff and independent review

**Files:** Modify `packages/backend-next/README.md`、本計画のチェックボックス。

**Interfaces:** Consumes J1 code/tests。Produces J2/J3へ渡す入力形式・保存済み状態・検証結果と未実装範囲。

- [x] READMEの「内部テーブルなし」を更新し、同一transactionへの組み込み例・形式上限・J2/J3残作業を示す。
- [x] `pnpm --filter backend-upstream sync:check`、`pnpm --filter backend-next... build`、`pnpm --filter backend-next... typecheck`、unit/integration を実行する。
- [x] 独立エージェントが合意設計と差分をレビューし、有効な指摘を修正して再レビューを指摘0件まで繰り返す。
- [ ] shipping checks / diff確認後 commit・push、テンプレートに従う PR を作成する。#124 は Refs のみ（最終提出手順）。

## 検証記録とレビュー

- Unit 174件 / integration 56件（J1 18件）/ Role acceptance 63件 / process 20件が成功。
- 新規テストで未実装の失敗を確認した後に実装。独立レビューの2指摘（未await append の寿命逸脱、依頼全体2 MiB境界）は再現RED→GREENを確認し、再レビュー指摘0件。
- 代表1600通知itemと高entropyの2 MiB依頼について、index/TOAST込みの実relationサイズが保存済み論理予約額以下であることを検証。全運用条件の物理安全性を保証するものではない。
- migrate/check-migrations/check-schema のCLIが専用DBで成功し、down/up は実DB結合テストで検証。COMMIT応答喪失は実DBのcommit完了後・呼び出し元への応答境界に例外を注入して検証し、TCP障害の実測とは区別する。
- 結合テスト初期化時の pg 並行query非推奨警告は固定本家migration `1651224615271-foreign-key.js` 内の Promise.all 由来とtraceで確認。同期管理対象をこの変更で修正しない。
- J1の次はJ2。その後J3で管理・保持清掃・物理監視等を完了するまで、#124 全体を完了扱いにしない。
