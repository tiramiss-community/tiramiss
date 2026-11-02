# AP配送の業務規則と削減後の引き継ぎ

#171/#160/#162で実際のAP表現・署名HTTP・通常BullMQを接続するための入力。
今回、未使用の配送実装は追加しない。固定本家は `8e07cf085adf7009583d234a208e30436f020e26`。

- [NoteCreateService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/NoteCreateService.ts)のローカル作者かつ非localOnlyの配送分岐を起点にする。remote mention・reply作者・renote作者がdirect候補、public/home/followersがfollowers対象、publicがrelay対象。channel等の入力補正と最新の連合条件も接続時に照合する。
- [ApDeliverManagerService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/ApDeliverManagerService.ts)はfollowersを先に処理し、Followingの非正規化sharedInboxを優先、なければindividual inboxをMapへ登録する。両方nullなら例外。directはsharedInboxが既登録なら省略、individual inboxがnullなら省略し、それ以外はindividual inboxへ登録する。同じURLでは後のMap更新が優先される。
- [RelayService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/RelayService.ts)はaccepted relayへ別copyのactivityを配送する。to欠落時のPublic補完とLD署名があり、followers/directの集合へ単純に統合・重複排除しない。
- [QueueService](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/QueueService.ts)の通常add/addBulk、AP既定12試行・backoff・履歴と、配送processorの停止host/連合条件/結果分類をその機能の実装時に比較する。永続snapshot/page/host leaseは初期前提にしない。

撤去した旧snapshotはdirect inbox欠落を全体拒否し、relayを同じ集合へ統合していた。
そのテストを本家互換性のoracleとして流用しない。新実装の比較には[固定N0観測](../superpowers/compatibility/note/README.md)と上記ソースを使い、追加の失敗・重複・連合条件を検証する。
旧protocolの設計根拠は[宛先固定設計](../superpowers/specs/2026-10-23-ap-recipient-snapshot-design.md)、実行コードはPR #212マージ時点までのGit履歴に残る。宛先規則の記録だけでAP配送の実装・互換性検証を完了扱いにしない。
