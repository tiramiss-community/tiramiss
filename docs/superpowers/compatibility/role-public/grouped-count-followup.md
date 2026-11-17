# 公開 Role 一覧の割当数取得の追補

CodeRabbit Web #617 の Minor（thread `PRRT_kwDONZTrjs64VWMZ`、comment4596998803）を、固定本家 `8e07cf085adf7009583d234a208e30436f020e26` と実 PG で検証した。本家 Role packer は各 Role へ COUNT を発行するが、業務上必要なのは Role ごとの有効割当数であり、並びは元 Role の取得順である。専用回帰では公開4件の割当取得が4クエリになる RED を確認した。

`listPublic` だけを TypeORM QueryBuilder の roleId ごとの `COUNT(*)` / GROUP BY へ変更した。取得した Role ID に絞り、期限なしまたは expiresAt > 基準時刻を数える。割当のない Role は0を補完し、元 Role 配列へ map するため repository の取得順を維持する。空一覧は空配列を返す。単件 show/admin show は従来の pack/COUNT 経路を維持し、既存 Role 応答/policy 補完も共用する。集計失敗は一覧全体の500であり、部分成功や書込を追加しない。

固定 source9件の再実行と同じ観測 JSON を使う通常 listening HTTP/PG 比較で、応答全体・非公開/未知・並び・期限前/等号/後・0件・空一覧・list/showの失敗境界を検査する。実 QueryRunner の logger 窓口でSQLを観測する回帰は、一覧に対する role_assignment 読取が1回であることを確認する。これはクエリ数の回帰であり、負荷試験や速度改善率の測定ではない。

同じ追補で CI の `role-application.test.ts` の旧2操作固定期待を再現し、現在の公開2操作＋管理2操作へ期待と名前だけを更新した。transactionを開かない既存の判定は維持する。CIの当該失敗を見なかったことにはせず、REDログを保存する。

新しい測定は [grouped-count-followup-evidence.json](grouped-count-followup-evidence.json) にコマンド・結果・実測前後の入力一致・REDログを記録する。原測定と過去のreceipt/fixture/実測件数は変更しない。広域全integration/CIの成功はこの追補の近接検証だけで主張せず、最新headのCIで別に確認する。
