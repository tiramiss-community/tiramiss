# 連合の共通土台の最小契約（#215）

判断基準は[GOALS](GOALS.md)。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。#215 については、[網羅性監査](coverage-audit.md)・対応表・旧詳細設計より本書を優先する。

本書が持つのは、各機能が共通に使う事実の取得と判定だけ。AP の表現・配送は #160/#171/#172、受信 activity ごとの処理と remote user 解決は #195、外向き HTTP の安全条件は #216 が持つ。プロセス間のキャッシュ同期は #217 が持つ。

## 公開契約と置き場所

I/O を持たない判定は `src/modules/federation/` に置き、`public.ts` から公開する。DB と Redis の adapter は `src/platform/` に置き、`composition/` で関数として UseCase へ渡す。万能の FederationService、汎用のロック基盤やキャッシュ基盤は作らない。

戻り値は平らな値型に限る。MiUser・MiInstance・EntityManager・ioredis 等の型は渡さない。鍵の素材は log・job payload・`DiagnosticError` の details へ入れない。現在の logger の伏せ字は `pass|token|secret|authorization|config` に一致するキーだけが対象なので、鍵の PR で `privateKey` を加える（packages/backend-next/src/platform/logger.ts:28）。

| 操作（入力 → 出力） | 失敗 | 置き場所 | 最初の利用 |
| --- | --- | --- | --- |
| `toPuny(host)`/`toPunyNullable` | なし | modules | #170 #195 |
| `extractDbHost(uri)`/`punyHost(url)` | URL が不正なら TypeError | modules | #195 #160 |
| `createHostRules(selfHost)` → `isSelfHost`・`isUriLocal`・`fullApAccount`・`emojiHost(src, noteUserHost)` | なし | modules | #170 #195 |
| `FederationPolicy` と、`isFederationAllowedHost/Uri`・`isBlockedHost`・`isSilencedHost`・`isMediaSilencedHost`・`isDeliverSuspendedSoftware` | なし（純関数） | modules | #160 #171 #195 |
| `readFederationPolicy()` → FederationPolicy | DB 例外を伝播 | platform/database | 上記 |
| `ensureSystemAccount('actor'\|'relay'\|'proxy')` → `{id, username}` | DB 例外・一意制約違反を伝播 | platform/database | #195 #194 #187 #199 |
| `generateRsaKeyPair()` → `{publicKeyPem, privateKeyPem}` | なし | platform | 本 Issue・#179 signup |
| `readUserKeypair(userId)` → `{publicKeyPem, privateKeyPem}` | 行がなければ例外 | platform | #160 #195 |
| `toSpkiPublicKeyPem(pem)` | PEM が不正なら例外 | modules | #195（actor 公開） |
| `findPublicKeyByKeyId(keyId)`/`findPublicKeyByUserId(userId)` | DB 例外 | platform/database | #195 |
| `fetchInstance(host)`/`fetchOrRegisterInstance(host)` → InstanceFacts/null、`updateInstance(id, patch)`、`listSuspendedHosts()` | DB 例外（初回登録の競合を含む）を伝播 | platform | #160 #195 |
| `deliverSuccessPatch`/`deliverFailurePatch(instance, now, policy)`、`packInstanceState(instance, policy)` | なし（純関数） | modules | #160 #195 |
| `acquireApObjectLock(uri)` → `release()` | 約 5 秒で取得できなければ例外 | platform | #195 |
| `fetchInstanceMetadata(instance, {force})` | 取得・更新の例外は記録して握る | platform（判断は modules） | #160 #195 |

`ensureSystemAccount` は、呼び出し元の transaction には参加しない。本家と同じく、自前の transaction で作成を確定する。UseCase は自分の transaction を開く前に呼ぶ。[backend-next の運用ルール](../../packages/backend-next/AGENTS.md)は共有 Service による transaction 開始を禁じているが、本家と同じ遅延作成にはこの例外が必要になる。例外はこの 1 操作に限る。

## 維持する本家の挙動

- **ホスト**
  - `toPuny` は `domainToASCII(host.toLowerCase())`（packages/backend/src/core/UtilityService.ts:116-125）。
  - `extractDbHost` は `url.host` を、`punyHost` は hostname とポートを使う（:110-114,127-132）。
  - `isSelfHost(null)` は true（:32-36）。
  - 絵文字のホストの正規化は packages/backend/src/core/CustomEmojiService.ts:346-355 に従う。
  - ポート付きの入力と、ポート付きの自ホストの結果は、最初の PR の前に本家の probe で固定し、扱いを決める。
- **連合可否**
  - blocked・silenced・federationHosts は、`.${host 小文字}` に対する後方一致で判定する。リスト側は小文字化しない（UtilityService.ts:51-61,134-142）。
  - mediaSilenced は完全一致（:63-67）。
  - 判定順は「自ホストなら許可 → none なら拒否 → specified で一覧外なら拒否 → blocked なら拒否 → 許可」。
  - 配信停止ソフトウェアの判定は、名前が null なら非該当、バージョンが null なら `'*'` だけ一致、それ以外は semver の includePrerelease で判定する（:150-164）。
  - silenced による public→home と、mediaSilenced による絵文字の除外は、投稿者がリモートの場合だけ効く（packages/backend/src/core/NoteCreateService.ts:491-495,607）。これは #195 のリモート投稿の経路で接続する。
- **Meta**
  - 本家は id DESC の先頭行を使う（packages/backend/src/GlobalModule.ts:100-127）。
  - backend-next の既存の読み取り（note-reader・note-writer・role-authorization-facts）は順序を指定せず、行がなければ失敗する。最初の PR で、まとめて id DESC の先頭行を読むように揃える。
  - 行がなければ、本家と同じく id `'x'` を upsert してから読み直す（packages/backend/src/core/MetaService.ts:72-93）。同時に呼ばれても安全な upsert にする。2026-11-03 にユーザーが本家準拠を決定した。
  - 保存時の正規化（packages/backend/src/server/api/endpoints/admin/update-meta.ts:259-287,751-757）は #194 が持つ。
  - `enableStatsForFederatedInstances` の項目は analytics 領域が持つ。本書は読み取るだけ。
- **システムアカウント**
  - 種別は actor・relay・proxy の 3 つ（packages/backend/src/core/SystemAccountService.ts:23）。
  - 新規作成時の username は `system.${type}`（:99-102）。
  - migration で引き継いだ既存データでは、actor と relay が `instance.actor`・`relay.actor` のまま `system_account` に紐付く（packages/backend/migration/1740121393164-system-accounts.js:15-23）。そのため、呼び出し側は `system_account` の行から引き、名前で決め打ちしない。
  - username に `.` を含むかどうかでシステムアカウントを判定する本家の処理は、#171 等の表現側が維持する（packages/backend/src/core/entities/UserEntityService.ts:387、activitypub/ApRendererService.ts:500）。
  - 初回利用時に、user・user_keypair・user_profile・used_username・system_account を 1 つの transaction で作る（SystemAccountService.ts:113-172）。
  - 作成時の値: isLocked=true、isBot=true、isExplorable=false、name=Meta.name。token はネイティブトークン、password は bcrypt（salt 8）。profile は autoAcceptFollowed=false。
  - 同名のユーザーが既にあれば早期 return する（:128-136）。ロックは取らず、同時に初回作成されたときの例外は呼び出し元へ伝える。
  - キャッシュはプロセス内の 10 分（:50）。
  - Meta.name の変更による名前の連動（:55-76）と update-proxy-account（:177-202）は、#194 の UseCase が直接更新する。
- **鍵**
  - RSA 2048。公開鍵は SPKI、秘密鍵は PKCS#8 の PEM（packages/backend/src/misc/gen-key-pair.ts:11-41）。
  - `readUserKeypair` のキャッシュは `kvcache:userKeypair:v2:<userId>`。Redis 24 時間、メモリ 1 時間、値は JSON（packages/backend/src/core/UserKeypairService.ts:27-39）。行がない場合はキャッシュしない。
  - PKCS#1 は読み込み時に PKCS#8 へ変換して返し、DB 更新は待たない（:51-63）。
  - 公開時は SPKI に正規化する（packages/backend/src/core/activitypub/ApRendererService.ts:296-307）。
  - リモート鍵は keyId の完全一致で引き、12 時間のメモリキャッシュを持つ。null は保存されるが、次回は再取得する。削除済みユーザーの判定は keyId 経路だけで行う（packages/backend/src/core/activitypub/ApDbResolverService.ts:39-61,126-174）。
- **インスタンス台帳**
  - キャッシュは `kvcache:federatedInstance:<host>`。Redis 30 分、メモリ 3 分。null もキャッシュし、Date の 4 列は復元する（packages/backend/src/core/FederatedInstanceService.ts:30-45）。
  - `fetchOrRegister` は、ロックを取らずに find→insert する（:49-71）。
  - `fetch` は行を作らない（:73-89）。
  - `update` は returning の結果でキャッシュを上書きする（:91-103）。
  - 応答用の状態は packages/backend/src/core/entities/InstanceEntityService.ts:33-56 のとおりに導出する。isSuspended は、停止状態が none 以外か、配信停止ソフトウェアに該当する場合。
- **配送による状態更新**
  - スキップ判定は、連合可否 → 停止 host（1 時間キャッシュ）→ 配信停止ソフトウェアの順（packages/backend/src/queue/processors/DeliverProcessorService.ts:49-81）。
  - 配送前は、`enableStatsForFederatedInstances` が true なら fetchOrRegister、false なら fetch を使う。失敗時は値にかかわらず fetchOrRegister を使う。成功時のメタデータ取得は true のときだけ行う（:74-76,100-102,115）。
  - 成功時は不通状態を解除する。
  - 失敗時は 3 つに分岐する（:83-139）。
    - 不通でなかった場合は、不通を記録する。
    - 不通なのに開始時刻がない場合は、開始時刻だけを設定する。
    - 不通になってから 7 日（`<=`）経過し、停止状態が none なら autoSuspended にする。
  - sharedInbox への 410 で goneSuspended にするのは #160。状態値の型は本書が持つ。
  - 受信による更新と自動解除は #195 が受け持つ（packages/backend/src/queue/processors/InboxProcessorService.ts:232-248）。
- **排他**
  - キーは `lock:ap-object:<uri>`。SET PX 30000 NX で取得し、100ms 間隔で 50 回まで試みる。
  - 解放は、GET で値の一致を確かめてから DEL する（packages/backend/src/misc/distributed-lock.ts:8-42）。この解放は原子的ではないが、追加保証として原子化はしない。
- **メタデータ取得**
  - `SET fetchInstanceMetadata:mutex:v2:<host> 1 EX 30 GET` で多重実行を避ける。force=false では、fetchOrRegister を経由して取得から 24 時間以内なら省略する。
  - force=true ではロックを確かめず、終了時に無条件で解放する。
  - ロック取得時の Redis 例外は伝播する。取得・更新の例外は記録して握る（packages/backend/src/core/FetchInstanceMetadataService.ts:52-63,77-90,133-135）。
  - nodeinfo・DOM・manifest から更新内容を作る判断（nodeinfo 2.1/2.0/1.0 の優先、software 名の小文字化、icon と favicon の選択）は、modules の純関数にする（:110-126,158-161,232-325）。

Redis のキー名と値の形式は本家と揃える。こうしておけば、切り替え時に残っている本家のキャッシュを読んでも結果は変わらない。既存データ形式の互換の照合は #138 が持つ。

## 実装の順序

1. **ホスト正規化と連合可否（最初の PR）**
   - 純関数、`readFederationPolicy`、絵文字のホスト正規化、既存の Meta 読み取りの統一（行がない場合の初期化を含む）を入れる。Entity の追加は不要。
   - #170 が使うのは、自ホストの判定とホスト正規化だけ。backend-next の render-note と note-reader にある `domainToASCII` の直書きは、この関数に置き換える。
   - #160 と #195 の先行契約になる。
2. **鍵とシステムアカウント**
   - SystemAccount・UserKeypair・UsedUsername と、UserProfile とそれが参照する Entity を同期で複製する。
   - `generateRsaKeyPair`・`readUserKeypair`・`toSpkiPublicKeyPem`・`ensureSystemAccount` を実装する。
   - #216 と合わせて、#160 の署名と、#195 の remote user 解決を解く。#170 のリモートメンションの 501 は、その後に #195 が除去する。
3. **インスタンス台帳と配送による状態更新**: #160 の配送を接続する PR と同時に入れる。
4. **リモート鍵の参照と AP オブジェクトの排他**: UserPublickey を複製する。#195 の受信実装と同時に入れる。
5. **メタデータ取得**: #216 の `getHtml` と一緒に入れる。

各段階は最初の利用者と同じ PR か、その直前の PR で通常起動へ接続する。利用者のいない adapter を先に積まない。

## 監査行の割り当て（federation-base 32 行）

| 割り当て | 行 |
| --- | --- |
| 1 | meta-setting:blockedHosts・silencedHosts・mediaSilencedHosts・federation・federationHosts・deliverSuspendedSoftware、responsibility:instance-moderation:42・55・56・57 |
| 2 | entity:system_account・user_keypair、service:SystemAccountService・UserKeypairService、responsibility:instance-moderation:25・26（作成とキャッシュ）・users-social-auth:24・misc-utils:18（genEcKeyPair は本家に利用者がないため移植しない） |
| 3 | entity:instance、service:FederatedInstanceService、responsibility:instance-moderation:48・job-processors:01・02・03・packers:39 |
| 4 | entity:user_publickey、responsibility:activitypub:30・misc-utils:03 の AP 部分 |
| 5 | service:FetchInstanceMetadataService、responsibility:instance-moderation:49・50 |
| 他 Issue | instance-moderation:26 の名前連動と update-proxy-account は #194。activitypub:12 の resolver と `signToActivityPubGet` の切り替えは #195、signedGet は #160。misc-utils:03 の chart のロックは #200。proxy アカウントによる follow は、list が #187、アカウント移動が #199。nodeinfo と /api/meta での proxy 名の公開は、各配布経路の担当が `ensureSystemAccount` を使う |

backend-next の note-authors は、UserLite.instance を作るために instance 表を直接読んでいる。段階 3 で `fetchInstance` に置き換える（本家は packages/backend/src/core/entities/UserEntityService.ts:506 でキャッシュを使う）。

## 比較と検証

- **単体**
  - ホスト表: 大文字小文字、IDN、ポート付き、null。
  - 一致の規則: 後方一致と完全一致、リスト側が大文字の場合。
  - 判定順: 自ホストは none や blocked より優先される。
  - 配信停止ソフトウェア: semver、`'*'`、名前が null の場合。
  - 配送失敗の 3 分岐と 7 日の境界、インスタンス状態の導出。
  - 鍵: PKCS#1 から PKCS#8 への変換、SPKI 化、生成した鍵での署名と検証。
- **本家 probe**
  - 同じ入力表を本家の UtilityService・CustomEmojiService・InstanceEntityService に通し、その JSON を `docs/superpowers/compatibility/federation-base/` に置いて比較する。
  - `domainToASCII` の結果は、.node-version の Node で固定する。
- **実 DB/Redis**
  - 5 表を同時に作成すること、2 回目は再作成しないこと、同時の初回作成、早期 return の分岐。
  - 旧名（instance.actor）で移行済みのデータ。
  - Meta が複数行ある場合の選択、行がない場合の初期化と同時呼び出し。
  - キャッシュのキー名・TTL・JSON。行がない場合は否定キャッシュしないこと、null のキャッシュ、Date の復元。
  - ロックのキー・TTL・取得をあきらめるまでの時間。
- **偽の外部サーバー**
  - メタデータ取得: nodeinfo のバージョン選択、404、HTML・manifest・favicon、24 時間の省略、force。
  - 署名の検証は、#160 と #195 の fake inbox で行う。

## 意図的差異

提案しない。本家で待たない DB 更新とロック解放は、新実装では失敗を log に残す。外から観測できる結果は変わらないので、差異には数えない。
