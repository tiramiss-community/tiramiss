# Promotion reads — #530 limited slice

Fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`; implementation base `706f82eb20`. This slice adds normal `POST /api/promo/read`: credential and `write:account` authorization, Note existence, viewer-specific existing-read lookup, and insert with a generated ID. Duplicate reads return empty 204 without changing the existing ID. Missing Notes return `NO_SUCH_NOTE` (`d785b897-fcd3-4fe9-8fc3-b85c26e6c932`). Private/followers-only and unpromoted Notes retain the source's lack of a visibility or PromoNote lookup. Separate existence/insert operations retain unique-key race failure; no transaction/upsert is added.

`PromoRead` is mechanically synchronized from the fixed Git object, using the existing full upstream migration history. The business module owns sequencing and authorization; TypeORM remains in the store and ID/role/auth wiring in composition. Existing promo HTTP mounting is reused.

## Evidence and limits

`source-probe.mjs` extracts the literal pinned endpoint callback, schema/meta and `GetterService.getNote`, and binds their hashes plus the PromoRead entity source. Fourteen finite cases cover public/private/followers/unpromoted Notes, duplicate, another viewer, missing Note, malformed input, and note/existence/insert failures. Controlled repositories and deterministic IDs are explicit doubles. `--pg` runs the same callback/Getter with real TypeORM repositories in an isolated migrated test DB; it rejects non-disposable names and remote hosts before connection. Connection options are copied explicitly; unknown keys and nonempty `extra` are rejected before connection. Rows are compared by `(noteId,userId)`, and only generated IDs are normalized.

The integration suite uses the normal listening backend-next HTTP app, real tokens, PostgreSQL and Redis. It compares saved state/error codes with the pinned callback/PG execution; checks credential/suspension/scope-before-input, ordinary user and scoped write success, DB read/existence/insert errors, unique viewer/Note constraint and Note/user CASCADE. Exact internal DB messages/random error IDs and full upstream HTTP/auth infrastructure are outside this measurement. No upstream full server is claimed.

`compatibility-predecessor.json` projects only five exact mechanically synced/metadata-test/route-test inputs to their previous bytes for historical receipts. Unknown input drift is passed to existing guards; old evidence is unchanged.

This implements only promo/read within #530. Pinned users await detailed-user support #297; #530/#193/#114 remain open. Timeline promotion selection is outside this slice; admin creation is the separate #542 result.

## Reproduction

Use repository-supported Node and pnpm. Install isolated dependencies and start only the dedicated Compose project:

```sh
pnpm install --frozen-lockfile --filter backend-next...
BACKEND_NEXT_TEST_DB_PORT=63432 BACKEND_NEXT_TEST_REDIS_PORT=63379 docker compose -p sol-promo-read530 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/promo-read.test.ts test/unit/promo.test.ts
BACKEND_NEXT_TEST_DB_PORT=63432 BACKEND_NEXT_TEST_REDIS_PORT=63379 pnpm --filter backend-next test:integration test/integration/promo-read.test.ts test/integration/promo.test.ts test/integration/migrations.test.ts
node docs/superpowers/compatibility/promo-read/source-probe.mjs --check
node --test scripts/*contract*.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 706f82eb20
BACKEND_NEXT_TEST_DB_PORT=63432 BACKEND_NEXT_TEST_REDIS_PORT=63379 docker compose -p sol-promo-read530 -f packages/backend-next/compose.test.yml down
```

`current-evidence.json` records measured commands, log hashes and input hashes. API type regeneration for the legacy backend is skipped: its metadata/schema have not changed; the new API reproduces the existing upstream contract. No CHANGELOG was edited. Candidate: backend-next supports viewer-specific promotion read tracking.

Initial build/typecheck, upstream5, source14, near-unit32 and real HTTP/PG/schema41 passed. The helper follow-up passed source14, normal HTTP/PG15, entity import1 and catalog/nearest-root17. R1 evidence is archived byte-for-byte. A broad root run passed817/skipped1 (818 total) before the final fourth metadata-test projection was added; nearest17 and import1 cover that final addition. Independent Codex review confirmed the helper connection boundary fix. The initial exploratory root run failed136 before finite successor wiring; its log is retained and is not claimed as a successful measurement.

CI follow-up: the first full unit run found the canonical composition route inventory still lacked `/api/promo/read` (one failed,5349 passed,one existing skip). Added that route and its credential gate assertion, extending the finite predecessor to five inputs. The final local full unit run passed5350/skipped1 across156 files; targeted composition/promo/import49 and root23 passed. Product runtime is unchanged. `r2-current-evidence.json` preserves the preceding receipt byte-for-byte.
