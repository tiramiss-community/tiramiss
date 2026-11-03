# 投稿保存・後続処理の最小契約

判断基準は[GOALS](GOALS.md)。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。#124/#127/#169 の旧同時確定・容量・復旧条件より本書を優先する。

## 保存と応答

認証 → 通常レート制限 → 停止/移行/scope → 入力検証 → 業務判断 → Note保存 → 取得済み資料から出力（描画） → 後続処理開始。応答の入れ子の返信先/Renote対象のcountを本家と同じく今回の加算前の値にするため、描画を終えてから後続処理を始める。描画に失敗しても保存済みなので後続処理は始め、500のログに保存済みNoteのIDを残す。本家の基本text投稿は単純insertであり、Noteと独自requestの同時保存を必要としない。投票など複数の業務データが一体となる処理は、その機能でtransactionを使う。COMMIT応答不明やクライアント切断を理由に投稿操作を自動再実行しない。

HTTP成功は保存とレスポンス生成の成功。AP配送や通知の完了を待たない。後続処理失敗で保存済みNoteを巻き戻したと扱わず、エラーを記録する。本家同様、user.notesCount/updatedAtは保存後の処理で原子的加算する。通常終了では開始済み処理を既存の終了期限まで待つ。

業務コードへHTTP/ORM/queue/DI型を渡さない。保存窓口と副作用開始を分け、レスポンスは既存のNote資料取得とpure rendererで作る。show UseCaseをcreate UseCaseから呼ばない。

## 非同期処理と通知

基本text保存のためだけのjobは作らない。AP送信・投票終了・webhookなど、本家がqueueを使う仕事を実装するときにBullMQの通常add/addBulk/Workerを接続し、本家相当のretry/backoff/limiter/履歴/管理を移植する。PG正本、二重claim、世代token、内部Lua差替え、全損再構築は初期経路に入れない。全副作用を万能dispatcherへ集めない。

通知実体は承認済みのPostgreSQL保存を維持する。#173/#177では、通知条件を判断したUseCaseから直接保存する小さい窓口へ変え、work_request/claim/通知effect/容量課金への依存を外す。通常の受信者別保持・既読・配信・既存Redis通知移行は残る。今回、通知機能を接続済みとは扱わない。保存先の差異は取り消さず、強い一度だけ成立は初期必須から外す。

## 最初の実装PR

- 通常起動に `POST /api/notes/create` の基本text作成を接続する。text 1–3000、空白のみ禁止、trim、CW null/1–100、公開範囲・localOnly・reactionAcceptanceを扱う。
- native/Bearer/MiAuth/App permission、productionの1時間300/factor制限、入力より先の制限/資格判定、sensitiveWords/禁止語/Roleによるpublic→homeを比較する。キーワード正規表現は本家と同じRE2。
- N0のC1/C2/C3基本入力/C4のHTTP・DB・count・showを検証する。C1のAP観測まで一致したとは報告しない。
- 添付・poll・reply/Renote・channel・指定宛先・MFM抽出は#170（下記「関連入力」）。#169の時点では、未実装の入力/抽出対象を黙って捨てず、501 `NOT_IMPLEMENTED`で保存前に拒否していた。
- 通常起動に利用者がない独自BullMQ transport、Redis世代復旧、専用テスト、README手順を撤去する。残るdispatch/claim/AP/通知adapterは互いに依存しているため、直後の削減PRでPG通知の依存分離と併せて撤去する。未使用のまま全機能完成まで保持しない。
- 本家schemaと適用済みmigrationは変更しない。残存データ/ジョブの扱いを検査する新migrationで不要内部テーブルを廃止する。今回DBの内容は削除しない。

## 関連入力（#170）

添付・投票・返信/Renote/引用・channel・指定宛先・MFM抽出を、固定本家の `notes/create` と `NoteCreateService` に合わせて接続する。基本text作成の501暫定制限は、未登録リモートユーザー宛てメンションを除いて撤去する。

- **判定順**: 入力検証 → 指定宛先の取得 → 添付 → Renote対象 → 返信先 → 投票期限（本家どおり、`expiredAfter` は要求開始の時刻から数え、期限は関連の取得を終えた時点の時刻と比べる。Dateの範囲外の値は期限切れとせず、保存時のDBエラーで500）→ channel → 返信先によるchannelの補正 → channel投稿の強制（public・宛先なし・localOnly）→ sensitiveWords/canPublicNote（channelなしのみ）→ 禁止語（trim前のcw・text・選択肢）→ Renote対象/返信先による公開範囲・localOnlyの補正 → textのtrim → MFM抽出（text・cw・選択肢）→ メンション解決 → 返信先作者・指定宛先の追加 → メンション数上限 → 保存。複数の誤りでは最初のエラーを返す。エラーのcode/id/messageは本家どおり。
- **存在・可視性・ブロックの確認**は保存と同じtransactionに入れない（本家も同じ）。確認後の削除・ブロックは検出しない。本家の `create()` 内でcacheによりブロックを再確認して500になる経路は、DBの確認と食い違う競合時だけに起きるため移植しない。
- **保存**: 投票ありはNoteとPollを、UseCaseが所有する1つのtransactionで保存する。投票なしはNoteの単純insert。非正規化列（threadId・replyUserId/Host・renoteUserId/Host・renoteChannelId・attachedFileTypes・mentionedRemoteUsers）も本家と同じ値で保存する。
- **保存後のcount**: user.notesCountに加え、返信先repliesCount、Renote対象renoteCount（他人の投稿・botでない投稿者のみ。引用も含む）、channelのnotesCount・lastNotedAt・usersCount（その投稿者のchannel内Noteが1件ならusersCount+1）を、保存後の原子的更新として行う。本家どおり削除では減らさない。作成応答の描画を終えてから開始し、応答の入れ子の返信先/Renote対象のcountを本家と同じく今回の加算前の値にする。
- **メンション**: ローカルユーザーと登録済みリモートユーザーをDBで解決する。見つからないローカルユーザーは本家どおり無視する。自ホスト判定とホスト正規化は[連合の共通土台](federation-base-contract.md)を使う。登録済みリモートユーザーは `lastFetchedAt` に関係なく再同期せず使う。DBにない（未登録の）リモートユーザー宛ては、メンション解決の位置で保存前に501 `NOT_IMPLEMENTED`で拒否する。どちらも#195で除去する暫定制限であり、完成版の意図的差異にしない。
- **指定宛先とMFM抽出**: 指定宛先は本家と同じく順序を付けずに取得し、存在しないIDは黙って除く（保存順は入力順を保証しない）。ハッシュタグの長さの上限は本家どおり正規化前の値で判定するため、NFKCで128文字を超えるタグは保存時のDBエラーで500になる。mediaSilencedによる絵文字の除外はリモート投稿にだけ効くため、ローカル投稿の経路には入れない。
- **後続Issueの材料**: 投票終了のjob登録と通知は#173で、保存済みの `poll.expiresAt` を材料に実装する。#170では空のjobを作らない。通知・stream（#173）、hashtag表・ランキング・検索索引・TL・antenna（#174）、webhook（#175）、AP配送（#171）、チャートは本Issueで実装しない。いずれも保存済みのNote列（mentions・mentionedRemoteUsers・tags・reply/renote/channel）から判断できる。

## 選択の理由

旧PG実行プロトコルを接続する案は初期目的に不要な保証と運用を増やす。先に全強化実装を消す案は未接続adapterの置換作業だけで機能実装を遅らせる。基本投稿を通しながら参照のない部分から撤去し、相互依存する残りを直後のPRでまとめて減らす。
