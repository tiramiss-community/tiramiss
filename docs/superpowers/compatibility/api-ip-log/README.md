# API 利用 IP 記録 #388

親 #178、全体 #114。固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `ApiCallService.logIp`、constructor の履歴クリア timer、`dispose` / `onApplicationShutdown` と config の trustProxy 既定値を比較する。

認証成功後、Meta の `enableIpLogging` が有効なら user/IP ごとに一度だけ `user_ip` へ非同期 insert する。匿名・認証失敗・認証前の入力拒否は記録しない。認証後の認可拒否・入力エラー・業務失敗も対象となる。現在の共通 gate、notes/show・create・delete・一覧、chart の全6認証入口に接続した。未移植の API・multipart・signin はこの変更で追加しない。

履歴は HTTP app 単位で1時間ごとに全消去する。固定本家と同じく保存開始前に履歴を確保し、同期例外・非同期失敗でも次の消去まで再試行しない。DB の `(userId, ip)` unique 制約と `orIgnore(true)` により、履歴消去・HTTP 再起動後も既存行の createdAt を更新しない。新しい保存期間保証や schema/migration は追加しない。MiUserIp は固定 Git object から同期した。

HTTP adapter は本家 Fastify と同じ `@fastify/proxy-addr 5.1.1` と固定 config の既定 trusted subnet を使う。設定の boolean・hop数・subnet文字列/配列も反映し、信頼されない peer の転送ヘッダーは採用しない。Hono の `app.request` のように実 peer のない呼び出しではアドレスを作らない。IP 解決・観測 callback の同期例外で業務結果を置き換えない。

本家は insert の同期例外だけを catch し、返された Promise の rejection を扱わない。新実装では同期・非同期の両方を捕捉し、既存の構造化 Logger で name/code だけを出す。API の確定結果を変えず、HTTP 停止では受付済み handler の後に保存を drain して timer を解除する。この失敗処理と停止待機は明示的な差異である。独自の永続ジョブ・再試行は追加していない。Meta は既存 cache を利用し、cache 全体の比較 #217 は本 slice の完成条件に含めない。

## 比較・検証

`corpus.json` / `observations.json` は disabled・anonymous・duplicate・異なる IP・異なる user・hour clear・同期失敗・非同期失敗の8入力を固定する。source probe は固定ソースの AST から method / timer statement を抽出し、repository double と固定 clock で実行する。非同期 rejection は repository 境界で観測し、probe 自体の unhandled rejection を回避する。本家 full HTTP/PG を動かした比較ではない。source/config/corpus/probe の SHA-256 を保存し、CI の root contract test で入力と観測の結び付きを検査する。

新実装の単体は同じ8入力を消費し、明示 clock の 3,599,999ms / 3,600,000ms 境界、timer 解除、未完了 insert drain、proxy trust、認証失敗と業務拒否を別に検証する。実 PG/listening HTTP は匿名・設定切替・全認証 adapter・並行重複・別 user/IP・unique/createdAt維持・保存失敗/redaction を検証する。ACCESS EXCLUSIVE lock で insert を保留し、応答成功後も HTTP close が完了せず、unlock 後に保存されることを確認する。実 PG の時間境界は履歴が空の第二 HTTP app で unique を確認し、1時間の timer 発火そのものは単体の明示 clock で検証する。

2026-11-19、Node 24.20.0 / pnpm 12.9.1、専用 Compose `backend-next-b388`（DB 55388 / Redis 56388）。依存は既存依存を借用し `pnpm_config_verify_deps_before_run=false` で自動 install を無効化した。

- PASS: upstream sync:check / upstream 同期5 tests、backend-next と upstream の build / typecheck。
- PASS: 近傍単体158 tests / 10 files、実PG/listening HTTP 5 tests（pending schema DDL 0を含む）、source 8入力、root receipt / predecessor 3 tests。
- PG は既存 query の並行利用に関する deprecation warning を出すが、検証は全件成功。新しい schema/migration は不要、旧 backend API 型生成も対象外。

再実行（repo root、適切な専用 DB/Redis を起動して実行）:

```sh
node docs/superpowers/compatibility/api-ip-log/source-probe.mjs --check
node --test scripts/api-ip-log-contract.test.mjs
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/api-ip-log.test.ts test/unit/http test/unit/config.test.ts test/unit/composition/http-app.test.ts test/unit/http-drain.test.ts
BACKEND_NEXT_TEST_DB_PORT=55388 BACKEND_NEXT_TEST_REDIS_PORT=56388 pnpm --filter backend-next test:integration test/integration/api-ip-log.test.ts
node scripts/check-shipping.mjs --base c25f3ee979
```

`compatibility-predecessor.json` と既存の `scripts/compatibility-inputs` 登録は、今回変更した既存16入力だけを正確な基点の bytes へ投影する。過去の測定値を更新せず、未知の追加 bytes は従来の drift guard へ残す。public-emojis の旧実測が保持する api-endpoint 入力にも、このパスだけ既存 projector を適用する。これは旧 runtime の再測定を意味しない。

4対象ID `entity:user_ip` / `meta-setting:enableIpLogging` / `responsibility:api-server-stream-oauth:10` / `timer:src/server/api/ApiCallService.ts:104` の有限成果であり、親 #178 / 全体 #114 を完了扱いにしない。

CHANGELOG 候補: 新バックエンドで、設定に応じた API 利用元 IP の記録と停止時の保存完了待機に対応。
