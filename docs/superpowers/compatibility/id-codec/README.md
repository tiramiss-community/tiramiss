# ID codec の限定比較（#575）

基準: develop `706f82eb20`。固定本家: `8e07cf085adf7009583d234a208e30436f020e26`。
#575全体は未完了であり、通知移行#442・remote Note取込#329の実利用比較待ちを維持する。

## 今回の範囲

- aid・aidx・meid・meidg・objectid・ulid の生成時刻prefix、長さ、既存IDの日時解析。
- 通常時刻、Unix epochの前後、AID epochの前後、秒精度、未指定/0/NaNの現在時刻選択、未来clamp、形式の桁境界、ULID上限/超過。
- 時計自体が0/負数の場合も比較する。本家meid/meidg/objectidは正規の幅に埋めず、0に短縮したprefixを使う。現行codecとの差を修正した。生成後の日時解析が元の負日時を復元するという契約にはしない。
- 6形式すべてを大文字のYAML設定から読み、通常listening HTTPのDriveフォルダ作成 → PostgreSQLの独立したRepository再読取 → `drive/folders/show`の新しいHTTPリクエストへ通す。返るID形式と`createdAt`を固定本家の時刻結果と比較する。objectidだけ秒単位になる。

`source-probe.mjs`は固定コミットのIdServiceメソッドと6形式・bigint helperの宣言をASTで取り出して実行する。宣言の手書き置換は行わず、ファイルごとのSHA-256を`observations.json`へ記録する。本家のulid依存と同じ3.0.2を利用する。乱数は明示double（AID seed=0、AIDX node=0000、Math.random=0、ULID PRNG=0）であり、生成IDの乱数部分のバイト一致は要求しない。時計はケースごとに固定する。

`observations.json`は138生成ケースと12既存IDを持つ。既存IDは各形式の追加部分が0/最大になるもの。`safe`と`full.date`/`full.additional`も本家の担当引継ぎ用に採取する。codecがこれらの未使用APIを実装・利用した証拠ではない。

## 再現と検証

repo root、指定Node/pnpm、backend-nextとbackend-upstreamの依存導入後:

```sh
node docs/superpowers/compatibility/id-codec/source-probe.mjs --check
pnpm --filter backend-next test test/unit/id-codec.test.ts test/unit/config.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
BACKEND_NEXT_TEST_DB_PORT=58432 BACKEND_NEXT_TEST_REDIS_PORT=58379 \
  docker compose -p id-codec-575 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
BACKEND_NEXT_TEST_DB_PORT=58432 BACKEND_NEXT_TEST_REDIS_PORT=58379 \
  pnpm --filter backend-next test:integration test/integration/id-codec.test.ts
node scripts/check-shipping.mjs --base origin/develop
```

2026-11-18の実測: source再採取一致、単体208件/2files、実HTTP/PG 6件、build/typecheckがPASS。変更3ファイルのlint・SPDX・locale safetyもPASS。初回のHTTP試験はテストtokenがchar(16)を超えて準備時失敗したため、16文字へ直してから上記6件を再測定した。依存の初回は`--ignore-scripts`によりre2 native artifactがなく、`pnpm rebuild re2`後に実行した。これは製品不具合の修正ではない。

比較は本家ソースのmethod実行と新実装の実HTTP/PGを組み合わせた有限比較である。本家full server/PG、全ID利用者、全単体、process、切替migrationを実行した意味ではない。

## 残る担当と適用条件

- #329: remote Note取込で`published`を受ける際の`isSafeT`。本家ではaid/aidxが2000-01-01より後、他4形式がUnix epochより後かを調べるだけで、桁上限検査ではない。保存済みlocal NoteのAP公開日時は既存の`createdAtFromId`を利用しているが、remote publishedの採用判断を実装した意味ではない。
- #442: 本家通知IDの`parseFull`によるdate/additional分解と、承認済みPG通知方式への実際の移行・読取。本家の追加部分はaidで2桁base36、aidxで8桁base36、meid/meidgで12桁hex、objectidで16桁hex、ulidで16桁base32。後者は80bitであり、NotificationServiceはRedis Stream用に`BigInt.asUintN(64, additional)`で下位64bitを取る。IdServiceの「at most 64 bits」というコメントだけを移行仕様に使わない。
- 本家NotificationServiceが日時・追加部分を旧保存形式へ分解する内部表現は、PG通知方式でそのまま複製する必要があると未判断。移行対象と読取契約が揃う前に未使用の`parseFull`/`isSafeT`をcodecへ追加しない。担当へ渡せる本家の結果と境界fixtureは今回固定した。
- 本家方式と同じく設定を変えれば過去IDの解析方式も変わる。混在形式の自動判別・新ID形式・新しい一意性保証を追加しない。生成・保存の今回の確認だけで通知移行/AP取込の先行条件を完了としない。

親#138/#114、#575はOPENのまま。新たな方針・依存順の変更はない。
