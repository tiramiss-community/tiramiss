# Local Emoji object GET — #325

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `ActivityPubServerService.createServer` にある `GET /emojis/:emoji` と `ApRendererService.renderEmoji/addContext` を対象にする。実装 runtime は `140acaf7d0283a76cc4de4a9f0227ae130a86ccd`、基準は PR #588 後の `0ffa36d8f5`。管理・画像配信・他の caller・inbox は対象外。親 #195/#176/#127 は未完了、`notes/create:partial` / `postingComplete:false` を維持する。

## 公開契約

- federation `none` は Emoji 読取より前に空本文403。`specified` は公開可。
- name は一度だけ path decode し、大小文字を変えず `host IS NULL AND name = :name` で直接 DB 読取する。remote・欠損・localOnly は空本文404、redirectなし。alias・isSensitive・利用role制限で検索/非公開化しない。
- 成功は context付き Emoji。`public, max-age=180`、Varyなし。AcceptがLDを選ぶ場合だけLD、HTML/JSON/不一致のAcceptもactivity JSONで公開する。MIMEのnullと空文字、publicUrl空時のoriginalUrl、licenseのnull/空文字、保存updatedAtと未設定時の現在時刻を保持する。
- DB読取失敗500は未cache。renderEmojiが例外を返す場合は、描画前に設定済みの180秒cacheを保持する。本家の順序を変えない。予期しない失敗は既存Logger形式の固定分類だけを記録する。
- GET/HEADは同じ読取を行い、wire上のHEADは本文なし。OPTIONSは404で業務読取/CORSなし。不正percent/UTF-8、100 UTF16単位を超えるpathはCORS・Meta読取より前に拒否する。空name・encoded slash・Unicode・二重encodeも有限比較に含む。

## 比較と実測

[`local-emoji-object-corpus.json`](local-emoji-object-corpus.json) の53ケースを、[`local-emoji-object-source-probe.mjs`](local-emoji-object-source-probe.mjs) が固定Git blobから抽出したliteral methodsと実Fastify injectで実行する。repository doublesは明示したlocal/name照合と障害だけを担当する。[観測](local-emoji-object-observations.json)はsource/probe/corpus hashを保持し、productの単体テストは本文・status・選択HTTP headers・意味上の読取・保存不変を比較する。

**HEAD不正pathの限定差**: Fastify injectはrouter拒否400のJSON本文を返すが、Hono app.requestはHEAD本文を除去する。この1ケースはsourceの生本文を保存し、status/headers/読取は一致、本文差を明示して確認する。実listening HTTPはHEAD本文が空であることを別に検証した。53件すべてのinject本文が完全一致したとは主張しない。

実測は Node26.4.0、専用Compose `backend-next-parallel-325`、PG56525/Redis57525。通常の `createBackendHttpApp` と `listenHttp`、同期済みmigrationを使う。実PG19ケースは、公開JSONと全選択header、local/remote同名・case/alias・現在値再読取・保存/Meta行の不変・書込みSQLなし・federation gate・実relation一時renameによるDB失敗/復元・HEAD/OPTIONS・一度decodeとUTF16境界を確認した。source側の実PG/full server比較ではない。

| 実行 | 結果 |
| --- | --- |
| upstream sync:check / backend-next... build / typecheck | PASS |
| 近傍単体（Emoji source54、通常composition13、actor tag、outbox HTTP） | 115件 / 4 files PASS |
| 実listening HTTP/PG（Emoji19、outbox23） | 42件 / 2 files PASS |
| literal source `--check` | 53件 PASS |
| source contract | 6件 PASS |
| 変更TS7ファイルquiet lint / SPDX / locale safety | PASS |

実DB検証には既存のpg concurrent-query deprecation warningが出た。失敗/skipはない。旧backendのAPI型、Entity、migrationを変更していないため、旧backend向け型生成・migration差分検査は対象外。

## 有限証跡と残責任

[`local-emoji-object-current-evidence.json`](local-emoji-object-current-evidence.json)は14入力の実測前後hash、無drift、7実行のexit/count/raw log hashとruntime commitを固定する。各入力がruntime commitのGit blobに一致することも確認した。host raw logs/receiptがある場合は照合し、ないCIではsealed記録とcurrent入力を検査する。

[`local-emoji-object-predecessor.json`](local-emoji-object-predecessor.json)は基準時の `http-app.ts` と通常composition testだけを保存する。`scripts/local-emoji-object-evidence.mjs` が現14入力・receipt・predecessorを検査してこの2ファイルだけを復元し、既存outbox readerへ渡す。旧#324/#323/follow/featuredのreceiptとsealは書き換えず、offline optional-readerの伝播も保持する。新しい入力drift・偽receipt・過去fixture改変は専用contract testが拒否する。

本家のinjected Metaと新実装のDB直読はstable Metaに限った比較であり、cache鮮度・通知・Meta読取失敗差は#217に残る。Meta行不在時には既存readMetaが行を作るため、保存不変の実測はseed済みMetaを前提とする。このendpointのEmoji読取は本家も直接DBであり、actor/Noteのlocal emoji cacheとの既知差をここへ混同しない。他caller・Like公開#360・画像バイト配信・絵文字管理はそれぞれの作業単位に残る。

再実行:

```sh
node docs/superpowers/compatibility/remote-user/local-emoji-object-source-probe.mjs --check
pnpm --filter backend-next test test/unit/federation/local-emoji-object-source.test.ts test/unit/composition/http-app.test.ts test/unit/federation/local-actor-tags.test.ts test/unit/http/activitypub-outbox.test.ts
BACKEND_NEXT_TEST_DB_PORT=56525 BACKEND_NEXT_TEST_REDIS_PORT=57525 pnpm --filter backend-next test:integration test/integration/local-emoji-object-http.test.ts test/integration/local-outbox-http.test.ts
node --test scripts/local-emoji-object-*-contract.test.mjs scripts/local-emoji-object-contract.test.mjs scripts/local-outbox-evidence.test.mjs
```

source probeには固定upstream checkout（既定 `/tmp/tiramiss-relay171-upstream`）と既存source依存harness（既定 `/tmp/tiramiss-s1-r13-probe`）が必要。`UPSTREAM_ROOT` / `PROBE_HARNESS`で指定できる。CIの静的contractとproduct consumerはこの一時harnessを必要としない。
