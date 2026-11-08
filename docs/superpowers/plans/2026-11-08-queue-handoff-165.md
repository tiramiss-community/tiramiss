# Queue Handoff #165 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 固定本家が残した実 BullMQ job の保持・実行互換を検証し、完全停止下で引き継げない残仕事を変更せず検出する。

**Architecture:** 現在の3業務 queue は同じ Redis DB・prefix・BullMQ 形式を保持して引き継ぎ、変換しない。停止確認専用 CLI は raw ioredis の読み取りだけで全10 queue を検査し、active・未対応の仕事・scheduler・不明形式を非0終了で拒否する。本家 producer の実引数と実 BullMQ が作る状態を、新実装の既存 worker・PG・隔離 HTTP 宛先へ接続して検証する。

**Tech Stack:** Node.js、TypeScript、BullMQ 6.3.11、ioredis 5.11.1、Vitest、既存 PostgreSQL/Redis 結合テスト基盤。

**Spec:** [GOALS](../../backend-next/GOALS.md)、[ROADMAP](../../backend-next/ROADMAP.md)、[#165](https://github.com/tiramiss-community/tiramiss/issues/165)、[現在の投稿契約](../../backend-next/posting-contract.md)、[通常保持の比較資料](../compatibility/queue-retention/README.md)。完全停止切替全体は [#139](https://github.com/tiramiss-community/tiramiss/issues/139)。

## Global Constraints

- 基準 worktree は `.claude/worktrees/next-handoff-241`、base は `21bf6e46209bdc8924e3747f2876d2751c6521ae`。
- 固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。入力は `/tmp/tiramiss-relay171-upstream` の作業ファイルではなく固定 Git オブジェクトから読む。
- 現在と固定本家の BullMQ は共に `6.3.11`。依存更新・仮の新形式・PG 台帳・万能 reader/converter を追加しない。
- `packages/backend`、`backend-upstream` の管理ファイル、既存 migration、locale、CHANGELOG は編集しない。新しい業務 handler 7種や通知移行 #177 も追加しない。
- checker は Queue/Worker/QueueEvents、通常アプリの起動、DB 接続、pause/retry/promote/clear/add/scheduler 変更を行わない。通常の Queue constructor 自体にも metadata 書き込みがあるため再利用しない。
- Redis 接続は `redisForJobQueue` の host/port/db/TLS/auth と prefix を使い、ioredis keyPrefix を外す。物理 root は `<prefix>:queue:<name>:<name>`。prefix がない場合の式も固定 source へ照合する。
- 全旧 HTTP/worker/scheduler/補助 producer の完全停止は運用上の前提。`--stopped` は利用者の明示確認であり、分散プロセスの停止証明ではない。
- 専用依存先は PG `55487` / Redis `56387`。自分の Compose project・prefix・検証 DB だけを使い、ユーザー用 `misskey-infra` を操作しない。
- 既存近傍単体の baseline は4 files / 97 tests PASS（controller の実行記録）。今回の追加検証とは区別する。
- 既存の次 PR 実行許可に従い、この計画後は同セッションで実装・検証を続ける。計画作成を新たな許可待ちにしない。

## Review Focus

- glob 文字・別 DB・専用 job Redis・隣接 prefix：指定 namespace のみを検査し、空の queue に metadata も作らない。Task 2 の実 Redis snapshot test で固定する。
- 100件を超える job と孤立した hash/lock/repeat metadata：先頭100件の成功で残りを見落とさず、不明な証拠を拒否する。Task 2 の paging/orphan test で固定する。
- webhook の過去イベント：現在の producer の4型だけで、本家の既存 follow/followed 等を不当に破棄・承認しない。Task 1 の実 payload と Task 2 の実送信で判定する。
- active/結果不明・部分失敗：lock 期限切れを安全な再実行と解釈せず、試行・delay・外部効果を維持する。Task 2 の active/refusal と同 ID retry test で固定する。
- CLI の接続失敗と機密情報：有限時間で非0終了・接続解放し、任意の Redis 値/キー/診断例外を出力しない。Task 2 の実 child と sentinel test で固定する。

---

## File Structure and Ownership

| Task / owner | Files | 責任 |
| --- | --- | --- |
| 1 / source worker | `docs/superpowers/compatibility/queue-handoff/reference-queue-handoff.cjs`、`observations.json`、同 directory の `README.md`、必要なら `generate-bullmq.cjs` | 固定 source 全10 queue の契約台帳、必要な実 payload fixture と実 BullMQ 生成手順 |
| 2 / runtime writer | `packages/backend-next/src/platform/job-queue/handoff.ts`、必要なら同 directory の責任別 helper、`src/entrypoints/check-queue-handoff.ts`、`package.json` | 読み取り専用検査・安全な report・CLI |
| 2 / runtime writer | `test/unit/job-queue/handoff.test.ts`、`test/integration/queue-handoff.test.ts`、`test/processes/queue-handoff.test.ts`、必要な `test/fixtures/queue-handoff*.mjs` | source artifact からの実 Redis 状態生成・実 handler 引継ぎ・CLI の寿命 |
| 3 / fresh docs worker | `packages/backend-next/README.md`、`docs/backend-next/posting-contract.md`、`docs/backend-next/ROADMAP.md` | 利用手順、未対応所有者、#139 backup/rollback と実測範囲 |
| controller | この計画、最終差分/Issue/PR記述 | 判断・検証記録・独立レビューの統合 |

Task 1 と Task 2 は artifact の型を先に共有し並行する。Task 3 は source と runtime の確定した挙動・実測結果を受け取って更新する。共有ファイルへ複数 worker が書かない。

### Task 1: 固定 source の実 payload と残仕事の棚卸し

**Files:** 上の source worker 所有ファイルを作成。`generate-bullmq.cjs` を追加する場合も source worker が所有する。

**Interfaces:**

- Consumes: 固定 SHA と本家 `QueueService`、`QueueModule`、`queue/const`、`queue/types`、poll 投入 block、`NoteDraftService.schedule`、webhook の event/payload 定義。
- Produces: 合意済み JSON root `{ sourceCommit, sources, toolchain, doubles, fixtures, schedulers }`。`sources` は path ごとの blob/hash。`fixtures` は `Array<{ id, producer, queue, method, jobs: Array<{ name, data, opts }> }>`、`schedulers` は `Array<{ id, repeat, template }>`。fixture ID は `deliver-single`、`deliver-bulk`、`poll-future`、`webhook-note`、`webhook-follow`、`webhook-followed` を使う。scheduler の `id/repeat/template` は実 `upsertJobScheduler` の3引数を保持する。
- `.add`/`.addBulk` の引数は source 実行由来とし、実 BullMQ へ投入できる JSON 値を保持する。digest は本家同等の SHA-256 値、clock/UUID は明示的な固定値を使う。

- [x] **Step 1:** 既存 retention probe の source/AST/compiler の狭い方式で新 probe を作り、期待値を通常検証で書き換えない `--check` を設ける。既存 retention JSON は payload を省略するため、新たな実 payload fixture の代用にしない。
- [x] **Step 2:** 全10名、prefix/config、各 producer の payload/name/options、auto ID と明示 jobId、9 system scheduler と古い定義削除の契約を文書化する。既存 retention の24観測/32 producer method の根拠を再利用し、全 payload の2個目の網羅 oracle は作らない。scheduler constructor は double のみで動かす。
- [x] **Step 3:** 新しい実行 fixture は現在3業務 queue の deliver single/bulk、poll、webhook note/follow/followed と、拒否を確かめる代表的な未対応 job/scheduler に絞る。scheduled note・announcement・delayed unfollow は契約台帳で識別し、実拒否 test に必要な代表だけ採取する。webhook 全8 event と実 content 分岐も記録し、producer の未実装と既存 transport の実行可能性を区別する。
- [x] **Step 4:** `node docs/superpowers/compatibility/queue-handoff/reference-queue-handoff.cjs /tmp/tiramiss-relay171-upstream --check` を実行し、固定 SHA・blob/hash・観測が一致することを確認する。期待値を変えた negative control は不一致になり、復元後に PASS することも確認する。
- [x] **Step 5:** README に source double / AST 実行と、Task 2 が扱う実 BullMQ/Redis/worker の証明範囲を分けて残す。実件数は成功した出力から記録する。

### Task 2: 停止下 checker と実旧 job の引継ぎ

**Files:** 上の runtime writer 所有ファイル。巨大な1ファイルにせず raw Redis 列挙・判定・test state 生成を必要に応じて責任別に分ける。

**Interfaces:**

以下は report の安全性を示す暫定 interface。runtime writer は既存 style に合わせて関数引数・type/file 名・test 分割を調整できる。読み取り専用・全10名・有限終了・機密を出さない境界と Task 1 の合意済み artifact schema は維持し、変更した呼出形を controller/source/docs worker へ共有する。

```ts
type HandoffQueueReport = {
  queue: QueueName;
  counts: Record<'waiting' | 'paused' | 'active' | 'delayed' | 'prioritized' | 'waiting-children' | 'completed' | 'failed' | 'repeat', number>;
  blockers: Array<{ code: string; count: number }>;
};
type QueueHandoffReport = { ready: boolean; queues: HandoffQueueReport[]; blockers: Array<{ code: string; count: number }> };
inspectQueueHandoff(options: { redis: RedisConfig; connectTimeoutMs: number }): Promise<QueueHandoffReport>;
```

`QueueName` は既存全10名の公開 union を利用する。report は allowlist 名・数・固定 reason code のみとし、job ID/name・Redis key・scheduler ID・URL・payload・secret・failedReason・任意例外文を含めない。CLI は `--stopped` のみを認め、不足/未知引数は Redis 接続前に非0終了する。正常 report でも blocker があれば非0終了する。

- [x] **Step 1:** unit test を先に作る。全10名の判定、3実 queue の正常 payload、未知/欠落 payload・旧廃止 durable 形式・不明 custom backoff/flow/repeat の拒否、他7 queue の未完了/failed の拒否、completed history 保持を期待する。未実装時に対象 test が失敗することを確認する。
- [x] **Step 2:** raw ioredis 読み取り専用の inventory を実装する。finite connect/command timeout、lazy connect、再接続なし、offline queue なし、finally で解放する。TYPE/SCAN/EXISTS/LLEN/ZCARD/LRANGE/ZRANGE/HMGET 等を用い、全対象を paging する。圧縮 opts・delayed score・repeat metadata は installed 6.3.11 の実保存形式と Task 1 の材料に照らす。
- [x] **Step 3:** active と lock は全 queue で拒否する。waiting-children/repeat/scheduler/孤立した関連 metadata・不明 queue root も拒否し、状態を変えない。glob prefix を escape または正確な startsWith 照合で限定し、既知 metadata を job と誤判定しない。指定 job namespace 外は検査・変更しない。
- [x] **Step 4:** deliver/poll は既存 parser と同じ入力要件を使う。webhook は generic sender が実行する snapshot を検証し、`content` を `{note}` に限定しない。固定 source の follow/followed 等も実送信 test が揃えば保持可能とする。証明できない event/旧形式は変換せず停止前完了/feature owner へ拒否する。既存 producer 型の拡張や新イベント生成は不要。
- [x] **Step 5:** `check-queue-handoff` script と単発 entrypoint を追加する。`loadConfig` 以外の通常起動 composition を呼ばず、安全な JSON report と固定 failure code だけを出す。unit test が PASS するまで必要な範囲だけ直す。
- [x] **Step 6:** 実 Redis に空/正常/拒否ケースを作り、検査前後の値を独立に比較する。空 namespace に新 key が無い、prefix の glob 文字で隣接 namespace を巻き込まない、別 DB/通常 Redis/pubsub に触れない、100件超と orphan/不正 Redis type を見落とさないことを固定する。全7未実装名の拒否と completed-only を test に含める。
- [x] **Step 7:** Task 1 の実引数を使う standalone old-producer child を installed upstream BullMQ 6.3.11 で起動し、挿入後 close/exit を待つ。その同じ job hash/state を checker にかけ、変更なしを確認してから新 worker を起動する。source 引数+実 BullMQ であり、本家 full server 実行とは記述しない。
- [x] **Step 8:** 旧 deliver single/bulk -> 新既存業務 handler -> fake inbox、旧 poll delayed -> 既存 worker -> 実 PG 通知、旧 webhook note と follow/followed snapshot -> 実 HTTP と status 保存を確認する。ID/name/data/opts/eventId/createdAt/digest と遅延時刻を維持し、新規 add や replay で代用しない。
- [x] **Step 9:** 実旧 BullMQ worker の一時失敗が作る delayed/attemptsMade=1 と terminal failed を保存する。停止/check 後に新 worker が同 ID の通常 retry を進め、failed は明示 retry 無しで残ることを確認する。通常 60秒 backoff を1例待つか、隔離 test の timing 制御を明記する。移行手順の promote/消去/再投入で代用しない。
- [x] **Step 10:** 実 system scheduler template と遅延 instance、旧予約投稿等、active/lock を作り、拒否と完全保持を確認する。繰り返し登録がある限り waiting=0 でも成功にしない。placeholder 業務 worker を実装済みとして扱わない。
- [x] **Step 11:** built CLI child で正常/拒否/引数不正/接続失敗/途中切断を確認する。有限時間・非0終了・解放と、普通の文字列フィールドにも埋めた sentinel secret が出ないことを確認する。同じ旧 job を built worker 子で処理して SIGTERM 正常終了する process 証拠を1例含める。
- [x] **Step 12:** 以下の近傍検証を実行し、実際の成功件数/未実行を controller へ渡す。

```sh
pnpm --filter backend-next test test/unit/job-queue/handoff.test.ts
BACKEND_NEXT_TEST_DB_PORT=55487 BACKEND_NEXT_TEST_REDIS_PORT=56387 pnpm --filter backend-next test:integration test/integration/queue-handoff.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
BACKEND_NEXT_TEST_DB_PORT=55487 BACKEND_NEXT_TEST_REDIS_PORT=56387 pnpm --filter backend-next test:process test/processes/queue-handoff.test.ts
```

### Task 3: 現在の判定・#139への引継ぎを文書化

**Files:** fresh docs worker の所有3ファイル。source README は Task 1 owner と連絡し、同時編集しない。

**Interfaces:** Task 1 の固定観測、Task 2 の CLI 入力/report/exit と実測結果を消費し、README の実行例・現在契約・工程を更新する。未成功の予定件数を書かない。

- [x] **Step 1:** 全10名を retain / stop-before-complete / blocked の実形式ごとに整理する。現在3 handler と7管理専用 queue を区別し、system #199/#200、postScheduledNote #183、inbox #195、db #199、relationship #182、objectStorage #188/#199、systemWebhookDeliver #198 を明示する。
- [x] **Step 2:** 正確な設定先 DB/prefix、完全停止と `--stopped`、安全 report、非0理由を README に記す。成功は queue 条件のみで、#135 の未対応なし・#138 配布・#177 通知移行や全機能の完成を意味しないことを説明する。
- [x] **Step 3:** #139 へ、全プロセス停止/active 解決 -> coordinated PG/Redis/必要 storage backup -> restored isolated copy 検査 -> migration/schema 確認 -> 新起動、の順を渡す。不明な外部効果を失敗とみなさず、scheduler 削除・queue clear・無断 retry で条件を満たさない。
- [x] **Step 4:** checker の読み取り後は queue 形式を変えていないことと、消費/migration/通知保存変更後の binary-only rollback は別であることを記す。backup 復元は AP/webhook 成功を取り消せず重複送信を起こし得る。独自 ledger/厳密一度だけ保証を追加しない。
- [x] **Step 5:** source 比較、実依存、process、保持した既存差異を分け、確認した件数/コマンドを記録する。ROADMAP の現在地と投稿契約を更新し、#124/#176/#139 全体を完了にしない。

### Task 4: Controller の統合・独立レビュー・出荷チェック

- [x] **Step 1:** 四つの #165 条件に、全10棚卸し・実形式別判断・checker/rollback引継ぎ・旧payload/遅延/定期/失敗の実検証の根拠が揃うことを確認する。揃えば現在の #165 範囲の完了候補とし、欠ける場合は `Refs #165` にして残作業を明記する。
- [x] **Step 2:** 固定 source の採取/網羅性と、新実装の raw key 解釈/読み取り専用/機密出力/実handler証明を独立にレビューし、実欠陥を修正して近傍だけ再検証する。
- [x] **Step 3:** `node scripts/check-shipping.mjs --base 21bf6e46209bdc8924e3747f2876d2751c6521ae` を実行し、変更対象 quiet lint・`SPDX: OK`・locale safety を確認する。API/schema/Entity変更は無いので旧 backend 型生成・migration検査を代用として実行しない。
- [x] **Step 4:** 実装/検証/未対応とブランチ/worktree/commitを記録し、ユーザーの既存 next PR 許可の範囲でPR本文と送信先を確定する。merge/close の明示許可は推測しない。ユーザー影響があれば CHANGELOG 候補を引継ぎに1行だけ示す。

## Completion Boundary

全形式の棚卸しと保守的な拒否を含めることで #165 の現在の仕事を完了できるが、全10業務 handler の引継ぎ実行や本番切替可能性の証明にはしない。system scheduler が現在残っていれば切替は拒否され、その機能所有者が実装と新しい互換証拠を揃えて checker を更新する。#124/#176 の全体照合、#139 の最終リハーサル、#177 の通知移行は別に残る。

## Execution Record

- 計画作成時: repository/product 変更前。source/runtime の read-only 調査を入力として作成。
- 実行方法: controller が Task 1/2/3 の担当を分け、同セッションで統合する。
- Task 1/2: 固定17 fixture・全10名・9 scheduler・11 source guard、関連単体135件、通常/固定本家の結合31件ずつ、通常process全4件が成功。固定本家の実source/本家側BullMQによる3 handler・7 webhookイベントの実行と通常60秒retryも個別に成功し、単体/結合/CLIの拒否・非更新を確認した。build/typecheck・変更ファイルlint/SPDX/localeも成功。
- 初期実装commit: `738f34c61e550a37e7040aaef0f4e5ec6df56639`。最終レビューの通常失敗metrics判定修正は `7b6be9556a10ef786a7f6afc2665e0221c127036`。sourceとcheckerの独立レビューは指摘修正・再レビュー後に承認済み。文書9ファイルと生成表を更新し、2119契約・1432監査行のID/状態/所有/出典不変と参照の保持を確認した。全差分の独立レビューは、最終指摘の修正・限定再レビュー後に WholeBranch APPROVE / Spec PASS / Quality APPROVE となった。

- 最終承認: source・checkerの個別承認に加え、全21ファイルと最後の修正差分の独立レビューを完了。通常の失敗メトリクス保持の指摘を修正し、実WorkerによるRED→GREEN・通常/固定本家の結合31件を確認した。CodeRabbitの実装11ファイルに対する指摘1件も同修正により解消し、修正2ファイルの限定レビューは指摘0件で完了した。
