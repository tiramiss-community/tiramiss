# 通知の PostgreSQL 保存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 実通知、成立記録、仕事の進捗を同一transactionで確定する。

**Architecture:** 通知業務型とDB保存アダプタを分ける。caller-owned transactionと既存のローカル完了fencingを使い、条件再評価を必須にする。通常workerへの接続は後続。

**Tech Stack:** TypeScript / TypeORM 1.1.1 / PostgreSQL 18 / Vitest。

**Spec:** `docs/superpowers/specs/2026-10-23-notification-persistence-design.md`

## Global Constraints

- 本家固定SHAとpublic schema・349件のmigration履歴を変更しない。
- 独自状態はbackend_internal、新migrationはup/downと登録を用意する。
- Repository/QueryBuilderを優先。advisory lock等DB固有操作のみSQL。
- 既存の100万行/20GiB、通常作成90%、係数4・1024bytes切り上げを維持する。
- 独立レビューの指摘を修正し、再レビューを受けてからPRへ進む。

## Review Focus

- claimのpayload差し替え: 保存済みrequest/item検証から実際の対象を導く。
- 実体削除後の遅延処理: effectが残り、再作成しない。
- 同じ受信者への並行作成: 件数上限と容量の差分が一致する。
- 途中のlease/deadline失効: 実体・effect・容量のすべてがrollbackする。
- renoteId欠落: targetNoteIdなしのrenote実体を成功にしない。

### Task 1: 実通知保存と回復の境界

**Files:**
- Create: `packages/backend-next/src/modules/notification/public.ts`
- Create: `packages/backend-next/src/platform/database/notification/schema.ts`
- Create: `packages/backend-next/src/platform/database/notification/migration.ts`
- Create: `packages/backend-next/src/platform/database/notification/persistence.ts`
- Modify: `packages/backend-next/src/platform/database/{data-source,migration-sources}.ts`
- Test: `packages/backend-next/test/integration/post-work-notification.test.ts`
- Modify: `packages/backend-next/test/integration/migrations.test.ts`

**Interfaces:**
- Consumes: `LocalExecutionClaim`, `withLocalWorkCompletion(manager, claim, work)`、実MiNote/MiUser、LocalWorkValidationCache。
- Produces: `PostNotificationPersistence.complete(manager, claim, recheck): Promise<NotificationEffect>`、`readEffect(manager, requestId, recipientId, type)`、`flush(manager, recipientId)`。再評価はNotificationFactsからdeliver/suppressを返す必須callback。

- [x] 実MiNote/ユーザーを保存し、上記Review Focusと同時確定・並行実行・異event・抑止・容量不足・commit後再接続・migration down/upのDBテストを書く。
- [x] 専用Compose環境で対象テストを実行し、新テーブル未存在によるREDを確認する。
- [x] schemaと新timestampのmigration、登録、業務型、保存アダプタを実装する。通知IDは既存codecを呼ぶ注入関数、作成時刻はDB時刻。
- [x] 対象DBテスト・migrations/check-schemaをGREENにする。変更ファイルlint/build/typecheck/unit/full integrationを実行する。
- [x] READMEへ今回の保証と未接続部分を反映し、独立レビューの全重要指摘を収束させる。
- [ ] shippingチェック後にcommit/pushし、#124に関連するPRを作成する。
