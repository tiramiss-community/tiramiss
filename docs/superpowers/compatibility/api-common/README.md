# API共通gateの固定本家比較（#178 最初のslice）

対象は `misskey-dev/misskey@8e07cf085adf7009583d234a208e30436f020e26` の `ApiServerService.ts`・`ApiCallService.ts`・`AuthenticateService.ts`・`RateLimiterService.ts`・`endpoint-base.ts`・`error.ts`。[目的](../../../backend-next/GOALS.md)・[全体計画](../../../backend-next/ROADMAP.md)・[Issue #178](https://github.com/tiramiss-community/tiramiss/issues/178)を優先する。実装計画は[plans/2026-11-08-api-gate-178.md](../../plans/2026-11-08-api-gate-178.md)。

本sliceでは、Role管理API 2件と queue管理API 14件を共通gateへ移した。noteの3 APIは、トークン抽出・本文解釈・エラー整形だけを共通部品へ寄せた。noteの認可は、従来どおり各UseCaseが持つ。

## 本家の判定順と新実装の対応

| 順 | 本家 | 新実装 |
| --- | --- | --- |
| 1 | `/api` 全routeのCORS `*`・`Cache-Control: private, max-age=0, must-revalidate`、1 MiB上限(413)、`allowGet`なしのGETは認証前に405 | `src/http/api-request.ts` の `registerApiRoute`・`readApiRequest`。endpointの完全一致パスごとに登録する |
| 2 | 大文字小文字を区別する `Authorization: Bearer ` が本文の`i`より優先。`i`は入力に残る | `readApiRequest` |
| 3 | `token == null`は匿名。16文字はnative（全permission）、それ以外はアクセストークン（`hash = lower(token)`または`token`）、`appId`があればAppのpermission。失敗は401 `invalid_token`、それ以外の失敗は`info`なしの500 | `src/platform/database/authenticate.ts` が `AccessCredential`（nativeかpermission集合）を返す。`src/http/api-endpoint.ts` が401・500へ変換する |
| 4 | rate limit（`limit`のあるendpoint） | `src/platform/api-rate-limit.ts`。本sliceの利用者はnote作成・削除の既存limiterだけ（キー・窓の順序は不変） |
| 5 | 資格必須で匿名なら401 `CREDENTIAL_REQUIRED`（`Bearer realm="Misskey"`のみ）、凍結なら403 | 匿名はgateがUseCase前に拒否。凍結以降は `src/modules/access/authorize.ts` の `authorizeAccess` |
| 6 | moderator `d33d5333` / administrator `c3d38592`（rootは通過） | 同上。rootは `roleAccessFacts` で両方を満たす事実として渡す |
| 7 | 非nativeトークンはendpointの`kind`をpermission集合に持つこと。資格必須で`kind`なしなら全て拒否。403 `insufficient_scope` | 同上 |
| 8 | Ajv（`useDefaults`、`misskey:id`）。400 `INVALID_PARAM`、`info {param: schemaPath, reason}` | `src/modules/access/input.ts` の共有Ajv（`compileInput`）。Role・queue・`notes/show`が使う。`notes/create`・`notes/delete`は従来のAjvのまま |
| 9 | 204/JSON、`{error: {message, code, id, kind, info?}}`、status・headerの優先順、handlerの予期しない失敗は`info.e {message, code: name, id}`付き500 | `src/http/api-error.ts` の `apiErrorResponse`・`commonApiError`、`api-endpoint.ts` |

endpointの認可要件（本家metaの`requireCredential`・`requireModerator`・`requireAdmin`・`kind`）はHTTPのendpoint定義に置く。gateは要件を束縛した `AccessRequest` をUseCaseへ渡す。UseCaseは事実を読んだ位置で `authorize` を呼び、`roles/update` は同じトランザクション内で判定する。成功しても `authorize` が呼ばれていなければ、gateは内部エラーにする。

[endpoint-access.json](endpoint-access.json) は、gateへ登録した全endpointについて固定本家のmetaから抜き出した要件である。`test/unit/http/endpoint-access.test.ts` が登録内容と完全一致を照合する。endpointを追加したら、次のコマンドで再生成する。

```sh
node docs/superpowers/compatibility/api-common/reference-endpoint-access.mjs /path/to/upstream-checkout <endpoint名...>
```

## 意図的差異

| ID | 本家 | 新実装 | 理由・承認 |
| --- | --- | --- | --- |
| G1 | 文字列でないトークン（数値・object等）は応答を送らず接続が残る | 空本文の400 | Role #120で承認済み（[role/intentional-http-cases.json](../role/intentional-http-cases.json)）。queue・noteも同じ |
| G2 | 不正JSON・1 MiB超過はFastify独自形式のJSONエラー | 空本文の400・413（413は`Connection: close`） | 既存Role/queue/noteの契約を維持 |
| G3 | `lastUsedAt`は待たずに更新 | 待って更新し、失敗はログだけで認証を失敗にしない | Role #120で承認済み |
| G4 | 有効なトークンの持ち主が消えた場合は匿名扱い（資格必須なら`CREDENTIAL_REQUIRED`） | `AUTHENTICATION_FAILED` | トークンはユーザー削除でcascade削除されるため実際には到達しない。既存の挙動を維持 |
| G5 | gate内のロール・ポリシー読み取りの失敗は未包装のエラーをそのまま返す（`INTERNAL_ERROR`ではない） | UseCase内で事実を読むため、handler段階の`INTERNAL_ERROR`＋`info.e` | 認可をUseCaseが所有し、更新と同じトランザクションで判定するための差異。本sliceで記録 |
| G6 | 認証段階の予期しない失敗はログなし | 同じ`info`なし500を返し、`api.authentication-failed`をログに残す | 応答は同一。診断のためログだけ追加 |
| G7 | `@fastify/cors`の既定（strictPreflight）では、`Origin`等のないOPTIONSを400にする（未実測） | Hono `cors` は204 | noteで既存の挙動。Roleも本sliceで同じになった |
| G8 | handlerの予期しない失敗は`info.e`付き500 | noteの3 APIは`info`なしの500のまま | note APIをgateへ移す次のsliceで揃える |

Role APIは本sliceで、本家と同じCORS・Cache-Control（以前は無し）と、handler段階の500での`info.e`（以前は無し）を持つようになった。どちらも本家へ寄せた変更であり、差異ではない。

## 検証

- 単体: `test/unit/access/authorize.test.ts`（判定順・nativeの全permission・`kind`なし資格必須endpoint・`authorize`の実施記録・Ajvのparam/reason）、`test/unit/http/api-endpoint.test.ts`（route guard・トークン優先・匿名拒否・401/500の段階別の形・`authorize`未実施の拒否・status/headerの優先順）、`test/unit/http/endpoint-access.test.ts`（本家metaとの照合）。
- 既存の固定比較: `test/unit/queue/source-compat.test.ts`（queue 67観測）、`test/integration/role-http.test.ts`・`role-acceptance.test.ts`（Role 28ケース・意図的差異・CORS/preflight）、`test/integration/queue-admin.test.ts`、note-create/delete/show の結合テスト。

## 残範囲（#178）

- note 3 APIをgateへ移す（`prohibitMoved`、rate limitをgateの段階として実行、`notes/create`・`notes/delete`の入力検証を共有Ajvへ、G8の解消）。資格不要の`notes/show`は、gateが作成時に認可を終える経路（`createAccessRequest`）を使う。
- 未知endpointの404 `UNKNOWN_API_ENDPOINT`、`allowGet`とGETの型変換、`cacheSec`、`secure`、`requiredRolePolicy`、匿名のIP rate limit、`user_ip`記録、OpenAPI。
- multipartは#188の最初の利用者と同じPRで入れる。
