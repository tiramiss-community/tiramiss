# AP 作成宛先の初回固定

対象: #124（親 #122 / #114）。[保存契約](2026-10-21-job-persistence-design.md) §5 と [投稿設計](2026-10-21-note-flow-design.md) §6.1 の作成側を実装する。削除側・ページ実行・送信・通常worker接続は後続。

## 方針

候補を呼出側で配列化する案は、複数読取り間の関係変更で集合が混ざるため採らない。PostgreSQL の単一 statement snapshot で followers / accepted relay / direct を取得し、重複排除した台帳へ INSERT SELECT する。TypeORM の通常CRUDを使いつつ、この CTE は単一snapshot・件数検査・集合固定を明示するため生SQLを使う。全件をアプリのheapへ載せない。

固定本家 SHA は `8e07cf085adf7009583d234a208e30436f020e26`。Following / Relay はmanifestに追加して機械同期する。public Entity/migrationは改変しない。followersはremoteのみ、sharedInboxを優先する。directは既にfollowers集合にsharedInboxがあれば除き、それ以外は個人inboxを使う。publicだけaccepted relayを加え、最終inboxは出来事内で一意。複数経路が同じURLになる場合は個人配送（shared=false）を優先する。異なる出来事は統合しない。URLは保存済の文字列をそのまま使い、HTTP側の安全な接続・host判定は後続送信adapterで行う。

## 成立範囲

`PostApRecipientSnapshot.complete(manager, claim, recheck)` はactiveなcaller-owned transaction専用。claimを最初にコピーし、note→itemの既存実行権検査後に保存済request/itemを再検証する。Create/Announce・generation1のみ受理し、Delete/Undoは変更せず拒否する。候補の配送許可を捏造しないため、最新の連合条件を同じtransactionで読む `recheck(request)` は必須とする。全面的な連合条件・AP表現の移植はN4。

localOnly/channel・recheckによる抑止は宛先0件の固定結果とする。remote宛先の解決は事前に済ませる。direct IDの不存在とremote followerのinbox欠落は成功扱いで捨てず例外にし、全体rollback。local directは配送しない。

独自 `delivery_recipient` は `(create_event_id,inbox)` が主キー。requestへのFK、note/actor/activity ID、shared、send_state、固定時刻/90日期限、算定版/課金額を持つ。投稿本文はrequestだけに保持し、public Noteへのcascadeを付けない。後続送信は台帳の同一行を更新し、削除側は作成集合を参照する。snapshot集合・coverage=fixed・root item成功・先頭 `ap.expand.page`（targetKey `start`, payload `{after:null}`）を同時確定する。空集合はページなしで成立する。

件数上限200000を超えたら一件も挿入せずrootをfailed_permanent/recipient_limitにし、coverageをunavailableとする。容量不足・SQL timeout・途中例外は全rollbackし、呼出側が既存retry契約で扱う。snapshot statementは20秒を上限とし、呼出側の短いstatement_timeoutを緩めない。成功後は元の設定へ戻す。20秒はsnapshot queryの上限であり、transaction全体の期限管理はworker組込み時に接続する。

通常90%のrow/byte枠に台帳全件と初回pageを追加課金する。台帳は512baseと保存可変識別子のUTF-8 bytes、既存4倍・1024丸め。保持・削除時は保存額を使う。pageは既存item算定を使い、元requestのdeadlineを延長しない。再実行でfixed集合を拡大しない。破損したfixed状態を空集合から作り直さず拒否する。

## 検証と境界

実DBで公開範囲別レシピ、重複、localOnly、関係変更、同時実行、削除取消、lease失効、破損payload、容量不足、例外rollback、commit前不可視・応答喪失後照会、上限超過、migration up/down/schemaを確認する。通常workerは引き続き未接続。dispatchはpageを投入できるが、既存local executionはpageを実行しないため、page claim/固定cursor照合は後続PRで実装してから起動へ接続する。#124全体を完了扱いにしない。
