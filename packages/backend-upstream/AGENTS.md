# backend-upstream の開発・運用ガイド

ルートの [AGENTS.md](../../AGENTS.md) に加え、このパッケージの同期・ビルド・利用方法を変える前に本ガイドを読む。
利用側の設計と検証は [backend-next/AGENTS.md](../backend-next/AGENTS.md)、実行手順の概要は [README](README.md) を参照する。

## このパッケージの責務

固定した本家コミットのEntity・必要な補助定義・全migration履歴を、内容を変更せず提供するworkspaceライブラリ。
業務処理、DB接続、migrationの適用は所有しない。旧backend全体を共有ライブラリとして取り込まない。

| 場所 | 編集方法 |
| --- | --- |
| `upstream-sync.json` | 複製元SHA・対象ファイル・許可する外部依存・生成規則の記録。変更内容を確認して編集する |
| `scripts/`、ビルド設定、package manifest | 独自コードとして編集し、同期・ビルド・利用側を検証する |
| `src/`、`migration/` | 本家のGitオブジェクトからの複製。直接編集しない |
| `exports/`、`.managed-files.json` | 同期スクリプトによる生成物。直接編集しない |
| `built/` | ビルド成果物。直接編集・コミットしない |

## 同期範囲や複製元を変える順序

1. [基本設計 §16](../../docs/superpowers/specs/2026-10-15-misskey-backend-redesign-design.md#16-本家の取り込みと保守) と、対象Issue・親Issueの対応順を確認する。現在の固定SHAは `upstream-sync.json` を正とする。
2. 固定SHAのGitオブジェクトがローカルで参照できることを確認する。浅いcloneで不足していれば必要な履歴を取得する。作業ツリーの内容や未コミットの変更をコピー元にしない。
3. 追加対象と必要な参照先・外部依存を調べ、manifestを更新する。複製元SHAの変更は本家追従の対象範囲を変えるので、単なるビルド修正のついでに進めない。
4. `pnpm --filter backend-upstream sync` を実行し、追加・変更・削除と公開入口の差分を確認する。
5. `sync:check`、同期テスト、依存順ビルド・型検査と、利用側の該当テストを実行する。

新しい依存を検出して同期が止まった場合は、必要な範囲を調査して明示する。未知の依存を無視したり、旧Service・NestJS Moduleまで自動追跡して取り込んだりしない。
importやmigrationの内容・ファイル名・クラス名・timestampを、ビルドやlintの都合で書き換えない。
別名importなどに対応が必要なら、基本設計に沿ってライブラリ側のビルドで解決し、出力JavaScriptをNode.jsで読み込めることも検証する。

## 公開入口とmigration

- 利用側は `backend-upstream/entities` と `backend-upstream/migrations` からimportする。内部パス・別パッケージをまたぐ相対パス・内部ディレクトリへのglobを利用側へ露出しない。
- Entityとmigrationの入口を統合しない。Entityだけの利用で全migrationとそのネイティブ依存を読み込ませない。
- Entityは `backend-next` の永続化アダプタで扱い、業務モデルとして公開しない。
- 本家migrationは全履歴と既存の `public.migrations` の識別情報を引き継ぐ。新機能で必要なEntityだけを取り込んだ場合も、migrationまで部分履歴にしない。
- 独自の永続状態・migrationは `backend-next` 側の `backend_internal` で管理する。この複製領域へ独自定義を混ぜない。
- 本パッケージからDBへ接続・適用しない。完全停止下の適用と、通常起動の読み取り専用検査は `backend-next` が担当する。

## 検証と完了判定

repo rootから必要なコマンドを実行する。

```sh
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
```

同期スクリプトの変更では、固定元の再現、未宣言依存の拒否、管理対象の削除と手書きファイルの保持を検証する。
公開入口・Entity・migration・依存の変更では、利用側の読み込みや該当するDB結合検証も選ぶ。環境と共通チェックは利用側のガイドに従う。

`sync:check` の成功は、複製・生成の一致を示すだけで、業務動作の移植完了ではない。
本家更新の「対応済み」は、受け入れ条件・新実装での実現箇所・検証結果が揃った場合だけとする。
本家追従の記録・スキル整備は [#134](https://github.com/tiramiss-community/tiramiss/issues/134) を参照し、同期だけで未対応項目を消さない。

独自スクリプトのコメント・テスト・可読性には、利用側ガイドの記述方針も適用する。複製ファイルへその方針を適用するための手編集はしない。
