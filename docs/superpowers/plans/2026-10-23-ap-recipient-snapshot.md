# AP recipient snapshot implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation; independent agent review before shipping.

**Goal:** 作成APの宛先集合・初回page・root成功をDBで同時確定する。
**Architecture:** caller-owned transactionに結び付いたsnapshot adapter、単一CTEによる候補固定、既存claimと容量の条件付き更新。
**Tech Stack:** TypeScript / TypeORM / PostgreSQL / Vitest。
**Spec:** [設計](../specs/2026-10-23-ap-recipient-snapshot-design.md)。

## Global constraints

- upstream固定SHAを変えずFollowing/Relayをmanifestから同期。managed source手編集禁止。
- 最大200000宛先、snapshot SQL最大20秒、保持90日、通常容量90%、deadlineは元requestを維持。
- Delete/Undo、page実行、HTTP送信、通常worker接続は今回の範囲外。

## Review focus

- localOnly/specifiedがfollowers/relayへ流出しないこと。
- shared/direct重複と欠落remote材料を成功扱いで切り捨てないこと。
- 途中障害、容量不足、取消、lease失効で部分集合が残らないこと。
- commit後の関係変更で固定集合を拡大しないこと。
- page deadline/ID/課金とmigration rollbackの整合。

## Task 1: snapshot adapterと台帳

Files: upstream-sync.json（Following/Relay）、database/ap/schema.ts・migration.ts・snapshot.ts、database登録、test/integration/post-work-ap-snapshot.test.ts、README。
Interface: `PostApRecipientSnapshot.complete(manager, claim, recheck): Promise<{count:number}>`。

- [x] RED: 実DBの台帳存在検査が失敗することを確認。
- [x] Entity同期、新schemaと新migrationを生成し、登録。schema/migration検査を通す。
- [x] RED: 実followers/direct/relayから固定しpageを同時生成するテストを失敗させる。
- [x] adapter実装。上記Review focusのテスト、20万件超過・migration up/downを含め実行。
- [x] 独立レビューの指摘を検証して修正し、再レビューで収束。
- [x] 依存順build/typecheck、unit/結合、sync検査、shipping検査を通す。
- [ ] READMEに実装範囲/未接続を記録し、commit/push/PR作成。
