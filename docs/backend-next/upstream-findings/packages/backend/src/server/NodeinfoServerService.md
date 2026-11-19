# NodeinfoServerService

### UF-019 共有文書キャッシュがNodeInfoの版間で書き換わる

- 本家: [NodeinfoServerService.ts:127–167](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/server/NodeinfoServerService.ts#L127)
- 内容: 2.0と2.1が同じ10分キャッシュを使い、最初の取得版が `software.homepage` を決める。2.0は共有オブジェクトから `software.repository` を削除するため、その後の2.1でもrepositoryが欠落する。
- 影響: 同じ2.1 URLでも、直前に2.0を取得したか、どちらが最初にキャッシュを作ったかによってsoftware情報が変わる。
- 新実装での扱い: 同じ挙動を引き継いだ。[固定source HTTP比較](../../../../../../superpowers/compatibility/nodeinfo/README.md)で2.1→2.0→2.1と2.0→2.1を確認する。
- 本家への報告: 未報告。
