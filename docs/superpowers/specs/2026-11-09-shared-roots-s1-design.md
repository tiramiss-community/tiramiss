# S1 共有 root 整理の設計

## 目的と範囲

[#114](https://github.com/tiramiss-community/tiramiss/issues/114)・[#128](https://github.com/tiramiss-community/tiramiss/issues/128) の共有 root 整理を、[ROADMAP](../../backend-next/ROADMAP.md) の順序どおり #176 の前に独立してレビュー可能な一変更として行う。基準は `5d6aafe9e0305be1b1effa004c7cc10d451cff76`。現在の通常動作と失敗・停止時の振る舞いを維持し、後続領域の共有ファイル競合を減らす。履歴として封印された source snapshot や比較証跡は書き換えない。

## 方式

静的で狭い抽出を controller の判断として採用する。領域追加時の明示的な import・登録は残るが、順序と依存を読める。完全な動的 discovery は共有登録の編集を減らせる一方、探索・配布・順序の新たな契約が必要なため採用しない。汎用 registry framework は作らない。

- HTTP: `composition/http-app.ts` を薄い root、`composition/note-routes.ts` を Note の準備と登録の担当に分ける。Note 依存の準備 → Role 基底生成 → Actor → Note delete → show → create → 任意 queue の順を維持する。既存 `note-http.ts` は新 root への互換 re-export のみとし、root から旧入口への逆 import を禁止する。新しい親 Hono は重ねない。HTTP process のリソース寿命、認証、エラーと停止も維持する。
- Worker: `QueueName` で型付けした静的 readonly `{ name, start }` 表には `endedPollNotification`、`userWebhookDeliver`、`deliver` の既存 3 種だけを順に置く。`start` は呼び出し前に副作用を起こさず、逐次開始する。部分失敗時は開始済み全 worker の停止を待ち、cleanup の失敗を記録して元の起動エラーを再送出する。通常停止も並行 `Promise.allSettled` とし、webhook・deliver の idle は各 worker の close 成功後に待つ。管理対象 10 queue と handoff 判定は別契約として維持する。
- CI: shell 展開の `node --test scripts/*-contract*.test.mjs` は現在の inventory、note 3 件、remote-user の計 5 ファイルを各 1 回実行する。push と pull_request の paths に同じ `scripts/*-contract*.test.mjs` を使い、inventory 本体の path と独立した `inventory --check` は残す。将来の対象は scripts 直下のこの命名範囲とする。

## 制約と検証

新 handler、scheduler、DI、runtime discovery、重複登録を拒否する runtime 契約、queue options の変更は追加しない。S2–S5 の領域実装や #176 の完了条件は変更せず、これらの機能完成を主張しない。既存の動作を確認する characterization は変更前に成功することを確認し、振る舞いを変えない整理で意図的に失敗させない。root の経路、部分起動・停止、および CI glob の境界を実際の出力や観測可能な副作用で検証する。詳細な対象と実行手順は対応する実装計画に記す。
