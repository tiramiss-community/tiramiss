# tiramiss-build-scripts

`tiramiss-community/tiramiss`（Misskey の fork）の運用（upstream 追従、作業ブランチの再構築、トピック適用）を自動化するためのスクリプト群です。

本リポジトリは主に 2 つの形で使われる想定です。

- ローカルで `pnpm run <task>` を実行して運用する
- `tiramiss` リポジトリに `.tiramiss/` として vendoring し、GitHub Actions から同じエントリポイントを再利用する

---

## 前提

- Node.js 24
- pnpm
- git
- 実行対象のリポジトリ（例: `tiramiss-community/tiramiss` のフォーク）で作業すること
- **作業ツリーがクリーンであること**（未コミットの変更があると停止します）

セットアップ:

```bash
pnpm install --frozen-lockfile
```

---

## `.tiramiss` への vendoring 運用

実運用では `tiramiss` リポジトリ直下に `.tiramiss/` を作成し、このプロジェクトを **clone して vendoring（コミット）**する運用を想定します。

- GitHub Actions では `.tiramiss` を `working-directory` にして各スクリプトを実行します
- ただし `git` コマンドはサブディレクトリから実行しても親の worktree を操作できるため、`.tiramiss` 配下で実行しても `tiramiss` リポジトリ自体のブランチ/コミットを更新できます

例:

```bash
# tiramiss リポジトリのルートで
git clone <this-repo-url> .tiramiss
pnpm -C .tiramiss install --frozen-lockfile

git add .tiramiss
git commit -m "chore: vendor .tiramiss scripts"
```

---

## ブランチ/参照の前提（デフォルト）

このプロジェクトは以下の運用ブランチを前提にしています（すべて CLI オプション/環境変数で変更可能）。

- `develop-upstream`: upstream の `develop` を取り込む同期用ブランチ
- `develop-working`: 作業用の一時ブランチ（再構築されうる）
- `tiramiss`: トピック適用後の統合ブランチ

また upstream のタグは、名前空間付きで `refs/tags/upstream/*` に同期します。

---

## 主要コマンド

`package.json` の scripts に対応します。

- `pnpm run sync-upstream`
- `pnpm run rebase-working`
- `pnpm run issue-to-topics -- --token <token>`
- `pnpm run bundle-topics`
- `pnpm run apply-topics`
- `pnpm run typecheck`
- `pnpm run format:fix`

---

## 各スクリプトの概要

### 1) sync-upstream（upstream 追従）

Upstream の参照（デフォルト: `upstream/develop`）を、同期用ブランチ（デフォルト: `develop-upstream`）へ `merge` で取り込みます。
また upstream のタグを `refs/tags/upstream/*` に保存し、必要に応じて origin に push します。

- upstream remote が無ければ追加（既存 remote の URL 上書きはしない）
- `fetch --prune`（ブランチ）
- upstream tags を `refs/tags/upstream/*` へ fetch
- `develop-upstream` を作成/更新し `merge`
- `PUSH=true` の場合は `develop-upstream` とタグを origin へ push

オプション（環境変数でも指定可）:

- `--upstreamUrl` / `UPSTREAM_URL`（default: `https://github.com/misskey-dev/misskey.git`）
- `--upstreamRemote` / `UPSTREAM_REMOTE`（default: `upstream`）
- `--targetBranch` / `TARGET_BRANCH`（default: `develop-upstream`）
- `--sourceRef` / `SOURCE_REF`（default: `upstream/develop`）
- `--upstreamTagNamespace` / `UPSTREAM_TAG_NAMESPACE`（default: `refs/tags/upstream`）
- `--push` / `PUSH`（default: `true`）

注意:

- merge コンフリクトが起きた場合は停止します（手動解決が必要）。
- タグ同期は `--force` と `--prune` を伴います。

---

### 2) rebase-working（作業ブランチ再構築 + ツールの vendoring）

作業用ブランチ（デフォルト: `develop-working`）を、指定したベース参照から作り直します。
オプションで upstream タグを基準点にできます。
さらに外部リポジトリ（デフォルト: `tiramiss-community/tiramiss-repository-ops`）を `TOOL_DIR` へ vendoring し、依存関係をインストールしてコミットします。

主な挙動:

- `fetch --all --prune`
- `BASE_UPSTREAM_TAG` が指定されている場合:
  - `refs/tags/upstream/<tag>` を origin から fetch（先に `sync-upstream` が必要）
  - タグが `BASE_REF` の履歴上にあることを検証
- `develop-working` を作成/更新して `reset --hard <base>`
- `TOOL_REPO` を一時ディレクトリに clone → `.git` を除去 → `TOOL_DIR` にコピー
- `pnpm install --frozen-lockfile` を `TOOL_DIR` で実行
- 変更があれば `ops: vendor ...` としてコミット
- `PUSH=true` かつ変更があれば origin に push（既存なら force push）

オプション（環境変数でも指定可）:

- `--baseRef` / `BASE_REF`（default: `origin/develop-upstream`）
- `--baseUpstreamTag` / `BASE_UPSTREAM_TAG`（例: `2025.10.0`）
- `--upstreamTagNamespace` / `UPSTREAM_TAG_NAMESPACE`（default: `refs/tags/upstream`）
- `--workingBranch` / `WORKING_BRANCH`（default: `develop-working`）
- `--toolRepo` / `TOOL_REPO`（default: `https://github.com/tiramiss-community/tiramiss-repository-ops.git`）
- `--toolRef` / `TOOL_REF`（default: `HEAD`）
- `--toolDir` / `TOOL_DIR`（default: `./`）
- `--push` / `PUSH`（default: `true`）

注意（重要）:

- `TOOL_DIR` 配下は一度削除してからコピーします（`rm -rf <TOOL_DIR>/*` 相当）。
- `reset --hard` を行います。作業ブランチは「再構築されるもの」として扱ってください。

---

### 3) issue-to-topics（Issue → topics.txt 生成）

GitHub Issue の本文を読み、箇条書きから `topics.txt`（および任意で `bundles.txt`）を生成します。

このスクリプトが解釈する箇条書きは **次の 2 形式のみ**です。

- `topic:`: ブランチ名、または PR 番号から 1 トピックを追加
- `bundle:`: bundle ブランチを 1 トピックとして追加し、任意で `bundles.txt` に bundle 定義を出力

#### 束ね定義を Issue に書く（bundles.txt 生成）

「依存解析はしない」「束ね定義は人間が決めて Issue に書く」運用なら、Issue の箇条書きから `bundles.txt` を生成できます。

記法（箇条書き 1 行 = 1 エントリ）:

- `topic:`
  - `- topic: bundle/feature-x` → `topics.txt` に `bundle/feature-x` を追加
  - `- topic: 123` / `- topic: #123` → PR #123 の head ブランチ名を解決して `topics.txt` に追加（ラベル条件つき）
- `bundle:`
  - `- bundle: bundle/feature-x` → `topics.txt` に `bundle/feature-x` を追加
  - `- bundle: bundle/feature-x topic-A topic-B` → `topics.txt` に `bundle/feature-x` を追加し、`bundles.txt` に `bundle/feature-x topic-A topic-B` を出力

注意:

- `topic:` は 1 トークンのみ指定してください（ブランチ名 or PR 番号）
- `bundle: <bundle> <topics...>` は `bundle/*` 形式を推奨します
- topics 側に重複や自己参照（`bundle/...` が自分自身を含む）がある場合はエラーにします

実行例:

```bash
pnpm run issue-to-topics -- \
  --token "$GITHUB_TOKEN" \
  --issue 123 \
  --output topics.txt \
  --bundlesOutput bundles.txt
```

オプション:

- `--token` / `-t`（GitHub token。`GITHUB_TOKEN` を渡しても可）
- `--repo` / `-r`（default: `tiramiss-community/tiramiss`）
- `--issue` / `-i`（default: `47`）
- `--output` / `-o`（default: `topics.txt`）
- `--bundlesOutput` / `-b`（`bundles.txt` の出力先。未指定なら生成しない。環境変数 `BUNDLES_OUTPUT` でも指定可）
- `--labels` / `-L`（default: `先行実装,独自機能`）

---

### 4) apply-topics（topics 適用 → 統合ブランチ生成）

`topics.txt` に並んだトピックブランチを統合ブランチ（デフォルト: `tiramiss`）へ適用します。

- `topics.txt` を探索（デフォルト: `<TOOL_DIR>/topics.txt` → `topics.txt`）
- `tiramiss` を作成/更新し、現在の `HEAD` から開始
- 各トピックを `mode` に従って適用
- `PUSH=true` の場合、origin に push（既存なら force push）

モード:

- `merge`: `git merge --no-ff <topic>`
- `pick`: `merge-base(topic, BASE_REF)` からのコミットを `cherry-pick -x`
- `squash`（default）: `git merge --squash --no-commit <topic>` → コミット本文を寄せ集めて 1 コミット化（`Co-authored-by` も可能な範囲で維持）

オプション（環境変数でも指定可）:

- `--baseRef` / `BASE_REF`（default: `origin/develop-upstream`）
- `--integrateBranch` / `INTEGRATE_BRANCH`（default: `tiramiss`）
- `--toolDir` / `TOOL_DIR`（default: `./`）
- `--topics` / `TOPICS_FILE`（topics ファイルの明示パス）
- `--mode` / `MODE`（`merge` | `pick` | `squash`。default: `squash`）
- `--push` / `PUSH`（default: `true`）

コンフリクト時:

- `pick`: コンフリクトを解消して `git add -A && git cherry-pick --continue` 後、再実行
- `squash`: コンフリクトを解消して `git commit` 後、再実行

---

## 依存ブランチ（A に依存する B）を扱う場合

「ブランチBはブランチAに依存し、最終的に **A と B は常にセットで統合する**」前提なら、`apply-topics` のデフォルト運用（`MODE=squash`）でも問題なく回せます。

ポイント:

- `topics.txt` には **上位ブランチ（B）だけ**を載せます（A は載せない）
- B は A を含んだ状態（A の上に積まれている状態）を保ちます
- こうすると `squash` は実質「A+B をまとめて 1 トピックとして取り込む」形になります

避けたいこと:

- A と B の両方を `topics.txt` に並べる（A を squash した後に B を適用すると、A 分を二重に取り込もうとして衝突/重複しやすい）

開発・レビュー上は、A を土台として B を積んで PR を分ける（stacked PR）運用自体は可能です。
ただし **統合（topics 適用）の単位は B だけ**に揃えるのが最も安定します。

---

## 依存ツリーを束ねる（A に依存する B/C を 1 トピック化）

「A に依存する B と C があり、B と C は互いに無関係」など、依存関係がツリー状になる場合は、
**束ねブランチ X（統合用作業ブランチ）**を自動生成し、`topics.txt` には X だけを書く運用が安定します。

推奨命名:

- 束ねブランチ: `bundle/<name>`（例: `bundle/feature-x`）

このリポジトリには、束ねブランチを自動生成する `bundle-topics` を用意しています。

### bundles.txt の形式

`bundles.txt` は `bundle-topics` 用の定義ファイルです。
vendoring 運用では、通常 `.tiramiss/bundles.txt` に置いてコミットしておくのが一番シンプルです。

このプロジェクトの推奨運用では、**Issue 本文に `bundle:` 定義を直書き**し、`issue-to-topics --bundlesOutput bundles.txt` で `bundles.txt` も生成します（生成物として扱う）。
手で編集して管理することもできます。

ただし初回導入を楽にするため、`bundle-topics` は `bundles.txt` が見つからない場合に雛形を自動生成します。
（生成後は内容を編集してから再実行してください）

`bundle-topics` の探索順（デフォルト）は次の通りです。

- `<TOOL_DIR>/bundles.txt` → `bundles.txt`

（GitHub Actions では `.tiramiss` を `working-directory` にしているため、特に設定しなければ `.tiramiss/bundles.txt` が読まれます）

ファイルは 1 行 1 バンドルで次の形式で記述します。

```text
# <bundle-branch> <topic1> <topic2> ...
bundle/feature-x topic-A topic-B topic-C
```

### 実行例（develop-working 上で束ねブランチを更新）

```bash
# 例: develop-working をチェックアウト済み（CI でも同様）
pnpm run bundle-topics -- --baseRef HEAD
```

動作:

- `BASE_REF`（デフォルト: `HEAD`）から束ねブランチを作り直し（`switch -C`）、指定順で `merge --no-ff --no-edit`
- `PUSH=true`（デフォルト）なら origin に push（既存なら force push）
- 成功時は、実行開始時のブランチへ戻ります（CI で後続ステップが `develop-working` を前提にできるようにするため）

そして `topics.txt` 側には、**束ねブランチ名（例: `bundle/feature-x`）だけ**を書きます。

### 開発ブランチ（topic）は develop-working を基準にする

`bundle/*` は `bundle-topics` が **毎回作り直す生成物ブランチ**なので、開発ブランチのベースには使わないことを推奨します。

`develop-working` 更新に追従する流れは次の通りです。

1. `develop-working` を更新（`rebase-working`）
2. `topic-a` を新しい `develop-working` にリベース
3. `topic-b` / `topic-c` が `topic-a` に依存するなら、それぞれ `topic-a` にリベース

注意:

- `bundle-topics` は `bundle/*` を `switch -C` で作り直し、`origin` へも force push します。生成物ブランチとして扱ってください。

### Issue 本文テンプレ（topic/bundle 記法）

`issue-to-topics` は、Issue 本文の箇条書きから `topics.txt` を生成します。
束ね運用では、人手のミス（順番/抜け/二重記載）を避けるため、Issue 側は **`topic:` / `bundle:` 記法だけ**に統一するのが安全です。

例:

```markdown
## 次回取り込み（bundles）

- topic: bundle/feature-x
- topic: bundle/feature-y

## もしくは bundle 定義を直書き

- bundle: bundle/a-b topic-a topic-b
- bundle: bundle/a-c topic-a topic-c

## メモ

- topic: bundle/topic-z は来週
```

補足:

- PR 番号を `topic:` として書く場合は、PR 取得のため `--token`（または `GITHUB_TOKEN`）が必要です

---

## 典型的な運用フロー

ローカルで実行する場合の流れ例です（CI でも同じ順序で動きます）。

1. upstream 追従: `pnpm run sync-upstream`
2. 作業ブランチ再構築: `pnpm run rebase-working`（必要なら `BASE_UPSTREAM_TAG` を指定）
3. Issue から topics 生成: `pnpm run issue-to-topics -- --token <token> --issue <n> --bundlesOutput bundles.txt`
4. 束ねブランチ更新（必要な場合）: `pnpm run bundle-topics -- --baseRef HEAD`
5. topics 適用: `pnpm run apply-topics`（必要なら `--mode` を変更）

---

## GitHub Actions（workflows テンプレート）

このリポジトリの `workflows/` はテンプレートです。
`rebuild-working-branch` ワークフロー内で `workflows/` の内容を `.github/workflows/` にコピーして更新する運用を想定しています。

- `workflows/sync-upstream.yml`
  - 毎日 JST 03:00（UTC 18:00）に実行
  - `develop-working` を checkout し、`.tiramiss` 配下で `pnpm run sync-upstream`
- `workflows/rebuild-working-branch.yml`
  - 手動実行（任意で `base_upstream_tag` を指定）
  - `pnpm run rebase-working` → `pnpm run issue-to-topics` → `pnpm run bundle-topics` → workflows/topics をコミットして `develop-working` へ push
- `workflows/apply-topics.yml`
  - 手動実行
  - `.tiramiss` 配下で `pnpm run bundle-topics` → `pnpm run apply-topics`

権限/シークレット:

- いずれも「管理者のみ実行可」をチェックしています
- `WORKFLOW_APP_ID` / `WORKFLOW_APP_KEY`（GitHub App トークン発行用）が必要です
  - 通常の `GITHUB_TOKEN` ではワークフロー更新ができない前提で、GitHub App を利用しています

---

## 安全運用の注意

- すべてのスクリプトは「クリーンな作業ツリー」を要求します。
- `rebase-working` / `apply-topics` は `reset --hard` や force push を行うため、運用ブランチ以外では実行しないでください。
- `rebase-working` は `TOOL_DIR` 配下を削除します（`rm -rf <TOOL_DIR>/*` 相当）。`TOOL_DIR` の指定ミスが最大事故要因なので、実行前に必ず確認してください。
- 特に `.tiramiss` を `working-directory` にして実行している場合、`TOOL_DIR=./` は **`.tiramiss` 配下の全消し**になり得ます。外部リポジトリを vendoring する場合は、`TOOL_DIR=vendor/<name>` のように専用サブディレクトリを指定する運用を推奨します。
