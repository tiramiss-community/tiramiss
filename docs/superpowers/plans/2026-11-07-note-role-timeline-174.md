# Role Timeline Producer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #174の残る通常更新から、投稿後のRole timelineへのRedis投入とpublicationを通常起動へ接続する。

**Architecture:** 固定本家の `RoleService.addNoteToRoleTimeline` を、Role公開評価契約、取得adapter、既存timeline cache、publicationに分ける。既存の投稿イベント準備で描画したpacked noteを使い、開始した処理は既存post-saveの終了待機と診断へ接続する。Role timelineの閲覧APIとWebSocket channelは追加しない。

**Tech Stack:** TypeScript、Hono、TypeORM、PostgreSQL、ioredis、Vitest。新しいdependency、Entity、migration、queueは不要。

**Spec:** [GOALS](../../backend-next/GOALS.md)、[ROADMAP](../../backend-next/ROADMAP.md)、[投稿の最小契約](../../backend-next/posting-contract.md)、[#174](https://github.com/tiramiss-community/tiramiss/issues/174)。固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の `NoteCreateService.ts:836–846`、`RoleService.ts:335–353,652–663`、`GlobalEventService.ts:420–421`、`FanoutTimelineService.ts` が今回の具体契約。調査メモ `/tmp/tiramiss-next234-source.md` は補助資料であり、実装時に固定source/probe/観測をrepo内へ保存する。

## Global Constraints

- 開始baseはdevelop `7d606dec1f95c110b90203a9ea05d1a71744e00c`。作業worktreeは `.claude/worktrees/next-posting-234`。元worktreeの `.claude/settings.json` は触らない。
- 「本家機能は原則すべて初期範囲に含む。」今回のslice完成を #174/#172/#176/#181/#189 全体の完了としない。
- 「HTTP成功は保存とレスポンス生成の成功。AP配送や通知の完了を待たない。」Role更新失敗も保存済みNoteを失敗扱いにしない。
- 「通常終了では開始済み処理を既存の終了期限まで待つ。」新規のretry、永続台帳、tombstone、削除時purgeを追加しない。
- 「業務コードへHTTP/ORM/queue/DI型を渡さない。」Role公開契約経由で評価し、UseCase間呼び出しを作らない。
- 本家の取得順、期限切れ条件 `expiresAt > now`、assigned＋conditionalの順序と重複を維持する。roleの公開/探索可否、noteのvisibility/channel、MetaのenableFanoutTimelineによるproducerフィルターを追加しない。
- Redis keyは `list:roleTimeline:<roleId>`、maxlenは `1000`。既存の3分境界、古いID、10%trimのcache契約を再利用する。
- publicationは既存pubsub接続のinstance hostチャンネルへ `{ channel: "roleTimelineStream:<roleId>", message: { type: "note", body: packed } }`。timeline専用Redisへの投入と混同しない。
- 新規code/probeにはSPDX。locale YAML/CHANGELOGは変更しない。旧backendのcode/buildへ依存しない。

## Review Focus

1. follower向け・specified投稿や非公開Roleでもproducerは書く。閲覧者への公開制限は #185/#189 のconsumerが所有する。
2. 同じconditional Roleへの手動割当は同じIDを二度返し、二度投入/publicationする。Setで潰さない。
3. packed描画失敗はRole開始を止める。開始後のRole取得/Redis/publication失敗は、後続webhook/mention/AP/searchの準備を止めない。
4. enableFanoutTimeline=false、channel投稿、保存直後の削除でもRole経路の開始条件を変えない。削除後の遅延投入とcached ID残留は本家相当。
5. Redisの部分コマンド失敗・pubsub失敗・終了中の処理を診断/終了待機へ接続し、開始済みPromiseを解放後まで残さない。

---

### Task 1: Role timelineの保存後producerとpublicationを接続する

**Files:**
- Create: `packages/backend-next/src/platform/database/role-timelines.ts`（RoleMaterialReaderとUser取得を既存公開評価へ渡すadapter）
- Create: `packages/backend-next/src/composition/posting-role-timelines.ts`（Role ID取得、cache batchとpublicationの組み立て）
- Modify: `packages/backend-next/src/modules/note/created-events.ts`（描画成功直後の独立した開始port）
- Modify: `packages/backend-next/src/composition/posting-notifications.ts`、`src/platform/connect-resources.ts`（portと既存資源の接続）
- Modify: `packages/backend-next/src/platform/posting-stream.ts`（role publication envelope）
- Test: `packages/backend-next/test/unit/note/created-events.test.ts`、新規 `test/unit/note/role-timelines.test.ts`、`test/integration/note-role-timelines.test.ts`、`test/processes/note-role-timelines.test.ts`
- Create: `docs/superpowers/compatibility/note/role-timeline/README.md`、`reference-role-timeline.mjs`、固定source期待値JSON
- Update: 本計画、`docs/backend-next/ROADMAP.md`、`docs/backend-next/posting-contract.md`（実装範囲・制約・再構築引継ぎ）

**Interfaces:**
- Consumes: `RoleMaterialReader.readRoles/readAssignments`、`selectApplicableRoles`、`createTimelineCache(...).begin(noteId)`、既存 `Record<string, unknown>` packed noteとpost-save snapshot。
- Produces: `createRoleTimelineReader(manager, roleMaterials, createdAtFromId).roleIds(userId: string, now: number): Promise<string[]>`。UserRoleFactsは既存modelの全条件を供給する。
- Produces: `createPostingRoleTimelines({ readRoleIds, cache, publish, currentTime }): (noteId: string, userId: string, note: Record<string, unknown>) => Promise<void>`。`readRoleIds(userId, now): Promise<string[]>`、`publish(roleId, note): Promise<void>`。Role定義/ORMをnote業務へ渡さない。
- Produces: `created-events` の任意port `roleTimelines?(noteId: string, userId: string, note: Record<string, unknown>): Promise<void>` と `postingStream.role(roleId: string, note: Record<string, unknown>): Promise<void>`。

- [x] **Step 1: 固定sourceの独立した比較資料を保存する。**
  Git SHA/blobとメソッド抽出probeを記録し、getUserRoles→roleごとpush/publication→pipeline.execの順序・重複・非同期失敗境界を固定期待値にする。NoteCreateServiceのpacked描画直後の開始とsilentの条件も比較する。full server実行とsource method実行を区別する。
- [x] **Step 2: REDを確認する。**
  `pnpm --filter backend-next test test/unit/note/role-timelines.test.ts test/unit/note/created-events.test.ts`。未実装による失敗を記録する。単体は空Role、期限ちょうど、期限後、conditional、手動＋conditional重複、roleごとのmax1000/envelope、pack失敗時開始なし、Role失敗時webhook/AP/index継続を検証する。
- [x] **Step 3: Role取得adapterとproducerを実装する。**
  上記interfaceで既存Role材料cacheと評価を使い、User条件を明示時刻で評価する。役割選択後は各roleのcache pushとpubsubを本家順に開始し、開始した直接更新/publicationを全て待ち、Redis部分失敗を診断へ返す。空roleでも本家のbatch境界を確認する。取得失敗を空role成功に置き換えない。
- [x] **Step 4: 通常投稿イベントと資源へ接続する。**
  `created-events` の `ports.stream.notes(packed)` 開始直後、webhookの前にrole portをstartする。HTTP応答や他の後続処理は待たせない。既存timeline専用Redisとpubsub接続を使用し、cleanupの資源順序を維持する。新規silent入力/WS channelを作らない。
- [x] **Step 5: 実HTTP handler/PG/RedisのGREENを確認する。**
  `pnpm --filter backend-next test:integration test/integration/note-role-timelines.test.ts`。専用db/prefixのtimeline Redisとpubsub subscriberでHTTP投稿→Role ID順cache/publicationを観測する。visibility4種・channel・fanout無効・非公開/非探索Roleを含め、期限切れ・conditional条件・重複を実DBで確認する。既存cache無効化を通じたRole更新が次投稿へ反映されることを確認する。保存直後削除と遅延post-saveでもsnapshotから投入し、削除時にpurgeしない。WRONGTYPEでも他roleの投入/publicationとHTTP成功を残し、安全な失敗ログを確認する。
- [x] **Step 6: 終了待機と回帰を確認する。**
  dependency順build/typecheck後、`pnpm --filter backend-next test:process test/processes/note-role-timelines.test.ts`。実HTTP子の投稿直後SIGTERMで既存post-saveが投入/publicationまでdrainし、終了code0と資源解放を確認する。単体でpubsub拒否と開始済み古いID直接処理の待機を確認する。既存timeline-cache、post-save、created-eventsの近傍テストを一度実行する。
- [x] **Step 7: 比較と再構築材料を永続文書へ整理する。**
  実行したprobe/期待値と新実装のテストの対応、source比較と実依存の証拠、detached失敗を安全なログ/drainへ接続する差異を記録する。再構築はNote＋User＋現時点Role/assignmentでは過去の所属/条件一致を再現できず、publicationは再構築で再送しないことを #132/#133 へ引き継ぐ。未実装のhashtag/antenna/featured、Role閲覧/API/WSは残す。
- [ ] **Step 8: 出荷検査・独立レビュー・実装commit。**
  `pnpm --filter backend-next... build`、`pnpm --filter backend-next... typecheck`、固定probe再生、`node scripts/check-shipping.mjs --base 7d606dec1f95c110b90203a9ea05d1a71744e00c`、`git diff --check` を実行する。独立レビューの必須指摘を修正し、controllerがTask1のみをcommitする。Entity/migration変更がないためschema検査と旧backend API型生成は対象外。

### Task 2: 実装commitへ対応表と検証metadataを固定する

**Files:** `docs/superpowers/compatibility/backend-inventory/domains.json`、`audit-items.json`、生成 `contracts.json`/`contracts.md`、同README、本計画。

**Interfaces:** Task1の実在する実装commit、repo内の比較資料と検証ファイルを参照する。T1完了前に新規ファイルを指すimplementationCommitを作らない。

- [ ] **Step 1: 対応するproducer行の根拠だけを更新する。**
  `implementationCommit`をTask1 commitへ進め、Role timeline投稿更新/publicationの根拠を追加する。監査判定・担当domain・既存source証拠を維持し、Role API/WS/閲覧や#174全体の状態を完了へ変えない。
- [ ] **Step 2: 生成と検証を行う。**
  `node scripts/backend-contract-inventory.mjs --write`、`node scripts/backend-contract-inventory.mjs --check`、`node --test scripts/backend-contract-inventory.test.mjs`、`node scripts/check-shipping.mjs --base 7d606dec1f95c110b90203a9ea05d1a71744e00c`、`git diff --check` を実行し、生成差分が対象行とpinに限定されることを確認する。
- [ ] **Step 3: metadata commitとPR引継ぎを行う。**
  controllerがTask2を別commitにし、PRは `Refs #174` とする。#174/#172/#176/#181/#189をcloseしない。#114/#127/#174のlive本文は#230未マージと記載した古い状態なので、ユーザーから認められた範囲で進捗更新する場合も本sliceと既存マージ済み成果を区別する。

## 実装・検証結果

T1製品・比較資料・検証は実装済み、独立coreレビューAPPROVE（P1/P2なし）。T1 commitとT2 metadataはcontrollerが順に行う。開始baseは上記のまま、実装commitはまだない。

- RED: created-events 26件中3失敗（Role開始/非同期失敗/終了待機未接続）。新producer import不在も確認。同期例外drain追加は6件中1失敗→6件成功。
- PASS: focused producer/created-events 2 files / 48件、近傍Role条件・timeline-cache/plan・post-saveを含め6 files / 112件。controllerの全unit 61 files / 2119件。
- PASS: 実HTTP handler/PG/専用timeline Redis/host subscriber 11件、通常HTTP子の投稿直後SIGTERM→Role cache/publication→exit0 1件。専用Compose `backend-next-role234`（PG55480/Redis56380）以外は変更しない。
- PASS: `pnpm --filter backend-next... build` と `typecheck`。固定source229件のportable probe再実行と保存JSONのcmp一致。これは本家full server/実PG/Redis比較ではなく、新実装との直接fixture比較はmembership16件。
- PASS: 出荷検査は変更TS12件のlint、SPDX、locale safetyと `git diff --check`。controllerのcommit前確認へ引き継ぐ。
- 実装判断: `selectApplicableRoles`内部のassigned選択を狭い公開helper `selectAssignedRoles`として共用し、manual-only定義で不要なUser取得を避けた。条件評価/expiryをadapterへ複製しない。既存契約の変更・新consumer/API/schema/dependencyはない。
- 差異: 既存#119材料cache/現在User factsを維持する。本家の5分User cacheとnotesCount競合はsource原メソッドで記録し、加算完了→Role評価の順序を追加しない。sourceのdetached workは既存診断と終了待機へ接続する。
- 制約: role maxlen1000は最近IDの10%trim時に適用し、古い直接更新はtrimしない。常時hard capとは扱わない。削除purge/backfillはなく、#132/#133へ履歴材料の不足とpublicationを再送しないことを記録。
- 残範囲: antenna/hashtag/featured等#174、Role閲覧API #181/#185、Role WS #189、#172/#176の最終連携、T2対応表pin/生成とPR送信。Entity/migration変更と旧backend API変更がないためschema検査/旧API型生成はSKIPPED。

詳細なケース対応と再実行手順は[Role producer比較資料](../compatibility/note/role-timeline/README.md)。
