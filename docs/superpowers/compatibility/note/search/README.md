# 投稿の検索登録・解除（#174/#172）

固定本家commit `8e07cf085adf7009583d234a208e30436f020e26`。検索producerだけを比較し、検索API全体/旧HTTPサーバー全体の新規実測は行っていない。

## 固定sourceから独立した期待値

`reference-search.cjs`は指定checkoutから固定Git blobを読み、TypeScript ASTで本来のSearchService、GlobalModule factory、NoteCreateService.index/postNoteCreated、NotificationManager、NoteDeleteService.deleteを抽出して実行する。SDK/Repository/IdService等の境界はdouble。新実装を期待値生成に使用しない。

| 固定source | blob |
| --- | --- |
| SearchService | `c54195d91a70e7c5fa9dcdac75ef8e47ebdc620e` |
| NoteCreateService | `05e98541844d7f14e91263a78a03c9ec0139a89d` |
| NoteDeleteService | `1b945277b7590bf89fcdaaf5c56ec16513a59d6a` |
| GlobalModule | `adccb4dc3ee273d4389de53ce01c2fcc2ab3449f` |

```sh
OUTPUT=/tmp/search-observations.actual.json node docs/superpowers/compatibility/note/search/reference-search.cjs /path/to/fixed-upstream-checkout
cmp docs/superpowers/compatibility/note/search/observations.json /tmp/search-observations.actual.json
cmp docs/superpowers/compatibility/note/search/post-created-boundaries.json /tmp/post-created-boundaries.json
```

`observations.json`の256ケースは、5scope×3host×4visibility×4contentの240ケースと、provider/client/settings/直接拒否/作成wrapper/削除開始境界。新unitは240ケースのdocumentと解除条件を直接照合する。`post-created-boundaries.json`の8ケースは元の完全なpostNoteCreated+NotificationManagerを実行した成功、pack失敗、mention準備失敗、detached stream/webhook/AP render throw/AP render reject/AP execute reject。元のunhandled rejectionはprobeが捕捉する。新unitは同じ準備失敗対detached失敗境界を検証するが、新旧HTTP同時測定とは呼ばない。

## 維持する契約

providerが明示的meilisearchの場合だけSDK 0.62.0でclientを作り、root設定host/port/apiKey/ssl/index/scopeを使う。数値portは本家example、文字列portは本家型に対応。空apiKey/indexも有効。`${index}---notes`へ起動時settingsを送る。searchable text/cw、sortable createdAt、filterable createdAt/userId/userHost/channelId/tags、typo無効、maxTotalHits10000。

public/homeでtextまたはcwが非nullなら登録候補。scopeは既定local、global、host完全一致配列。配列でもlocal authorを許可する。localOnly/チャンネル/返信を独自除外しない。documentはid、ID由来のミリ秒createdAt、userId、userHost、channelId、cw、text、tags。1投稿1addDocuments、primaryKey=id。登録はpack/mention準備成功末尾で開始し、detached失敗では省かない。

解除はpublic/homeのみ。content/scope/remote/localOnlyを追加条件にしない。DB DELETE前に開始し、DELETE失敗でも取り消さない。SDK成功はMeili task受付であり適用完了ではない。settings受付待ちやengine healthを起動条件にせず、要求失敗で確定済み投稿HTTPを失敗にしない。

## 新実装の実依存検証と差異

`note-search-index.test.ts`のintegrationは実HTTP handler・専用PG/Redis・実Meilisearch v1.3.4/SDK0.62.0でdocument/settings/primaryKey/CW検索/public-home/非公開除外、remote allowlistと非対称解除、DB失敗でもengine解除、作成snapshot、SQL provider無通信を確認する。同じintegrationファイルの保留/拒否SDK要求はloopback HTTP gatewayで制御する。task適用待ちはテスト内だけにある。本家test composeはv1.3.4、当時のCIは別versionであり、全本家環境共通versionとは主張しない。

processは実HTTP子・実SDKとloopback HTTP gateway（実engineとは別）でsettings保留中のready、add/delete要求保留中のHTTP成功、SIGTERMで開始済み要求待機、task適用を待たない終了、settings拒否時の起動継続、設定欠落時の起動失敗、既存停止期限を確認する。Compose/CIに専用Meili serviceを追加し、公開portを上書き可能にした。

本家のdetached unhandled rejectionを再現せず、`search-settings.failed`/`search-index.failed`/`search-unindex.failed`と既存post-save/deleteの安全な構造化ログに記録する。本家SearchServiceにdisposeは無いが、新実装では既存の受付停止→開始済み要求待機→資源解放/期限の契約へ接続する。engine task完了待ち、独自timeout/retry/batch/rebuildは追加しない。有効化されたMeili設定の不正値は新実装の既存方式でINVALID_CONFIGとして拒否する。未知のproviderを含めmeilisearch以外では未使用のMeili設定を読まず、外部通信しない。

## 再構築への材料と残範囲

| #132/#133へ渡す材料 | 再現できる範囲 |
| --- | --- |
| Note.idと設定id method | sourceと同じcreatedAt |
| visibility/text/cw/userHostと現在scope | 現在の登録候補 |
| userId/channelId/tagsと本文 | 同じdocument |
| index名とsettings | 同じ現在索引の設定 |

DB正本と現在設定で現在候補を再構成できる。過去のscope、削除済みNote、detached失敗/順序による過去engine状態は復元できない。遅れたcreate addとdeleteの競合は本家同様に残る。通常経路へrebuild台帳・tombstone・強い順序を追加しない。

検索API #186、再構築 #132/#133、antenna/hashtag/featured/role timelineなど#174の残り、#172の最終削除連携、投稿全体#176は未完了。`Refs #174, refs #172`で扱い、closeしない。
