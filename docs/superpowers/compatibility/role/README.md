# Roleの本家比較資料

対象は[#116](https://github.com/tiramiss-community/tiramiss/issues/116)。契約の正本は[仕様書](../../specs/2026-10-17-role-compatibility-contract.md)。比較元は本家 `8e07cf085adf7009583d234a208e30436f020e26`。

## 資料

| ファイル | 用途 |
| --- | --- |
| `http-cases.json` | actor・対象API・入力差分・HTTP status・error code/id/message/kind・認証ヘッダー・入力エラーinfo。roleIdは投入した対象ロールのIDへ置換 |
| `intentional-http-cases.json` | 承認済みの仕様修正。本家での観測と新実装の期待値を区別 |
| `policy-defaults.json` | 本家の全39ポリシーのコード既定値。時間式は分の数値に展開 |
| `reference-role.e2e.ts` | 実HTTP・DB・Redisによる上記ケース、部分更新、監査before/after、無変更更新、Bearer優先の確認 |
| `reference-role.unit.ts` | 固定時刻・固定材料で本家の評価メソッドを実行する追加probe |

probeは参照checkoutの `packages/backend/test/` へコピーして実行する。本リポジトリの旧backendや新backendの製品コードに追加するテストではない。#117以降ではJSONの期待値と仕様書のケースを新実装のテストへ接続する。本家の型・Serviceを新実装の依存にしない。

追加unit probeは取得済み材料を仮実装で渡す。本家の計算処理は実物を呼び、計算結果のコピーを実行しない。HTTP probeは実トークンを認証し、サーバーと別接続で保存行・監査を読む。日時・生成ID・tokenをgolden値にせず、形式・関係・期待する結果をassertする。

## 再実行

リポジトリ指定のNode.jsとpnpmを用いる。既存checkoutのnode_modulesを流用するとバージョンが一致しない場合があるため、参照側でlockfile通りに導入する。

1. repo rootから固定コミットを新しい一時ディレクトリへ展開し、probeだけを追加する。`ROLE_PROBE_ROOT` は以降の同じシェルで使う。

   ```sh
   export ROLE_PROBE_ROOT="$(mktemp -d /tmp/tiramiss-role-116.XXXXXX)"
   git archive 8e07cf085adf7009583d234a208e30436f020e26 | tar -x -C "$ROLE_PROBE_ROOT"
   cp docs/superpowers/compatibility/role/reference-role.e2e.ts "$ROLE_PROBE_ROOT/packages/backend/test/e2e/role-contract.ts"
   cp docs/superpowers/compatibility/role/http-cases.json "$ROLE_PROBE_ROOT/packages/backend/test/e2e/role-http-cases.json"
   cp docs/superpowers/compatibility/role/reference-role.unit.ts "$ROLE_PROBE_ROOT/packages/backend/test/unit/RoleContract.ts"
   cp docs/superpowers/compatibility/role/policy-defaults.json "$ROLE_PROBE_ROOT/packages/backend/test/unit/role-policy-defaults.json"
   ```

2. **55116・56116・61116・62116が未使用であることを確認する。** 本家テストサーバーには起動時に指定ポートのプロセスを停止する処理がある。使用中ならこの実行を開始しない。自分が起動した専用コンテナ以外へ接続しない。

   次のコマンドはrepo rootで実行する。プロジェクト名も他セッションで使用していないものにする。既存の `misskey-infra` は使わない。

   ```sh
   python3 - <<'PY'
   import socket
   sockets = []
   for port in (55116, 56116, 61116, 62116):
       sock = socket.socket()
       sock.bind(('127.0.0.1', port))
       sockets.append(sock)
   print('probe ports are free')
   PY
   BACKEND_NEXT_TEST_DB_PORT=55116 BACKEND_NEXT_TEST_REDIS_PORT=56116 \
     docker compose -p role-116-reference -f packages/backend-next/compose.test.yml up -d --wait
   ```

3. 参照側の `.config/test.yml` を以下の値で作る。既存checkoutの設定をコピーしない。DBは専用Composeのtmpfs上。**本家テストはこのDBのschemaを削除・再作成する。** migration実行の検査とHTTPテストの検査は別に扱う。

   ```yaml
   url: 'http://127.0.0.1:61116'
   port: 61116
   setupPassword: role-116-test-only
   db:
     host: 127.0.0.1
     port: 55116
     db: backend_next_test
     user: postgres
     pass: foundation-test-only
   redis:
     host: 127.0.0.1
     port: 56116
   id: aidx
   proxyRemoteFiles: true
   ```

4. 参照rootへ移動し、依存導入・ビルド・設定変換を行う。probe内でも上記のDB・Redis・HTTP設定を検査する。元ソース・manifest・lockfileは変更しない。

   ```sh
   cd "$ROLE_PROBE_ROOT"
   pnpm install --frozen-lockfile --filter backend...
   pnpm build-pre
   pnpm --filter backend... build
   NODE_ENV=test pnpm --filter backend compile-config
   pnpm --filter backend build:e2e
   ```

5. 以下を**順番に**実行する。同一の専用DBを使う本家テストを並行起動しない。

   ```sh
   NODE_ENV=test pnpm --filter backend exec vitest run --config vitest.config.unit.ts test/unit/RoleService.ts
   NODE_ENV=test pnpm --filter backend exec vitest run --config vitest.config.unit.ts test/unit/RoleContract.ts
   NODE_ENV=test pnpm --filter backend exec vitest run --config vitest.config.e2e.ts test/e2e/role-contract.ts
   pnpm --filter backend exec eslint --quiet test/e2e/role-contract.ts test/unit/RoleContract.ts
   ```

   `role-contract.ts` の初期データをSQLで投入した後、本家形式の `roleCreated` / `userRoleAssigned` を専用Redisへ送る。本家のキャッシュが既に温まっている場合にも投入状態を反映するため。これを新実装の更新通知の契約と混同しない。ロール作成・割り当てAPI全体を今回の検証対象へ広げない。

6. 終了後、元repo rootに戻って、自分が起動したプロジェクトだけを片付ける。

   ```sh
   BACKEND_NEXT_TEST_DB_PORT=55116 BACKEND_NEXT_TEST_REDIS_PORT=56116 \
     docker compose -p role-116-reference -f packages/backend-next/compose.test.yml down
   ```

## 2026-10-17の実行記録

環境: Node.js `v24.20.0`、pnpm `12.9.1`、PostgreSQL `18`、Redis `8`。参照checkout: `/tmp/tiramiss-role-116-reference`。Compose project: `role-116-reference`。ポートは上記の専用値。

| 検査 | 結果 |
| --- | --- |
| 参照ソースの同一性 | PASS。元ソース・既存テスト・manifest・lockfile等1110ファイルのGit blob hashが固定コミットと一致 |
| lockfile固定の `pnpm install --frozen-lockfile --filter backend...` | PASS |
| 依存順ビルド、`build:e2e`、設定変換 | PASS |
| 専用DBへの本家migration全履歴の適用 | PASS。HTTPテストは別途schemaを再作成するため、HTTP検証の保存状態をmigration互換検査とは扱わない |
| 本家 `test/unit/RoleService.ts` | PASS、47件 |
| 追加 `RoleContract.ts` | PASS、36件 |
| 追加HTTP `role-contract.ts` | PASS、33件（HTTPケース28件と補足5件） |
| probeのESLint | PASS。参照package rootから変更probe2ファイルへ `eslint --quiet` |

実行時はpnpmを `/tmp/tiramiss-role-116-tools` へ導入した。既存環境はlockfileと依存バージョンが一致しなかったため使用しなかった。スクリプト内のpnpmがホスト側の別バージョンを選ぶ問題を避けるため、設定変換とvitestは参照側の `node scripts/compile_config.js`、`node_modules/.bin/vitest` も使用した。製品ソースの改変によるビルド回避はしていない。

記録する期待値はJSONとprobeのassertion。認証情報・生成トークンや一時的な実行時間を含む生ログはコミットしない。本家は監査保存完了を待たないため、HTTP204の直後に監査が存在することは要求せず、到達をpollしてスナップショットを確認する。

## 後続の判定

本家側の期待値を固定した段階。新実装は未接続であり、新旧一致をPASSとはしていない。#117から評価の期待値を移し、#120で同じHTTPケースと保存確認、#121で新旧比較と意図的な差異の障害・競合検証を揃える。

本家の監査FK削除連鎖など、コード読解のみの確認は仕様書で区別する。追加probeの通過を全API・全異常データの網羅的な検証とは扱わない。非文字列トークンは500msのクライアント打ち切りまで応答しないことを確認し、400を完了させる新実装の期待値とは別にする。
