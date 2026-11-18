# chart保存schemaと既存履歴（#273）

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の12系列・24テーブルを採取し、全349本家migrationを適用したPostgreSQL 18で既存行を読書きできることを確認した。#200 / #114 のうち **schemaの収容方式と検査手順** を確定する資料であり、chart API・producer・buffer・flush・schedulerの実装完了ではない。

## 採用する境界

`backend-upstream` は現在のモデル定義と全migration履歴を原文のまま提供する。chartの動的生成Entityを現行の同期入口へ追加しない。後続の最初の利用者 #274（notes系列）は `backend-next` のchart永続化アダプタで必要な系列の `EntitySchema` を生成し、本資料の固定生成結果と照合する。未使用の全12系列や汎用chartサービスを先に本番登録する必要はない。

`source-probe.mjs` は本家Gitオブジェクトの `Chart.convertSchemaToColumnDefinitions` / `Chart.schemaToEntity` の2メソッドと4定数をそのまま抽出し、12定義のリテラルで実行する。TypeORMの実 `EntitySchema` を使い、NestJS/chartサービスを起動しない。`schema-manifest.json` は列型・default・array・group・index・uniqueと、accumulate / uniqueIncrement / intersectionを含む元の生成定義を保持する。新生成処理を本家クラスの複製・importで実装することはしない。

同期スクリプトと同じimport走査（type importも対象）で確認した依存閉包は105ファイル、現行manifestに存在するのは44、未宣言は61。26ファイルは許可パス `src/models/**` / `src/types.ts` にも収まらない。外部依存 `chalk` / `color-convert` / `date-fns` / `nested-property` も未宣言。`core.ts` → `models/_.ts` の集約モデル、logger・decorator・time等まで広がることが確定した。入力108ファイルのGit blobとSHA-256、許可範囲外パスと外部依存一覧はmanifestに収録する。旧backend全体を同期対象へ広げる方式は採らない。

## 12系列

hourは `__chart__`、dayは `__chart_day__` の接頭語で、camelCaseの系列名をsnake_caseに変換する。

| 定義ファイル | 系列名 | group | 指標数 |
| --- | --- | --- | ---: |
| federation | federation | なし | 8 |
| notes | notes | なし | 14 |
| users | users | なし | 6 |
| active-users | activeUsers | なし | 9 |
| instance | instance | varchar(128) | 24 |
| per-user-notes | perUserNotes | varchar(128) | 7 |
| per-user-pv | perUserPv | varchar(128) | 4 |
| drive | drive | なし | 8 |
| per-user-reactions | **perUserReaction** | varchar(128) | 2 |
| per-user-following | perUserFollowing | varchar(128) | 12 |
| per-user-drive | perUserDrive | varchar(128) | 6 |
| ap-request | apRequest | なし | 3 |

全テーブルにserialのinteger primary key `id` と秒単位のinteger `date` がある。指標は `___` + `.` を `_` に置換した名前、rangeはsmall→smallint、big→bigint、省略/medium→integer、defaultは0。uniqueIncrementは追加で `unique_temp___` のvarchar配列（default `'{}'`）を持つ。列はすべてNOT NULL。本家は `(date)` / `(date, group)` にunique indexとunique constraintを両方定義するため、一方へ整理しない。`per-user-reactions` の系列名は単数形であり、既存テーブル名もこれを維持する。

## 既存データの読書き

`existing-db-fixture.json` は**本番からのdumpではない**。空の隔離DBに本家全migrationを適用して作った実schema・index・全349履歴と、独立SQLで投入した36の模擬既存行である。group有りは同一dateの2groupを用意し、varchar配列とJSの安全整数範囲を超えるbigint文字列 `9007199254740993` を含む。新たなschema同期で作ったテーブルを既存DBとみなしていない。

`database-probe.mjs` は次を実行し、固定fixtureと完全照合する。

1. 本家migrationで作った既存24テーブルに対し、採取したmetadataのschema builder差分がup/downとも0。
2. 独立SQLの既存行を、接続を開き直したTypeORM Repositoryで全列読取り。
3. 既存1行の指標更新、別group不変、新期間insert、serial採番・0/空配列default、重複date/groupの23505拒否。
4. schema catalogと全migration履歴が読書き前後で完全一致。
5. 検証用の余分な列を付けると差分を検出し、検査だけではDDLを実行しない。列を除去すると再びup/down差分0。

業務側へORMを公開せず、必要なRepositoryをchartアダプタ内に保持する。既存テーブル名・列・index・public.migrationsは変更せず、通常起動での `synchronize` / 自動DDLを有効にしない。後続実装ではアダプタの登録対象だけを既存 `check-schema` 相当の読取検査へ接続する。既存の `check-schema` が今すぐchartを検査するという意味ではない。

このprobeは保存表現の検査であり、集計/交差/欠損補間/期間境界/lock/再試行/retentionの同等性、既存履歴の再構築、本家full serverとの同時実行比較を証明しない。これらは#200の後続Issueが所有する。対応表の `responsibility:queue-daemons-charts:38` は調査根拠を追加しても本番実装のstatusを昇格させない。

## 再実行

repo rootで依存を準備し、固定本家Gitオブジェクトを取得した環境で実行する。source入力は作業ツリーから読まない。

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-upstream build
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
node docs/superpowers/compatibility/chart-storage/source-probe.mjs --check
BACKEND_NEXT_TEST_DB_PORT=55473 docker compose -p tiramiss-chart273 -f packages/backend-next/compose.test.yml up -d --wait postgres
BACKEND_NEXT_TEST_DB_PORT=55473 node docs/superpowers/compatibility/chart-storage/database-probe.mjs --check
BACKEND_NEXT_TEST_DB_PORT=55473 pnpm --filter backend-next test:integration test/integration/chart-storage-contract.test.ts
BACKEND_NEXT_TEST_DB_PORT=55473 docker compose -p tiramiss-chart273 -f packages/backend-next/compose.test.yml down
node scripts/check-shipping.mjs --base origin/develop
```

並行セッションは専用Compose名と未使用portへ変更する。probeは `backend_next_<UUID>` DBだけを作成/削除し、本番設定や通常Redisを使わない。`--write` はfixtureの明示更新時だけ使い、本家SHA・生成定義・同期manifest・TypeORM/PG版の変更時にはsourceとDB両方の差分をレビューする。通常integration CIではGit不要の固定metadataでDB読書きprobeを実行する。
