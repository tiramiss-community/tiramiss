# Drive folders #278

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. Current product: `bf0ef2115e` (current revision/input digests in `pubsub-fix-evidence.json`; initial published record remains `current-evidence.json`). Parent #188 and overall #114 remain open.

The five owner-scoped APIs `drive/folders/create`, `delete`, `find`, `show`, `update` are connected through ordinary HTTP composition, current token/Role facts, TypeORM CRUD and the existing configured Pub/Sub publisher connection. Basic pack serves create/update/find; show gathers each ancestor and its direct folder/file counts before pure recursive projection. Ancestors and counts follow source filtering: ownership is checked on the initial/chosen folder, ancestors load by ID and counts include all owners. Update preserves omitted parent, detaches explicit null and ignores empty name. Exact source error UUIDs and all three Drive event bodies are retained.

Create consumes the authenticated actor's production 10/hour window before suspension, permission and input checks, with current Role `rateLimitFactor`; factor zero skips the limiter. Moderator status alone does not skip it. Redis limiter failure prevents the write. Saving/deleting must succeed before publication starts. A publication failure is logged without undoing the stored row or HTTP success. Normal response does not wait for publication. Existing HTTP shutdown first drains accepted handlers, then waits for pending folder publications before resource release; a write paused across close proves that later-started publication is included. The same order holds when other HTTP drainers reject: after all work settles, one original error is preserved or multiple original errors are aggregated. This extends the repository's established shutdown drain to this producer without a new durable job or retry contract.

`corpus.json` has 57 finite folder cases. `source-probe.mjs` verifies exact fixed Git blobs, extracts literal source handlers/Ajv schemas/packer/aidx parser, and records returned values, error codes/UUIDs, stored rows and event calls. Repository behavior, generated ID and captured publication are doubles. Five additional literal `ApiCallService.call` limit/suspension/scope branch observations pin combined ordering; these are connected to new-runtime unit cases. No source full-server/PG/Redis parity is claimed.

New-runtime tests exercise actual listening HTTP, migrated PostgreSQL and Redis pub/sub. The folder integration file plus existing HTTP-root file has 70 cases; near units plus existing composition/drain tests have78; the2 real TCP shutdown regressions are in the process lane, with pure pending/failure cases in unit. They include source-shaped row/result/event comparisons, schema and migration history checks, save/delete faults, missing-ancestor read fault, native/app/MiAuth permissions, rate ordering and factors, Redis failures and delayed publication shutdown. Folder comparison IDs carry distinct timestamps at each ancestor level. One source double case accepts 200 characters; real PG retains the upstream varchar(128) boundary and independently verifies128/129. Orphan source cases are unit doubles; the real test injects a missing ancestor read without weakening FKs. Existing migration setup emits pg's concurrent-query deprecation warning.

## Reproduce

Use repository Node/pnpm versions. Start a dedicated Compose project; this run used `s1-folders278-20261115`, PG16551 / ordinary Redis16552 / Meili16553 / Pub/Sub Redis16554. Never use `misskey-infra`.

```sh
UPSTREAM_ROOT=/path/to/fixed-upstream node docs/superpowers/compatibility/drive-folders/source-probe.mjs --check
pnpm --filter backend-next test test/unit/drive/folder-drain.test.ts test/unit/drive/folders.test.ts test/unit/composition/http-app.test.ts test/unit/http-drain.test.ts
BACKEND_NEXT_TEST_DB_PORT=16551 BACKEND_NEXT_TEST_REDIS_PORT=16552 BACKEND_NEXT_TEST_MEILI_PORT=16553 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=16554 pnpm --filter backend-next test:integration test/integration/drive-folders.test.ts test/integration/http-app.test.ts
pnpm --filter backend-next test:process test/processes/drive-folder-drain.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-upstream sync:check
node --test scripts/drive-folders-contract.test.mjs scripts/drive-folder-pubsub-contract.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs
```

CI already discovers the new unit, integration and `*-contract` tests. It uses frozen source observations; regenerating them requires the fixed upstream checkout. The initial published `current-evidence.json` stays byte-for-byte historical at runtime `c5b6b9574fbaf47340b766f9e11b69dc0b67c5c4` (20 inputs, near78, real integration68, source57, full unit4353/115). Its original predecessor remains unchanged. The separate `pubsub-fix-evidence.json` binds24 unchanged inputs at `bf0ef2115eb202250713800c61c26e5af32f4952`: build/typecheck, near78, actual HTTP/PG/two Redis integration70, process2, source57, sync, shipping and full unit4353/115. Available raw logs are checked against their hashes.

The review fix reuses `postingStream.drive`, which is already backed by the connected/monitored/closed `redisForPubsub` publisher. The quota stays on ordinary Redis. An actual split-server regression first failed with a missing event; current tests verify the destination envelope and silence on ordinary Redis, plus the default shared-server configuration. Only integrationCI adds the second Redis test service; no product configuration or connection is added. HTTP lifetime regressions use the process lane, and unit tests exercise publisher pending/failure behavior without TCP.

A finite seven-file preimage restores the measured initial folder inputs and changed shared publication/test-infrastructure bytes before historical readers use them. The original two-file initial projection then restores older composition inputs. This adds bounded validation of24 current inputs per initial folder-receipt validation; historical measurements are neither rewritten nor promoted. Drive channel subscription is still excluded.

## Limits and remaining owners

- The shared gate/config has no `enableIpRateLimit`, `trustProxy` or client-IP model yet. Anonymous create returns credential-required without the source's optional/default-enabled IP window. This existing shared limitation belongs to API common #178 and boot/config #138; the authenticated folder limit is implemented here. Full ApiCallService parity is unproved.
- `DriveFolderEntityService.packMany` hint/memoization paths are not called by these five source APIs; packer inventory remains partial. Folder listing/paging and Drive channel subscription are excluded by #278 and remain with #188/#185/#189.
- Ordinary concurrent writes retain the source behavior; [UF-011](../../../backend-next/upstream-findings/packages/backend/src/server/api/endpoints/drive/folders/update.md) records the confirmed lost-update boundary. Publication failure has no replay guarantee. The source handler permits200-character names while PG stores128; [UF-010](../../../backend-next/upstream-findings/packages/backend/src/server/api/endpoints/drive/folders/create.md) records the retained boundary.
- No misskey-js generation or migration change: old backend metadata and synchronized Entities/migrations are untouched. CHANGELOG candidate: backend-nextでDriveフォルダーの作成・検索・参照・更新・削除と変更イベントを提供。
