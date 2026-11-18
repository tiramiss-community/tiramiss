# notes/translate (#486)

対象本家: `8e07cf085adf7009583d234a208e30436f020e26`。実装開始基準: `1613804464`。
親 #183 / 全体 #114、投稿初期フローの partial は維持する。独自の翻訳キャッシュ・保存は追加しない。

## 実装と比較範囲

`modules/note-translate` が認可、入力、実効 `canUseTranslator`、Note 取得、可視性、描画後の `isHidden`、空本文、鍵、送信を順に扱う。
DB 読み取りは既存の Role 評価・Note 材料取得を使う。HTTP は中央の `createBackendHttpApp` へ直接登録する。
`deeplAuthKey` / `deeplIsPro` は既存 Meta キャッシュの現在値から取得し、既存の外向き HTTP を使用する。

`test/fixtures/note-translate/translate.ts.txt` は固定 Git オブジェクトの endpoint 全文。
SHA-256: `4391eae48a336feccb097575c9c2677183f3a348197abbf0434949425cb25e9e`。
`test/unit/note-translate/source.test.ts` は固定 bytes を検証し、本家 `meta` と literal callback を TypeScript から実行する。
callback を新実装の手書き模倣で置き換えない。19 入力で結果・エラー分類・外向き URL / method / headers / form を直接比較する。

- free/pro、CW 結合・本文なし CW・空 CW、空鍵、空本文は鍵なしでも undefined。
- policy は Note 不在・空本文より先、可視性・描画後の非表示は空本文・鍵より先。
- `targetLang` の `-` より前だけを送信し、大文字化や別の正規化を追加しない。
- 最初の翻訳のみ採用し、不正な shape は実際にプロパティ参照に失敗する場合のみ失敗する。フィールド欠落の object は本家と同じ undefined を維持する。
- 送信失敗・不正応答は内部エラーになり、再試行・独自永続化を行わない。

`test/integration/note-translate.test.ts` は通常アプリの listening HTTP、保存済み native / access token、全 migration 適用済み PostgreSQL、実 Redis、実外向き HTTP client と localhost の偽 DeepL を使う。
free/pro の行先ホストだけを偽サーバーへ接続し直し、method・form・headers と非 2xx 拒否・JSON 読み取りは実 client で検証する。
16 ケースで認証/凍結/scope/入力、Role の許可と期限切れ、指定/フォロワー/メンション/返信者/本人、時刻による非表示・followers 化、鍵なし/空本文、400/500/不正 JSON/不正 shape、保存不変を確認する。

## 境界と既知差異

source callback 比較の Role / Getter / `isVisibleForMe` / pack は入力ごとに結果を与える doubles。full NestJS HTTP、実 source DB、source RoleService / NoteEntityService の再実行比較ではない。
新実装の Role / Note 描画の既存比較と今回の実 DB テストを引き継ぐ。既存の Note 参照予算 D7（64 階層 / 256 Note、循環 500）と Meta/cache の境界も維持する。
送信/JSON 例外の message は `Note translation failed` に固定する。共有 API envelope が内部例外 message を公開するため、鍵を含む外部例外を返さないための限定した差異。500 と INTERNAL_ERROR の分類は維持し、source 内部診断 message / stack / ランダム error ID の完全一致は主張しない。
設定値を消費する翻訳経路を対象にし、全管理設定更新 API の完成は主張しない。親の他の投稿周辺参照・下書き・予約機能は別作業。

## 再実行

```sh
pnpm --filter backend-upstream build
pnpm --filter backend-next build
pnpm --filter backend-next typecheck
pnpm --filter backend-next test test/unit/note-translate
BACKEND_NEXT_TEST_DB_PORT=55486 BACKEND_NEXT_TEST_REDIS_PORT=56486 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56487 \
  docker compose -p backend-next-translate486 -f packages/backend-next/compose.test.yml up -d --wait postgres redis redis-pubsub
BACKEND_NEXT_TEST_DB_PORT=55486 BACKEND_NEXT_TEST_REDIS_PORT=56486 \
  pnpm --filter backend-next test:integration test/integration/note-translate.test.ts
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 1613804464
BACKEND_NEXT_TEST_DB_PORT=55486 BACKEND_NEXT_TEST_REDIS_PORT=56486 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56487 \
  docker compose -p backend-next-translate486 -f packages/backend-next/compose.test.yml down
```

2026-11-18 の限定検証: translation unit 34 / integration 16、build / typecheck、inventory、shipping は実行結果を PR に記録する。
unit は通常 CI の glob、integration は `test:integration` の glob に含まれる。
本家の `HttpRequestService.send` は既定で非 2xx を拒否し、新 client の既定 `okOnly: true` と一致する。

## 共有入口の履歴参照

中央の `http-app.ts` に import と route 登録を追加し、composition unit に outbound client fixture・route/認証期待値を追加した。`scripts/note-translate-predecessor.mjs` はこの 2 ファイルの追加前後の固定 hash と追加断片の一意一致を検査して前の bytes を復元する。既存 well-known / promo の有限な入口投影へ接続し、未知の bytes は下流の既存 drift 検査へ渡す。`note-translate-contract.test.mjs` が両共有ファイルの正常投影と、既存の履歴 reader / notes validator による未知の変更の拒否を検証する。過去の receipt / 測定件数 / source 結果は書き換えず、古い製品テストを今回再測定したとは主張しない。

`note-routes.ts` と notes-pagination / poll の補助処理は共通基準の bytes を維持する。#635 の独立した投稿ルート変更と翻訳の登録を分離するため、翻訳を中央 composition に登録した。translation unit 34 件に加え、既存 composition unit 16 件も実行し成功した。

## #636 との積み重ね

翻訳 PR は #636 (`feat/backend-next-promo-542`) を base とする。両機能は業務上独立しているが、同じ composition unit の固定入力を使うため、比較資料の順序だけを依存させる。翻訳の有限投影は合成済み fixture を #636 の fixture へ戻し、その後で promo 投影が既存の入力を復元する。promo の保存済み source 観測・receipt・測定結果は保持し、direct な promo/well-known 読み取りにも翻訳投影を通す。

積み重ね後の近傍再検証: package import・translation・composition・featured・promo の unit 6 files / 72 件、translation と promo の実 HTTP/PG/Redis integration 2 files / 36 件が成功。依存順 build / typecheck と inventory 生成検査も成功した。既存の pg 同時 query 警告と promo の不正日時入力の pg deprecation warning は残る。
