# Page 読み取り（#293）

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `pages/show` と `PageEntityService` を移植する。親 #191/#114 全体、Page CRUD、一覧、likes の更新、UserDetailed 本体は未完了。

## 経路と責任

通常 `createBackendHttpApp` → `pages/show` → Page reader → Page adapter で通す。`modules/page/public.ts` は取得済み Page の `pack` / `packMany` と純粋な変換を公開し、後続の pinnedPage が UserLite だけを経由して利用できる。業務モデルに ORM・Hono・Packed 型は持ち込まない。取得・旧形式変換・書戻し・表示を分け、Drive の既存 public renderer と `readNoteAuthors` を利用する。

ID 指定が優先され、名前指定では小文字化した username と local host NULL の作者を選ぶ。Page 名は大文字小文字を区別する。本家と同じく Page.visibility / visibleUserIds による追加制限は設けない。画像は children を再帰し、順序と重複を保持する。attachedFiles は Page 所有者のファイルのみで、他者・欠損は除外する。eye catch は所有者を制限せず、欠損時は表示全体が失敗する。attachedFiles は本家 packMany → packNullable と同じ userId を返し、eye catch は pack と同じ userId:null を返す。

guest は isLiked を省略し、資格がある場合は PageLike の true/false を返す。公開APIなので凍結済み利用者・scope のない app token も読み取り可能で、不正 token は共通認証で拒否する。GET は提供しない。

## 旧 content と失敗

`input` は子孫まで変換する。text → textInput、number → numberInput、truthy な default だけ parseInt(…,10) を適用する。不明な inputType も書戻し対象にする。変換は取得済み材料を変更しない。NaN は本家応答と JSONB 保存と同じく JSON で null になる。

書戻しは非同期で開始し、HTTP 応答は待たない。その後の表示材料取得が失敗しても、開始済み書込みは独立して確定し得る。DB の書込み失敗では、応答は変換済み content を返し、保存 content は旧形式のまま残る。更新は content 列だけで updatedAt を変更しない。独自のジョブ・retry・永続状態は加えない。

本家は update の Promise を監視していない。新実装は開始済み書込みの失敗を診断し、通常 HTTP 終了時に待つ。成功応答を待機型に変えず、失敗を unhandled rejection にしないための運用上の差異である。本家フルサーバーのプロセス終了挙動は測定していない。

## 比較と再実行

`source-probe.mjs` は固定 Git object の **モジュール全体**を TypeScript から CommonJS に変換し、require の実体を解決する。Page・pages/show・DriveFile・IdService と、それらが利用する19モジュールと固定 PostgreSQL 設定の計20ファイルのバイト hash/blob を observations に記録する。メソッドの抽出や新実装を oracle にする経路は使わない。Nest/Endpoint の枠、repository、UserLite は corpus に列挙した double。未宣言の import は拒否する。本家のフル Nest / PG サーバーを起動した比較ではない。

同じ18入力を通常 HTTP/PG テストへ結び、欠損・所有者・重複画像・名前/ID優先・guest/like・入れ子入力・数値変換・保存結果・読取/書込失敗を比較する。fileId の欠落/null は固定本家の WHERE-ignore 設定と同じく所有者条件だけで取得し、anyOf が名前分岐で受理した pageId:null はID分岐を選んで先頭Pageを取得する。children の文字列も本家の for-of と同じく巡回する。これら4境界は、本家モジュール実体と固定DB設定を実PGへ接続した追加テストでも比較する。production の DataSource 設定は変更しない。missing eye は FK が不正状態を防ぐため、別読取り間の欠落として repository 結果だけを注入する。書込み失敗は実 PG trigger が拒否する。追加テストで本家 migration と PageLike metadata の schema 差分0件、無scope token、凍結利用者、不正token、GETを確認する。

```sh
export PATH=/tmp/tiramiss-s1-node26/bin:$PATH
export BACKEND_NEXT_UPSTREAM_PATH=/home/osamu/develop/misskey
export UPSTREAM_ROOT="$BACKEND_NEXT_UPSTREAM_PATH"
node docs/superpowers/compatibility/page-read/source-probe.mjs --check
pnpm --filter backend-next test test/unit/page test/unit/composition/http-app.test.ts
BACKEND_NEXT_TEST_DB_PORT=55931 BACKEND_NEXT_TEST_REDIS_PORT=56931 pnpm --filter backend-next test:integration test/integration/page-read.test.ts
```

専用Composeの起動は backend-next README に従う。実測入力・ログ・コマンドと hash は `verification.json`。notes-pagination の古い receipt は不変のまま、Page 登録と登録 assertion の有限のバイト差分だけを `scripts/notes-pagination-evidence.mjs` で元へ戻す。新しい実測結果を古い入力へ付け替えない。

初回の全単体検証は PageLike 追加に伴う metadata 件数 assertion の39→40未更新で1失敗、4,973成功だった。対象 assertion/関係検査を更新後、4,974件成功。R2 では既存証跡 reader の重複適用と drift 診断ラベルを検出し、測定中に修正したため noInputDrift:false を保持する。旧 receipt を保存したまま、R3 は入力を固定したが既存 poll synthetic assertion の2失敗を保持する。独立レビューのP2（nullish ID条件と文字列 children）を4ケースでRED→GREENにしてから最終R4を測定する。R1–R3の件数は修正後R4へ付け替えない。実DB検証には既存 migration 経路由来の pg query deprecation warning が出るが、全assertionは成功する。
