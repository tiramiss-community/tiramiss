# ID codec の限定比較（#575）

基準: develop `706f82eb20`。固定本家: `8e07cf085adf7009583d234a208e30436f020e26`。
#575全体は未完了であり、通知移行#442・remote Note取込#329の実利用比較待ちを維持する。

## 今回の範囲

- aid・aidx・meid・meidg・objectid・ulid の生成時刻prefix、長さ、既存IDの日時解析。
- 通常時刻、Unix epochの前後、AID epochの前後、秒精度、未指定/0/NaNの現在時刻選択、未来clamp、形式の桁境界、ULID上限/超過。
- 時計自体が0/負数の場合も比較する。本家meid/meidg/objectidは正規の幅に埋めず、0に短縮したprefixを使う。現行codecとの差を修正した。生成後の日時解析が元の負日時を復元するという契約にはしない。
- 6形式すべてを大文字のYAML設定から読み、通常listening HTTPのDriveフォルダ作成 → PostgreSQLの独立したRepository再読取 → `drive/folders/show`の新しいHTTPリクエストへ通す。返るID形式と`createdAt`を固定本家の時刻結果と比較する。objectidだけ秒単位になる。

`source-probe.mjs`は固定コミットのIdServiceメソッドと6形式・bigint helperの宣言をASTで取り出して実行する。宣言の手書き置換は行わず、ファイルごとのSHA-256を`observations.json`へ記録する。本家のulid依存と同じ3.0.2を利用する。乱数は明示double（AID seed=0、AIDX node=0000、Math.random=0、ULID PRNG=0）であり、生成IDの乱数部分のバイト一致は要求しない。時計はケースごとに固定する。

`observations.json`は138生成ケースと13既存IDを持つ。既存IDは各形式の追加部分が0/最大になるものと、短いobjectidに非ゼロ接尾辞を持つもの。`safe`と`full.date`/`full.additional`も本家の担当引継ぎ用に採取する。codecがこれらの未使用APIを実装・利用した証拠ではない。

## 再現と検証

repo root、指定Node/pnpm、backend-nextとbackend-upstreamの依存導入後:

浅いcloneなどで固定本家のGitオブジェクトがない場合は、先に固定SHAを取得する。probeは作業ツリーではなく、そのGitオブジェクトを読む。既に存在する環境ではfetchは省略できる。

```sh
git fetch --no-tags https://github.com/misskey-dev/misskey.git 8e07cf085adf7009583d234a208e30436f020e26
git cat-file -e '8e07cf085adf7009583d234a208e30436f020e26^{commit}'
node docs/superpowers/compatibility/id-codec/source-probe.mjs --check
pnpm --filter backend-next test test/unit/id-codec test/unit/config.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
BACKEND_NEXT_TEST_DB_PORT=58432 BACKEND_NEXT_TEST_REDIS_PORT=58379 \
  docker compose -p id-codec-575 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=58432 BACKEND_NEXT_TEST_REDIS_PORT=58379 \
  pnpm --filter backend-next test:integration test/integration/id-codec.test.ts
node scripts/check-shipping.mjs --base origin/develop
```

2026-11-18の実測: source再採取一致、単体208件/3files、実HTTP/PG 6件、build/typecheckがPASS。変更ファイルのlint・SPDX・locale safetyもPASS。初回のHTTP試験はテストtokenがchar(16)を超えて準備時失敗したため、16文字へ直してから上記6件を再測定した。依存の初回は`--ignore-scripts`によりre2 native artifactがなく、`pnpm rebuild re2`後に実行した。これは製品不具合の修正ではない。

比較は本家ソースのmethod実行と新実装の実HTTP/PGを組み合わせた有限比較である。本家full server/PG、全ID利用者、全単体、process、切替migrationを実行した意味ではない。

## 残る担当と適用条件

- #329: remote Note取込で`published`を受ける際の`isSafeT`。本家ではaid/aidxが2000-01-01より後、他4形式がUnix epochより後かを調べるだけで、桁上限検査ではない。保存済みlocal NoteのAP公開日時は既存の`createdAtFromId`を利用しているが、remote publishedの採用判断を実装した意味ではない。
- #442: 本家通知IDの`parseFull`によるdate/additional分解と、承認済みPG通知方式への実際の移行・読取。本家の追加部分はaidで2桁base36、aidxで8桁base36、meid/meidgで12桁hex、objectidで16桁hex、ulidで16桁base32。後者は80bitであり、NotificationServiceはRedis Stream用に`BigInt.asUintN(64, additional)`で下位64bitを取る。IdServiceの「at most 64 bits」というコメントだけを移行仕様に使わない。
- 本家NotificationServiceが日時・追加部分を旧保存形式へ分解する内部表現は、PG通知方式でそのまま複製する必要があると未判断。移行対象と読取契約が揃う前に未使用の`parseFull`/`isSafeT`をcodecへ追加しない。担当へ渡せる本家の結果と境界fixtureは今回固定した。
- 本家方式と同じく設定を変えれば過去IDの解析方式も変わる。混在形式の自動判別・新ID形式・新しい一意性保証を追加しない。生成・保存の今回の確認だけで通知移行/AP取込の先行条件を完了としない。

親#138/#114、#575はOPENのまま。新たな方針・依存順の変更はない。

## 過去の比較記録の維持

`compatibility-predecessor.json`と`id-codec-predecessor.mjs`は今回の`id-codec.ts`だけについて、変更後SHA-256と一致する入力を正確な変更前バイト列へ戻す。Driveフォルダの2つのvalidatorとその下流readerがこの有限な投影を使う。過去のreceipt・測定件数・hashを書き換えたり、今回再測定したと主張したりしない。その他のパスと未知の変更はそのまま従来のguardへ渡す。新しいcontractは正確な投影と、1文字の追記も両validatorで拒否することを確認する。

独立レビュー後、source probeの例外記録を生成時に限定した。解析時の例外はprobe自体を失敗させる。現コーパスの生成失敗はULIDの負日時2件と48bit超過1件だけで、単体では例外の名前も比較する。HTTPサーバー・DB・一時設定の後片付けは前段のcloseが失敗しても試みる。

追補後のroot gate: `node --test scripts/*-contract*.test.mjs` が817件中816成功・0失敗・1skip（既存の条件付き項目）でPASS。追加前の既存`id-codec.test.ts`をhistorical receiptの元バイトで保持し、新規ケースは`id-codec-compatibility.test.ts`へ分離した。最初の全root実行では既存単体ファイルのhash差による3失敗があり、分離後に全件を再実行した。

2026-11-19 Webレビュー追補: 138生成・既存12件の期待値を維持し、非ゼロ接尾辞を持つ17文字objectidを1件追加した。現在の近傍単体は209件/3files、HTTP/PGは6件がPASS。HTTP fixtureは同じ通常appとHonoのNode listenerを直接127.0.0.1へ接続し、実TCPの保存後読取を維持する。Vitestのキャンセルと10秒のfetch期限を渡し、ケース終了hookで時計復元・リクエスト中断・受付停止・受理済み処理とapp workの待機を行う。後片付けの待機は15秒、hookは20秒を上限とする。productionのHTTP helperと運用設定は変えていない。

追加のroot contractは、pubsubの入力検証後にfolder側の読取だけへ変更を入れて拒否を確認する。folder自身の入力照合ループを意図的に外したcounterexampleで新規テストが失敗し、復元後3件がPASSした。固定SHAのGitオブジェクト取得・事前存在確認も再現手順へ追加した。

追補後も`node --test scripts/*-contract*.test.mjs`は818件中817成功・0失敗・既存1skipでPASS。typecheck・変更ファイルlint・SPDX・locale safetyもPASSした。前述の817件の結果は追補前の測定として保持する。
