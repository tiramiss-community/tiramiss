# Chart core

### UF-017 空の過去区間では現在の最新行により既存totalの補間を失う

- 本家: [固定8e07cf0のcore.ts:687–707](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/core.ts#L687)。
- 内容: 要求区間に保存行が一つもなければ、時刻の上限なしで最新行を取得する。00時total10と03時total13があり01時以降の空区間を読む場合、03時行だけが補間材料となり、補間器は未来行を使わないため00時のtotal10も継承せず0を返す。
- 影響: データの少ない過去区間を読むと、以前のtotalが存在しても0として表示され得る。
- 新実装での扱い: 同じ挙動を引き継ぐ。#319で既存note chartのstoreをusersにも利用し、[固定source cursor観測](../../../../../../../superpowers/compatibility/users-charts/README.md)と照合する。上限を付ける改善は固定版との互換性変更になるため、この移植では行わない。
- 本家への報告: 未報告。

### UF-018 resyncは未flushのtotal差分をそのまま再適用する

- 本家: [固定8e07cf0のcore.ts:583–620](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/core.ts#L583)と[users.ts:47–66](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/chart/charts/users.ts#L47)。
- 内容: 登録後の+1がbufferにある間にresyncが実User件数1をtotalへ書くと、次のsaveはbufferの+1を適用しtotal2へ増やす。resyncはtick(true)を呼ぶだけでbufferを消去しない。
- 影響: 登録・削除のbufferがある状態のresyncでは、次のflush後にtotalが実行件数から再度ずれる場合がある。
- 新実装での扱い: 同じ挙動を引き継ぐ。resyncはcurrent totalだけを上書きし、保留中のtotal/inc/decは次のflushで適用する。#319のunitは絶対値保存にdiffがないことと、次回saveへ元の差分だけが渡ることを固定する。
- 本家への報告: 未報告。
