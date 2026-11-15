# 既存3 consumerの共有internal受信（#290）

固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。#217全体、領域CRUD、他cache同期、永続event履歴、stream channelの追加を完了した記録ではない。

通常HTTP/workerの `connect-resources` は `redisForPubsub` のsubscriberを1本作り、URLのhost topicと `${prefix}:backend-next:role-materials:v1` を購読する。RedisのkeyPrefixはchannelに適用されない。host上の `{channel:'internal',message:{type,body}}` と、既存Role専用通知の `{kind:'role-definitions-changed',roleId}` を混同しない。Role publisherは既存の接続・形式を維持する。WebSocketの接続別配送は既存stream subscriberが引き続き担当する。

| 利用者 | 反映 | 接続・取得中更新・停止 |
| --- | --- | --- |
| Role材料 | roleCreated/Updated/DeletedはDB定義cacheを無効化。userRoleAssigned/Unassignedは対象userIdの割り当てを無効化。policiesUpdatedは受信し、定義を無効化するが基本policyの正本は各評価で参照するDB | 接続喪失・再購読で両cacheを破棄。subscribe ACK前と世代が変わった読み取りを拒否。既存の有限TTL・private topic通知・DB材料のみ信頼する方式を維持 |
| user webhook | activeの作成・更新・削除を遅延一覧へ反映 | 既存差異W1: raw Redis ready時点（subscribe ACKより前）で一覧破棄、世代の古いDB取得結果を排除。shared receiver完成後の登録もinitial readyを受け、最初のreconnectを検出 |
| antenna | 作成・更新・削除とfollowに伴うfollowing cache破棄 | warmed一覧をreconnectで破棄しない。cold fetchの完了が途中のeventを上書きできる既存方式を維持。following削除の開始済み処理を停止時に待つ |

各consumerのcloseは自分のhandlerを解除する。共有receiverのcloseは全consumerの解除後にResourceScopeで実行する。単独open呼出しではreceiverを所有して解放する。停止後のlate ACKで利用可能状態を復活させない。JSON null/配列/不正envelope・利用するfieldが壊れたbodyは無視し、handlerごとにpayloadを複製してthrow/rejectを隔離する。これは既存の意図しないJSON例外・cache汚染を防ぐ受信境界であり、不正payloadに対する本家の例外まで互換保証するものではない。

`source-probe.mjs` はGitから固定SHAのGlobalEventService.publish/publishInternalEvent、RoleService.onMessage、AntennaService.onRedisMessage、UserWebhookService.onMessageの**実method body**を抽出実行する。cacheとRedis publicationはdouble。`source-observations.json` の15操作を通常unit testが消費し、hook選択、antenna id/withReplies、Role id/administrator、assignmentの次操作の有限projectionを比較する。Roleは通知payloadのcache直接更新とDB正本の無効化方式の差異がある。後者には、同じ保存結果を持つDB readerの材料を与える。日時・join列、全field、実本家serverのHTTP/Redis縦断を比較した証拠ではない。policiesUpdatedは固定sourceのenvelopeと通知受信を確認し、基本policy DB参照の既存設計を保持する。

実Redis比較は `test/integration/internal-events.test.ts`。1本のconnectionへの3利用者登録、受信失敗の隔離、実client kill/reconnectとheld ACK、1利用者だけ解除後の継続受信、transport close後のclient解放を測る。従来Role/antenna/webhookの実依存試験と通常process試験も実行した。`current-evidence.json` はproduct commitと実行時のsource/test SHA・log SHAを結び付ける。古いreceiptは変更しない。`predecessor.json` は履歴検査に必要な変更済み共通compositionの1ファイルだけを保持し、新しい実装を古い試験で測定済みと主張しない。

専用Docker projectを使い、通常CIでは固定されたsource observationを利用する。source probeの再実行は固定checkoutを指定する。

```sh
pnpm --filter backend-next test test/unit/internal-events.test.ts test/unit/internal-event-consumers.test.ts test/unit/internal-event-source.test.ts test/unit/user-webhooks-reconnect.test.ts test/unit/user-webhooks-startup.test.ts test/unit/note/antennas.test.ts test/unit/note/antenna-lifecycle.test.ts test/unit/role/material-cache.test.ts
pnpm --filter backend-next test:integration test/integration/internal-events.test.ts test/integration/role-materials.test.ts test/integration/note-antennas.test.ts test/integration/user-webhook.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next test:process test/processes/role-http.test.ts test/processes/note-antennas.test.ts test/processes/user-webhook.test.ts
BACKEND_NEXT_UPSTREAM_PATH=/path/to/pinned-checkout node docs/superpowers/compatibility/internal-events/source-probe.mjs
node --test scripts/internal-events-contract.test.mjs
```

2026-11-15の専用環境はNode26、pnpm12.9.1、PostgreSQL18・Redis8、DB16541/Redis16542/Meili16543、project `s1-events290-20261115`。実依存試験のpg同時query非推奨警告は既存のもの。新しいmigration・Entity・REST API型・locale・CHANGELOGは変更していない。親#217と#114は継続し、#317/#291/#303などの後続は個別の利用者・writerに接続して検証する。

固定product revision `00d2a724bbb082ab27b7ade6c47d5906a63cd3df` の測定はbuild・typecheck・syncと、unit 4,302件/116ファイル、integration 36件/4ファイル、process 5件/3ファイル、source projection 15操作がPASS。全21入力を各runの前後でhash比較した。独立reviewで指摘されたantenna src配列の受理とRole初期接続検査の欠落は、失敗を再現する回帰試験から修正し、この測定に含めた。対応表の16行はこのcommitを `evidenceRevision` に持つ `partial` とし、global `implementationCommit` と過去の監査判定は変更していない。
