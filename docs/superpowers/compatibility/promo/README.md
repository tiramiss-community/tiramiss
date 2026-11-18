# Promotion creation #542

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. Implementation base: `1613804464` (PR #634). This slice connects normal `POST /api/admin/promo/create` to current role authorization, input validation, Note lookup, duplicate detection and `promo_note` insert. Store the Note author (including remote authors), note ID and the supplied millisecond expiry. Existing and expired promotions both return `ALREADY_PROMOTED`; missing Notes return `NO_SUCH_NOTE`. Successful responses are empty 204. Private Notes do not add a visibility check. The source's separate existence/insert boundary and primary-key race failure remain; no upsert, transaction, new expiry constraint, audit event or background operation is added.

The module owns operation ordering and business errors; the TypeORM store exposes only Note identity/author and promotion operations. Composition evaluates current role facts; the endpoint declares moderator and `write:admin:promo` requirements. `PromoNote` is mechanically synchronized from the fixed Git object; the original migration history is unchanged.

## Comparison and limits

`source-probe.mjs` extracts the literal endpoint callback/schema/meta, literal `GetterService.getNote` and entity source. The manifest hashes identify all three pinned source files. `corpus.json` supplies 18 cases: public/private/remote author, past/zero/date-limit expiry, existing/expired duplicate, unknown Note, missing or malformed parameters, and Note/existence/insert failures. `observations.json` records controlled repository observations, consumed by the new module unit tests and ordinary HTTP/PG tests.

`--pg` executes the same literal callback and Getter with real TypeORM repositories against the dedicated test database. Integration tests compare its state/errors to normal listening backend-next HTTP for valid/duplicate/missing/input cases, missing Note/promo tables, and an invalid Date rejected on insert. Normal HTTP also exercises root/moderator/administrator, ordinary/expired/suspended roles, invalid credential, scoped token success/denial, auth-before-input ordering, PK/FK and Note deletion CASCADE. Neither source mode starts full upstream HTTP/auth infrastructure; exact internal DB messages/random diagnostic IDs are not compared. Existing common auth-gate behavior supplies HTTP authorization mapping. PG's invalid Date deprecation is intentional failure injection.

Timeline promotion selection and `promo/read` are outside #542. #194/#114, Note posting completeness and existing dependency order remain unchanged.

## Reproduction

Use Node26.4.0 (`/tmp/tiramiss-s1-node26/bin`) and pnpm12.9.1, independent worktree/node_modules, and dedicated Compose `sol-promo542`, PG62432/Redis62379. Never use `misskey-infra`.

```sh
export PATH="/tmp/tiramiss-s1-node26/bin:$PATH"
pnpm install --frozen-lockfile --filter backend-next...
BACKEND_NEXT_TEST_DB_PORT=62432 BACKEND_NEXT_TEST_REDIS_PORT=62379 docker compose -p sol-promo542 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test
BACKEND_NEXT_TEST_DB_PORT=62432 BACKEND_NEXT_TEST_REDIS_PORT=62379 pnpm --filter backend-next test:integration test/integration/promo.test.ts test/integration/migrations.test.ts
node docs/superpowers/compatibility/promo/source-probe.mjs --check
node --test scripts/*contract*.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 1613804464
```

Keep the specified Node at the front of PATH for every command. `current-evidence.json` records actual final logs/input hashes, including unsuccessful earlier runs. The additive predecessor projects only six exact changed inputs to their historical bytes; existing receipts are not relabeled as new measurements. Shared helper entrypoints remove this finite addition before earlier guards. Unknown bytes remain subject to those guards.

CHANGELOG candidate: backend-next supports moderator creation of promotion posts.

Final measured result: dependency build/typecheck, upstream sync5, source18, all unit5293/1 existing optional skip, real HTTP/PG/schema26, root808/1 existing optional skip, and shipping PASS. Root input hashes matched before/after the frozen run. Logs are under `/tmp/promo542-*`; the durable input/log hashes and unsuccessful run history are in `current-evidence.json`. Independent product review approved runtime `e13fc9364d`; proof delta and CLI/web review are separate gates.

The initial catalog used immutable R1 proof commit `ec99a6b97c`; R2 points to `3a2dbd3654`. Initial generation/check and inventory+promo contracts13 PASS; R2 generation/check and inventory+promo contracts14 PASS. The metadata-only catalog step follows the recorded frozen root measurement and does not claim that historical run included later catalog text.


## R2 review follow-up

The CLI review of 23 runtime files produced five minor test/docs findings. R2 exports Node PATH for the whole reproduction block, bounds source child execution to30s/SIGKILL, attempts each cleanup stage and aggregates errors, asserts all three pinned source paths/hashes, and rejects non-temporary or remote DB targets before connecting/clearing. The accepted PG name is the exact `createTestDatabase` convention `backend_next_<32 lowercase hex>` on loopback. Guard rejection is tested before any connection.

R2 typecheck/source18/HTTP-PG-schema26/nearest-contracts22/shipping PASS. Runtime source is unchanged. The byte-identical original `r1-current-evidence.json` retains the previous whole-unit and frozen-root measurements; those were not rerun or relabeled for R2. `current-evidence.json` records the R2 targeted logs/current input hashes and links the R1 archive. This follow-up does not claim a new full upstream server comparison.
