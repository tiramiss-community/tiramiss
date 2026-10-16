# backend-next の開発・運用ガイド

ルートの [AGENTS.md](../../AGENTS.md) に加え、このパッケージの調査・実装・検証では本ガイドを読む。

## 着手時に読むもの

1. 対象のGitHub Issue、その親Issueの対応順、先行依存。全体計画は [#114](https://github.com/tiramiss-community/tiramiss/issues/114)、Role初期実装は [#115](https://github.com/tiramiss-community/tiramiss/issues/115)。子Issueを追加・分割した場合は、親の対応順も更新する。
2. [バックエンド再設計の基本方針](../../docs/superpowers/specs/2026-10-15-misskey-backend-redesign-design.md) と、担当機能の詳細設計。Roleは [ロールのポリシー更新と反映](../../docs/superpowers/specs/2026-10-16-role-policy-update-design.md) を読む。
3. [README](README.md) の設定・起動・テスト手順と、変更対象のコード・テスト。

最小実行基盤は [PR #113](https://github.com/tiramiss-community/tiramiss/pull/113) で導入済み。基盤の存在だけでRole API・認証・実ジョブなどの業務機能も完成したとは扱わず、現在のコード・Issue・検証結果を確認する。

Issueは作業の範囲・順序・完了条件、設計書は合意した契約、READMEは実行手順を示す。食い違いがあれば既存コードだけを正解として仕様を変更せず、差異を整理する。合意済みの方針を実装上の都合で黙って変更しない。

## 編集範囲と依存規則

- 新しい業務処理はここへ実装する。リニューアルのために旧 `packages/backend` を変更したり、そのソース・ビルド成果物へ依存したりしない。
- 本家由来の定義はworkspace依存の `backend-upstream/entities`・`backend-upstream/migrations` から利用する。別パッケージの内部ファイルへの相対importで迂回しない。複製範囲を変える場合は [backend-upstreamの運用ルール](../backend-upstream/AGENTS.md) も読む。
- UseCaseが認可、同時確定、必要な副作用の境界を所有する。別UseCaseの呼び出しや、共通Service・DIなどを介した間接呼び出しは禁止する。
- 他モジュールへは狭い公開契約を通じて依存し、公開契約を含む循環を作らない。共有Serviceは独自にトランザクションを開始・確定しない。
- 業務コードへHono Context、TypeORM Entity・EntityManager、BullMQ Job、Packed型、DIコンテナを公開しない。Inversifyによる組み立てはcomposition側に限定する。
- 業務上の判断と変換は取得済みの材料から行い、レスポンス変換中のDBアクセスを避ける。時刻など結果に影響する値を明示的に渡す。
- トランザクション専用の窓口は同じ接続へ結び付け、終了後へ持ち出さない。失敗は例外で伝え、COMMIT結果不明を確定rollbackとして扱ったり、安全性を確認せず再実行したりしない。
- キャッシュ無効化通知と、業務上必要な後続処理の依頼記録は別の契約。Roleの無効化通知のためだけに永続ジョブ基盤を追加しない。具体的な仕事が必要になる前に汎用基盤を作り込まない。

## DBと実行プロセスの運用

- 本家の業務データ構造と `public.migrations` の履歴を維持する。独自の永続状態は `backend_internal` と独立した履歴で管理する。本家由来のmigrationは複製先で修正しない。
- 新しい独自migrationの `up()`・`down()` と登録先を用意し、既存の `src/platform/database/migration-sources.ts` の実行設定へ接続する。適用済みの履歴を編集しない。
- `migrate` は完全停止下で本家→独自の順に適用する。通常起動からの自動migration・schema同期・履歴作成を追加しない。
- `check-migrations` は履歴、`check-schema` は登録済みEntityの定義差分を検査する。後者は検証用DBで実行し、未取り込みEntityのテーブルを削除対象にしない。
- 通常起動はSupervisor→HTTP×1・worker×設定数。接続とDIは各子が作る。子の予期しない終了は全体停止とし、独自の再起動ループを足さない。
- Redisは必須。障害時のDBへの縮退運転を追加しない。commit後のキャッシュ通知失敗によって確定済みの更新を失敗扱いにしない。
- 終了は受付停止→受理済み処理の待機→接続解放とし、期限を設ける。HTTP切断を業務取消や再実行の理由にしない。

## ビルドと検証

コマンドはrepo rootから実行する。Node.js・pnpmはリポジトリの指定を使う。

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-upstream sync:check
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
```

`backend-upstream`を先にビルドする。旧backendのビルドや設定コンパイルは新パッケージの前提にしない。

変更に最も近い検証を選ぶ。全タスクで広域テストを繰り返すことは求めない。

| 変更・確認対象 | 検証 |
| --- | --- |
| Policy・UseCaseなど | `pnpm --filter backend-next test`。対象テストを絞り、HTTP・DIなしで振る舞いを確認する |
| DB・Redis・トランザクション・キャッシュ | 実際の依存先を使う `pnpm --filter backend-next test:integration` |
| 起動・停止・Supervisor・HTTP接続の寿命 | ビルド後に `pnpm --filter backend-next test:process` |
| 同期・生成処理 | `pnpm --filter backend-upstream test` と `sync:check` |
| schema・migration | 専用の検証用DBで `migrate` → `check-migrations` → `check-schema` と、該当の結合テスト |
| 出す前の共通チェック | [shipping-misskey-change](../../.claude/skills/shipping-misskey-change/SKILL.md) に従い、変更ファイルのlint・SPDX・localeを確認する |

DB・Redisの起動・停止・ポートと設定は [READMEの検証手順](README.md#検証) に従う。Dockerの `misskey-infra` プロジェクトはユーザー用なので使わず、停止・削除もしない。別の専用プロジェクトを使い、本番・既存の開発DBへmigrationやテストを実行しない。
並行セッションではComposeプロジェクト名と公開ポートも分け、片付けるのは自分が起動したプロジェクトだけにする。ポート変更にはREADMEの `BACKEND_NEXT_TEST_DB_PORT`・`BACKEND_NEXT_TEST_REDIS_PORT` を使う。

APIはJSONの形だけでなく認証・認可・エラー・保存結果・副作用も確認する。本家比較は対象コミットと分離環境を固定する。旧backend向けのAPI型生成やテストだけで新実装の互換性を証明したとは扱わない。CIの検証構成は [test-backend-next.yml](../../.github/workflows/test-backend-next.yml) を参照する。

## 別セッションへの引き継ぎ

- 対象Issue、親の対応順、作業ブランチ・worktree、コミット済みかどうかを示す。ローカルのメモだけを引き継ぎの根拠にしない。
- 実装済みの契約と残作業を区別し、実行した検証コマンド・結果・未実行の理由を残す。コード生成や無関係なテスト成功だけで完了にしない。
- 新たな仕様判断・意図的な差異は設計書や許可されたIssue更新へ反映する。本家追従の記録・移植支援スキルは [#134](https://github.com/tiramiss-community/tiramiss/issues/134) で整備する計画であり、現時点の実装・運用の有無を確認する。
- 次に着手できるIssueと先行依存を明記する。Issueの更新・PR作成などの外部送信は、ルートの許可ルールに従う。

## 記述方針

| 場所 | 残すこと |
| --- | --- |
| コード | **How**：どのように実現するか。実装を読めば分かる手順をコメントで重複説明しない。 |
| テストコード | **What**：何が期待される振る舞いか。実装の内部構造ではなく、入力・結果・外部に現れる副作用で示す。 |
| コミットログ | **Why**：なぜ変更が必要になったか。変更内容の列挙だけでなく、背景や解決する問題を残す。 |
| コードコメント | **Why not**：一見すると改善できそうなのに、あえてそうしていない理由。代案を採らない制約や、失われる保証を残す。 |

## 人が読み解きやすい構成

- 長い処理は、入力の検証、準備、実行、後始末など意味のあるまとまりごとに空行で区切る。
- import 群、型定義、関数・クラスの間にも空行を置き、宣言や処理の境界を見分けやすくする。
- 一文ごとに機械的に空行を足さず、関連する処理は近くにまとめる。読みやすさのためだけに手順を説明するコメントを増やさない。
- 名前や処理の配置でも意図を伝える。関数への切り出しは、意味のある責務や名前を与えられる場合に検討する。
- `if` / `else` / `for` / `while` / `do...while` の本文は、必ず中括弧で囲み、別行に置く。早期 `return`・`throw`・`break` や一文だけのループも例外にしない。`else if` はそのまま使ってよい。

## コメントを書くとき

- 将来の変更者が自然に選びそうな代案と、それでは困る具体的な理由を書く。
  例：「COMMIT 時の通信断では成否を確定できないため、ここでは自動再試行しない。」
- ファイル・関数ごとのコメントを義務にしない。自明な処理への逐語的な説明や、テスト名と同じ説明は追加しない。
- 理由は設計・実装で確認できる事実に基づける。推測した経緯や、実装が保証しない性質を書かない。
- 制約が変わったらコメントも更新・削除する。コメントを未解決の不具合を放置する根拠にしない。

## テストと複製コード

- テストは振る舞いの契約を示す。内部メソッドの呼び出し順など、契約でない実装の詳細へ不要に依存させない。
- 本家からの複製ファイルは、この方針のために直接編集しない。`backend-upstream` の同期管理対象は本家との同一性を保ち、生成ファイルも生成元で扱う。
- 独自に書いた同期スクリプトなどでは、同じ観点で判断理由を残す。
