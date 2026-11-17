# 公開 Role 集計の配列 parameter 追補

`e766ff4bfe9ce53e1970fceb37cc6f8787d6c993` の一覧一括集計に対する独立レビューで、IN の配列展開が Role 件数に比例した bind を生成する点を確認した。実 TypeORM metadata と production reader の QueryBuilder を使い、DB へ送る直前で実行だけを止める回帰で、65,535 Role が65,536 bindになる RED を再現した。原方式にはなかった parameter 上限由来の失敗を導入するため修正する。

変更は条件を `assignment.roleId = ANY(:roleIds)` とする1行である。取得済みの Role ID 集合を単一の PostgreSQL 配列 parameter、期限の基準時刻をもう1 parameter として渡す。新たな一覧上限・chunk・別取得・validator/cache変更を追加しない。GROUP BY と期限なし/基準時刻より後の条件、元 Role の並び、0補完、空一覧、失敗時の500、単件 pack は維持する。

非DBの QueryBuilder 回帰は0/1/65,535 Roleを扱い、空一覧では集計実行なし、非空では配列＋時刻の2 bindを検証する。これは実 parameter 生成の試験であり、65,535 Roleを実PGへ投入した負荷・容量試験ではない。通常 listening HTTP/PG24件は実driverへ同じ配列条件を送り、一覧の割当読取1回と配列/時刻の実parameter、固定本家 JSON との応答全体・期限/0/空/失敗を照合する。

新測定は [bounded-bind-followup-evidence.json](bounded-bind-followup-evidence.json) に記録する。元のCOUNT一括化のRED/成功記録、固定source/corpus/観測値、旧receiptは変更しない。今回の局所修正の成功を、過去の単独/合成/CI測定の入力へ付け替えない。
