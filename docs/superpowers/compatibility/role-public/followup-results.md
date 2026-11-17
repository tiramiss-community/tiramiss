# 共有証跡入口の追補

最初の runtime/source 測定は `ae37f95aa52d978d47b665433d06c66018a34825` と [current-evidence.json](current-evidence.json) に保持する。その後の広域 root contract で、追加した workflow docs paths の有限復元と、Page/public Role/Entity projection を直接呼ぶ入口への接続漏れを検出した。初回は784件中624成功・159失敗・既存1skipだった。成功へ読み替えずログと入力の範囲を区別する。

修正は次の正確な byte に限定する。既存receipt、cache/validator設計、上限は変更しない。

- Role の route assertion を、公開 Role の直接入口・Page の直接入口でも復元する。
- Announcement 単独と Role 合成の root/route assertion を、それぞれ確認した hash と patch から復元する。
- Announcement Entity 2件と metadata test を、PageLike の直接入口でも復元する。
- workflow の role-public / announcements docs path 2件を push / pull_request それぞれから除去し、従来の workflow hash を確認する。既存のraw workflow検査もこの明示的な段を通す。

近接67件、および宣言した合成byteを実ファイルへ配置した隔離fixtureで Role contract3件が成功した。この合成fixtureは製品の実HTTP/PG試験ではなく、byte projection の直接入口と未知drift拒否の試験である。

[followup-evidence.json](followup-evidence.json) は修正入力の前後一致を確認した新規の独立測定で、全 root contract784件中783成功・失敗0・既存1skipとshipping成功を記録する。原測定のproduct入力や測定結果を付け替えない。後続Announcement製品修正の追加variant・最終合成測定は、それぞれ後続receiptで区別する。

Announcement の publish 失敗修正後の root `b54091a0049aa30a888c72227f5a3e568156eabb4804b11fd3b34a7ca9ed853d` は、[追加の固定variant](announcement-fix-predecessor.json) と [別測定](announcement-fix-variant-evidence.json) に分離した。旧variantと旧proofを保持し、近接68件・新しい宣言合成実ファイルfixture4件・shippingの成功と前後入力一致を記録する。新variant後の全root成功はここで再主張せず、取りまとめ担当の最終合成測定と各PR最新headのCIで確認する。
