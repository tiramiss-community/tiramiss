# 投稿N0 本家比較契約 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #167 の固定本家 HTTP・保存・AP・stream の観測を再実行でき、#168–#176 が共有できる比較資料を残す。

**Architecture:** 固定本家を Git archive から隔離展開し、本家の e2e サーバーへ probe を追加する。入力・正規化済み期待値・実行手順・未対応台帳を `docs/superpowers/compatibility/note/` に保存する。製品コードと複製元の業務処理は変更しない。

**Tech Stack:** Node.js / pnpm / TypeScript / Vitest / PostgreSQL 18 / Redis 8 / localhost fake inbox.

**Spec:** `docs/superpowers/specs/2026-10-21-note-flow-design.md` (§8 C1–C10 / F1–F8), #167.

## Global Constraints

- 比較本家 SHA: `8e07cf085adf7009583d234a208e30436f020e26`。
- fork 固有機能は対象にしない。未測定を実測済みとせず、新 backend の未移植を意図的差異へ読み替えない。
- 専用 Compose `note-167-reference`、DB55167 / Redis56167 / HTTP61167 / controller62167 / fake inbox63167。ユーザー用 infra を使わない。
- 正規化対象は生成ID・時刻・host・署名など非決定値のみ。配列順・null/省略・error code/id/message/status は保持する。
- PG通知保存、同時確定、413/503、取消・有限回復は新設計の差異。本家の実測とは分離する。

## Review Focus

- 認証失敗と入力不正が同時に存在する場合の検証順と App/native token の違い。
- hidden note の本文・添付・poll・ネスト字段の null/省略を正規化で消さない。
- follow・指定相手・reply/mention による可視性例外と public→home 補正。
- channel人数の更新時点、返信/Renote数、削除の監査・Undo fallback。
- 実際の AP HTTP と queue記録の区別、localOnly の配送抑止、stream の欠落を成功と誤認しない。

### Task 1: 固定本家の観測環境とHTTP/DB比較probe

**Files:** Create `docs/superpowers/compatibility/note/reference-note.e2e.ts`, `http-cases.json`, `observations.json`.
**Interfaces:** consumes fixed upstream e2e harness; produces ordered case IDs and normalized HTTP/DB observations for N1–N3/N5.

- [x] 固定本家を隔離展開し専用設定を起動前に検査する。依存とソースSHAを固定する。
- [x] C1–C8/C10 の入力、認証/検証順、show、カウント、添付/投票/関連入力を実HTTPと別DB接続で観測する。
- [x] 観測JSONを保存した後、record無効で同じprobeを再実行し期待値の再現を確認する。

### Task 2: AP/stream と C/F ケースの引き継ぎ

**Files:** Extend probe; create `README.md`, `coverage.json`, `intentional-differences.json`.
**Interfaces:** consumes Task1 case IDs; produces C1–C10/F1–F8 evidence/ownership ledger.

- [x] localhost受信器と本家実workerで AP audience/Create/Announce/Delete/Undo と配送集合を確認する。Redis stream購読で削除通知も確認する。
- [x] C/F各ケースの観測・未測定・新設計期待を区別し、#159–#200の既存Issueへ追跡する。
- [x] 再構築・実行・記録更新の手順、後続Issueが再利用するJSONと条件を記述する。

### Task 3: 独立レビューとPR

**Files:** Update `packages/backend-next/README.md` only with entry link; plan execution record.
**Interfaces:** consumes probe/goldens/coverage; produces reviewable PR linked to #167.

- [x] 期待値再生・probe lint・shipping・diffを検証する。
- [x] 独立エージェントレビューを依頼し、指摘を修正・再レビューして収束する。
- [ ] feature branchをcommit/pushし、テンプレートに従うPRを作成する。Issue親へ成果/次順を反映する。

## Execution record

着手基準 develop `a5840cc43089ea49c9f3ac14444390b0a809953f`。PR #201 は未マージで、本作業は依存しない。


2026-10-24–25の実行記録:

- 固定本家をGit archive展開し、src/migration/manifest/lock 1330ファイルのGit blob hash一致を検証。専用Compose note-167-referenceを使用した。
- 42入力と追加シナリオを本家HTTP/別DB接続/実worker→fake inbox/Redis PubSubへ接続し、89観測とproduction rate 3観測を保存。正規化の回帰検査追加後は本家51テスト。
- Ruling: F1–F7は永続request/所有世代/同時確定という新設計の保証。本家で同じ保証を実測済みとせずcoverageへ担当Issueと追加する障害試験を記録した。誤った場合はN7で必要な障害比較が不足するため、#176で全台帳を照合する。
- 独立レビュー初回のP2二件: 固定MD5の置換、相対投票期限の上限/DB一致の未検証を修正。本文/MD5/エラーUUID保持をRED→GREEN。期限はrequest前後+600000msの範囲と保存値一致を正規化前にassertした。
- 二巡目のP2一件: 引用AP HTML内の生成リンクの正規化漏れ。回帰検査を追加してREDを確認し、URL成分の置換をHTML内にも適用した。
- record失敗ガード: 参照コピーに意図的なassert失敗を注入し、失敗suiteがgoldenを上書きしないことをSHAで検証した（PASS）。注入は復元済みで成果物に含まない。
- 共通shippingはSPDX/locale PASS、管理対象lintは対象なし。参照packageからprobeのeslintも実行する。製品/API/Entity/migrationは変更せず、API型再生成・広域backendテスト・schema検査は対象外。


最終結果: 本家51テストのrecord無効再生、production rate HTTP/DB probe、参照側probe lint、Node fixture4件、workflow YAML、文書リンク23件、Node構文、SPDX/locale/diffはPASS。独立レビューは3巡で指摘3件を解消、最終No findings。実装/API/schema変更がないため広域の新旧backendテスト・API型生成・schema検査はSKIPPED。PRのCI結果はローカル検証と区別する。
