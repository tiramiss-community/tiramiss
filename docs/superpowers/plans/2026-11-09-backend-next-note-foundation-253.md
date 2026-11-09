# [tiramiss-community/tiramiss] Note/Poll 共通基盤適用 Implementation Plan

> **For agentic workers:** 実装時は `superpowers:executing-plans` または、許可済みの Ultracode 実行方法で、以下の2タスクを進める。チェックボックスで実行結果を記録する。本書の返却時点では実装・子エージェント起動・commit・外部送信を行わない。

**Goal:** Note/Poll の既存保存契約を維持し、Note 固有の lifetime 管理を共通 runner に集約して、実 HTTP が利用する作成専用 factory を設ける。

**Architecture:** UseCase が保存範囲を選ぶ現在の構造を維持する。Note adapter は共通 runner の lifetime を使って書き込み能力を束縛し、`createNoteApplication` が作成に必要な adapter と UseCase を組み立てる。接続と保存後処理の所有・停止順は既存 runtime に残す。

**Tech Stack:** TypeScript、Hono、TypeORM 1.1.1、PostgreSQL、既存 Redis/BullMQ、Vitest。依存追加なし。

**Spec:** [承認済み #251 設計](../specs/2026-11-09-backend-next-application-foundation-design.md)、[Issue #253](https://github.com/tiramiss-community/tiramiss/issues/253)、[投稿契約](../../backend-next/posting-contract.md)。

## Global Constraints

- 基準は #252 取り込み後の develop `2f6d4614f939e672e0ad061d8ef6a50771b92900`。作業ブランチは `refactor/backend-note-foundation-253`。
- 本作業はユーザー承認済みの #251 段階2。設計の再承認を実装開始条件に追加しない。
- 投票なしは単独 insert、投票付きは Note/Poll を同一 transaction で確定する。
- リモート解決・描画・保存後処理を Note/Poll transaction に含めない。
- 描画失敗時も既存の後続を開始する。認可・入力エラー・副作用の開始順を変更しない。
- 終了後の新たな能力利用は DB アクセス前に拒否する。開始済み Promise の取消・自動回収・自動再試行は追加しない。
- COMMIT 結果不明を rollback 成功に読み替えない。
- 業務へ Hono/ORM/DI 型を渡さず、UseCase 間呼び出しを作らない。
- factory は接続済みリソースを借用する。initialize/destroy、subscriber、timer、cleanup を所有しない。
- schema、migration、公開 HTTP 契約、比較期待 JSON、locale、CHANGELOG を変更しない。
- 通知・remote user・system account の transaction と mokuroku は既存担当へ残す。

## Review Focus

| 条件 | 守る結果 | 検証担当 |
| --- | --- | --- |
| callback 成功・例外後に Note/Poll 能力を持ち出す | 両操作とも repository 取得前に拒否し、元例外を維持 | Task 1 adapter unit、Task 2 実 DB |
| Poll の保存途中・確定直前で失敗する | 別接続に片方だけ見せず、失敗後は両行とも残さない | Task 2 factory integration、既存 Poll 障害テスト |
| 保存後の HTTP 応答描画が失敗する | 保存済み ID をログに残して500を返し、後続を1回開始 | Task 2 unit・HTTP integration |
| factory 構築後に post-save の開始口が差し替わる | 呼び出し時の `resources.notePostSave.start` を使う | Task 2 HTTP integration |
| 受理済み Poll 投稿中に切断・SIGTERM が起きる | Note/Poll と count 更新を完了して終了する | Task 2 process |

## 現状と境界の決定

共通 runner は、bind と awaited callback を同じ `try/finally` に含め、ORM callback 終了時に lifetime を失効させている。共通 runner の製品コード変更は不要である。[transaction-runner.ts:12](../../../packages/backend-next/src/platform/database/transaction-runner.ts)

Note adapter は現在、その外側に第二の `run` と `active/finally` を持つ。両 insert は既に repository 利用前の guard を備えている。[note-writer.ts:86](../../../packages/backend-next/src/platform/database/note-writer.ts)

保存範囲は UseCase 内で確定している。投票なしは root writes、投票ありは Note→Poll を await する transaction。remote 解決は保存前、render は保存後、`afterSaved` は render の `finally` にある。この業務コードを移動・変更しない。[create-note.ts:332](../../../packages/backend-next/src/modules/note/create-note.ts)、[create-note.ts:351](../../../packages/backend-next/src/modules/note/create-note.ts)

factory は作成専用の `{ createNote }` とする。show/delete、reader、削除 renderer まで移す案は、作成保存の依存整理に不要な変更と回帰範囲を増やすため採用しない。

HTTP の応答取得は既存の `readNotePlan → readMaterials → renderNote` を維持する。`showNote` への置換は UseCase 間呼び出しと独自の閲覧判定を持ち込む。[note-routes.ts:49](../../../packages/backend-next/src/composition/note-routes.ts)

実経路は `processes/http → composition/http-app → prepareNoteRoutes`。Note 準備が Role 構築より先という順序を維持する。[http-app.ts:12](../../../packages/backend-next/src/composition/http-app.ts)

## ファイル配置と所有

パッケージ内のパスは `packages/backend-next/` 相対。

| ファイル | 操作・責任 | 担当 |
| --- | --- | --- |
| `src/platform/database/note-writer.ts` | Note の局所 lifetime を撤去 | Task 1 |
| `test/unit/note/note-write-transactions.test.ts` | 新規。実 adapter の manager 束縛・失効 | Task 1 |
| `test/integration/transaction-runner.test.ts` | 実 DB の bind 例外を補足 | Task 1 |
| `src/composition/note.ts` | 新規。作成専用 factory | Task 2 |
| `src/composition/note-routes.ts` | inline 作成 assembly を factory 呼び出しへ置換 | Task 2 |
| `test/integration/note-application.test.ts` | 新規。factory の実 DB 契約 | Task 2 |
| `test/integration/note-create.test.ts` | rollback 後失効、HTTP 描画障害、開始口の接続 | Task 2 |
| `test/unit/note/create-note.test.ts` | Poll を含む描画待機・失敗の観測を補足 | Task 2 |
| `test/processes/note-create.test.ts` | 既存 fixture を Poll へ拡張 | Task 2 |
| `docs/backend-next/application-foundation-inventory.md` | 段階2の経路・実測・残責任 | Task 2 |
| `docs/backend-next/ROADMAP.md` | 段階2の限定進捗と計画参照 | Task 2 |

製品変更は3ファイルに限定する。既存 unit/composition テストは原則そのまま実行する。

## 担当・gate 調整

- #253 が所有するのは Note 保存 adapter と作成 composition。
- #178 が所有する `http/note*-api.ts`、`authenticate.ts`、共通 gate/error、認可順は変更しない。既存の credential bridge も維持する。[note-create-api.ts:43](../../../packages/backend-next/src/http/note-create-api.ts)
- 調査時の `api-gate-178` は clean。`55d8d9f276` は基準 HEAD の祖先で、基準からの three-dot diff は空。過去の作業ブランチを未取り込み差分として扱わない。
- 実装開始時に worktree と関連差分を読み直す。進行中 gate 作業と `note-routes.ts` が重なる場合は同時編集を避け、既存差分を取り込んでから接続する。#178/#176 全体の完了を待つ条件は追加しない。
- 以下は Task 1→Task 2 の順に統合する。将来 writable workers を使う場合、編集ファイルは上表で分離し、Task 2 の factory は Task 1 の公開署名をそのまま利用する。DB/Redis の環境と最終 shipping・台帳は統合担当が所有する。

---

## Task 1: Note write adapter を共通 lifetime へ移行する

**Interfaces — Consumes**

```ts
createTransactionRunner<Scope>(
  source: DataSource,
  bind: (manager: EntityManager, lifetime: TransactionLifetime) => Scope,
): TransactionRunner<Scope>;
```

**Interfaces — Produces**

```ts
createNoteWriteTransactions(source: DataSource): TransactionRunner<NoteWrites>;
```

既存の `NoteWrites` を維持する。

```ts
interface NoteWrites {
  insertNote(note: NewNote): Promise<Record<string, unknown> | void>;
  insertPoll(poll: NewPoll): Promise<void>;
}
```

### 手順

- [x] **1. adapter unit を追加する。**

`test/unit/note/note-write-transactions.test.ts` に以下を追加する。

| テスト名 | 必須 assertion |
| --- | --- |
| `binds Note and Poll writes to the transaction manager` | root/transaction manager を別の fake にする。両 insert は transaction manager だけを使う。Note の raw snapshot と Poll の期限変換を維持する |
| `rejects escaped $operation before repository access after $outcome` | success/callback rejection × `insertNote`/`insertPoll`。終了後は ended を示す例外で reject。終了後の `getRepository`/insert 呼び出し0回 |
| `ordinary Note writes remain usable without opening a transaction` | `createNoteWriter(...).writes.insertNote` が root manager で成功。transaction 開始0回 |

失効テストでは callback の sentinel error を `rejects.toBe(failure)` で照合する。メッセージの完全一致は仕様にせず、DB 利用前の拒否という振る舞いを検証する。

- [x] **2. 移行前の characterization を確認する。**

```bash
pnpm --filter backend-next test \
  test/unit/note/note-write-transactions.test.ts
```

期待結果：既存の振る舞いを維持する refactor のため PASS。メッセージ差だけの人工的な RED を作らず、既存契約の検証を移行前後で実行する。新 factory は Task 2 で実際の未実装入口を RED として確認する。

- [x] **3. adapter を置換する。**

`src/platform/database/note-writer.ts` の `createNoteWriteTransactions` を次に置換する。

```ts
export function createNoteWriteTransactions(
  source: DataSource,
): TransactionRunner<NoteWrites> {
  return createTransactionRunner<NoteWrites>(
    source,
    (manager, { assertActive }) => createNoteWrites(manager, assertActive),
  );
}
```

`createNoteWrites` は private のまま、通常書き込み用の no-op guard と既存マッピングを維持する。局所 `active/finally` と第二の `run` を削除する。

- [x] **4. 実 DB の bind 例外ケースを追加する。**

`test/integration/transaction-runner.test.ts` に `expires lifetime and preserves a synchronous bind failure on a real source` を追加する。

bind 内で lifetime を捕捉して sentinel error を throw。次を確認する。

```ts
await expect(pending).rejects.toBe(failure);
expect(work).not.toHaveBeenCalled();
expect(() => capturedLifetime.assertActive())
  .toThrow('The transaction has ended');
```

続く別 transaction が成功することも確認する。これは共通 runner の実 DB 補足であり、既存実装でも PASS する回帰検証として記録する。Note binder に障害注入のためだけの公開 seam は追加しない。

- [x] **5. GREEN と既存 runner 回帰を確認する。**

```bash
pnpm --filter backend-next test \
  test/unit/note/note-write-transactions.test.ts \
  test/unit/transaction-runner.test.ts \
  test/unit/note/create-note.test.ts

pnpm --filter backend-next test:integration \
  test/integration/transaction-runner.test.ts
```

期待結果：すべて PASS。既存 runner unit の await 中有効・COMMIT 前失効・bind/callback/source 例外・並行 lifetime・開始失敗を再利用する。[transaction-runner.test.ts:54](../../../packages/backend-next/test/unit/transaction-runner.test.ts)

**成果物:** Note 固有 lifetime owner 1→0、runner 階層2→1。共通 runner の製品差分なし。

---

## Task 2: 作成専用 factory を HTTP へ接続し、契約・実測・台帳を完成する

**Interfaces — Consumes**

Task 1 の `createNoteWriteTransactions(source)` と、既存 `createNoteWriter`、`createCreateNote`。

**Interfaces — Produces**

`src/composition/note.ts` に次を公開する。型は既存の公開契約から import する。

```ts
export interface NoteApplicationDependencies {
  dataSource: DataSource;
  roleMaterials: RoleMaterialReader;
  ids: {
    newId(atMs: number): string;
    createdAtFromId(id: string): number;
  };
  clock(): number;
  remoteUsers: RemoteUserPorts;
  limit(userId: string, factor: number): Promise<void>;
  afterSaved(input: NotePostSaveInput): void;
}

export type NoteApplication = ReturnType<typeof createCreateNote>;

export function createNoteApplication(
  parts: NoteApplicationDependencies,
): NoteApplication;
```

返す操作は次の既存署名だけとする。

```ts
createNote<T>(
  actor: NoteCreateActor | null,
  input: unknown,
  now: number,
  render: (noteId: string, viewerId: string) => Promise<T>,
): Promise<T>;
```

### 手順

- [x] **1. factory integration を書く。**

`test/integration/note-application.test.ts` は既存 `role-application.test.ts` と同様に専用 DB・独立 observer 接続を所有する。Meta とローカル作者を seed し、Role reader、remote ports、limit、ID、時計、afterSaved を明示的に渡す。

| テスト名 | 必須 assertion |
| --- | --- |
| `constructs only createNote without owning resource lifecycle` | keys は `['createNote']`。構築時 initialize/destroy/transaction 0回 |
| `creates a Note directly using injected dependencies` | transaction 0回、Note 1行、Poll 0行、注入 ID を使用。limit の作者/factor、期限判定用 clock、afterSaved の payload を確認 |
| `commits a Note and Poll together` | ローカル投稿で transaction 1回。callback の両 insert 後、確定前に barrier で保持。observer は両行なし。解放後は両行あり、render は確定後 |
| `rolls both rows back when work rejects after both inserts` | 実 transaction 内で両 insert 後に sentinel error。例外同一性、両行なし、render/afterSaved 0回 |
| `starts successors after rendering settles for poll=$poll` | Poll なし/あり。render を保留中は afterSaved 0回。render の resolve/reject 後に1回。reject は元例外を維持 |

transaction の barrier/例外はテスト側で `source.transaction` の実呼び出しを包み、元の実装へ委譲して注入する。偽 transaction で atomicity を証明しない。barrier は `finally` で必ず解放する。

- [x] **2. factory 不在による RED を確認する。**

```bash
pnpm --filter backend-next test:integration \
  test/integration/note-application.test.ts
```

期待結果：`src/composition/note.js` が存在しないため FAIL。factory 追加後は実 DB へ到達して GREEN を確認する必要がある。

- [x] **3. factory を実装する。**

factory は次だけを組み立てる。

1. `createNoteWriter(parts.dataSource.manager, parts.roleMaterials, parts.ids.createdAtFromId)`
2. `createNoteWriteTransactions(parts.dataSource)`
3. `createCreateNote`：writer の能力、上記 transactions、`matchesWords`、明示注入した残りの能力

`clock` は既存の `currentTime` へ渡す。request の `now` は `createNote` 引数として維持する。

Redis、logger、全 `RuntimeResources`、全 `RuntimeConfig`、cleanup は factory の引数に追加しない。rate limiter と remote ports の具体生成は routes 側のままにする。

- [x] **4. 既存 HTTP の inline 作成 assembly を置換する。**

`src/composition/note-routes.ts` で `createNoteApplication` を呼ぶ。reader/show/delete と応答取得は現在位置に残す。

保存後開始口は次を維持する。

```ts
afterSaved: input => resources.notePostSave.start(input)
```

`afterSaved: resources.notePostSave.start` へ変更しない。構築後の差し替えを呼び出し時に反映する既存の接続を保つ。

`prepareNoteRoutes` が返す既存の `create` に factory 結果を入れれば、登録側の `create.createNote` を維持できる。HTTP adapter の generic render callback と保存済み ID の記録位置を変えない。[note-create-api.ts:63](../../../packages/backend-next/src/http/note-create-api.ts)

- [x] **5. 既存 Note integration を拡張する。**

`test/integration/note-create.test.ts` に以下を追加・拡張する。

| ケース | assertion |
| --- | --- |
| 既存 escaped writes を commit/rollback へ parameterize | 両 insert を拒否。元 callback error の同一性、Note/Poll 件数不変 |
| HTTP 応答資料取得の一度だけの障害 | canonical root からローカル Poll 投稿。500、確定済み Note/Poll、ログの `savedNoteId`、afterSaved 1回、idle 後の作者 count +1 |
| 構築後に post-save start を差し替える | 差し替えた spy が1回呼ばれ、元 start へ委譲して実後続も完了する |

描画障害は、関連入力のない投稿で root manager の `MiNote` repository の `findBy` を一度だけ reject させ、作成応答の `readNotePlan` に限定する。失敗後の読み取りは元実装へ戻す。logger は既存 fixture の出力を収集する。各ケース前に既存後続を idle まで待ち、件数差分を分離する。

既存の Poll trigger 障害ケースは再利用する。同等の trigger テストを factory suite に複製しない。[note-create.test.ts:261](../../../packages/backend-next/test/integration/note-create.test.ts)

- [x] **6. 描画境界と停止境界の既存テストを補足する。**

`test/unit/note/create-note.test.ts` の render 失敗ケースを Poll なし/ありへ拡張し、保留中の afterSaved 0回、settlement 後1回を確認する。既存の direct insert、Poll 保存順、Poll 失敗時の render/afterSaved 未開始は維持する。

`test/processes/note-create.test.ts` は現在の connected/disconnected 2ケースを、さらに Poll なし/ありで parameterize する。各ケースで次を確認する。

- Note が1件、Poll は対応する0件または1件。
- 作者 count は1回だけ増加。
- HTTP 接続ありは200、切断済みは既存の切断結果。
- SIGTERM 後に終了コード0、post-save failure なし。

既存の INSERT lock・実子プロセス fixture を使い、新しい停止 harness を作らない。[note-create.test.ts:29](../../../packages/backend-next/test/processes/note-create.test.ts)

- [x] **7. GREEN と近傍回帰を実行する。**

repo root で実行する。専用インフラのポートは使用状況を確認し、空いていれば以下を使う。衝突時は3ポートを変更し、Compose と全テストへ同じ値を渡す。

```bash
export BACKEND_NEXT_TEST_DB_PORT=55442
export BACKEND_NEXT_TEST_REDIS_PORT=56389
export BACKEND_NEXT_TEST_MEILI_PORT=57753

docker compose -p backend-note-foundation-253 \
  -f packages/backend-next/compose.test.yml up -d --wait postgres redis

pnpm --filter backend-upstream sync:check
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
```

```bash
pnpm --filter backend-next test \
  test/unit/transaction-runner.test.ts \
  test/unit/note/note-write-transactions.test.ts \
  test/unit/note/create-note.test.ts \
  test/unit/note/create-api.test.ts \
  test/unit/note/post-save.test.ts \
  test/unit/composition/http-app.test.ts

pnpm --filter backend-next test:integration \
  test/integration/transaction-runner.test.ts \
  test/integration/note-application.test.ts \
  test/integration/note-create.test.ts \
  test/integration/note-create-relations.test.ts \
  test/integration/remote-user.test.ts

pnpm --filter backend-next test:process \
  test/processes/note-create.test.ts \
  test/processes/children.test.ts

pnpm --filter backend-next test:process \
  test/processes/note-deliver.test.ts \
  -t 'HTTP success precedes relay preparation'
```

期待結果：全対象 PASS。既存比較 fixture の status/body/header/保存差分、rate→停止/移行/scope→schema、関連確認→期限/禁止語の優先順を維持する。

remote actor の先行保存が Note/Poll 失敗後も残るケースは `integration/remote-user.test.ts` を再利用する。remote transaction の改修は行わない。

HTTP 応答 render の失敗と、後続内部の packed render の失敗を区別する。後者で既存の downstream 分岐を省略する挙動と antenna の独立開始は `unit/note/post-save.test.ts` を再利用する。[created-events.ts:78](../../../packages/backend-next/src/modules/note/created-events.ts)

Note-before-Role と準備失敗時の元例外は既存 `unit/composition/http-app.test.ts` が検証する。show/delete の assembly は動かさないため、その全 suite を必須範囲へ追加しない。

- [x] **8. 台帳と ROADMAP を更新する。**

段階1の実測履歴を残し、段階2として次を追記する。

| 尺度 | 基準値 | 実装後の記録 |
| --- | --- | --- |
| Note adapter の runner 階層 | 2 | 1 |
| Note 固有 lifetime owner | 1 | 0 |
| routes の作成用 writer/transaction/UseCase constructor | 3 | factory 1 |
| 対象3製品ファイルの総行数 | writer 118＋routes 61＋新 factory 0＝179 | 同じ3ファイルをヘッダー・空行込みで実測 |
| 保存までの経路 | routes→UseCase→Note wrapper→共通 runner→writes | factory を含む新経路と wrapper 撤去を記録 |

show/delete/read 等を含む routes 全体の「9→1」は今回の範囲では成立しないため記録しない。行数削減率や処理性能改善も先に約束しない。

```bash
wc -l \
  packages/backend-next/src/platform/database/note-writer.ts \
  packages/backend-next/src/composition/note-routes.ts \
  packages/backend-next/src/composition/note.ts

rg -n \
  'createNoteWriter|createNoteWriteTransactions|createCreateNote|createNoteApplication' \
  packages/backend-next/src/composition/note-routes.ts \
  packages/backend-next/src/composition/note.ts
```

台帳には Note transaction 行、作成 composition の旧/新経路、HTTP 利用、検証コマンド・件数・結果、残責任を記録する。ROADMAP の段階1記録に続けて #253 の限定成果と計画参照を追加する。#251 全体完了とは記載しない。

残責任は次を維持する。

| 残る対象 | 担当・再評価条件 |
| --- | --- |
| notification transaction | #177。通知 persistence/consumer を変更する slice |
| remote-user transaction | #195/#215。競合回復・部分 refresh を含む actor slice |
| system-account transaction | #215。独立 lazy creation 契約を変える場合 |
| mokuroku 準備・実移行 | #254/#255。固定成果物と互換性条件 |
| `connect-resources.ts` の投稿系 composition imports・組み立て | 実際に該当機能を移す slice。今回も残存と明記 |

残る platform→composition 依存は具体的に `connect-resources.ts` の投稿系 imports と後続組み立てを示す。[connect-resources.ts:9](../../../packages/backend-next/src/platform/connect-resources.ts)

- [x] **9. 最終レビューと shipping を完了する。**

実装時は許可済みの CodeRabbit を、利用可能な公式 CLI・認証を確認して基準コミットに対して実行する。

```bash
coderabbit --version
coderabbit auth status

coderabbit review --agent \
  --base-commit 2f6d4614f939e672e0ad061d8ef6a50771b92900
```

指摘は本書の保存境界・範囲と照合する。共通 runner の再設計、全 transaction 移行、show/delete 抽出、outbox、queue 移行を追加完了条件にしない。修正した場合は対応する近傍テストを再実行する。

最後に変更ファイル lint、SPDX、locale safety をまとめて確認する。

```bash
node scripts/check-shipping.mjs \
  --base 2f6d4614f939e672e0ad061d8ef6a50771b92900

git diff --check
git status --short
```

期待結果：shipping exit 0、`SPDX: OK`、locale safety PASS、whitespace 違反なし。変更対象が新 backend の内部配線だけなので、旧 backend の API 型生成・migration 検査を代用実行しない。

自分が起動した専用インフラのみ片付ける。

```bash
docker compose -p backend-note-foundation-253 \
  -f packages/backend-next/compose.test.yml down
```

**成果物:** 実 HTTP が作成専用 factory を使い、旧 inline assembly と Note wrapper が撤去され、保存・失敗・後続・停止契約と測定結果を追跡できる状態。

## 完了判定と今回の調査結果

実装完了には、2タスクの GREEN、既存契約の回帰、build/typecheck、レビュー、shipping、台帳の実測記録を必要とする。DB 接続不能は GREEN とせず、未検証項目と理由を残す。

以下は計画作成時の結果（統合後の最新結果は運用 inventory を参照）：

- **PASS:** 指定 HEAD、clean worktree、`git diff --check`、SPDX 3,250ファイル。
- **参照記録:** supplied baseline logs の unit 134件／3ファイル、integration 169件／4ファイル、process 2件／1ファイル。今回の再実行結果ではない。
- **未実行:** 実装、テスト suite、Docker 起動、CodeRabbit、commit、外部送信、子エージェント、goal 作成。

設計・署名・所有ファイル・検証の対応は本書内で自己照合済み。上記は計画作成時点の記録。実装・検証の現在地はチェックボックスと運用 inventory を参照。

## 統合完了記録

2タスクを実装し、各タスクと全差分の独立レビューは仕様 PASS / 品質 APPROVE。統合先で単体2,811件・実 DB217件・process17件と後続待機1件、build/typecheck・sync・shippingを確認した。CodeRabbit は全12変更ファイルで指摘0件。詳細と未移行箇所は[運用 inventory](../../backend-next/application-foundation-inventory.md)を参照。#253 の完了判定は本変更のマージ時で、#251 全体の完了ではない。
