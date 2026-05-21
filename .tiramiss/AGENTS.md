# AGENTS.md

本ファイルは、このリポジトリで作業する LLM エージェントおよびコード生成ツール向けの共通指針（SSoT）です。詳細はすべて `.claude/rules/`（厳守事項）と `.claude/docs/`（参照資料）に分割しており、本ファイルはエントリポイントとして最小限の内容のみを記載します。

## プロジェクト概要

- 目的: Misskey フォーク `tiramiss` の運用自動化（upstream 追従、作業ブランチ再構築、Issue 由来の topics 適用、束ねブランチ生成、統合ブランチ生成）を担う CLI 群です。
- 技術スタック: Node.js 24 + pnpm + TypeScript (NodeNext, ES2022, `noEmit`) + vite-node + Biome + yargs + Octokit です。
- 実行形態: ローカルでは `pnpm run <task>` を実行します。本番運用では本リポジトリを対象側へ `.tiramiss/` として vendoring し、GitHub Actions から同一のエントリポイントを再利用します。

## ディレクトリ早見表

- `src/`: 各エントリポイント（`sync-upstream.ts`, `rebase-working-branch.ts`, `issue-to-topics.ts`, `bundle-topics.ts`, `apply-topics.ts`）。
- `src/utils/`: 共通ラッパー（`git.ts`, `proc.ts`, `upstream-tags.ts`）。直接 `child_process` を叩かず必ずこれを通します。
- `workflows/`: GitHub Actions のテンプレートです。`rebuild-working-branch` で対象側の `.github/workflows/` へコピーされます。
- `.claude/`: LLM エージェント向けの構造化ドキュメント群です（`rules/`, `agents/`, `skills/`, `docs/`）。
- `README.md`: 人間向けの一次ドキュメントです。CLI オプション・既定値の最終的な真実はこちらに置きます。

## 主要スクリプト

- `pnpm run sync-upstream`: upstream（既定 `upstream/develop`）を `develop-upstream` へマージし、上流タグを `refs/tags/upstream/*` に同期します。
- `pnpm run rebase-working`: `develop-working` をベース参照から再構築し、外部の repository-ops を `TOOL_DIR` へ vendoring します。
- `pnpm run issue-to-topics`: GitHub Issue の `topic:` / `bundle:` 記法から `topics.txt` と任意で `bundles.txt` を生成します。
- `pnpm run bundle-topics`: `bundles.txt` の定義に従い `bundle/*` ブランチを毎回作り直します。
- `pnpm run apply-topics`: `topics.txt` を統合ブランチ `tiramiss` へ `merge` / `pick` / `squash`（既定）で適用します。

## 厳守事項（要約）

1. 応答・コード内コメント・エラーメッセージは原則として日本語で記述します。
2. 破壊的 git 操作（`reset --hard` / force push / `TOOL_DIR` 配下の上書き）を行う前に、対象ブランチとパスをユーザーへ提示し明示確認を取ります。
3. git および外部プロセス起動は必ず `src/utils/git.ts` の `git()` / `gitOk()` / `ensureClean()` 等、または `src/utils/proc.ts` の `run()` を通します。`child_process.spawn` の直叩きは行いません。
4. コードスタイルは Biome（ダブルクオート / 2 スペース）に従い、CLI は `yargs` の `.option` で宣言して環境変数で上書きできるようにします。
5. 軽量 CLI のスコープを逸脱する追加（フレームワーク導入・他リポジトリの自動操作・秘密情報の埋め込み）は行いません。

各厳守事項の根拠と具体例は次のファイルにあります（必要なときのみ参照してください）。

- 言語ポリシー: [.claude/rules/language.md](.claude/rules/language.md)
- Git 安全運用: [.claude/rules/git-safety.md](.claude/rules/git-safety.md)
- コードスタイル: [.claude/rules/coding-style.md](.claude/rules/coding-style.md)
- 非目標とスコープ: [.claude/rules/non-goals.md](.claude/rules/non-goals.md)

## 追加読込ガイド（オンデマンド）

セッション開始時には読み込まず、関連タスクに着手する直前にだけ参照します。

- 5 スクリプトの運用フローと CLI オプション/環境変数の対応: [.claude/docs/operational-flow.md](.claude/docs/operational-flow.md)
- 破壊的 git 操作の深掘り・コンフリクト時の手順・`bundle/*` の扱い: [.claude/docs/git-safety.md](.claude/docs/git-safety.md)
- `src/utils/` API リファレンス、ログ規約、エラーハンドリング方針: [.claude/docs/code-conventions.md](.claude/docs/code-conventions.md)
- ワークフローテンプレート、`.tiramiss` vendoring、管理者ガード、必要シークレット: [.claude/docs/github-actions.md](.claude/docs/github-actions.md)

## サブエージェントとスキル

`.claude/agents/` および `.claude/skills/` には、本プロジェクト固有の作業を補助する定義を置いています。対応するツールから呼び出し可能です。

- 上流追従と作業ブランチ再構築の手順検証: [.claude/agents/upstream-sync-runner.md](.claude/agents/upstream-sync-runner.md)
- 破壊的 git 操作レビュー: [.claude/agents/git-safety-reviewer.md](.claude/agents/git-safety-reviewer.md)
- 新しい CLI スクリプトを追加する手順: [.claude/skills/add-cli-script/SKILL.md](.claude/skills/add-cli-script/SKILL.md)
- 新しいワークフローテンプレートを追加する手順: [.claude/skills/add-workflow/SKILL.md](.claude/skills/add-workflow/SKILL.md)

## 用語の統一

- 「LLM エージェント」: チャット型のコード支援ツール全般の総称です。
- 「コード生成ツール」: 補完・編集系の支援ツールの総称です。
- 「破壊的 git 操作」: `reset --hard` / force push / `TOOL_DIR` の上書きを含む不可逆操作を指します。
- 「運用ブランチ」: `develop-upstream` / `develop-working` / `tiramiss` / `bundle/*` をまとめて指します。

## 他ツール互換メモ

本ファイルが唯一の SSoT です。`AGENTS.md` 直読に対応するツールは本ファイルのみを読み込めば十分です。Claude Code は `CLAUDE.md` 経由で本ファイルを `@import` します。GitHub Copilot は `.github/copilot-instructions.md` から本ファイルを案内する形にしています。
