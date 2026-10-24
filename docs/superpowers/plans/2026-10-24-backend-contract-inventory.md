# Backend contract inventory implementation plan

> **For agentic workers:** Use superpowers:executing-plans to execute this plan; obtain independent whole-branch review and repeat review until findings converge, as requested by the user.

**Goal:** #129 の固定本家の公開入口と必要な保存・副作用を、新実装・検証根拠・担当 Issue へ対応付ける。

**Architecture:** 固定 SHA の Git オブジェクトを TypeScript AST で読み、API 登録・HTTP route・stream・AP activity・job を列挙する。機械的な入口の一覧と、人が確定する領域の責任・未対応・意図的差異を分け、領域一覧と検証スクリプトを版管理する。

**Tech Stack:** Node.js built-ins、既存の TypeScript devDependency、JSON、Markdown。

**Spec:** #129、#114、および `docs/superpowers/specs/2026-10-15-misskey-backend-redesign-design.md` §2・14・16。投稿の境界は `2026-10-21-note-flow-design.md` §9。

## Global constraints

- 本家 SHA は `8e07cf085adf7009583d234a208e30436f020e26`。新実装の監査基準は `a5840cc43089ea49c9f3ac14444390b0a809953f`。
- 本家オブジェクトと registry を入力にする。fork の作業ツリーや生成物を移植対象と混ぜない。
- 業務実装・managed upstream・migration・locale・CHANGELOG は変更しない。
- 入口の列挙は互換性テストの代用にしない。Role show/update 以外の HTTP API を完成扱いにしない。
- Issue 作成・親子/必須依存の更新・feature branch push・PR 作成まで実施する。merge・close・レビュー返信は行わない。

## Review focus

- registry 外のログイン・OAuth・API fallback、AP/HTML の同一 path、multipart を落とさない。
- stream の接続操作/別名/状態変更、queue 内の複数 dispatch と queue 外の timer を落とさない。
- 宛先展開/通知の保存 adapter と、通常 worker・HTTP・完全な公開契約を区別する。
- 領域への未分類や既存 Issue との二重責任、親の全完了を要求する循環/過剰 blocking を検出する。
- 壊れた参照、証拠なしの verified、固定 SHA と snapshot の不一致を検査で拒否する。

## Task 1: Reproducible source inventory and validation

**Files:** `scripts/backend-contract-inventory.mjs`、`scripts/backend-contract-inventory.test.mjs`、`docs/superpowers/compatibility/backend-inventory/domains.json`、`contracts.json`。

**Interfaces:** Script consumes the pinned Git source and domain ownership rules; exports extraction/validation helpers for Node tests and produces the checked-in JSON contract list. CLI: `node scripts/backend-contract-inventory.mjs --write|--check`.

- [x] 独立レビューの入口調査を確認し、領域と明示的な共通能力を定義する。
- [x] 未分類・重複・証拠欠落・参照切れ・registry 外の route を検証する test を先に追加し RED を確認する。
- [x] AST の抽出と検証を実装し、全登録 API と非 API 入口を生成する。
- [x] Node test と `--check` が成功することを確認する。

## Task 2: Ownership, evidence and remaining feature issues

**Files:** 上記 `domains.json`、`docs/superpowers/compatibility/backend-inventory/README.md`、`packages/backend-next/README.md`。

**Interfaces:** 領域ごとに scope、保存/副作用、owner/関連 Issue、実装/検証/差異を持ち、各 contract の domain から辿れる。

- [x] Role の実装済み2契約と、job/通知/AP の部分実装の根拠を記録する。
- [x] 未対応領域を既存 Issue と照合し、不足する領域 Issue をテンプレート通りに作成する。
- [x] #128 の子として登録し、#129 の必須依存を設定する。#114/#128/#129 には PR 作成後に成果物リンクを追記する。
- [x] 件数の意味、未検証範囲、次の優先順位、更新手順を README へ残す。

## Task 3: Independent review and shipping

**Files:** すべての変更。

- [x] 独立レビューを受け、指摘を修正して収束するまで再レビューする。
- [x] `node --test scripts/backend-contract-inventory.test.mjs`、`node scripts/backend-contract-inventory.mjs --check`、shipping 検査、差分検査を実行する。
- [ ] commit/push/PR を作成し、#129 の成果物・件数・残作業の追跡先を報告する。

## Execution record

- 分離 worktree: `/tmp/tiramiss-contract-inventory-129`、branch: `docs/backend-next-contract-inventory-129`。
- 基準: `a5840cc43089ea49c9f3ac14444390b0a809953f`。root checkout は変更しない。
- 初期調査: endpoint directory の 440 `.ts` のうち2件は test。公開 registry は438契約。ファイル数をAPI数と混同しない。
- 生成結果: 438 API、84 HTTP登録、19 stream channel、10接続操作、14 AP受信dispatch、35 job dispatch、36 processor、9定期登録、3 CLI、39共通能力の計687行。重複する確認単位なので機能数/完成率には使わない。
- 28領域。既存5領域のIssueを再利用し、23領域を #178–#200 に追加（親#128、必須依存#129）。通知#177、CLI/配布#138、回復設計#130の境界も明記する。
- RED→GREEN: 抽出module/dispatch helper未実装、HTTP定数解決、参照先検査、handler集合の網羅性を確認。最終Nodeテスト9件成功、snapshot/生成表の整合性検査成功。
- 独立レビュー: user webhookの全領域所有、異なるaliasの同一handlerによる登録漏れ検出、DM既読操作、clipのqueue外timerの4指摘を反映。2人の独立レビューと再レビューで追加指摘なし。
- 検証: workflow YAML構文、Node構文、文書参照、diff、SPDX、locale safety成功。ESLintは変更ファイルに管理対象なしでSKIPPED。業務コード/schema/API型変更なしのためbackend広域テスト/build/migration/API生成は実行しない。
