# Avatar decoration public read and cache (#368 / #367)

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. Normal HTTP now serves `POST /api/get-avatar-decorations` through the common API gate. It returns only id, name, description, URL, role restrictions and nullable category. The repository has no ORDER BY, matching the source: the response preserves the supplied row order without promising a database sort order. Role restriction order and duplicates are retained; unknown roles are removed. Guests see public role IDs, while authenticated callers see all existing role IDs, regardless of assignments. Missing visibility metadata fails closed for guests.

The source endpoint calls `getAll(true)`: every public request invalidates and refreshes the process cache. The shared reader's normal `getAll()` retains the source's thirty-minute TTL, valid at exactly 1,800,000 ms and expired one millisecond later. TTL starts when a read completes. Empty lists cache successfully; failed reads are not cached. Forced reads clear the old value before querying. Concurrent misses remain independent and an in-flight read may refill after a change event, as in the pinned MemorySingleCache.

`avatarDecorationCreated`, `avatarDecorationUpdated` and `avatarDecorationDeleted` on the existing shared internal-event transport clear the cache without trusting their payload. Cache close unregisters its consumer, rejects new reads and drains accepted reads; it does not own or close Redis. The normal resource scope owns close. The existing role-material cache supplies role definitions and its existing invalidation/failure rules apply. This does not establish the pinned RoleService's one-hour cache freshness; stable persisted roles are compared here. Decoration admin writers and their real publication proof remain #541 / #582 under #194 / #217. User packing continues using its existing decoration reader; this PR does not claim that all User display consumers now use this cache.

## Comparison and reproduction

```sh
node docs/superpowers/compatibility/avatar-decorations/source-probe.mjs --check
pnpm --filter backend-next test test/unit/avatar-decoration test/unit/composition/http-app.test.ts
pnpm --filter backend-next test:integration test/integration/avatar-decorations.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
node scripts/check-shipping.mjs --base origin/develop
```

The source probe reads Git objects at the fixed SHA, records complete SHA256 for AvatarDecorationService, MemorySingleCache and the endpoint, and executes the literal getAll/onMessage/cache methods and endpoint callback. Repository and RoleService doubles supply explicit rows and roles. [Two projections and nine cache observations](observations.json) are directly consumed by new implementation tests. This is a source-method comparison, not an upstream full-server or PostgreSQL run. Normal new-backend listening HTTP tests use actual PostgreSQL rows, token authentication and Redis publication. Common API authentication/error formatting is inherited and smoke-tested, not independently compared to a full upstream HTTP server in this slice.

2026-11-19, Node v24.20.0 / pnpm 12.9.1. Dedicated Compose project `tiramiss-b368` uses PG55368 / Redis56368 / pubsub56369 / Meili58368 and randomly named test databases. Initial fixture runs failed because Role required timestamps/description were missing. The next run caught assertions that incorrectly assumed PostgreSQL retained tuple order after UPDATE; these assertions now locate the affected ID. The production reader remains unsorted, matching source. A common-gate smoke assertion was corrected from403 to the existing401 authentication result. Historical failed logs remain in `/tmp/b368-integration{,-r2,-r3}.log`.

- Source-method replay: 2 projections + 9 cache observations PASS.
- Focused unit: 31 tests, 3 files PASS (`/tmp/b368-unit-r5.log`).
- Actual HTTP/PG/Redis: 9 tests PASS (`/tmp/b368-integration-r4.log`), including guest/private-role filtering, forced public refresh, all three notification types, warm-cache DB failure, forced-read failure and recovery, invalid credentials, unsupported GET and empty list.
- Dependency-order build/typecheck PASS; changed-file lint, SPDX and locale safety PASS. No entity or migration changes; no legacy API schema or misskey-js generated type changes.

CHANGELOG was not edited. Candidate: “backend-next: アバター装飾の公開取得と変更通知に対応する共有キャッシュを追加”. #531 remains unchanged pending users-chart #319; #193 / #217 / #114 and admin writer proof remain open.

The parent-provided shared resource formatting commit `bb1822c301` is an actual ancestor. The final implementation shape was rechecked in `/tmp/b368-{unit,integration,build,types,shipping}-final.log` with unit31 / listening HTTP9 / build / typecheck / shipping PASS. Adjacent shared HTTP, Meta and internal-event integration passed7 in three files, with transport/Meta unit8 in two files (`/tmp/b368-shared-{integration,unit}.log`). These separate executions are not added to the finite source-method observation count.

[compatibility-predecessor.json](compatibility-predecessor.json) and its sealed descriptor preserve only exact prior bytes for three shared runtime/composition inputs. The resource file projects to the actual shared formatter parent, then its parent record projects to `63854ab4c0`; the HTTP composition and its route-list test project directly to `63854ab4c0`. This is historical-input continuity, not renewed execution of historical receipts. Unknown byte changes retain the historical drift checks.
