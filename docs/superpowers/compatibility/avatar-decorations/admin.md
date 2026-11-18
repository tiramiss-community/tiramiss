# Avatar decoration administration (#541)

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. The normal listening HTTP app now mounts `admin/avatar-decorations/create`, `update`, `delete` and `list`. The use case owns authorization and save/effect ordering; its narrow store uses the synchronized `MiAvatarDecoration` and existing moderation-log writer. User decoration attachment remains outside this issue.

Every operation requires credentials, the matching `read:admin:avatar-decorations` or `write:admin:avatar-decorations` app scope, and effective `canManageAvatarDecorations`. Root and administrator roles bypass the policy requirement; moderator alone does not. Suspension precedes the policy check, which precedes scope and input validation. Effective role evaluation reuses the existing role contract over current database materials. This does not claim the pinned RoleService's cache freshness is identical.

Name/URL must be nonempty strings; description may be empty. Restrictions preserve unknown IDs, order and duplicates in storage and admin output. URL syntax is not restricted. Category defaults to null; restriction IDs default to an empty array. Partial updates preserve omitted attributes and always set updatedAt, including a no-op update. The list validates upstream paging parameters but ignores them and returns all rows without ORDER BY. Absent update/delete IDs retain the pinned general internal error. There are no migrations or legacy API schema/misskey-js changes.

After persistence, each writer starts its matching `avatarDecorationCreated`, `avatarDecorationUpdated` or `avatarDecorationDeleted` notification and moderation log. Create/delete logs contain the full stored row; update contains before/after snapshots. Publication uses the existing connection configured by `redisForPubsub`, on the configured URL host and upstream internal envelope. HTTP success does not wait for these effects, matching source behavior. Accepted work is drained on HTTP shutdown and failures are diagnosed without changing saved success, including when diagnostics themselves throw. No durable notification/retry guarantee is added. Cache invalidation remains asynchronous, retaining #368's in-flight refill behavior.

## Executed comparison

`test/helpers/avatar-decoration-source.ts` checks fixture SHA256 before executing literal pinned service methods, endpoint callbacks, the `miRepository.insertOne` method from `models/_.ts`, and the credential/policy/scope block from `ApiCallService.ts`. Complete service/endpoint files and exact repository/access excerpts live under `test/fixtures/avatar-decoration-admin`. The source insertOne runs its original insert→findOneOrFail against real PostgreSQL. Source methods receive explicit ID/time bindings; events and log calls are captured, while new-backend events/logs use actual Redis and PostgreSQL. This compares the source callbacks/service/gate, not a booted upstream Nest HTTP server. Source `getAll(true)` is supplied the actual repository's fresh find; the cache implementation itself retains the separate #368 comparison.

The HTTP test compares source create/update/list/delete responses, full event payloads, all three audit payloads, missing IDs and create write failure. Independent Redis subscribers/cache readers prove the real writer events invalidate another reader. Public retrieval observes the saved update with its existing role filtering. Additional HTTP tests exercise defaults, no-op update, all-row list, root/admin/policy/moderator/expired/suspended actors, delegated scopes, invalid credentials, malformed input, unsupported GET and event failure/shutdown drainage.

```sh
BACKEND_NEXT_TEST_DB_PORT=55541 BACKEND_NEXT_TEST_REDIS_PORT=56541 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56542 pnpm --filter backend-next test:integration test/integration/avatar-decoration-admin.test.ts test/integration/avatar-decorations.test.ts
pnpm --filter backend-next test test/unit/avatar-decoration test/unit/composition/http-app.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
node scripts/check-shipping.mjs --base db1f3652fb
```

Dedicated Compose project `tiramiss-541` uses PG55541/base Redis56541/pubsub56542/Meili58541 with randomly named test databases. Earlier failed fixture runs are retained in `/tmp/541-integration{,2,3}.log`: an empty TypeORM update criterion, a source-method async wrapper and TypeScript 6's default strict prologue were test harness issues. No failed/skipped run is counted as success. Routine pg concurrent-client deprecation warnings are inherited from startup.

CHANGELOG was not edited. Candidate: “backend-next: アバターデコレーションの管理 API と変更通知・監査ログを追加”. Parent #194/#114 and cache producer coverage #582 remain separate work.

2026-11-19 final validation: ordinary HTTP/PG/Redis 24 tests in two files PASS (`/tmp/541-integration-final.log`), including 15 admin tests and nine existing public/cache tests. All backend-next units: 164 files, 5,550 PASS and one existing SKIP (`/tmp/541-all-unit.log`). Dependency-order build/typecheck, changed-file lint/SPDX/locale PASS (`/tmp/541-{build,typecheck,shipping}-final.log`). These executions are finite comparisons, not proof of parent-domain completion or a full upstream HTTP runtime.
