# OAuth client discovery の有限比較 #398

対象は #398（親 #179、全体 #114）の先行可能な比較資料。固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `OAuth2ProviderService.ts` から `validateClientId`・`parseMicroformats`・`discoverClientInformation` を TypeScript AST でそのまま抽出して実行する。エラー型も同じ固定 Git object から読み、旧 fork の作業ツリーを比較元にしない。

`corpus.json` の15 URL入力と25 discovery入力に対し、`observations.json` は一意な ID ごとの結果または OAuth エラー、fake client への request path、error log 回数を保存する。入力・probe・本家3ソース・本家 `test/e2e/oauth.ts` の SHA-256 と依存バージョンを記録する。e2e ファイルは比較範囲を確認する参照であり、この probe で e2e suite を実行したとは主張しない。

| 比較範囲 | 固定した入出力 |
| --- | --- |
| URL | production/test の HTTPS/HTTP、URL不成立、scheme、fragment、user/password、domain/localhost/loopback、query/port、URL正規化 |
| JSON | name/logo、相対URL、Link headerとの結合順・重複保持、redirect候補なし、型違い、空の名前、client_id不一致、client_uri prefix不一致、不正JSON・null、charsetとmedia type |
| HTML | h-app内の一致する名前・logo、名前の不一致/URLなし/src、最初のh-app、Link headerとlink要素、空の文書、Content-Typeなし |
| 取得境界 | 実HTTP 302後の最終URLを相対URLのbaseにする、404/503のStatusError、接続切断による一般例外 |

fake client は `127.0.0.1` の空きポートで実際に listen する。`{{origin}}` はその実 origin の可逆な表記置換で、期待する URL の意味を変更しない。HTTP取得には制御した native `fetch` adapter を使い、非2xxを固定本家の `StatusError` に変換する。parser は固定本家 manifest と同じ `node-html-parser 9.0.4`・`http-link-header 1.1.4`、抽出用 TypeScript は `6.0.2`。採取環境は Node `24.20.0`。

この adapter は本家 `HttpRequestService` の実行ではない。DNS/IP range gate、outbound HTTPの制限・retry・timeout、authorize handler・redirect_uriの許可判定、画面、同意、PKCE、token交換・保存・失効は未比較。URL検証関数を単独で呼ぶため、そこで許可されたURLにproductionのauthorizeが到達できるとは主張しない。discoveryが返す空のredirect候補も成功結果として保存し、後続authorizeによる拒否と区別する。

## 再実行

依存は他のworktreeのnode_modulesへ接続せず、専用ディレクトリにインストールする。以下のパスは例で、既存ユーザー環境へのinstall/rebuildは不要。

```sh
npm install --prefix /tmp/oauth-client-probe-deps --cache /tmp/oauth-client-probe-cache --ignore-scripts --no-audit --no-fund --save-exact typescript@npm:@typescript/typescript6@6.0.2 node-html-parser@9.0.4 http-link-header@1.1.4
BACKEND_NEXT_UPSTREAM_PATH=/path/to/git-checkout OAUTH_CLIENT_PROBE_DEPENDENCIES=/tmp/oauth-client-probe-deps node docs/superpowers/compatibility/oauth-client/source-probe.mjs --check
node --test scripts/oauth-client-contract.test.mjs
```

`BACKEND_NEXT_UPSTREAM_PATH` は固定 Git object が読める checkout。checkout の HEAD は比較元ではない。`--write` は固定本家から採取し直す場合に使い、通常の検証では `--check` を使う。CI の既存 `scripts/*-contract*.test.mjs` glob は入力・probeとの対応、一意なID、代表的な出力境界を検査する。固定本家probeの再実行は上記の明示コマンドで行う。

## 後続の authorize 利用者への引き継ぎ

#401 の authorize 利用者と同じ PR で runtime を接続し、同じ入力IDと観測を新実装の比較に利用する。その際は通常HTTP入口から `redirect_uri` の完全一致、候補未登録・欠落、DNS/IP gate、取得adapterの失敗境界まで比較する。runtime単独の未使用portは追加しない。

今回の成果は40入力の固定比較であり、OAuth runtime、#398全体、親 #179、全体 #114 の完了を意味しない。対応表・監査の `responsibility:api-server-stream-oauth:36` / `:37` は runtime 完成として更新しない。ユーザー向け挙動は変わらないため CHANGELOG 候補はない。
