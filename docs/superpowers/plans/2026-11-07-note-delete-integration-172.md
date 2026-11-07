# Note deletion integration #172 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. 本セッションではユーザー指定の Ultracode native fallback に従い、実装と独立レビューを分担する。

**Goal:** 通常投稿の派生更新が揃った状態で削除の連携を実プロセスから検証し、#172 の残る通知・stream・TL・検索・webhook の責任を確定する。

**Architecture:** 既存の HTTP / worker composition を実 PG・Redis・Meili と fake AP inbox / webhook へ接続し、同じ Note の作成・閲覧・削除前後を観測する。認可・AP・検索・通知の業務処理は既存実装を使い、テストで欠落が再現した場合だけ所有 adapter を最小修正する。強い Create/Delete 順序、削除 webhook、派生履歴の purge を追加しない。

**Tech Stack:** TypeScript, Vitest, Hono, TypeORM, BullMQ, PostgreSQL, Redis, Meilisearch, WebSocket.

**Spec:** [投稿の最小契約](../../backend-next/posting-contract.md)、[#172](https://github.com/tiramiss-community/tiramiss/issues/172)、[#176](https://github.com/tiramiss-community/tiramiss/issues/176)、[通常更新の全責任監査](../compatibility/note/derived-updates/README.md)。固定本家 `8e07cf085adf7009583d234a208e30436f020e26`。

## Global Constraints

- GOALS → ROADMAP → Issue の順で範囲を判断する。#174 は PR #237 で完了済み。
- #172 の必須依存 #170 / #171 は完了済み。#176 の削除連携部分を本 PR で検証できるが、#176 全体の完了は宣言しない。
- #176 の必須依存 #124 は #163–#165 を残す。queue 管理・保持・残 payload 引継ぎの省略や保留への変更はしない。
- 通常 DELETE は reply 減算 → stream/AP/remote count/検索の開始 → DELETE → 他人削除 audit。後段失敗で前段を rollback 扱いにしない。
- 本家に削除 webhook / 通知削除 callback / TL・Role・antenna・hashtag・featured purge はない。承認済み PG 通知保存は維持する。
- 旧 backend と同期管理ファイルを編集しない。公開 API・Entity・migration の変更は予定しない。

## Approaches

1. **採用:** #172 の残る削除連携を、通常プロセスを使う少数の結合ケースで確定する。既存の各 slice 比較を再利用し、配線全体でしか見つからない失敗を検証できる。
2. #176 全体を完成させる案は採らない。#124 の明示的な未完了依存と、C 群全体・停止再開・未対応台帳照合が残る。
3. #163 の queue 管理 API 等へ先に移る案も着手可能だが、#114 の対応順と、いま揃った削除 producer の最終確認を先に完了する。

これは通常実装判断として選んだ範囲であり、Issue の完了条件を変更する提案ではない。

## Review Focus

- 第三者の削除拒否で Note と派生状態が残り、削除 AP / stream / unindex を開始しない。
- DB DELETE 拒否でも先行 AP / deleted stream / unindex が残り、Note と Poll は残り、他人削除 audit は増えない。
- 成功した削除は Note/Poll の実保存結果と show の不存在へ反映し、キャッシュの歴史値を勝手に消さない。
- 作成時の通知と webhook snapshot は削除で取消・再生成されず、削除 webhook を発行しない。
- 開始済み後続処理の終了待機と非同期 engine 適用を区別し、無期限 sleep や全副作用の強い順序に依存しない。

## Task 1: 削除責任と本家の比較入力を確定する

**Files:** `docs/superpowers/compatibility/note/delete-integration/README.md` と必要最小限の固定 source probe / observations。既存資料はリンクで再利用する。

- [x] 固定 NoteDeleteService と NotificationManager / webhook / 各 producer の既存比較から、開始する仕事・開始しない仕事・DELETE 失敗時の状態を表にする。
- [x] 本家 full server 実行、固定 source method + doubles、新実装の実プロセス結果を混同しない。新 probe が必要なら固定 Git blob / SHA-256 / 再実行コマンドを残す。
- [x] #129 / #174 の責任表を照合し、削除の必須責任に未所有・未接続がないか確認する。必要なら実装タスクへ具体的な欠落を渡す。

## Task 2: 通常プロセスで削除連携を検証する

**Files:** `packages/backend-next/test/processes/note-delete-integration.test.ts`。既存 `test/helpers/process.ts` / database / fake inbox / role seed を再利用する。共通 helper の抽出は重複が明確な部分に限る。

**Interfaces:** `launch('built/entrypoints/http.js', config.path)` と worker entrypoint、実 token の `/api/notes/create` / `show` / `delete`、既存 `/streaming`、PG / Redis / Meili の独立した照会を使う。post-save や delete UseCase の差替えを成功ケースに使わない。

- [x] public な mention / hashtag / poll Note を作成し、show、PG 保存と通知、WebSocket 受信、通常 TL、Meili document、AP Create、note/mention webhook を確認する。必要な Role / antenna 等は既存 fixture を再利用し、削除に無関係な全 routing matrix は繰り返さない。
- [x] 第三者の delete を拒否し、保存状態と既存 snapshot が残り、削除を起点とする新しい AP / stream / Meili task がないことを確認する。非発生は開始・終了済みの仕事や queue / task の観測で判定する。
- [x] 作者または現在 moderator で削除し、204、Note/Poll 不存在、show エラー、deleted WS、通常 AP Delete、Meili task 適用後の document 不存在を確認する。TL ID・既存通知・hashtag / ranking 履歴と既投入 webhook は保持し、削除 webhook を増やさない。
- [x] 独立ケースで DELETE trigger を拒否し、500 / Note・Poll 残存 / audit 不増加と、先行 deleted WS / AP Delete / unindex の結果を同時に確認する。trigger は必ず finally で除去する。
- [x] fake 配送先や SDK submission を gate した終了は既存 slice テストで補完し、通常 HTTP / worker の SIGTERM が成功することを確認する。runtime の欠落があれば失敗する最小ケースを先に残し、所有 adapter だけ修正する。

### 比較で確定した元 Renote 照会の修正

固定本家の `pure-renote-original-query-reject` 観測と独立監査で、元投稿の照会時点の差を確認した。本家は local かつ非 localOnly の純粋 Renote だけ、deleted stream の後に元投稿を読む。修正前の `note-deleter.readNote` の先行照会では、照会失敗時の stream と不要な照会による削除失敗が異なる。これは追加の順序保証ではなく、既存の失敗境界の修正である。

**Additional files:** `src/modules/note/delete-note.ts`、`src/platform/database/note-deleter.ts`、最も近い `test/unit/note/delete-note.test.ts` / `test/integration/note-delete.test.ts`。snapshot の組み立て時には元投稿を照会せず、認可・reply 減算・deleted stream の後の該当 AP 準備だけで照会する。

- [x] 元投稿照会だけの失敗で deleted stream が既に発行され、AP / search / DELETE / audit は始まらず Note が残る回帰を RED で確認する。
- [x] localOnly / remote / 通常 Note / 拒否された削除では元投稿を照会せず、従来の応答と副作用を保つことを確認する。
- [x] 狭い照会 port を適切な時点で呼ぶ最小修正を行い、元投稿ありの Undo / なしの Delete fallback と既存の比較を GREEN で確認する。

## Task 3: 検証・完了判定と記録

- [x] `pnpm --filter backend-next... build` と `pnpm --filter backend-next... typecheck` を実行する。
- [x] 専用 Compose project / port を使い `pnpm --filter backend-next test:process note-delete-integration` を実行する。関連修正があれば最も近い unit / integration を追加で選ぶ。
- [x] 既存 `note-delete` / `note-search-index` / `posting-websocket` / `user-webhook` のケースを新テストで代替したと推測せず、今回依存する振る舞いと既存検証を比較資料へ明示する。
- [x] `node scripts/check-shipping.mjs --base 617bd45d67173b401ed58b2f27fc17b7e608b8c5` を実行し、lint / SPDX / locale の結果を記録する。
- [x] 実際に得た結果を本計画と比較資料へ記録し、#172 の未完了 checkbox と一対一に対応づける。全責任が確認できれば PR は `Closes #172` とし、#176 は `Refs #176` とする。未確認の削除責任が残る場合は、具体的な残件を示して `Refs #172` に留める。
- [x] #176 全体・#124 / #163–#165・#195 の暫定 remote mention 501・全通知 #177・全 WS #189・再構築 #132/#133 を完了扱いしない。Issue の本文編集や直接 close は行わない。

## Execution Record

作業ブランチは `feat/backend-next-posting-238`、worktreeは `.claude/worktrees/next-posting-238`。開始点はdevelop `617bd45d67173b401ed58b2f27fc17b7e608b8c5`（PR #237）。以下は最終コードに対する検証結果。sourceと製品の独立レビューは承認済み。文書を含む全差分レビューとPR作成は未実施。

### 比較範囲と修正

固定本家sourceの17ケースを再生し、独立した再生成とのbyte比較も成功した。source資料の独立再レビューはSpec PASS / Quality APPROVE。これは固定methodとdoubleの証拠であり、本家full serverの実行ではない。新しい実プロセス2ケースがJSONと直接照合するのは、`success` / `db-delete-reject` の6状態（Note・検索documentの存在、通常TL・hashtag・通知・webhookの保持）とdeleted/AP種別のみ。17ケース全体の直接一致を主張しない。

実プロセスの新規3ケースは、通常HTTP/workerから作成→show→通知/WS/AP/webhook/TL/Meili→削除を通す成功・DB拒否の2件と、unindex submissionの保留/503に対するHTTP成功・診断・終了待機の1件。第三者の拒否は前2件の中で確認した。Role TL/antenna/featuredの全routing、remote counter、AP/webhookの保留中終了等は既存sliceの検証を再利用し、新規3件で代替したとは扱わない。

比較で発見した元Renote照会の時点差を業務処理とDB adapterの2ファイルで修正した。snapshot読取時に元投稿を取得せず、認可・reply減算・deleted stream後のlocal/non-localOnlyな純粋RenoteのAP準備だけで`readRenote`する。コピーした配送snapshotを用い、既発行snapshotを書き換えない。既存compositionのspreadが新portを接続するためcomposition変更は不要だった。

### RED / GREEN

runtime変更前に対象unitは19件中2 FAIL、integrationは12件中4 FAIL。元投稿照会失敗時のstream不在と、localOnly/remote/認可拒否に不要な照会が失敗を生むことを確認した。修正後、同じ対象unit19件・integration12件がPASS。REDの根拠は実装担当のtool結果を転記した記録であり、raw console logを保存したものではない。

照会拒否は`Repository.findOneBy`への選択的spyで元投稿だけを拒否し、他のDB操作を実PGへ通した障害注入である。PostgreSQLサーバーのSELECT拒否を注入したとは扱わない。新processのDELETE拒否は実PGのBEFORE DELETE triggerを使う。unitの元投稿照会回帰はsourceと同じ外部境界をassertするが、source JSONの直接比較はしていない。

### 最終検証

専用Compose project `backend-next-delete238`、PG `55484` / Redis `56384` / Meili `57784` を使用。以下のintegration/processコマンドには `BACKEND_NEXT_TEST_DB_PORT=55484 BACKEND_NEXT_TEST_REDIS_PORT=56384 BACKEND_NEXT_TEST_MEILI_PORT=57784` を指定した。

| 検証 | 結果 | 範囲 |
| --- | --- | --- |
| source probe再生・独立再生成との`cmp`・`node --check` | PASS | 17ケース、byte一致。固定source/doubleの証拠 |
| `pnpm --filter backend-next... build` | PASS | 修正後に再buildしprocessへ接続。controllerの最終raw logもPASS |
| `pnpm --filter backend-next... typecheck` | PASS | production/test双方 |
| `pnpm --filter backend-next test` | PASS | 66 files / 2,410 tests |
| `pnpm --filter backend-next test:integration test/integration/note-delete.test.ts test/integration/note-search-index.test.ts test/integration/note-notifications.test.ts test/integration/posting-websocket.test.ts test/integration/user-webhook.test.ts` | PASS | 5 files / 41 tests |
| `pnpm --filter backend-next test:process note-delete` | PASS | 2 files / 5 tests。新規3件と既存Delete/Undo/fallback・relay drain2件 |
| 先行回帰: `pnpm --filter backend-next test:process test/processes/note-delete.test.ts test/processes/user-webhook.test.ts test/processes/posting-websocket.test.ts` | PASS | 3 files / 5 tests。上の既存note-delete2件は重複するため件数を単純加算しない |
| `node scripts/check-shipping.mjs --base 617bd45d67173b401ed58b2f27fc17b7e608b8c5` | PASS | 変更5ファイルのquiet lint、SPDX 3,178ファイル、locale safety |
| API型再生成・Entity/migration検査 | SKIPPED | 公開API・Entity・migration変更なし。設定・依存変更もなし |

PGの`client.query`非推奨警告と、広いintegrationでの注入された`streaming.event.failed`診断は出力に残る。上表の全testはPASSであり、これらの診断を除去したとは主張しない。

### 完了判定と残範囲

#172の未完了だった通知/stream/TL/検索/webhook削除連携に対し、既存通知・TL/集計保持、deleted WS、検索解除、既投入webhook継続とdelete webhook不在を同じ投稿で確認した。既存の認可/DB/AP比較と元Renote照会回帰を合わせ、削除責任の検証は揃った。製品の独立レビューもSpec PASS / Quality APPROVEで指摘なし。#172の完了条件を満たすため、PRは`Closes #172`、`Refs #176`とする。PR自体は未作成。Issue本文変更・直接close/mergeは行わない。

#176の削除に絞った先行連携確認であり、#176全体は未完了。必須依存#124の#163–#165と、C群全体・停止再開・暫定501を含む未対応台帳の照合を残す。全通知#177、全WS#189、閲覧#185/#186、remote受信#195、chart#200、再構築#132/#133も完成扱いしない。

sourceと製品の独立レビューはいずれもSpec PASS / Quality APPROVE。CodeRabbitはstagedの製品5ファイルをreview_completed・0 findingsで終了した。CodeRabbitのローカル結果保存はEROFSで失敗したが、完了したstdoutを保持している。GitHubへレビューは投稿していない。CodeRabbitの対象にsource資料・本計画・ROADMAPは含まれず、それらを含む全差分レビューを代替しない。

- [ ] 文書を含む全差分レビューと最終shipping確認を行い、PRを作成する。
