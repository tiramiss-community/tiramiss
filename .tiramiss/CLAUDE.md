# CLAUDE.md

本プロジェクトにおける指針はすべて `AGENTS.md` を SSoT としています。Claude Code は以下の import 経由で本体を読み込みます。

@AGENTS.md

## Claude Code 固有の補足

- ルール・サブエージェント・スキル・詳細資料はすべて `.claude/` 配下に集約しています。それぞれの所在は `AGENTS.md` の各リンクから辿れます。
- `.claude/docs/*.md` はオンデマンド読込前提です。タスクに直接関係する場合のみ `Read` してください。常時読み込まないことでセッション開始時のコンテキスト消費を抑えています。
- 破壊的 git 操作の前にはユーザーへ明示確認を取る方針です。詳細は [.claude/rules/git-safety.md](.claude/rules/git-safety.md) を参照してください。
