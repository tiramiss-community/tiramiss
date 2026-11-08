# 本家実装の気になる点・直したほうが良い点

新実装の調査・移植の途中で見つけた、本家（misskey-dev/misskey）の実装上の問題・リスクを残す。新実装でその挙動を引き継いだか、変えたかも記録する。本家へ報告・修正提案するときの材料にもする。

基準の本家は `8e07cf085adf7009583d234a208e30436f020e26`（`backend-upstream/upstream-sync.json` と同じ）。

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
- AIエージェントは、見つけたものを `security/` に書いたうえでユーザーに伝える。本家への報告は、本家の[セキュリティ報告フォーム](https://github.com/misskey-dev/misskey/security/policy)から人が直接、非公開で行う。
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
