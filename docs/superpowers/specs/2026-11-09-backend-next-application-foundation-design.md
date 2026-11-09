# backend-next の依存組み立て・トランザクション・queue 登録の共通化

2026-11-09: ユーザーが段階1（棚卸し・共通 transaction lifetime・Role show/update composition）の着手を承認。[実装計画](../plans/2026-11-09-backend-next-foundation-251.md)と[統合後の実測・未移行一覧](../../backend-next/application-foundation-inventory.md)を参照する。以下の時期未定・候補という記述は相談時点の設計履歴。Note/Poll と mokuroku の実装は今回に含めない。

日付: 2026-11-09

追跡先: [Issue #251](https://github.com/tiramiss-community/tiramiss/issues/251)。導入時期・段階・取りこぼしを防ぐ対象一覧と完了条件を Issue に転記した。着手時期と担当は未決であり、起票を実装開始の指示とは扱わない。

状態: 方向性は会話で合意済み。具体設計と実施時期は相談中。#114 全体の進捗を踏まえて導入時期を先に判断し、実装計画へ自動的には進まない。実装・依存追加・依存先への変更依頼は未実施。

## 1. 目的と合意の範囲

UseCase からトランザクション内の操作へ辿る経路と、必要な依存を揃える作業を簡単にする。Hono を維持し、既存の業務処理を利用者にして小さな内部基盤を育てる。queue の定義・登録には mokuroku-js の利用を検討する。

ユーザーが負担として挙げたのは、UseCase → transaction → 実処理のつながりと依存の引き込み。会話で選ばれたのは、トランザクションの範囲は UseCase に残し、その裏側の接続・操作・依存の組み立てを共通化する方向。本書の API の形、初回の対象、依存先が未対応の場合の扱いは、その方向を具体化する設計提案である。

判断基準は [GOALS](../../backend-next/GOALS.md) と [ROADMAP](../../backend-next/ROADMAP.md)。本家相当の業務機能を進めるための整理とし、基盤の完成を未移植機能全体の先行条件にしない。

### 成功の基準

- Role 更新と投稿保存が、共通のトランザクション終了管理を使い、機能固有の二重の `run` ラッパーを不要にする。
- HTTP の組み立て側が Role の reader・更新操作・ID・時計を個別に配線せず、Role の composition の入口から公開操作を受け取れる。
- queue ごとの定義・投入・handler 登録・設定を同じ場所から追え、worker の起動側に業務処理の組み立てを直接追加しなくて済む。
- 認可、保存結果、副作用の開始位置、失敗の扱い、既存ジョブの形式が変わらない。
- 変更前後で、代表機能の追加・変更時に触る登録箇所、終了管理の重複、実処理までの経路を比較する。行数の削減率は先に約束しない。

## 2. 比較した進め方

| 案 | 利点 | 負担・採否 |
| --- | --- | --- |
| NestJS などの包括的なフレームワークへ寄せる | モジュール・DI・起動終了の既成の規約を使える | 移行・登録の記述が増え、本家互換の境界も別途必要。今回の選択にはしない |
| Hono と既存関数を維持し、内部の組み立てと transaction を揃え、queue は外部ライブラリを利用する | 今の業務コードを利用者にして配線の重複を減らせる | 小さな内部契約の保守と mokuroku-js の適合確認が必要。会話で選んだ方向 |
| 汎用の独自フレームワークを作る | 全体を独自の規約へ揃えられる | DI・実行モデル・拡張機構まで保守する負担が大きい。今回の対象にしない |

## 3. 調査した現在の構成

tiramiss の最初のローカル調査基準は `50b5f670c0bc33debe1d7d68e93d7d04315261c3`。作業開始時点で `.claude/settings.json` と `.playwright-mcp/` に既存の変更があり、本設計の対象外。以下はその時点の構成であり、その後に確認した最新 develop の差は節末に記す。

- [Role 更新](../../../packages/backend-next/src/modules/role/update-role.ts)は `TransactionRunner<RoleUpdateScope>` を受け取り、現在の権限確認・ロック・更新・監査を同じ transaction で行う。commit 後のキャッシュ通知失敗は更新を失敗へ戻さない。
- [Role 用 adapter](../../../packages/backend-next/src/platform/database/role-update.ts)と [Note 用 adapter](../../../packages/backend-next/src/platform/database/note-writer.ts)は、共通 runner の外に終了状態を持つラッパーをそれぞれ作る。
- [投稿保存](../../../packages/backend-next/src/modules/note/create-note.ts)は投票なしなら単独 insert、投票付きなら Note と Poll を同じ transaction で保存する。事前のリモート解決や描画・後続処理は transaction に含まれない。
- [HTTP の composition](../../../packages/backend-next/src/composition/role-http.ts)は、Role の業務操作と HTTP adapter の両方を組み立てる。
- [connectResources](../../../packages/backend-next/src/platform/connect-resources.ts)は DB・Redis 接続と、投稿・配送などの機能の組み立てを併せ持つ。[worker](../../../packages/backend-next/src/processes/worker.ts)も個別 handler と worker の組み立てを直接行う。
- Inversify は [createRuntime](../../../packages/backend-next/src/composition/create-runtime.ts)で logger の登録・取得に使われ、業務依存は factory 関数へ明示的に渡している。

実施時期の相談にあたり、GitHub の develop `cf8968694f01eaad637992af86281b7e3f339908` を確認した。[PR #249](https://github.com/tiramiss-community/tiramiss/pull/249) は 2026-11-09 にマージ済みで、HTTP root と Note routes の分離、既存3業務 worker の静的登録表、CI の契約テスト glob を導入している。queue 登録表の新設と HTTP root 抽出は、これから行う作業に数えない。残る提案は、この構成の上で行う機能単位の依存組み立てと transaction の共通化、および別途判定する mokuroku 移行である。ローカル checkout の更新・他セッションの作業変更は行っていない。

## 4. 依存関係の組み立て

`composition` に機能単位の組み立ての入口を置く。初回は Role の show/update と、投稿保存・既存3業務 queue を対象とする。名前とファイル分割は実装計画で確定する。

- 基礎リソースの接続と解放は platform が担当する。機能の composition を platform から import する構成を解き、composition 側が接続済みリソースを使って業務操作を組み立てる。
- Role の composition は接続・ID・時計・変更通知から show/update を生成し、HTTP adapter に必要な操作だけ返す。入口に無関係な全 `RuntimeResources` を要求しない。
- 他モジュールに渡すものは、そのモジュールが公開する狭い業務能力。生成した UseCase の集合は HTTP/worker などの入口へ渡し、別 UseCase の依存として渡さない。
- 起動側は機能の生成結果と明示的な cleanup を束ねる。初回から共通のモジュール基底クラス、プラグイン探索、任意の依存グラフを解決する仕組みは作らない。
- UseCase は必要な依存を引数で受け取る通常の関数のままとする。DI コンテナや起動用の巨大なリソース集合を業務へ渡さない。
- 既存 Inversify の用途の変更・撤去は今回の必須条件にしない。新しい DI ライブラリは追加しない。

機能側の後続処理を待った後に queue と接続を閉じる既存の順序を維持する。分割してファイルだけ増やし、元の組み立てと未使用の旧入口を並存させる形で完了にしない。

## 5. トランザクションの共通契約

業務側の `TransactionRunner<Scope>.run(work)` は維持する。UseCase が範囲を選び、コールバック内でその Scope の能力を使う。

インフラ側の共通 runner が、接続への束縛と操作の有効期間を管理する。概念上の API は次の形を想定する。既存 API ではなく設計案である。

```ts
createTransactionRunner(source, (manager, lifetime) => ({
  roles: createRoleWrites(manager, lifetime.assertActive),
  authorizationFacts: createRoleAuthorizationReader(manager, lifetime.assertActive),
  auditLogs: createRoleAuditWriter(manager, lifetime.assertActive),
}));
```

- `manager` と `lifetime` は platform 内だけで扱い、業務 Scope へ露出させない。
- bind は同じ transaction の manager から能力を同期的に生成する。各操作は共通の有効期間を確認してから DB を使う。
- bind の失敗を含め、runner は ORM のコールバック終了時に `finally` で有効期間を閉じる。commit/rollback の失敗でも閉じた状態を維持する。
- 終了後に持ち出された能力の新たな呼び出しは、DB を触る前に拒否する。この確認は、すでに開始した Promise を取り消したり、未 await の処理を自動回収したりする保証ではない。UseCase は内側の処理をすべて await する。
- 型付きの Scope は、Role の認可・Role 更新・監査など、同時確定が必要な能力だけを含む。汎用 ORM ラッパーを業務へ公開しない。
- 例外は呼び出し元へ伝える。自動再試行は追加せず、COMMIT 結果不明を rollback 成功に読み替えない。
- transaction の自動開始、AsyncLocalStorage による暗黙の接続選択、デコレーター、動的 Proxy は導入しない。

初回に Role と Note の専用 runner をこの契約へ移す。他の通知・remote user の transaction は、同じ共通 runner の既存呼び方を維持できるようにし、全モジュールの一括移行を要求しない。終了後利用拒否を新たに広げる場合は、その利用者の検証を追加して個別に扱う。

## 6. queue 登録と mokuroku-js

2026-11-09 のユーザー補足: mokuroku-js はユーザー自身が開発・保守しており、必要なインターフェースを追加できる。したがって既成 adapter の対応待ちだけでなく、ライブラリ側の汎用 API 拡張と backend-next への適用を分けて計画する。queue 単位の handler 選択、型付きの成功結果、ready/close/障害通知、BullMQ 6 対応を拡張候補とする。Misskey 固有の payload・prefix・業務判断は利用側に置く。これらは追加候補であり、既に提供・検証済みとは扱わない。最新の追跡は [#251](https://github.com/tiramiss-community/tiramiss/issues/251) を参照する。

調査対象は [mokuroku-js `51af573f5ffec3daf9723131ec3712e858508e19`](https://github.com/mokuroku-community/mokuroku-js/tree/51af573f5ffec3daf9723131ec3712e858508e19)。README と実装を比較した段階であり、実行互換性は未検証。

採用する場合、定義と runtime は platform/composition に置き、業務へ `JobRuntime`・handler context・BullMQ Job を渡さない。業務側は `schedulePollEnded`・`deliverMany`・`enqueueWebhook` などの具体的能力を使い、実行側の薄い adapter が payload を業務処理へ渡す。

queue の宣言には、既存の queue 名、ジョブ定義、worker 設定、handler の生成、必要な後続処理の待機をまとめる。起動側は明示的な登録関数を呼び、登録済み handler のある queue だけを実行する。import の副作用やファイル走査で自動登録しない。管理用の全10 queue と、業務 handler のある3 queue は別の集合として維持する。

### 採用前に解消する差

| 対象 | 調査時点の mokuroku-js | 必要な契約 |
| --- | --- | --- |
| handler の選択 | [backend](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L276)が保存済み `job.name` で handler を引く | 配送先・投稿ID・webhook IDを既存どおり name に保存しても処理できる。queue ごとの単一 handler など、保存名と処理選択を分ける公開契約が必要 |
| 成功結果 | 同 backend は handler の戻り値を返さず、[core の型](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/core/src/handler.ts)も `Promise<void>` | 配送・webhook の成功結果を BullMQ と管理 API で維持する。型と実装の両方で扱う |
| 起動・障害 | [manager](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/queue-manager.ts#L282)は取得ループを開始するが、接続完了の待機や既存の全接続 `end` 監視とは異なる | ready は必要な接続完了後。再接続なし・起動中の接続喪失・起動後の障害通知・正常終了した取得ループの異常扱いを接続する |
| 終了・途中起動失敗 | backend は未起動なら `stop` を省略し、途中失敗で state を idle に戻す | HTTP など投入専用でも Queue を閉じ、途中作成した Worker も解放する。1件の解放失敗で他の解放を省略しない |
| BullMQ の版 | [package.json](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/package.json#L42)の peer は `^5.16.0`、backend-next は `6.3.11` | BullMQ 6 対応の型・実行・依存条件を確認する。peer 不一致の強制無視で通さない |

採用には、上記を満たす取得可能な固定バージョンと、既存の比較を使った検証が必要。README の adapter 名は `@mokurokujs/bullmq`、調査した package.json の名前は `@mokurokujs/bullmq-adapter` なので、採用時の成果物で export と名前も確認する。

依存先が未対応なら、queue の mokuroku 移行だけを保留し、PR #249 の静的登録表と既存 BullMQ adapter を使い続ける。Role・Note の整理は進められる。core だけの導入や別の巨大な独自 adapter によって、互換性の問題を隠して採用済み扱いしない。依存先改修のための Issue/PR 起票・公開・別リポジトリの編集は本書の承認に含めず、具体化した段階で別途扱う。

### 維持する外部契約

queue 名・prefix・job name/id・payload・delay・attempts・custom backoff・保持条件・worker 並行度・rate limit・metrics・成功結果・非再試行エラーの意味を維持する。登録を整理するために既存の Redis データを変換・消去しない。DB schema と migration は変更しない。

HTTP は投入だけで業務 Worker を開始しない。Worker は処理を待ち、handler が開始した保存等の後続処理も待ってから投入先・接続を解放する。停止期限と Supervisor の異常終了の扱いは既存契約を使う。mokuroku のローカル Worker pause を管理 API の queue 全体 pause の代わりに使わない。

## 7. 初回の対象と対象外

初回の実装候補は共通 runner と Role 更新・Note/Poll 保存への適用、Role の composition の分離。既存3 queue の静的登録表は PR #249 の成果を使い、再実装しない。mokuroku 移行の採用可否は `endedPollNotification`・`deliver`・`userWebhookDeliver` の検証で別に判定する。これらを一括で直ちに実装する合意ではなく、導入時期は第10節の案を相談して決める。

API gate の拡張、全業務モジュールの移動、未実装7 queue の handler、scheduler の新規移植、ORM/DI/HTTP フレームワークの交換、独自の永続ジョブ・outbox・追加の配送保証は対象外。全設定を統一する万能基盤や外部公開用の新パッケージも作らない。

## 8. 検証と完了判定

実装計画では対象を絞り、既存の検証を再利用する。以下は必要な振る舞いであり、すべての広域テストを毎回要求する一覧ではない。

- transaction: Role の認可・更新・監査が同じ接続で成立し、失敗時に一括 rollback する。正常・例外・bind 失敗の終了後に能力を再利用できない。既存の [unit](../../../packages/backend-next/test/unit/transaction-runner.test.ts)・[integration](../../../packages/backend-next/test/integration/transaction-runner.test.ts) と Role 更新の近傍検証を使う。
- Note: 投票なしの保存と投票付きの同時確定、描画失敗後も後続が始まること、既存の認可・入力エラーを維持する。
- queue: 既存動的 job name の消費、raw Redis/payload/options の維持、成功結果、失敗・retry・保持・管理 API/QueueStats を実 BullMQ 6・Redis で比較する。静的な型付き定義だけで保存済み payload の検証を代替しない。
- lifecycle: 接続完了まで ready を出さない、投入専用プロセスの接続解放、途中起動失敗時の解放、Redis 切断の報告、受理済み処理・handler 後続の待機、停止期限を確認する。
- 構造: 業務へのフレームワーク型・コンテナの流入、UseCase 間呼び出し、公開契約を含む循環がないことを確認する。
- 完了時は不要になったラッパー・旧登録・未使用の組み立てを撤去し、build/typecheck と変更ファイル lint、SPDX、locale safety を確認する。

具体設計と実施時期の合意後に、対象範囲に対応する実装計画を作る。依存先の公開・起票などを伴う場合は、その具体的な変更と採用方法を別に提示する。GOALS の初期範囲や本家互換の承認済み差異をこの整理だけで変更しない。

## 9. 実装側に委ねる判断

factory・型・ファイルの名前、既存テストへの追加位置、内部関数の細かな分割、局所的な移行順は実装計画で決める。組み立てを隠す量より、依存の入口と transaction の範囲を短い経路で辿れることを優先する。

## 10. #114 に対する導入時期の案

以下は進捗を調べたうえでの提案であり、ROADMAP の正式な対応順・blocked-by を変更する合意ではない。進捗率や Issue の close 件数を時期の基準にせず、直近の移植で同じ配線が増えるか、変更する箇所が他の作業と重なるかで判断する。

### 確認した進捗

- [#114](https://github.com/tiramiss-community/tiramiss/issues/114) は投稿の代表フローから残る領域の並行移植へ進む計画を持つ。共有 root は PR #249 で整理済み。最新 ROADMAP では #178 の Role/queue gate、共通監査 appender、#182 の FollowRequest Entity 同期まで実装済みと記録されている。Issue 本文の古い「これから着手」と区別する。
- [PR #250](https://github.com/tiramiss-community/tiramiss/pull/250) は調査時点で open。N7 の C2/C10 の比較を補い、media/emoji・instance・chart・cache 等の初期機能を実装するまで #176 を閉じない方針を文書化している。まだマージ済みの規範として扱わないが、#176 の close を今回の全変更の前提に置くと、複数領域の完成まで待つことになる。
- GitHub に公開された進捗で判断しており、未公開の並行作業がないことまでは示さない。実施時には対象ファイルの担当と進行中の slice を確認する。

### 分けて判断する変更

| 変更 | 入れる時期の提案 | 待つもの・待たないもの |
| --- | --- | --- |
| 共通 transaction runner と Role への適用 | 直近の共有箇所を触る変更が落ち着いた短い区切りで先行し、#181/#182 等の更新 UseCase が増える前に試す | 対象ファイルを扱う進行中作業との調整と、Role の認可・監査・rollback の検証を必要とする。#176/#114 全体の close は待たない |
| Role の依存組み立ての整理 | runner の適用と同じ限定範囲で行い、新たな機能もその規約を使えるか確認する | 全モジュールの一括移動や起動基盤の全面改修を前提にしない |
| Note/Poll への適用と Note の依存整理 | PR #250 の比較変更が取り込まれる等、投稿の観測基準が揃った区切り。その後、#178 の Note gate 載せ替えと重ならない順序を担当間で決める | 「PR #250 のマージ」は候補の区切りであり、実施を自動開始する条件ではない。#176 の全初期機能の完成は待たない |
| mokuroku への移行 | 第6節の適合条件を満たした時点で、既存3 queue を専用の変更で検証する。可能なら追加 handler が増える前に判定する | 依存先の未対応を #195 inbox・#198・#199 等の移植全体の blocker にしない。対応が間に合わなければ PR #249 の登録表で移植を続け、移行時期を再評価する |

共通 runner と Role の適用は、認知負荷が下がるかを確認する最初の小さな変更とする。効果が乏しければ全領域への展開を既定路線にしない。mokuroku は Worker の起動・終了・ジョブの保存形式にも関わるため、内部の配線整理と同じ変更へ混ぜない。

#139 の最終切替検証に入った後の全面移行は避けたい。queue の起動・終了や旧ジョブ消費を検証し直す必要があるため、後ろへ送るなら、その前の明示的な判断機会を置く。日付・工数・実施担当・正規の工程への追加は、ユーザーとの時期の相談後に決める。
