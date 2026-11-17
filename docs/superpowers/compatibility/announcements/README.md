# お知らせの取得・個人既読 #337

親は #193、全体は #114。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`、作業基点は `45a2f217e3b991c309798ff61b118841085d7f48`。通常 composition の `POST /api/announcements`・`announcements/show`・`i/read-announcement` を実装する。管理更新・アーカイブ予約/起動復元 #449 と親領域全体の完成は含めない。

一覧は公開分と閲覧者個人宛だけを、isActive/期限・ID/日付cursor・limitで取得する。既存ユーザー条件とsilenceは一覧から除外する条件ではなく、未読の残数判定に使う。単体取得はinactive/期限切れも取得でき、他人宛は不存在と同じ `NO_SUCH_ANNOUNCEMENT` / `b57b5e1d-4f49-404a-9edb-46b00268f121`。匿名のisReadは省略し、認証済みの既読状態は閲覧者別に取得する。データ取得後の変換は純粋関数で行い、一括変換失敗はその項目を除外する。閲覧者既読をまとめて取得し、その取得自体が失敗した一覧は本家packManyと同じく空配列となる。単体取得の既読参照失敗は500となる。

既読は本家と同じ挿入→個人宛の無効化→未読判定→mainイベントの順とし、新しいtransaction/upsert保証を追加しない。挿入時のすべての例外を無処理で終了するため、重複、不存在FK、挿入障害も204となる。本家同様に他人宛のIDを既読として登録すること自体は拒否せず、そのお知らせは無効化しない。表示のアクセス制御と既読登録の契約を混同しない。本人宛の無効化はisActiveだけを変更し、updatedAtを変更しない。未読条件はactive・期限前・非silence・対象宛/全体・既存ユーザー条件（announcement.id > user.id）・未既読であり、残らなければ `{channel:"mainStream:<viewer>",message:{type:"readAllAnnouncements",body:null}}` を既存のpubsub接続へ送る。挿入後の参照失敗は既読行を残す点も維持する。

## 比較方法と限界

`source-probe.mjs` は固定Git objectから3 Endpointのcallback/meta/schema、AnnouncementServiceのgetUnreadAnnouncements/getAnnouncement/read、AnnouncementEntityServiceのpack/packMany、QueryServiceのページング、GlobalEventServiceのpublish/publishMainStreamをASTで抽出し、内容を変更せず実行する。固定fixtureの28ケース・63操作を、実際に全migrationを適用した専用PostgreSQLとTypeORM repositoryで実行し、`observations.json` に応答・既読行・isActive/updatedAt・イベントを保存する。manifestはsourceのblob/SHA256、corpus/probeのSHA256を記録する。

新実装の結合テストは同一の入力を通常 `createBackendHttpApp` のlistening HTTPへ送信し、実PGの行と実Redis購読メッセージを観測して、1操作ずつsource結果へ照合する。別の試験でtoken/scope/凍結順、5並列の同一既読、unique/FK/CASCADEを確認する。単体は純粋変換、失敗除外、重複、挿入失敗、挿入後失敗、認可順と証跡入力対応を確認する。

source側のEndpoint基底/ApiError/AJV、aidx用IdService、固定時刻、イベントtransportは明示したdoubleであり、本家のNestアプリ全体・認証/HTTPエラーserializer・本家Redis実接続は起動していない。新実装側では通常の共通認証とHTTP adapter、実PG、実Redisを使う。ランダムな診断UUID/内部DB例外文言の完全一致と、日付cursorの同一ミリ秒内の乱数suffix比較は主張しない。期限fixtureは測定時刻から十分離した2001/2099年であり、アーカイブ予約実行は検証しない。DB障害に対する本家同様の挿入例外抑制を維持し、Redis配信失敗は下記followupで補完した。本家の未処理Promise rejection自体は再現せず、診断して終了時に待つ。

Announcement/AnnouncementReadはmanifestへ追加して機械同期し、生成exportsから通常DataSourceに登録した。旧backendや既存migrationは編集しない。migration/history/schema検査とEntity読込・unique/FK/cascadeの実PG試験を実施する。

## 再実行

Node26.4.0・pnpm12.9.1、独立node_modulesを利用する。今回のCompose projectは `sol3-ann337`、PG15737・Redis16737・Meili17737、HTTPは動的port。全コマンドで指定Nodeと環境変数を維持する。

```sh
export PATH=/tmp/tiramiss-s1-node26/bin:$PATH
export BACKEND_NEXT_TEST_DB_PORT=15737 BACKEND_NEXT_TEST_REDIS_PORT=16737 BACKEND_NEXT_TEST_MEILI_PORT=17737
pnpm install --frozen-lockfile --filter backend-next...
docker compose -p sol3-ann337 -f packages/backend-next/compose.test.yml up -d --wait postgres redis meilisearch
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test
node docs/superpowers/compatibility/announcements/source-probe.mjs --check
pnpm --filter backend-next test:integration test/integration/announcements.test.ts test/integration/http-app.test.ts test/integration/migrations.test.ts
node scripts/check-shipping.mjs --base 45a2f217e3b991c309798ff61b118841085d7f48
```

測定input・実行結果・log SHA256は `current-evidence.json` を参照する。歴史的receiptは更新しない。共有HTTP route追加と同期Entity2件による既存proofの有限projectionは取りまとめ担当が別作業として所有する。共有proof未更新によるcontract driftと製品の比較結果を区別する。

CHANGELOG候補: backend-nextでお知らせの公開・個人宛取得と閲覧者別の既読処理を実装。

## 配信失敗のfollowup

独立レビューで、初版の `await readAll` がRedis配信拒否を保存済み既読のHTTP500へ変えていた差異を検出した。初版の `current-evidence.json` と28case/63step観測は当時の履歴として保持し、修正の入力・結果は `publish-followup-evidence.json` に別記する。

固定本家のread/publish/publishMainStreamはRedisの返却PromiseをHTTP結果に含めない。`publish-source-probe.mjs` はそのliteral methodsを抽出し、未完了配信より先にreadが返ること、遅延した配信拒否後にも既読保存・個人宛無効化・重複no-opが残ることを `publish-corpus.json` / `publish-observations.json` に記録する。この追加source probeのDB窓口は明示したdoubleであり、元の28case実PG比較とは区別する。

新実装は専用publisherで配信を非待機にし、拒否を `announcement-publish.failed` として診断する。受け付けた配信はHTTP終了時の既存drainへ登録する。実専用RedisのACLでPUBLISHだけを拒否する試験は、通常listening HTTPが204、既読行・個人宛isActive=false/updatedAt不変、再読で送信増加なしを確認する。遅延Promise注入による別の実HTTP/PG試験は、送信前のHTTP204と終了待機を確認する。元fixtureやreceiptのhashを新しい成功測定に付け替えない。
