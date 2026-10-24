# AP Recipient Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 固定宛先から最大100件ずつ送信 item を原子的に生成する。

**Architecture:** 既存 local execution の claim/completion に page を追加する。保存済み payload と台帳から cursor の出自を再検証し、同じ caller transaction で子生成と容量予約を行う。

**Tech Stack:** TypeScript / TypeORM / PostgreSQL / Vitest

**Spec:** docs/superpowers/specs/2026-10-23-ap-recipient-pages-design.md

## Global Constraints

- schemaVersion=1、page最大100宛先、8試行、元requestの24h deadlineを維持。
- 通常90%容量、1536 base・既存formulaVersion=1。
- 管理対象upstreamと既存migrationは変更しない。外部HTTPをtransactionへ入れない。

## Review Focus

- 実在するが正規境界ではないcursorを拒否する。
- 100件ちょうどで空の次ページを増やさない。
- 容量不足とlease失効で子・次ページ・親成功が部分確定しない。
- commit結果不明後も同じ子を二重生成しない。
- 台帳のidentityとrequestが一致しないとき配送itemを作らない。

### Task 1: 固定ページのclaimと送信item生成

**Files:** Create `platform/database/ap/page-payload.ts`, `page-validation.ts`, `pages.ts`、`test/integration/post-work-ap-pages.test.ts`。Modify local-work-validation / local-execution / local-execution-state、platform/jobs/local-execution、README（すべて packages/backend-next 配下）。

**Interfaces:** `PostApRecipientPages.complete(manager: EntityManager, claim: LocalExecutionClaim): Promise<{count:number}>`。local claim は `ap.expand.page` を受ける。継続 payload は `{after:string,previous:string}`、初回は `{after:null}`。

- [x] 境界・継続・rollback・quota・fence・破損・並行・commit不明の実DBテストを作り、未実装で失敗することを確認する。
- [x] 保存形式、bounded provenance 検証、page claim、原子的な最大100子生成を実装する。
- [x] 専用DB/Redisで対象テスト、local実行とsnapshot回帰、unit、build/typecheckを通す。
- [x] 独立エージェントで全差分をレビューし、指摘を修正して収束まで再レビューする。
- [ ] READMEと計画へ検証を記録し、shippingチェック後commit/push/PRを作成する。


## 実行記録

- 初期未実装RED → 基本32件GREEN。追加境界・既存回帰123件PASS。
- 独立レビュー: 既存子itemのimmutable照合・再利用が不足というP2を修正。追加テスト2件RED（duplicate key）→44件GREEN。再レビューで追加指摘なし。
- PASS: dependency build/typecheck、unit185件、実DB/Redis結合263件/15files、変更9ファイルlint、SPDX2975、locale safety、diff check。
- process/acceptanceは起動・HTTP変更がないためSKIPPED。本家定義・Entity/migration変更なし。
- 既知: 本家migration実行時のpg並行query非推奨警告。今回の失敗ではない。
- 残件: 実送信/host lease、Delete/Undo、workerと回復・走査・更新・停止の起動接続、管理と清掃。#124は未完了。
