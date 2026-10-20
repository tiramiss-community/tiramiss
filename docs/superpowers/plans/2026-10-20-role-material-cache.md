# Role material cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** #119 の期限付きRole材料キャッシュとRedis無効化通知を実装し、独立レビューを収束させてPRを作る。

**Architecture:** 合意済みRole詳細設計§6.2と互換性契約§5.4を実装する。プロセス内の取得キャッシュはRole全件とユーザー別割り当てのみ。Redis pub/sub は値を運ばず無効化を伝える。更新認可は既存のtx内DB参照を維持し、RoleChangesへ接続する。HTTPとID codecは#120。

**Tech Stack:** TypeScript, TypeORM, ioredis, Vitest, PostgreSQL/Redis.

**Spec:** ../specs/2026-10-16-role-policy-update-design.md §3.1/6.2; ../specs/2026-10-17-role-compatibility-contract.md §5.4/7.

## Global Constraints

- 旧backend・管理対象upstream・schema・localeを変更しない。
- TTLは取得開始から測定し、正の有限値。設定はbackendNext.roleCache.rolesTtlMs=30000、assignmentsTtlMs=30000、assignmentsMaxEntries=10000を既定とする。
- TTLに単調時計を用い、業務判断atMsと分離する。ユーザー別キャッシュはLRUで件数制限し、取得中も制限対象とする。
- Redisは必須。未購読・切断中の通常参照を拒否する。commit後の通知失敗は既存UseCaseが吸収する。
- 世代（エントリ同一性）により無効化済み・追い出し済み取得を再登録しない。進行中の呼出には取得値を返せるが共有キャッシュへ残さない。
- Redis購読readyごとにキャッシュを全破棄し、subscribe応答確認まで参照を拒否する。停止時も破棄し接続を解放する。
- ユーザー/設定は共有キャッシュへ追加せず、実効ポリシーは評価境界内だけにメモする。
- ユーザー指定により計画承認待ちで止めず実装・PRまで実行し、独立レビューは修正後も繰り返す。

## Review Focus

- 遅い取得がTTLを使い切ってから完了しても、新たな保持期間を得ない。
- 無効化・追い出し後に古い取得が成功/失敗しても新しいエントリを上書き/削除しない。
- reconnect購読確認前や切断中に、DBへの縮退で成功を返さない。
- 通知欠落と期限切れ、割り当て業務失効はそれぞれ独立して回復/評価される。
- 停止や再接続と競合する購読完了がキャッシュを再び利用可能にしない。

### Task 1: Bounded material cache and configuration

**Files:** create src/platform/role-material-cache.ts and test/unit/role/material-cache.test.ts; modify config/types.ts, config/load-config.ts and config tests (all under packages/backend-next).
**Interfaces:** Produces RoleMaterialCache with readRoles/readAssignments/invalidateRoles/clear, and validated RoleCacheConfig. Consumes async DB material readers and monotonic clock.

- [x] Write tests for start-based TTL, no sliding expiration, LRU/user isolation, clone isolation, invalidation/eviction in flight, slow failures and invalid config.
- [x] Run targeted tests; Expected: fail for missing cache/settings.
- [x] Implement cache and config with defaults above.
- [x] Run targeted tests and typecheck; Expected: PASS.

### Task 2: Redis lifecycle and runtime wiring

**Files:** create src/platform/role-materials.ts and src/platform/database/role-materials.ts; modify platform/connect-resources.ts and test/helpers/database.ts; create test/integration/role-materials.test.ts.
**Interfaces:** Consumes Task 1 cache/config. Produces openRoleMaterials with reads, RoleChanges, close, connected with runtime resource scope. DB reader uses upstream entities; publisher and subscriber both use redisForPubsub and explicit prefix in channel.

- [x] Write real Redis tests for cross-instance invalidation, missed notifications/TTL, in-flight race, reconnect clearing, fail-closed reads, failed publish and idempotent close. Use separate clients as process equivalents.
- [x] Run integration tests; Expected: missing adapter failure.
- [x] Implement dedicated subscriber startup/reconnect/cleanup and runtime wiring. Preserve unrelated existing connections.
- [x] Connect actual role update transaction and evaluation sessions to material cache; verify committed update/local memo invalidation and assignment expiry separately from TTL.
- [x] Run targeted integration, unit, build/typecheck and process suites; Expected: PASS.

### Task 3: Independent review, validation and PR

**Files:** update backend-next README and compatibility/role/README.md with settings, usage, evidence and #120 handoff.
**Interfaces:** Uses implemented cache/runtime contracts.

- [x] Independently review full branch using another agent. Fix actionable findings with regression tests and repeat review until no unresolved actionable findings.
- [x] Run shipping checks against develop, closest tests, sync:check, build/typecheck; Expected: PASS. No API/schema generation needed.
- [ ] Record evidence, commit and push feature branch; create PR using repository template with Closes #119.

## Execution record (2026-10-20)

- Task 1: cache/config tests RED→GREEN, 20 targeted cases PASS.
- Task 2: real Redis tests and actual DB update connected; dedicated pubsub publisher regression RED→GREEN.
- Review round 1: Important startup cleanup delay (ioredis default disconnectTimeout=2000) reproduced with half-open unresponsive TCP, fixed both added Redis connections with disconnectTimeout=0; regression RED→GREEN.
- Review round 2: reviewer independently reran unit20/integration28 and confirmed no unresolved Critical/Important/Minor. Fixed plan's primary-vs-pubsub wording and latest handoff status. ACK completion-delay/close coverage added.
- Final verification: sync:check, build/typecheck, unit130, integration38, process15, changed-file lint12, SPDX and locale safety PASS. See compatibility/role/README.md for environment and limits.
- User explicitly requested uninterrupted implementation/PR and repeated independent review. Feature branch in clean current checkout was used; no dependency changes. HTTP/ID codec assembly (#120) and end-to-end upstream comparison (#121) remain separate, per the existing issue boundaries.
- The last publication checkbox records the state before this commit; the resulting PR supplies the publication record.
