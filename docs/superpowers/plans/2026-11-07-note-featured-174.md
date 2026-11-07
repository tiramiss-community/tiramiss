# Renote Featured Producer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #174の残る通常更新から、他人のノートをRenoteした際のfeaturedランキング加点を通常投稿へ接続する。

**Architecture:** 本家の確率・経過時間・対象選定を純粋plannerへ分け、Redisへの加点を狭いadapterへ分ける。既存の作成時snapshotとrenotedNoteIdを使い、DBカウントと独立したpost-save処理として開始し、既存の診断と終了待機へ接続する。

**Tech Stack:** TypeScript、ioredis、Vitest、既存Hono/PostgreSQL。新dependency・Entity・migration・queueは不要。

**Spec:** [GOALS](../../backend-next/GOALS.md)、[ROADMAP](../../backend-next/ROADMAP.md)、[投稿の最小契約](../../backend-next/posting-contract.md)、[#174](https://github.com/tiramiss-community/tiramiss/issues/174)、親[#127](https://github.com/tiramiss-community/tiramiss/issues/127)。具体契約は固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `NoteCreateService.ts:818–820,965–987` と `FeaturedService.ts:13–50,118–138`。

## Global Constraints

- 開始baseはdevelop `ce5217a4be022a7c378f1519f96e639c2d316849`（PR #234マージ済み）。worktreeは `.claude/worktrees/next-posting-235`、branchは `feat/backend-next-posting-derived-174`。
- 「本家機能は原則すべて初期範囲に含む。」本slice完成を #174/#172/#176 全体の完了としない。hashtag・antennaは残る。reaction加点 #184、featured閲覧 #185、gallery #191も別責任。
- 「業務コードへHono Context、TypeORM Entity・EntityManager、BullMQ Job、Packed型、DIコンテナを公開しない。」UseCase間呼び出しを作らない。
- 「HTTP成功は保存とレスポンス生成の成功。AP配送や通知の完了を待たない。」featured失敗も保存済みNoteを失敗扱いにしない。
- 通常Redis `config.redis` を使う。timeline専用・reaction専用Redisへ書かない。新Redis接続や運用設定を増やさない。
- Redis加点はkeyごとの `MULTI → ZINCRBY score=5 → EXPIRE seconds NX → EXEC`。global/channelは3日window・9日TTL、per-userは7日window・21日TTL、epochは `2023-01-01T00:00:00Z`。
- DB count完了待ち、再実行台帳、retry、tombstone、削除時purge、再構築、閲覧APIを追加しない。新規code/probeにはSPDX。locale/CHANGELOGは編集しない。
- 専用Composeは `backend-next-featured235`、DB55481/Redis56381。既存ユーザー用環境を操作しない。

## Review Focus

1. quoteを含む他人Renote・nonbotが対象。既存 `renotedNoteId` gateを再利用し、投稿自体のvisibility/localOnly/channelやsilentによる新しい除外を足さない。
2. sampleはstrict `< 0.3`、対象IDから求めた経過時間はstrict `< 259200000`。未来IDを下限0で除外しない。時刻はpost-save実行時に取る。no Renote/self/botはsampleを消費せず、sample不通過ではage用clock・ID parseを呼ばない。age判定と各keyのwindow計算にはそれぞれの実行時刻を使う。
3. channel対象はreplyだけ除外し、元noteのhost/visibilityによる追加除外をしない。channelなしは元noteがpublic・local・非replyのときglobalとper-userへ各+5。
4. count DB拒否でもrankingを開始する。global/per-userは別MULTIで、global拒否や同期例外でもper-userの開始済み仕事を失わない。
5. 削除後の遅延post-saveは保存時snapshotを使う。本家にない対象の再取得/存在確認や削除時purgeを足さない。部分失敗と開始済み処理を診断・終了待機へ接続し、保持中featuredがある間はpost-saveのclose/idleが完了しないことを直接検証する。

---

### Task 1: featured Renote producerと比較・実依存検証を接続する

**Files:**

- Create: `packages/backend-next/src/modules/note/featured-plan.ts`（純粋な対象選定）、`src/platform/featured-ranking.ts`（Redis加点）、`src/composition/posting-featured.ts`（snapshot・実行時clock・random・ID codecの接続）。
- Modify: `packages/backend-next/src/modules/note/public.ts`、`src/platform/note-post-save.ts`、`src/platform/connect-resources.ts`。
- Test: 新規 `packages/backend-next/test/unit/note/featured.test.ts`、`test/integration/note-featured.test.ts`、`test/processes/note-featured.test.ts`、既存 `test/unit/note/post-save.test.ts`。
- Create: `docs/superpowers/compatibility/note/featured/README.md`、固定source probe、期待値JSON。
- Update: 本計画、`docs/backend-next/ROADMAP.md`、`docs/backend-next/posting-contract.md`、投稿比較README。

**Interfaces:**

- Consumes: `NotePostSaveInput.renotedNoteId`、`createdSnapshot.renote`、`createIdCodec(config.id).createdAtFromId`。対象materialの取得に旧backend・別UseCase・DB再読込を使わない。
- Produces: `planRenoteFeatured(input: NotePostSaveInput, facts: { now: number; sample: number; createdAtMs: number }): FeaturedNoteScore[]`。`FeaturedNoteScore`は `{ kind: 'global'; noteId: string } | { kind: 'user'; noteId: string; userId: string } | { kind: 'channel'; noteId: string; channelId: string }`。scoreは全て5で、任意keyを業務へ公開しない。
- Produces: `createFeaturedRanking(redis, currentTime): { add(score: FeaturedNoteScore): Promise<void> }`。windowは書込実行時に各keyで計算し、Redis結果のコマンド単位失敗を診断へ返す。
- Produces: `createPostingFeatured({ add, currentTime, random, createdAtFromId }): (input: NotePostSaveInput) => Promise<void>` と `createNotePostSaveWork` の独立port `featured?(input: NotePostSaveInput): Promise<void>`。全開始済み加点をsettleしてから失敗を返す。

- [x] **Step 1: 固定sourceの比較資料を保存する。** SHA/blobを記録し、NoteCreateの外側gateとincRenoteCount、FeaturedServiceのwindow/key/MULTIを実行する独立probeを作る。時刻/randomは固定し、sample0/0.299999/0.3/1、3日境界±1ms/未来、quote/self/bot、channel/host/visibility/reply、DB拒否、global失敗でもper-user開始を期待値へ保存する。no Renote/self/botのsample非消費と、sample不通過時のage用clock・ID parseの短絡も記録する。age判定・global書込・per-user書込でclock値を変え、3日/7日のwindow境界を跨いだ各keyの計算を検証する。source抽出比較と本家full server実測を区別する。
- [x] **Step 2: REDを確認する。** `pnpm --filter backend-next test test/unit/note/featured.test.ts test/unit/note/post-save.test.ts`。上記Review Focusのtarget/key/window/TTL/NX・random短絡・clock境界と、count未完了・拒否でfeaturedが先に開始すること、同期例外・非同期拒否でも独立加点を待つことを検証し、未実装による失敗を記録する。featured要求をholdした間はpost-saveのclose/idleが未完了で、release後に完了することを直接確認する。global拒否とper-user holdを組み合わせても、per-user終了までclose/idleが待つことを確認する。
- [x] **Step 3: planner・writer・組立を実装する。** 上記interfaceで対象を選び、globalとper-userは別MULTIを独立して開始する。plannerの3日判定用clockとwriterのwindow用clockはそれぞれ実行時の値を取る。random/timeの純粋入力を製品設定へ追加しない。
- [x] **Step 4: 通常post-saveへ接続する。** counts Promiseの解決を待たずfeaturedを開始する。既存Map/allSettled/診断とdrainへ加える。HTTP側の保存・response・既存後続の準備順を変更しない。snapshot欠落を新たなDB読込や対象変更で補わず、実製品経路が常に必要snapshotを渡すことをテストする。
- [x] **Step 5: 実HTTP handler/PG/RedisでGREENを確認する。** `pnpm --filter backend-next test:integration test/integration/note-featured.test.ts`。randomをテスト内で固定し、認証HTTPの他人Renote/quoteから元IDのglobal/per-user/channel score・正確なkeyとTTLを観測する。normal redisと別timeline redisを設定して接続先を確認する。self/bot/reply/古いIDは加点なし。global WRONGTYPEでもper-user加点・HTTP200・Note/count・安全な診断を確認する。DB triggerによるcount失敗でも加点が始まり、元note削除/遅延snapshotと削除時ranking残留も確認する。
- [x] **Step 6: processと近傍回帰を確認する。** dependency順build/typecheck後、`pnpm --filter backend-next test:process test/processes/note-featured.test.ts`。テスト専用Node preloadでMath.randomを固定し（製品コードのテスト設定は追加しない）、通常HTTP子へRenote→直後SIGTERM→score成立・終了0を観測する。終了前に書込が完了する場合もあるため、このprocess結果だけで保持中処理のdrainを証明したとは扱わず、Step 2のhold/release検証を併記する。既存post-save/create-note/counts/created-eventsの近傍テストを一度実行する。
- [x] **Step 7: 根拠・再構築材料・残範囲を文書化する。** ランキングは確率的な過去加点とwindow時刻から成り、現存Note/renoteCountだけから厳密復元できない。削除で減算/purgeしないことと #132/#133 への材料不足を記録する。実行済み比較範囲・失敗時状態・診断/drainの差異を明示し、未実測をPASSにしない。
- [x] **Step 8: 独立レビュー・出荷検査・実装commit。** `pnpm --filter backend-next... build`、`pnpm --filter backend-next... typecheck`、保存probe再生、`node scripts/check-shipping.mjs --base ce5217a4be022a7c378f1519f96e639c2d316849`、`git diff --check` を実行する。controllerが必須指摘を解消してT1をcommitする。Entity/migrationと旧backend APIに変更がないためschema検査・旧API型生成は対象外。

### Task 2: 対応表と検証metadataを実装commitへ固定する

**Files:** `docs/superpowers/compatibility/backend-inventory/domains.json`、`audit-items.json`、生成contracts、同README、本計画。

**Interfaces:** T1の実在する実装commitと、repo内に保存したsource比較・実依存検証を参照する。

- [x] **Step 1: 対象producer行だけを更新する。** `responsibility:notes-core:13`（Renote時featured加点）と関連する投稿副作用の根拠をT1へ固定する。window書込が実装される `responsibility:notes-core:40`（window方式と2-window平均）と `service:FeaturedService` は `partial` にし、未実装の読取merge・gallery/hashtag等を残範囲として明記する。featured閲覧/Reaction/Gallery/hashtag・antennaの未完了を維持し、監査A/B・担当domain・既存source証拠を変更しない。既存noteに残るRole TL未接続等の古い説明は対象の説明に限り最新実装へ合わせる。
- [x] **Step 2: 生成とmetadata検証。** `node scripts/backend-contract-inventory.mjs --write`、`--check`、`node --test scripts/backend-contract-inventory.test.mjs`、`git diff --check`。controllerが `node scripts/check-shipping.mjs --base ce5217a4be022a7c378f1519f96e639c2d316849` を実行し、最終shippingはPASS。ID集合・2,119契約・1,432監査行・31domainと既存根拠を保持したことを確認する。
- [ ] **Step 3: metadata commitとPR引継ぎ。** controllerがT2を別commitにし、PRは `Refs #174`。#174/#172/#176/#184/#185をcloseしない。#114/#127/#174本文には#230未マージ等の古い記述があり、PR234までマージ済みという実状態を基準にする。

## 選定理由と完了条件

GitHub #114/#127/#174/#185/#186/#131をread-onlyで照合した。#174の必須依存 #170は完了済みで、この直接更新sliceに #162や #132の完了待ちは不要。

featuredは既存snapshotで全材料が揃い、通常Redisだけで閉じる。hashtagは `MiHashtag` の機械同期、atomicなmentionedUserIds/count更新、Metaのhidden/sensitive、1h unique set・10分HLL・featuredHashtagsRankingを併せて実装する必要があり、featured単独より広い。antennaは `MiAntenna` の同期、候補cache/internal events、follow/list/keyword/visibility facts、timeline/publicationが必要でさらに広い。後者を未承認の省略で小さくしない。

完了は本家条件に沿うRenote加点が通常HTTP→post-save→実Redisで動き、境界値・独立失敗・終了待機・source比較が保存され、inventoryが実装commitへ固定されること。T1は実装・独立レビューを完了した。T2の対応表更新・生成・metadata検証も完了し、最終shippingはPASSし、ROADMAP追記の限定再レビュー・metadata commit・PR作成はcontrollerに残る。

## T1 検証結果（2026-11-07）

単体62ファイル2,174件、featured結合11件、既存投稿結合163件、通常HTTP子のprocess1件、依存順build/typecheckが成功。固定本家の実メソッド50観測は再生成一致、新実装の直接JSON比較は39件（ID日時変換はdouble、実codecは結合/processで確認）。変更11ファイルのlint・SPDX・locale・diff検査が成功し、独立T1レビューはSpec PASS / Quality APPROVE。Entity/migration・旧backend API変更がないためschema/旧型生成は対象外。

sourceのdetached処理に対する診断・終了待機、EXEC内command error検出、同期依存例外の独立集約を差異として記録した。新たなretry/永続状態/削除cleanupは追加していない。T1完成を#174/#172/#176全体の完成としない。

## T2 metadata検証結果（2026-11-07）

- PASS: `implementationCommit` を実在するT1実装commit `399987210060b90db0aaac89ed16bfaa69b95768` へ固定し、全implementation/verification参照がそのGit treeに存在することを確認した。
- PASS: `responsibility:notes-core:13`・`responsibility:notes-core:40`・`service:FeaturedService` の3行を `partial` にし、`api:notes/create`・`capability:timeline` の既存根拠へ追加した。検索2行は残範囲noteだけを更新し、計7行に限定した。
- PASS: `node scripts/backend-contract-inventory.mjs --write` / `--check`、`node --test scripts/backend-contract-inventory.test.mjs`（10件）、`git diff --check`。
- PASS: `/tmp/tiramiss-next235-metadata-invariants.py` による開始baseとのsemantic照合で、2,119契約・1,432監査行・31domain、ID集合と順序、全行のsource/name/line/domain/audit/references、既存implementation/verification/differences配列の内容・順序を保持した。statusの新規変更は3行の `not_implemented → partial` のみで、`verified` へ広げていない。
- PASS（controller実行）: 最終shippingで変更11TSのlint・SPDX対象3,156ファイル・locale safetyが成功。
- PASS: 最終レビューで不足を指摘されたROADMAP末尾へ本sliceの実装pin・比較範囲・残範囲・復元限界を追記し、過去sliceの記録を保持した。metadata変更はROADMAPを含む7文書。文書のみの修正後に `git diff --check` を実行した。
- SKIPPED（controllerへ引継ぎ）: ROADMAP追記の限定再レビュー、metadata commit、PR作成。T2はJSON/Markdownのみでruntimeを編集せず、T1の製品test/buildを再実行していない。
