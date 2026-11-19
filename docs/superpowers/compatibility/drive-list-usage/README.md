# Drive lists and usage (#507)

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`; implementation base: `5fdc1702d2568c2df9dc2f33411fd11ecc35db04`. This closes the list/usage slice of #188; #188 and #114 remain open.

The ordinary HTTP composition provides `drive`, `drive/files`, `drive/folders`, `drive/stream` and moderator `admin/drive/files`. The common gate checks credential, suspension, current moderator eligibility and token scope before endpoint input. Personal queries always select the authenticated owner. Folder/file lists default to the root; stream spans folders. MIME matching, nullable parameters, default/max limits, exclusive ID/date bounds and ascending since-only pagination follow the fixed handlers. Personal file sorting overrides order while preserving ID bounds. Admin userId takes precedence over origin/hostname; hostname is an exact stored-host filter. Admin detail/UserLite and ordinary self/raw output reuse preloaded pure projections.

The usage reader counts persisted original size only when `isLink = false`, returns zero for empty selections, and supports user, punycoded/case-folded host, local and remote selectors. `drive` reads the current Role driveCapacityMb and converts MB to bytes. HTTP/PG tests change assignments, expire a Role, change instance defaults, delete records between pages and temporarily rename tables to verify actual database errors return 500 rather than empty results, partial pages or zero usage. The routes perform no writes and publish no events. No storage reservations or WebSocket channel are added.

`source-probe.mjs` checks exact upstream blob bytes and records SHA-256/Git blob identities before extracting the five actual endpoint schemas/handlers, QueryService pagination and four DriveFile usage methods. It runs those queries with actual TypeORM/PostgreSQL on an isolated temporary database against the corpus. All 111 observations are bound to the new real listening HTTP/PG tests (aggregate helper cases call the real reader). The probe's file/folder packers return selected IDs only, and Role policy returns capacity100; these are explicit doubles. It therefore proves selection/order/count parity, while existing #278/#279 projection comparisons and new selected-field admin HTTP assertions cover rendering. It does not start a full upstream server or prove full upstream common-gate equivalence. The AIDX source functions run with a fixed node ID/counter; date cases avoid ties at the cursor timestamp.

## Reproduce

Use the repository Node/pnpm versions. This run used Node24.20.0 (supported package engine), pnpm12.9.1 and dedicated Compose project `backend-next-507` with PostgreSQL55507, Redis56507 and pubsub Redis56508. No user infrastructure is used.

```sh
BACKEND_NEXT_TEST_DB_PORT=55507 BACKEND_NEXT_TEST_REDIS_PORT=56507 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56508 docker compose -p backend-next-507 -f packages/backend-next/compose.test.yml up -d --wait postgres redis redis-pubsub
UPSTREAM_ROOT=/path/to/pinned/upstream BACKEND_NEXT_TEST_DB_PORT=55507 node docs/superpowers/compatibility/drive-list-usage/source-probe.mjs --check
pnpm --filter backend-next test test/unit/drive/list-usage.test.ts test/unit/drive/files.test.ts test/unit/drive/folders.test.ts test/unit/shared/pagination.test.ts
BACKEND_NEXT_TEST_DB_PORT=55507 BACKEND_NEXT_TEST_REDIS_PORT=56507 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56508 pnpm --filter backend-next test:integration test/integration/drive-list-usage.test.ts test/integration/drive-list-source-http.test.ts test/integration/drive-files.test.ts test/integration/drive-folders.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-upstream sync:check
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 5fdc1702d2568c2df9dc2f33411fd11ecc35db04
```

The implementation pass records 104 near unit cases, 199 real HTTP/PG regression cases and the full unit suite (5,622 passed / one existing skip, 172 files) passing. The initial test-first HTTP check returned404 for missing routes. Setup failures (missing storedInternal fixture field and missing dedicated pubsub Redis) and a test cleanup TRUNCATE rejected by existing foreign keys were corrected before the successful run. The composition route assertion was updated after the full unit suite correctly caught its outdated route list. A sealed three-file predecessor uses the existing parallel-input mechanism; historical receipts remain unchanged and unknown byte drift is still rejected. Existing migration setup emits the pg concurrent-query deprecation warning.

The aggregate inventory responsibility is complete for these four selectors; other Drive service helpers, storage delivery, writes and the wider parent remain under their existing slices. No legacy metadata, Entity or migration changed, so legacy misskey-js generation and migration-schema validation are unnecessary. CI automatically discovers the new unit/integration files and uses the recorded source observations without requiring an upstream checkout.

CHANGELOG candidate: backend-nextでDriveの一覧・ストリーム・管理一覧とRole容量を反映した使用量照会を提供。
