# AP 固定宛先のページ展開

対象: #124 / J2。#156 の固定集合を、投稿設計とジョブ契約 §5 に従って送信 item へ変換する。実装範囲の選択は既存の実装・PR 作成まで進める指示に基づく。

## 方針と比較

固定台帳を DB の inbox 順で最大101件取得し、最大100件の送信 item・必要なら次ページ・現在ページ成功を caller-owned transaction で同時確定する。全件をメモリへ読む案は20万宛先で負荷が増え、followers を再取得する案は固定集合を変えるため採らない。通常 CRUD は TypeORM QueryBuilder を使う。

## 形式と検証

schemaVersion=1。#156 の初回ページ `target=start / payload={"after":null}` を読む。継続は target=`after:`+SHA256(cursor)、payload=`{"after":cursor,"previous":前ページworkId}`。元の inbox は2048 bytesまであるため target に直接接頭辞を足さない。workId は既存と同じ SHA256(JSON.stringify([requestId,kind,target]))。

保存済み request と item の canonical payload/hash/版/期限を再検証する。coverage=fixed と成功した root が必要。継続は同じ依頼の成功済み previous を検証し、その cursor 後の最大101件の100件目が今回の cursor、101件目が存在することを確認する。任意の実在 inbox を cursor として途中を飛ばすことを許さない。成功済み前ページを帰納的な証明として使い、全ページを再走査しない。

送信 item は `kind=ap.send / target=inbox / payload={inbox,shared}`。本文・activity ID は request で共有し複製しない。台帳の request/event/note/actor/activity が保存済み依頼と一致することも確認する。ページ生成で台帳の send_state を変えない。

## 成立と上限

note→item ロック、owner/epoch/lease/deadline と取消世代を既存 completion で確認する。page の claim は postLocal と deliver の pause/recovery を確認し、最大8試行。子は試行0・元の deadline/not_before を引き継ぎ、容量課金は1536 base + 可変文字列の既存式で通常90%枠へ同時加算する。重複 insert は ON CONFLICT DO NOTHING 後に全 immutable 内容（ID・request/kind/target・版・payload/hash・期限・課金式/額）を照合し、一致する既存進捗は維持する。新規挿入分だけ課金し、追加課金0なら削除予約で通常枠を超えていても完了できる。不一致や失敗時は transaction 全体を rollback する。

commit 応答不明は保存済み成功/次ページ/子を別接続で照会し、成功ページを再実行しない。親は子が未終端なら open を保つ。取消後・coverage 消失・不正 cursor・未知版/破損形式は子生成を拒否する。claim の形式不正は認証済み dispatch を確認してから quarantine にする。

## 検証と残件

実DBで0/1/100/101件、1000件超、途中失敗と再開、並行・重複・commit応答不明、quota rollback、取消・lease・不正cursor・固定後の関係変更を検証する。既存 local claim / snapshot の回帰も通す。migration と本家定義の変更はない。

HTTP送信・送信 claim/host lease・署名・Delete/Undo・worker起動接続・管理/清掃は後続。送信itemの作成だけでAP配送や#124の完了とはしない。
