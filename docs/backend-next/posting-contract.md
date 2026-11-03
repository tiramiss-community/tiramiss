# 投稿保存・後続処理の最小契約

判断基準は[GOALS](GOALS.md)。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。#124/#127/#169 の旧同時確定・容量・復旧条件より本書を優先する。

## 保存と応答

認証 → 通常レート制限 → 停止/移行/scope → 入力検証 → 業務判断 → Note保存 → 後続処理開始 → 取得済み資料から出力する。本家の基本text投稿は単純insertであり、Noteと独自requestの同時保存を必要としない。投票など複数の業務データが一体となる処理は、その機能でtransactionを使う。COMMIT応答不明やクライアント切断を理由に投稿操作を自動再実行しない。

HTTP成功は保存とレスポンス生成の成功。AP配送や通知の完了を待たない。後続処理失敗で保存済みNoteを巻き戻したと扱わず、エラーを記録する。本家同様、user.notesCount/updatedAtは保存後の処理で原子的加算する。通常終了では開始済み処理を既存の終了期限まで待つ。

業務コードへHTTP/ORM/queue/DI型を渡さない。保存窓口と副作用開始を分け、レスポンスは既存のNote資料取得とpure rendererで作る。show UseCaseをcreate UseCaseから呼ばない。

## 非同期処理と通知

基本text保存のためだけのjobは作らない。AP送信・投票終了・webhookなど、本家がqueueを使う仕事を実装するときにBullMQの通常add/addBulk/Workerを接続し、本家相当のretry/backoff/limiter/履歴/管理を移植する。PG正本、二重claim、世代token、内部Lua差替え、全損再構築は初期経路に入れない。全副作用を万能dispatcherへ集めない。

通知実体は承認済みのPostgreSQL保存を維持する。#173/#177では、通知条件を判断したUseCaseから直接保存する小さい窓口へ変え、work_request/claim/通知effect/容量課金への依存を外す。通常の受信者別保持・既読・配信・既存Redis通知移行は残る。今回、通知機能を接続済みとは扱わない。保存先の差異は取り消さず、強い一度だけ成立は初期必須から外す。

## 最初の実装PR

- 通常起動に `POST /api/notes/create` の基本text作成を接続する。text 1–3000、空白のみ禁止、trim、CW null/1–100、公開範囲・localOnly・reactionAcceptanceを扱う。
- native/Bearer/MiAuth/App permission、productionの1時間300/factor制限、入力より先の制限/資格判定、sensitiveWords/禁止語/Roleによるpublic→homeを比較する。キーワード正規表現は本家と同じRE2。
- N0のC1/C2/C3基本入力/C4のHTTP・DB・count・showを検証する。C1のAP観測まで一致したとは報告しない。
- 添付・poll・reply/Renote・channel・指定宛先・MFM抽出は#170。未実装の入力/抽出対象を黙って捨てず、当面501 `NOT_IMPLEMENTED`で保存前に拒否する。noExtract指定で抽出しないことが明示された本文は保存できる。この暫定制限は#170で除去し、完成版の意図的差異にしない。
- 通常起動に利用者がない独自BullMQ transport、Redis世代復旧、専用テスト、README手順を撤去する。残るdispatch/claim/AP/通知adapterは互いに依存しているため、直後の削減PRでPG通知の依存分離と併せて撤去する。未使用のまま全機能完成まで保持しない。
- 本家schemaと適用済みmigrationは変更しない。残存データ/ジョブの扱いを検査する新migrationで不要内部テーブルを廃止する。今回DBの内容は削除しない。

## 選択の理由

旧PG実行プロトコルを接続する案は初期目的に不要な保証と運用を増やす。先に全強化実装を消す案は未接続adapterの置換作業だけで機能実装を遅らせる。基本投稿を通しながら参照のない部分から撤去し、相互依存する残りを直後のPRでまとめて減らす。
