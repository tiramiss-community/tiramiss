# backend-next CI の独立検査を並列化する

対象: `.github/workflows/test-backend-next.yml`。基準 `8a791b0033`（PR #589 merge 後）。S1 の機能実装は進めない。

## 設計

現行の suite 内部・対象・コマンドを維持し、4本の独立 runner へ配置する。

| Job | 検査 | 準備 |
| --- | --- | --- |
| contracts | 対応表、`scripts/*-contract*.test.mjs` | full checkout、Node/pnpm、frozen install、lockfile 不変 |
| checks | upstream sync、build、typecheck、lint、upstream test、backend-next unit | 同上。DB/Redis/Meili なし |
| integration | backend-next integration、Role acceptance | 同上と build。従来のPG/Redis/Meiliを独立したrunnerに作る |
| process | backend-next process | 同上と build。同じ3サービスを別runnerに作る |

各検査は担当 lane で一度だけ実行する。install/lockfile guard と runtime が必要な build は runner ごとの準備として繰り返す。6秒程度の install と短い build のために artifact/cache 受渡しや共通 action を追加しない。

既存 job ID/check名 `foundation` は `needs` に4本すべてを列挙し、`always()` で判定する。`needs` のキー集合が期待する4本と一致し、全 `result` が `success` の場合だけ成功する。failure/cancelled/skipped・欠落・未知の結果は不合格。lane の `continue-on-error`、条件付き skip、matrix fail-fast は追加しない。

元の push/PR/dispatch 条件を維持し、script helper 単独の変更も拾うため既存 script path を `scripts/**` で包含する。古い run の cancel、suite 内部の並列化/sharding、サービス共有、依存更新は対象外。

## 実装と検証

1. 実際の workflow を YAML として読み、トリガー・検査の配置/一意性・runner ごとの準備・3サービス・依存関係を検査する契約テストを追加する。変更前に失敗を確認する。
2. 4 lane と fail-closed `foundation` を実装する。テストは YAML 内の最終 gate の shell を実行し、全成功、各 lane の failure/cancelled/skipped、欠落/追加/不正 JSON を確認する。
3. 対象テスト・workflow parser/linter・shipping を実行し、全コマンドの対応を確認する。公開と実 CI は親が扱う。

## 性能の扱い

既存の実測では PR #589 の foundation は11分33秒、#590は15分23秒。主な直列工程は contracts 118/278秒、integration 181/222秒、process 283/308秒、install は約6秒。今回の変更は独立工程の待ちを除く。runner の空き待ち・setup の重複と runner 使用量は増え得る。新 layout の実 CI が完了するまで、短縮秒数や目標達成を実測済みとは表現しない。

## Review focus

- 1本の検査漏れや skip が `foundation` を成功させないこと。
- trigger、full Git history、compiled upstream exports、3サービスと health check を保持すること。
- integration と process は異なる runner で既存のポートを使い、DB/Redis状態を共有しないこと。

## 実装・ローカル検証

4 lane と既存 `foundation` gate を実装した。変更前は workflow 契約29件が不合格になり、変更後は29件すべて成功。既存の `js-yaml` で実 YAML を解析し、gate の shell を実行して結果を確認した。独立レビューは指摘なし。

公式 release checksum と一致する actionlint 1.7.12 で対象 workflow は指摘なし。SPDX / locale safety は成功、変更ファイル lint は対象なしで SKIPPED。lockfile 差分なし。新しい layout の GitHub Actions 実行時間は未測定。

別担当の [remote-profile 証跡 reader](../../../scripts/remote-profile-evidence.mjs) の限定した最適化も、同じ contracts lane の測定対象になる。workflow 自体は suite の内容を変えない。

`always()` と `needs` の失敗時の扱いは [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds) と [status expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#always) に基づく。
