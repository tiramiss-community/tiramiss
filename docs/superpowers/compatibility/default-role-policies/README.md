# 既定 Role policy 更新 (#415)

対象本家は `8e07cf085adf7009583d234a208e30436f020e26`。親 #181 / 全体 #114。
`admin/roles/update-default-policies` と Meta.policies の全置換、監査、通知、次操作の評価を実装する。各 policy 利用者の実装、他の Role 管理 API や全体の完成は含めない。

## 契約と比較

- 共通 gate で認証、凍結、管理者資格、`write:admin:roles` scope、入力の順に判定する。管理者資格は操作時の DB 材料で判定する。
- `policies` は必須 object。キー・値は本家どおり制限せず、未知キー、null、文字列の数値、不正な policy 値もそのまま保存する。部分指定は以前の JSON を置き換え、空 object は既定値へ戻す。
- 既定値は保存時に埋めず、評価時に `DEFAULT_POLICIES` と重ねる。匿名評価は未知キー・raw 値を保持する。通常ユーザーでは既存の Role 評価の boolean 厳密比較・数値変換を維持する。
- 本家 MetaService.update と同じく最新 ID の Meta 行を transaction 内で更新し、commit 後に `metaUpdated` を発行する。endpoint は primary の transaction で fresh Meta を読み直し（同じ値でローカル cache も更新）、`policiesUpdated`、`updateServerSettings` 監査を開始して HTTP 204 を返す。監査の info は policy JSON 自体の before/after。
- 通知・監査は非待機。失敗しても確定済み更新を戻さず診断する。新実装では開始済みの処理をプロセス終了時に待つ。監査失敗と更新の atomic rollback は保証しない。更新失敗時は保存と通知・監査が変わらない。
- 発行には既存の専用 `redisForPubsub` 接続を使う。別 runtime の温まった Meta cache は `metaUpdated` で更新する。Role の基本 policy は既存どおり操作ごとに DB から読み、既存操作内のメモを更新通知だけで変更しない。

`test/fixtures/default-role-policies/update-default-policies.ts.txt` は固定 Git オブジェクトの endpoint 全文。SHA-256 は `test/unit/role/default-policies-source.test.ts` が固定する。
9 件の source テストは literal schema/callback を実行し、有効・不正入力、全置換、raw JSON、イベントと監査 snapshot を新実装へ直接比較する。
MetaService・認証・DB は source 側では doubles。新実装の実 HTTP/PG/Redis 検証と区別し、本家 full server/PG の実行結果とは扱わない。producer の fresh read は cache の `refresh(read)` へ primary transaction reader を渡す。通常の cache reader は変更しない。MetaService の更新境界は同じ固定版の `packages/backend/src/core/MetaService.ts` を参照した。

## 検証

専用 Compose `backend-next-415`、PostgreSQL 55415、Redis 56415。ランダム専用 DB と独立 internal host topic を使用する。

```sh
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/role test/unit/composition/http-app.test.ts test/unit/meta-cache.test.ts test/unit/internal-event-source.test.ts
BACKEND_NEXT_TEST_DB_PORT=55415 BACKEND_NEXT_TEST_REDIS_PORT=56415 \
  pnpm --filter backend-next test:integration test/integration/default-role-policies.test.ts
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 63854ab4c0
```

unit は source 9 件を含め 173 件。実依存 21 件は資格・scope・入力・部分置換・既定値・raw 値、匿名/通常 user、別 runtime cache、DB CHECK 失敗時の非変更、監査/通知失敗後の保存維持、複数/欠落 Meta、実 DB lock 下での非待機 HTTP と開始済み監査の終了待機を確認する。
Entity/migration/旧 backend の API 定義に変更がないため、旧 backend の型再生成と migration/schema 追加検査は対象外。本家 migration の pg 同時 query 非推奨警告は既存のもの。

追加検証: Meta cache 回帰3件を含む実依存24件/2ファイル、既存 Role acceptance65件/2ファイルが成功した。
`node --test scripts/meta-initialization-proof.test.mjs` は clean baseline `63854ab4c0` でも4成功/1失敗。最初の不一致は connect-resources の実 hash `3a59947a796dd62d8f6c6cdd19b5873b508292038b8b3e171b38dd3ef447b9a3` と過去 proof の `acb6aeb42f0d18f3c77184259573fba6f84ac5b60216f9b633c9385c1735a0e9`。CI の `*-contract*.test.mjs` 集合とは別の既存失敗として記録し、過去 proof と当該スクリプトは変更しない。
