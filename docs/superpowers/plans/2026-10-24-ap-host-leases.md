# AP host lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AP 送信の全 worker 共通 host 2 枠を、実行権と同じ transaction で保存する。

**Architecture:** backend_internal の slot 2 行に owner/epoch/token/期限を保持する。TypeORM QueryBuilder で操作し、DB 時刻・容量と caller-owned transaction を使う。

**Tech Stack:** PostgreSQL 18 / TypeORM / Vitest。

**Spec:** `docs/superpowers/specs/2026-10-24-ap-host-leases-design.md`

## Global Constraints

- host 当たり AP 2、lease 60 秒、回収は参照終了後 30 日、最大 100 行/回。
- 新規行は base 256 / formula 1、通常 90% 枠。既存 migration は変更しない。
- HTTP・送信 claim・worker 接続は後続。生 SQL は DDL と検査・テストに限定する。

## Review Focus

- 同一実行を二重取得しても 2 枠を消費しない。
- slot 再利用・回収後の再作成を古い handle が変更しない。
- ロック待ちで期限が過ぎても lease を復活させない。
- host 枠不足で同 transaction の claim/試行加算も rollback する。
- 有効参照を持つ idle host を清掃せず、削除時は保存課金だけを戻す。

### Task 1: schema と host lease adapter

**Files:** `src/platform/database/ap/host-schema.ts`・`host-migration.ts`・`host-leases.ts`、database 登録、`test/integration/ap-host-leases.test.ts`、migration 検証。

**Interfaces:** `PostApHostLeases.acquire(manager, {workId, owner, epoch})` → host/slot/hostEpoch/token/実行識別の lease。`renew(manager, lease)` → void（失権は例外）。`release(manager, lease)` → boolean。`cleanup(source, limit=100)` → 削除行数。

- [x] 実 DB テストを先に追加し、未実装で RED を確認する。
- [x] 新規 migration の up/down と EntitySchema を登録する。
- [x] 取得・再取得・延長・解放・回収を実装して対象テストを GREEN にする。
- [x] migration 履歴/差分/rollback のテストを更新し、unit・typecheck・近接 integration を実行する。

### Task 2: 独立レビューと出荷

- [x] README に利用契約と未接続範囲を記載する。
- [x] 別エージェントの独立レビューを受け、指摘を修正して再レビューする。
- [x] shipping（変更 lint・SPDX・locale）、差分検査と必要な回帰を実行する。
- [ ] commit・push・#124 を参照した PR を作成する（merge は行わない）。

## 実行記録

- Task 1 完了: 新規 host 枠テストを未実装で RED 確認後に実装。capacity ロック待ち後の再取得が失効 item を返す回帰テストも RED→GREEN を確認した。
- 設計確認: 参照終了から 30 日を守るよう、参照 work の finished_at も保持判定へ含めた。work ID の最大 128 bytes を作成時に予約した。
- PASS: `pnpm --filter backend-next... build` / `typecheck`。
- PASS: `pnpm --filter backend-next test`（20 ファイル、185 件）。
- PASS: `pnpm --filter backend-next test:integration`（16 ファイル、295 件、101.66 秒）。うち新規 host 枠 32 件。migration up/down・349 件の本家履歴維持・schema 差分なしを含む。
- 既存 8 fixture の TRUNCATE 対象に新しい参照テーブルを明示追加した。初回の広域実行は同 FK 初期化エラーで失敗し、修正後に全件成功した。
- 独立レビュー: 設計確認と別エージェントの実装レビュー。実装レビューは指摘 0 件、fixture 修正後の再レビューも指摘 0 件。
- PASS: `node scripts/check-shipping.mjs --base 5672a696292e461d7801968346be1bbb32867b54`（変更 TS 15 ファイル lint / SPDX 2979 ファイル / locale safety）。`git diff --check` も成功。
- SKIPPED: process/acceptance、旧 backend API 型生成。本変更は起動/HTTP/API 契約を変更しない。CHANGELOG は未変更。
- 残作業: AP 送信 claim・12 試行・開始/結果不明回収、HTTP/署名・配送条件、Delete/Undo、worker 寿命と周期清掃、管理・容量監視。#124 全体は未完了。
