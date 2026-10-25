# 投稿の本家比較契約（N0 / #167）

[投稿設計](../../specs/2026-10-21-note-flow-design.md) §8 C1–C10/F1–F8を、後続の[#168–#176](https://github.com/tiramiss-community/tiramiss/issues/127)が引き継ぐための資料。比較元は本家 **`8e07cf085adf7009583d234a208e30436f020e26`**。新実装の基準はdevelop `a5840cc43089ea49c9f3ac14444390b0a809953f`（PR #158マージ後）。

本家の実HTTP・別DB接続・実worker→localhost fake inbox・Redis Pub/Subを観測した。新backendの投稿API・通常workerは未接続であり、この資料の成功は新旧一致や投稿領域の完成を示さない。本家e2eはテスト用schemaを再作成するため、本家migration全履歴の適用・本番移行の証明でもない。

## ファイルと使い方

| ファイル | 内容 |
| --- | --- |
| [http-cases.json](http-cases.json) | 42件のHTTP入力。actor/endpoint/params/setup、C1–C8分類。`$name`はprobeの初期データ・先行結果の論理ID、`$repeat`は長文入力 |
| [observations.json](observations.json) | 上記入力と追加シナリオの正規化済み実測89件。HTTP本文/エラー/WWW-Authenticate、Note/Poll差分、保存字段、show、カウント、AP受信、削除stream/監査 |
| [rate-observations.json](rate-observations.json) | productionモードの本家HTTPでのレート制限実測3件 |
| [coverage.json](coverage.json) | C1–C10/F1–F8の根拠キー・本家ソース・担当Issue・未測定/未接続。`measured`は記載範囲を実測した意味で全組合せの網羅ではない |
| [intentional-differences.json](intentional-differences.json) | 既存合意の差異D1–D6。新実装の検証済み欄はすべてfalse。未実装を差異へ読み替えない |
| [reference-note.e2e.ts](reference-note.e2e.ts) | 本家テストサーバーへのprobe。JSON入力を解決し、別接続のDBと受信結果を期待値に照合 |
| [reference-note.setup.ts](reference-note.setup.ts) / [reference-note.config.mjs](reference-note.config.mjs) | 本家e2e設定の上書き。HTTPサーバー側の署名用native poolも初期化する |
| [reference-note-rate.mjs](reference-note-rate.mjs) | e2e終了後、同じ専用DBでproduction HTTPプロセスを起動し、本物のレート制限を確認。自身の子だけを停止 |
| [fixture検査](../../../../scripts/note-contract-fixtures.test.mjs) | CIで入力/期待値/台帳の参照とhidden字段・AP根拠の整合性を確認。本家を起動する試験はこの検査とは別 |

`http-cases.json`を新APIのテストへ読み込み、actorとIDを新しいfixtureへ対応付ける。`observations.json`の必要なキーをそのまま期待値に使い、HTTPエラーのcode/id/message/kind/info・null/省略・配列順を手で複製しない。本家Service・NestJS・Entityを新実装の業務依存へ持ち込まない。

入力に収まらないshow/削除/AP/時系列の準備と手順はprobeの同名シナリオを正本にする。新テストへ接続したら担当Issueと本資料に接続先・コマンド・結果を記録する。JSONがあるだけでは新実装の検証済みへ変えない。

## 主要な実測と境界

- **C1/C2**: 基本text作成は200、public/localOnly=false/reactionAcceptance=null。作成とshowの全JSONを保存。未認証/不正tokenは401、停止/移行actor・scope不足は403で入力検証より先に拒否。native tokenとMiAuth scope、App permission優先（AccessToken permissionとの不一致）、大文字App hash、Bearer優先も確認。停止actorのshowは200、移行actorのdeleteは204。
- **レート制限**: 本家はNODE_ENV=testでlimiterを無効化する。別production HTTPにrateLimitFactor=300のactorを渡し、300/factor=1枠に縮める。1件目の空入力が400で枠を消費し、2件目は入力不正より先に429。error ID/形とNote不変を保存。通常factorで300回送る測定やIP単位quotaとは区別する。
- **C3/C7**: 空白/長文/cw、存在しない/他者file、fileIds優先・空配列優先・mediaIds alias・添付順、pollの既定multiple、choices重複/不足、期限切れ、expiredAfter優先を確認。失敗時Note/Poll増分0。ファイルはDBへ投入したfactsでありDrive uploadの実測ではない。未来期限は先に範囲assertしてから時刻を正規化。
- **C4**: sensitiveWordsとcanPublicNote=falseはpublicをhomeへ補正し保存・返却。補正を受けた同一操作のAP audienceは未測定で、明示homeのAPはC9で測定した。
- **C5**: followers/specifiedを作者/follower/mention相手/無関係/guestでshow。hiddenは200で本文/cw=null、添付空、isHidden=true、poll/visibleUserIds省略。ネストreply、閲覧制限エラー、myReaction/poll vote/添付消失、時刻制限0と作者例外を保存。全時刻閾値・深いネスト・server=localのremote表示・query数は#168で補う。
- **C6/C8**: 返信/pure Renote/引用、不存在/不可視/pure対象のAPIエラー、channel強制public/localOnly、archive/外部Renote拒否、noExtract*、specified+mentionを測定。集計は本家の完了を待って確認。renoteCountは引用も含むが自己Renoteを除外する（初期bob自己Renoteは加算されない）。botや各条件の個別比較は#170で追加。
- **本家のcount**: outsiderのnotesCountは0→作成1→削除後1。channelの(notesCount,usersCount)は(3,2)→対象actorの投稿を全削除しても(3,2)→同actor再投稿で(4,3)。削除で単純に減る/人数を再加算しない期待値へ黙って変えない。新設計の同時確定と値そのものの変更判断は分ける。
- **C9/C10**: 実workerが署名/Digest headerを持つHTTPをfake inboxへPOST。publicはrelayとshared inbox、home/followersはshared、specifiedは個人inbox。publicのremote返信先がfollowerのshared inboxと重なる場合は作成配送を重複排除。pureはAnnounce、引用はCreate。作者/他者/moderator削除、DB消失、監査、Redis noteStreamのdeleted、Delete/Undo、元投稿消失時のDelete fallbackを確認。public返信のDeleteはdirect/shared/relayの3配送となる。本probeは署名headerの存在を確認し、暗号検証は行っていない。
- **F8の本家側**: 作成後に追加したlate followerへ、home/followers/specifiedのDeleteも配送し、relayにも送る。本家観測をD3の新期待値で上書きせず残した。新実装の非public固定集合・unknown/取消世代は#161/#171/#172で検証する。

APの受信集合はpathで整列する（並列HTTPの到着順を互換契約にしない）。activity内部の配列順は保持する。localOnly=0件は正の配送完了後300msの有限観測であり、無期限の不在証明ではない。streamはRedis publishの実受信でありWebSocketクライアントまで通した試験ではない。

F1–F7は新しい同時確定/永続request/所有世代/有限回復を要求するケースで、本家に同じ契約がない。新実装での停止・並行・障害注入は未実施として台帳に残す。既存adapterの単体/結合成功を、通常workerでF群を縦断検証済みと読み替えない。

## 正規化

生成IDはID字段・配列要素とURLの成分（引用HTML内のリンクも含む）だけを論理名へ置換し、日時字段のISO日時は`$time`、設定originは`$origin`へ置換する。本文・固定MD5・エラーUUIDは保持する回帰テストを置く。Deleteに付くランダムUUIDのactivity IDは出来事の論理名へ置換し、全宛先で同じactivity IDであることを置換前にassertする。relayのLD署名nonce/signatureValueは`$nonce`/`$signature`。署名のtype/creator/created字段は保持する。rate reset/resetMsは数値・未来値をassertしてから各単位の記号へ置換する。

エラーUUID、null/省略、配列順、hidden/detail、保存フラグを除去しない。相対投票期限はリクエスト前後の時刻+600000msの範囲とDB保存値との一致を先にassertする。投票期限の優先順・countの収束など、時刻を消すと失われる判断は別assertで検証する。生token・秘密鍵・生成署名を期待値へ保存しない。

## 後続Issueへの引き継ぎ

| Issue | 接続するもの／残ること |
| --- | --- |
| [#168 N1](https://github.com/tiramiss-community/tiramiss/issues/168) | C1-show/C5全件、Note/Poll/関連facts、集合取得と純粋変換、query数非比例。追加のnested/時刻/remote表示はcoverage参照 |
| [#169 N2](https://github.com/tiramiss-community/tiramiss/issues/169) | C1/C2/C4、共通gate、成功/拒否HTTPとDB。D1/D2、F1/F3、容量413/503は新設計の追加期待値 |
| [#170 N3](https://github.com/tiramiss-community/tiramiss/issues/170) | C3/C6/C7/C8、添付・poll・reply/Renote・channel・MFM、同時変更。channel人数とcountの判断を明記 |
| [#171 N4](https://github.com/tiramiss-community/tiramiss/issues/171) | C9 AP全本文/audience/宛先、C6/C8の配送条件。#159/#160/#162の実送信/workerに接続し署名検証・HTTP分類・停止を追加 |
| [#172 N5](https://github.com/tiramiss-community/tiramiss/issues/172) | C10認可/監査/DB/Undo fallback、F8の本家差異。新取消/unknown/過去宛先を#161と検証 |
| [#173–#175 N6](https://github.com/tiramiss-community/tiramiss/issues/173) | 通知条件/stream、派生更新、webhookの公開契約と有限配送。Redis publish観測を実WebSocket成立としない |
| [#176 N7](https://github.com/tiramiss-community/tiramiss/issues/176) | coverageの全C/Fを、新実装の縦断・停止/競合試験へ対応付けてCIへ接続。空欄を新実装での成功へ変えない |
| [#178 共通API](https://github.com/tiramiss-community/tiramiss/issues/178) / [#179 認証](https://github.com/tiramiss-community/tiramiss/issues/179) | Role固有のHTTP gateを投稿にも使える契約へ。rate before input、moved/read/delete例外、App scope、D6を引き継ぐ |
| [#177 通知](https://github.com/tiramiss-community/tiramiss/issues/177) | PG正本というD5、全通知種別/既読/一覧/push/旧Redis移行。投稿通知部分は#173 |

全体の棚卸しは[#129 / PR #201](https://github.com/tiramiss-community/tiramiss/pull/201)。このPRを前提にコード依存や一括blockingを加えない。対応表がマージされた後にN1–N7の接続結果と照合する。

## 再実行（隔離環境のみ）

Node/pnpmはリポジトリ指定を使用する。以降の例で`NOTE_SOURCE_ROOT`は元repo、`NOTE_REFERENCE_ROOT`は新しい一時展開先。ローカルの既存参照checkoutは必要条件にしない。

```sh
export NOTE_SOURCE_ROOT="$PWD"
export NOTE_REFERENCE_ROOT="$(mktemp -d /tmp/tiramiss-note-167.XXXXXX)"
git archive 8e07cf085adf7009583d234a208e30436f020e26 | tar -x -C "$NOTE_REFERENCE_ROOT"
cp docs/superpowers/compatibility/note/reference-note.e2e.ts "$NOTE_REFERENCE_ROOT/packages/backend/test/e2e/note-contract.ts"
cp docs/superpowers/compatibility/note/http-cases.json "$NOTE_REFERENCE_ROOT/packages/backend/test/e2e/note-http-cases.json"
cp docs/superpowers/compatibility/note/observations.json "$NOTE_REFERENCE_ROOT/packages/backend/test/e2e/note-observations.json"
cp docs/superpowers/compatibility/note/reference-note.setup.ts "$NOTE_REFERENCE_ROOT/packages/backend/test/note-setup.ts"
cp docs/superpowers/compatibility/note/reference-note.config.mjs "$NOTE_REFERENCE_ROOT/packages/backend/note-contract.config.mjs"
cp docs/superpowers/compatibility/note/reference-note-rate.mjs "$NOTE_REFERENCE_ROOT/packages/backend/test/note-rate.mjs"
cp docs/superpowers/compatibility/note/rate-observations.json "$NOTE_REFERENCE_ROOT/packages/backend/test/note-rate-observations.json"
```

**55167/56167/61167/62167/63167とCompose projectが他で使われていないことを先に確認する。** 本家e2eはHTTPポートに既存プロセスがあれば停止する。probe内のassertより前にglobal setupが動くので、下記設定検査をVitestより先に実行する。probeは専用RedisをFLUSHDBしDB schemaを再作成する。ユーザー用misskey-infraや他セッションのプロジェクトを指定しない。

```sh
python3 - <<'PY'
import socket
sockets = []
for port in (55167, 56167, 61167, 62167, 63167):
    sock = socket.socket()
    sock.bind(('127.0.0.1', port))
    sockets.append(sock)
print('dedicated ports free')
PY
BACKEND_NEXT_TEST_DB_PORT=55167 BACKEND_NEXT_TEST_REDIS_PORT=56167 \
  docker compose -p note-167-reference -f packages/backend-next/compose.test.yml up -d --wait
```

参照側`.config/test.yml`を以下の値で作成する（既存の運用設定からコピーしない）。

```yaml
url: 'http://127.0.0.1:61167'
port: 61167
setupPassword: note-167-test-only
db:
  host: 127.0.0.1
  port: 55167
  db: backend_next_test
  user: postgres
  pass: foundation-test-only
  disableCache: true
redis:
  host: 127.0.0.1
  port: 56167
id: aidx
proxyRemoteFiles: true
allowedPrivateNetworks: ['127.0.0.1/32']
```

参照側で実行する。元のsrc/migration/manifest/lockfileを変更しない。

```sh
cd "$NOTE_REFERENCE_ROOT"
pnpm install --frozen-lockfile --filter backend...
pnpm build-pre
pnpm --filter backend... build
NODE_ENV=test pnpm --filter backend compile-config
pnpm --filter backend build:e2e
(
set -e
export NODE_ENV=test
node --input-type=module <<'JS'
import { loadConfig } from './packages/backend/built/config.js';
const c = loadConfig();
if (c.db.host !== '127.0.0.1' || c.db.port !== 55167 ||
    c.db.db !== 'backend_next_test' || c.dbReplications ||
    c.redis.host !== '127.0.0.1' || c.redis.port !== 56167 || c.port !== 61167) {
  throw new Error('Refusing to run outside note-167 dedicated configuration.');
}
console.log('Dedicated configuration: PASS');
JS
pnpm --filter backend exec vitest run --config note-contract.config.mjs test/e2e/note-contract.ts
node packages/backend/test/note-rate.mjs
pnpm --filter backend exec eslint --quiet test/e2e/note-contract.ts test/note-setup.ts
)
```

検査後に設定を変更・再コンパイルしない。`db.disableCache=true`は追加workerのproduction接続に本家のRedis query cache接続を残さないため。workerだけはtest用DataSourceがDBを再作成するのを避けてproductionモードで初期化し、初期化後に元のNODE_ENVへ戻す。HTTPの本体は最後のレートprobeを除き本家e2eのtestモード。本家ソースを改変してlimiter・署名・配送を代替していない。

再測定して期待値を更新するときだけ両probeに`NOTE_PROBE_RECORD=1`を渡す。e2eは失敗したsuiteの部分goldenを保存しない。成功した実行の出力を上記対応表の元ファイルへコピーし、record無効で必ず再生する。rate probeを単独で繰り返すと元actorのquotaが残るため、e2e→rateの順で再実行する。再実行中の他probeは並行起動しない。

終了後、元repoで**自分が起動した専用Composeだけ**を停止する。

```sh
cd "$NOTE_SOURCE_ROOT"
BACKEND_NEXT_TEST_DB_PORT=55167 BACKEND_NEXT_TEST_REDIS_PORT=56167 \
  docker compose -p note-167-reference -f packages/backend-next/compose.test.yml down
node --test scripts/note-contract-*.test.mjs
```

## 実行記録

2026-10-24、Node.js24.20.0 / pnpm12.9.1 / PostgreSQL18 / Redis8、専用Compose `note-167-reference`。Git archiveした固定本家と同SHA用の既存依存treeを再利用し、参照側を再ビルドした。src/migration/manifest/lockfile計1330ファイルを固定Git内容と照合した。本家のVite将来設定警告と複数Nest context由来のEventEmitter listener警告は本家環境の観測として区別する。

2026-10-25の最終再生は本家51テスト・production rate probe・probe lint・Node fixture4件がPASS。独立レビュー3巡で指摘3件を修正し、最終No findings。検証の詳細は[実装計画](../../plans/2026-10-24-note-compatibility-contract.md)とPRへ記録する。新backendの製品コード/API/Entity/migrationを変更していないため、旧backendのAPI型再生成・新migration/schema検査は今回の検証対象外。


PR #202の追加レビュー対応（2026-10-25）: 比較資料の固定SHA検査は更新される`backend-upstream`同期SHAから独立させた。rate probeはINSERT成功を確認した行だけを後始末する。`scripts/note-contract-review.test.mjs`で同期元SHAのみの更新、ロール/割り当ての衝突、行作成後のserver起動失敗を回帰検査する。後始末の試験は実際のprobeを子プロセスで実行し、DB接続をPK衝突と削除cascadeを再現するテスト用driverへ置き換える。本家HTTP/DBの再測定とは区別する。
