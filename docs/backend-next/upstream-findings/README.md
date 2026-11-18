# 本家実装の気になる点・直したほうが良い点

新実装の調査・移植の途中で見つけた、本家（misskey-dev/misskey）の実装上の問題・リスクを残す。新実装でその挙動を引き継いだか、変えたかも記録する。本家へ報告・修正提案するときの材料にもする。

基準の本家は `8e07cf085adf7009583d234a208e30436f020e26`（[`packages/backend-upstream/upstream-sync.json`](../../../packages/backend-upstream/upstream-sync.json) と同じ）。

## 書かないもの

- **脆弱性・セキュリティに関わるもの。** このリポジトリは公開されており、ここに書くことは公表と同じになる。これらは下の「セキュリティに関わるもの」に従い、`security/` に置く。
- fork固有機能の問題、好みの違い、本家の挙動の単なる説明。
- 新実装との差異そのもの。それは各比較資料（`docs/superpowers/compatibility/`）の意図的差異に書き、ここからはリンクする。

## 置き方

- 本家のソースと同じパスにディレクトリを切り、ソースと同じ名前に `.md` を付けたファイルに書く。例：`packages/backend/src/core/PageService.ts` → [`packages/backend/src/core/PageService.md`](packages/backend/src/core/PageService.md)。
- 1項目ごとに、通し番号のID（`UF-001`…）を見出しにする。IDは使い回さない。
- 複数のファイルにまたがる問題は、主なファイルの md に書く。下の索引には関係するファイルをすべて挙げる。
- 本家の固定SHAを更新するとき（[#136](https://github.com/tiramiss-community/tiramiss/issues/136)）は、各項目の行番号と「本家への報告」の状態を見直す。本家で直った項目は消さずに状態を更新する。

各項目には次を書く。

```md
### UF-000 一行の要約

- 本家: 固定SHAへのリンクと行番号
- 内容: 何が起きるか
- 影響: 誰に、どう困るか
- 新実装での扱い: 同じ挙動を引き継いだ／変えた（比較資料の差異へのリンク）／未移植（担当Issue）
- 本家への報告: 未報告／報告済み（リンク）／本家で修正済み（コミット）
```

## セキュリティに関わるもの

脆弱性になり得るもの（認証・認可の回避、情報漏洩、接続や資源を占有させられる挙動など）は、`security/` の下に同じ置き方で書く。例：`security/packages/backend/src/server/api/ApiCallService.md`。

- `security/` はルートの `.gitignore` で除外しており、各自の手元にだけ残る。コミット・push・Issue・PR・外部サービスへの送信に、その内容を含めない。
- ここで禁じる送信は、公開・共有のための送信（コミット・push・Issue・PR・チャット・外部サービスへの投稿など）を指す。作業中のAIエージェントがモデルの処理として内容を扱うことは含めない。セキュリティに関わる内容をAIエージェントに扱わせてよいかは、利用者がそのエージェントの契約・データの扱いの設定で判断し、扱わせない環境では人が手元で記録する。
- 唯一の例外は、本家への非公開の報告。本家の[セキュリティ報告フォーム](https://github.com/misskey-dev/misskey/security/policy)から、人が直接行う。AIエージェントは見つけたものを `security/` に書いてユーザーに伝えるだけで、報告そのものは行わない。
- IDは `SEC-001` から通し番号にし、公開側の索引には載せない。本家で修正・公表された後に公開側へ移すかは、人が判断する。

## 索引

| ID | 本家のファイル | 要約 | 新実装 | 本家への報告 |
| --- | --- | --- | --- | --- |
| [UF-001](packages/backend/src/core/ModerationLogService.md#uf-001-モデレーションログの書き込み失敗が検出されない) | `core/ModerationLogService.ts` ほか全57の呼び出し元 | モデレーションログの書き込み失敗が検出されない | 変えた | 未報告 |
| [UF-002](packages/backend/src/core/PageService.md#uf-002-ページ削除がロールバックしても削除ログが残る) | `core/PageService.ts` | ページ削除がロールバックしても削除ログが残る | 未移植（#191） | 未報告 |
| [UF-003](packages/backend/src/core/DeleteAccountService.md#uf-003-アカウント削除の前に削除ログを書く) | `core/DeleteAccountService.ts` | アカウント削除の前に削除ログを書く | 未移植（#199） | 未報告 |
| [UF-004](packages/backend/src/server/api/endpoints/admin/queue/clear.md#uf-004-queueの消去を待たずに成功を返しログを書く) | `server/api/endpoints/admin/queue/clear.ts` | queueの消去を待たずに成功を返し、ログを書く | 引き継いだ（失敗は診断） | 未報告 |
| [UF-005](packages/backend/src/server/api/endpoints/admin/queue/promote-jobs.md#uf-005-遅延ジョブの前倒しを待たずに成功を返しログを書く) | `server/api/endpoints/admin/queue/promote-jobs.ts` | 遅延ジョブの前倒しを待たずに成功を返し、ログを書く | 引き継いだ（失敗は診断） | 未報告 |
| [UF-006](packages/backend/src/server/api/endpoints/admin/queue/retry-job.md#uf-006-ジョブの再試行を待たずに成功を返す) | `server/api/endpoints/admin/queue/retry-job.ts` | ジョブの再試行を待たずに成功を返す | 引き継いだ（失敗は診断） | 未報告 |
| [UF-007](packages/backend/src/server/api/endpoints/admin/queue/remove-job.md#uf-007-ジョブの削除を待たずに成功を返す) | `server/api/endpoints/admin/queue/remove-job.ts` | ジョブの削除を待たずに成功を返す | 引き継いだ（失敗は診断） | 未報告 |
| [UF-009](packages/backend/src/server/web/UrlPreviewService.md#uf-009-summalyの共有optionsが並行取得の言語を上書きする) | `server/web/UrlPreviewService.ts`、`package.json`、Summaly `src/index.ts`（配布物 `built/index.js`） | Summaly 5.5.2の共有optionsで並行previewの言語が変わる | 引き継いだ（#377/#560） | 未報告 |
| [UF-010](packages/backend/src/server/api/endpoints/drive/folders/create.md#uf-010-フォルダー名の入力上限と保存先の長さが異なる) | `server/api/endpoints/drive/folders/create.ts`・`update.ts`・`models/DriveFolder.ts` | 入力は200文字、保存先は128文字で保存時に失敗する | 引き継いだ（#278） | 未報告 |
| [UF-011](packages/backend/src/server/api/endpoints/drive/folders/update.md#uf-011-フォルダーの同時更新で別の列の変更を古い値に戻す) | `server/api/endpoints/drive/folders/update.ts` | 名前・親の同時更新で先の別列変更を古い値に戻す | 引き継いだ（#278） | 未報告 |
| [UF-012](packages/backend/src/core/MetaService.md#uf-012-取得中の古いmetaが通知済みの値を上書きする) | `core/MetaService.ts` | 取得中の古いMetaが通知後にcacheを上書きする | 引き継いだ（#317） | 未報告 |
| [UF-013](packages/backend/src/core/MetaService.md#uf-013-周期再取得のdbエラーにrejection-handlerがない) | `core/MetaService.ts` | 周期再取得のDB失敗が未処理rejectionになる | loggerへ報告（#317） | 未報告 |
| [UF-014](packages/backend/src/server/web/ClientServerService.md#uf-014-twemojiバッジの96px指定に対して512pxが出力される) | `server/web/ClientServerService.ts` | Sharp 0.35.5の固定画像バッジが96px指定に対して512pxになる | 引き継いだ（#555） | 未報告 |
| [UF-015](packages/backend/src/core/entities/PageEntityService.md#uf-015-旧content書戻しのdb失敗が未処理rejectionになる) | `core/entities/PageEntityService.ts` | 旧inputの非待機書戻しにrejection handlerがない | 非待機を維持しloggerへ報告（#293） | 未報告 |
| [UF-016](packages/backend/src/core/QueueService.md#uf-016-アーカイブ予約の存在確認後に削除されると再投入しない) | `core/QueueService.ts` | 存在確認後に削除されたアーカイブ予約を再投入しない | 引き継いだ（#449/#450） | 未報告 |
| [UF-017](packages/backend/src/core/chart/core.md#uf-017-空の過去区間では現在の最新行により既存totalの補間を失う) | `core/chart/core.ts` | 空の過去区間が最新行を使い既存totalの補間を失う | 引き継いだ（#319） | 未報告 |
| [UF-018](packages/backend/src/core/chart/core.md#uf-018-resyncは未flushのtotal差分をそのまま再適用する) | `core/chart/core.ts`・`charts/users.ts` | resync後に保留total差分が再適用される | 引き継いだ（#319） | 未報告 |
