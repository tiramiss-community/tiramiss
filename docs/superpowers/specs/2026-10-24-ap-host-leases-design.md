# AP 送信 host 枠の保存

日付: 2026-10-24。対象: #124（親 #122、全体 #114）。

## 目的と範囲

[ジョブ契約](2026-10-21-job-persistence-design.md) §3・4.3・4.4・6・6.2 の、全 worker 共通で host 当たり AP 2 件、DB 時刻の 60 秒 lease、動的行の課金と参照終了後 30 日の回収を実装する。PR #157 までの固定宛先・送信 item を前提にする。

今回は PostgreSQL の host 枠 adapter のみ。送信 claim、開始記録、unknown 回収、HTTP/署名・配送条件・12 試行の分類、worker への接続は後続。ローカル実行 adapter の 8 試行契約を AP 送信へ流用しない。

## 方針と比較

- 採用: host と slot（0/1）を主キーにした 2 行。個々の所有世代と期限を条件付き更新でき、行ごとに保存額を課金・回収できる。
- host 1 行の JSON 内に 2 枠を持つ案は、所有条件と schema の検査が複雑になるため採らない。
- Redis semaphore は同じ transaction で業務実行権と確定できないため採らない。

この分割と物理列は実装上の判断。業務上の host 上限・保持・期限は既存の合意を維持する。

## 契約

`PostApHostLeases.acquire(manager, execution)`・`renew(manager, lease)`・`release(manager, lease)` は呼出側の有効な transaction が必須。acquire は note→item→capacity→host 順にロックし、保存された ap.send の running・owner/epoch・実行期限・元 deadline と取消世代を確認する。失効/不一致は例外。host 枠不足も例外にし、呼出側が直前に増やした試行数・実行 claim ごと rollback する。待機状態への変更は rollback 後の送信 claim adapter が所有する。例外を捕捉して同じ transaction を commit しない。

host は保存済み target inbox の WHATWG URL.hostname を小文字化し、DNS の末尾 dot を除く。HTTP/HTTPS、path、port を共有し、IDN と IPv6 は URL の正規形を使う。userinfo と HTTP(S) 以外・空 host を拒否する。inbox 自体は書き換えない。この解析は送信先の DNS/IP 制限や HTTP adapter の検査の代用ではない。

同じ work/owner/execution epoch の有効な再取得は同じ枠を返す。lease は DB の現在+60秒、item.execution_until、item.deadline_at の最小。host ごと 2 行を初回取得時に一括作成し、新規行だけ通常 90% 枠で課金する。行の base=256、variable=host の UTF-8 bytes + work ID の最大 128 bytes、formula=1 を保存する。既存行の利用には追加課金しない。

枠は work ID・execution owner/epoch・増加する host epoch・ランダム UUID token を持つ。古い worker の renew/release は新しい所有者を変更できない。UUID は 30 日回収後に同じ host/slot が再作成されても古い handle と一致させないために使う。renew は note/item と host のロック取得後に新しい DB 時刻で双方の有効 lease を確認し、失効枠を復活させない。実行 lease 自体の延長は後続の送信 adapter が同じ transaction で行う。

release は所有条件が一致する枠の有効 lease を解放する。期限切れでも一致した旧枠の解放は可能だが、置換後の枠は解放できない。work ID は参照として残し、再取得/別仕事への再利用で置き換える。

`cleanup(source, limit=100)` は専用の短い transaction で capacity→host/slot 順にロックし、最大 100 行を回収する。ロック後の新しい DB 時刻で、同 host の全枠の最終利用と参照 work の終端時刻の両方から 30 日が経過し、有効 lease と未終端 work 参照がないことを確認する。保存された行数/charged_bytes を同時減算する。FK を NULL 化して参照を隠したり、期限切れだけを根拠に回収しない。queue の inbox は host 行への永続参照ではなく、次の acquire で枠を再作成できる。周期実行への接続は後続。

## 検証

実 PostgreSQL で、並行 3 件中 2 件だけ取得、host 正規化、別 host、同一実行の再取得、期限と所有世代、ロック待ち中の失効、rollback と容量不足、参照を持つ 30 日回収、保存額による一度だけの減算、migration up/down と schema 一致を確認する。独立レビューを受け、指摘修正後に再確認する。
