# Local featured and AP Note publication: bounded results (#195, 2026-11-13)

Base: `0b5ab105952292ea1ac63ea54cefc638cbf88012` (PR #269 merged). Current product/source pin: `bcb828e878c5d14cb5be7b9ebf743fd452cca648`. Earlier reviewed product pin `b0d08179e20b98f0f1356d49e110f8fc0eb83d1f` comprised two ordinary commits, 23 files, +6881/-35. The earlier `210290` commit alone omitted the already tested `modules/federation/local-featured.ts`; the cancelled workflow produced no usable verdict. Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. See the [spec](../../specs/2026-11-13-local-featured-design.md) and [plan](../../plans/2026-11-13-local-featured.md).

The ordinary HTTP app publishes saved local pins at GET/HEAD `/users/:id/collections/featured` and AP GET/HEAD `/notes/:id`. All pin Notes are mandatory reads before filtering public/home and non-localOnly; pin ID order is descending without pagination. Featured embeds Notes and one local reply level (`dive=true`); Note GET and existing delivery explicitly use `dive=false`. Prepared facts preserve reply/author, quote, audience, mention/tag, file, poll, MFM and emoji acquisition/failure order before pure rendering. The two HTTP entries retain different negotiation, cache/header timing and redirect/error boundaries.

## Independent source and actual product receipt

The new [corpus](local-featured-corpus.json), [probe](local-featured-source-probe.mjs) and [observations](local-featured-observations.json) contain 100 finite cases (the original 98 retained and two Unicode redirect cases added). Literal pinned Git bytes, full-file SHA256, Git blob IDs and extracted method/block hashes establish provenance. The probe executes renderNote/renderOrderedCollection, featured/createServer/constraint/response-type handlers, MFM/media/ID/Utility helpers and the external AP redirect guard, using actual Fastify inject/accepts/vary. Repositories, cache, clock and other dependencies have explicit doubles. Expectations are independent of the new product implementation.

This is literal-method/Fastify-inject evidence with doubles, **not full upstream HTTP or PostgreSQL**. HTML frontend rendering belongs to #196 and is omitted; the new backend retains its existing 404 fallback without AP reads. Generic global server headers/HSTS and Fastify diagnostic error-body strings are outside the probe. Meta and local emoji reads use direct DB facts instead of source cache behavior; freshness/failure differences remain #217. The existing saved mention-order difference remains qualified, including the earlier delivery comparison's set projection.

The [current evidence record](local-featured-current-evidence.json) embeds the actual parent R3 receipt once, exact commands and log/artifact hashes, a finite 27-file subset and canonical 1,084-input map hash. It does not duplicate that map. The product/source subset and all available receipt logs and artifacts were independently hashed. Root metadata changed after R3 is a separate parent metadata-host gate, not R3 runtime coverage. Five predecessor identities come from immutable records and base Git bytes.

- R2 request: `/tmp/tiramiss-s1-r12-validation-request-r2.json`, SHA256 `e38359efbdbc7ee7b2216fbaec1781dcef3ab069a626778c093794f883e8f582`.
- R2 raw receipt: `/tmp/tiramiss-s1-r12-validation-receipt-r2.json`, SHA256 `349563567d2c943b4082c26798b99383dd236511cfe67429f00e17799d3c304d`.
- Canonical full input-map SHA256: `53f437bbb73cde52856665d723887443e3e349ec8dce5192497a3d9309df4da1` (sorted path keys, compact JSON, UTF-8).
- Actual overall window: `2026-11-13T08:45:07.807224+00:00` → `2026-11-13T08:45:36.570334+00:00`. Runtime: Node v26.4.0, pnpm 12.9.1. The broker recorded no per-command timestamps and verified frozen inputs before/after each command.

| Historical R2 command scope (exact commands in its request/receipt) | Result |
| --- | --- |
| `pnpm --filter backend-upstream sync:check` | PASS |
| `pnpm --filter backend-upstream test` | 5/5, 0 failed/skipped/cancelled/todo |
| `pnpm --filter backend-next... build` / `typecheck` | PASS / PASS |
| Selected local-featured RED/behavior, Note renderer/delivery and actor API units | 255/255, 0 failed/skipped |
| Real DB/listening HTTP local-featured, Note activity and actor integration | 202/202, 0 failed/skipped |
| Dedicated real DB migration/schema integration | 6/6, 0 failed/skipped |
| `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-featured-source-probe.mjs --check` | 98 cases, PASS |
| `node scripts/check-shipping.mjs --base 0b5ab105952292ea1ac63ea54cefc638cbf88012` | PASS |
| Separate composition unit command | 6/6, 0 failed/skipped |

These are distinct measurement scopes, not a full unit/process suite or a combined compatibility percentage. Actual new HTTP tests traverse actor featured URL → saved pin collection → linked Note GET and preserve stored rows; the schema run checks synchronized Entity availability and existing migration/schema behavior.

## Failure history and corrections

Product behavioral RED preceded implementation: `r12-red-r2.log` recorded three expected failures (reply embedding and both unregistered routes). Later lazy-order and redirect-guard RED/fix iterations, the literal ID codec fixture correction, initial infrastructure EPERM, lint failures and successful fixes are preserved in `/tmp/tiramiss-s1-r12-implementation-report.md`. Module-absence imports and infrastructure failures are not counted as behavioral RED or PASS.

Actual R1 `/tmp/tiramiss-s1-r12-validation-receipt-r1.json` is **FAIL**, SHA256 `699cf353af62866768aa0431bce097ef9dc427615473445c614d23ca23541983`. Its DB HTTP result is 198 passed / 202 total, four failed, zero skipped. The fixture inserted Meta without federation and inherited the real `none` default, causing 403 responses and the first actor JSON parse failure. Only tests were corrected to seed `all`; the production gate remained unchanged. Fail-fast left later R1 commands unrun. R2 is a separate explicit request/receipt after that fixture fix, not a hidden retry or rewritten R1 success. `/tmp/tiramiss-s1-r12-fix1-report.md` and raw R1 DB JSON/log preserve the four failures.

The parent corrected its earlier overbroad composition assertion ruling: extend the existing exhaustive enumeration by exactly two routes, keeping existing routes and other assertions. The user had not required immutable product assertion bytes or prohibited children in that earlier product request. This Task2 dispatch separately requires unchanged old root assertion files and no child workers; both are preserved.

## Current R3 and review follow-up

Parent R3 PASS binds 1,084 inputs, request `/tmp/tiramiss-s1-r12-validation-request-r3.json` SHA256 `9bc97e6e1c0e5657888576039aa785bafad70f2109eea617d19d0c04c61d3a1e`, receipt `/tmp/tiramiss-s1-r12-validation-receipt-r3.json` SHA256 `7692a6f923f5072ff2fd4d253437894a0324fade0bbaf56099bcf24ec64c6c36`; window 2026-11-13 09:13:50.847549–09:14:19.255022 UTC. Sync, upstream 5, build/typecheck, units 257, separate composition 6, real HTTP/PG 203, schema/migrations 6, literal source 100 and shipping passed, zero failures/skips. R2 above remains historical, before the Unicode defect was found.

The independent full review examined 23 files, 28 hunks and all original 98 cases and found a Unicode canonical-Link P2. The scoped fix review examined four files/five hunks and two new literal-source cases, finding P2 addressed, spec PASS and quality APPROVE. Original 98 inputs and expected observations match `b0d08179`; the incomplete Terra review and cancelled workers are not approvals. Both sides use accepts 1.3.8 and matching preference arrays; tie/wildcard equivalence was checked statically, not measured as new cases.

CodeRabbit reviewed 22 files and proposed one Minor cache-header change. The independent review rejected it: literal upstream sets Note cache headers before rendering, so Note render failure is 500 with `public, max-age=180`; featured render failure is 500 without cache headers. See [source](../../../../packages/backend-next/src/http/activitypub-notes-api.ts), `note-render-failure` and `featured-render-failure` in [observations](local-featured-observations.json), and the pinned `ActivityPubServerService.ts` handler. A current unfixed defect is not established by that proposal.

## Finite metadata proof and inventory

The new [leaf](../../../../scripts/local-featured-evidence.mjs) imports only Node, never ancestor evidence helpers or a recursive/global validator. Five actively checked changed files renew exact predecessor identities: federation renderer and database reader from the immutable tag record; federation public exports and composition unit consumer from the immutable WebFinger record; HTTP composition from that record's actual frozen subset. Each equals the base Git digest. New modules/tests/source artifacts are measured inputs without invented null predecessors. Unrelated identities pass through; unknown predecessors reject.

Old fields, image and WebFinger return projections remain unchanged. Explicit current-byte wrappers carry injected reads through the existing tag/profile/removal/image/WebFinger/fields chain into the finite hop. The validator checks exact current bytes, predecessor bytes, required actual measurements/counts/zero skips, source provenance, commands, times, hashes, semantic record identity and exact record bytes at the digest entry point. Available `/tmp` request/receipt/log/artifact bytes are verified; CI may omit those ephemeral files.

New tests were written first. The first RED exposed the real public-export identity mismatch through the existing tag/WebFinger chain as well as the absent leaf. Initial GREEN found a fifth active binding (`http-app.ts`) in the WebFinger frozen subset and a new test's incorrect assumption about which predecessor the image projection accepts; the finite binding and test were corrected from actual evidence/base bytes. Normal root then caught the historical image projection changing; an explicit current-byte wrapper restored that projection without changing old assertions. Final focused tests: 40/40, zero skipped. Raw attempts remain in `/tmp/tiramiss-s1-r12-metadata-{red,green1,green2,green3,green4}.log` and `-webfinger-local{1,2}.log`.

Inventory source changes affect exactly six audit rows and two HTTP overrides, all `partial`: `ap-module:ApRendererService`, `ap-render:renderNote`, `ap-render:renderOrderedCollection`, `entity:user_note_pining`, `responsibility:activitypub:06`, `responsibility:activitypub:40`, and HTTP IDs ending `ActivityPubServerService.ts:655` / `:734`. Entity owner remains accounts/#180; synchronization/read availability does not implement pin mutation. Other statuses, all 1,432 audit IDs/order, 2,119 contract IDs/order and 31 domain owners are preserved. Only the normal inventory generator may update `contracts.json`/`contracts.md`.

Local normal root execution and inventory `--write`/`--check` failed under sandbox `spawnSync git/node EPERM`; raw failures remain. After restoring projections, WebFinger's 35 direct cases and the new 40 direct cases pass, but those do not replace normal root validation. The frozen metadata request will include normal generator write/check, normal `node --test scripts/*.test.mjs` (old 271 plus new 40), inventory/product/history invariants, shipping and diff checks. At worker handoff, metadata host validation, final review and PR were pending; the subsequent parent metadata result is recorded below. The independent Task1 review and scoped fix review are recorded above. No gate approval is inferred from the product receipt.

Only the two normal generated inventory outputs may change during that metadata run. The request binds the prepared plan/results bytes; after the actual host receipt, the parent may append a factual validation stamp to this document and the plan. Those post-validation stamps are outside the measured executable proof and will not be represented as measured final document bytes. Code, source/test inputs, evidence record, helper/test assertions and inventory sources remain frozen.

## Remaining responsibilities

Local public featured does not ingest remote featured or remote Notes/collections, acquire the inbox object lock, process inbox signatures/activities, execute Move, or mutate pins via API/AP Add/Remove (#180). Outbox and other collection callers remain separate. Entity availability and read evidence are not pin management.

All five gap groups remain `media-emoji`, `instance-metadata`, `charts`, `rich-actor`, `remote-cache`: Drive/media fetching and byte serving (#188/#195), other instance callers (#215), chart (#200), remaining rich actor/remote featured/Move (#195/#199), cache/remoteUserUpdated (#217). #176/#127/#195/#215 stay OPEN; `notes/create:partial`, `postingComplete:false`. Formal shared roots → #176 → #195 inbox ordering and all domain ownership remain unchanged. Historical corpora, observations, receipts and prior result documents retain their original counts and scope.

CHANGELOG was not edited. Candidate: Fix: ActivityPubで保存済みピン留め投稿と公開Noteを取得できるようにする。

## Parent metadata validation stamp (2026-11-13)

The separate parent metadata gate passed on 1,101 frozen inputs: normal inventory `--write`/`--check`, normal `node --test scripts/*.test.mjs` **311/311** (old 271 + new 40, zero failed/skipped/cancelled/todo), all stated invariants, exact-base shipping and diff check. Window: `2026-11-13T09:26:46.284883+00:00` → `2026-11-13T09:26:57.298237+00:00`. Request `/tmp/tiramiss-s1-r12-metadata-validation-request-r1.json` SHA256 `2ae0d799dd4328b9d99dde7f41dd9d7828303a2e188a797701b73a014aa6e81e`; raw receipt `/tmp/tiramiss-s1-r12-metadata-validation-receipt-r1.json` SHA256 `9c8498f3c188eb06e167a7e4b1070939a191fd59c7702a72dd716db04c85f8cb`. The invariant program was already frozen by the worker request; the 17 parent-added artifacts bind that handoff and actual R3 request/receipt/logs/results.

Only the two normal generated inventory outputs changed during this run. Afterward, the parent appended factual status stamps to this document and the plan and corrected this document’s omitted-module path and R2 cross-references. Their exact measured preimages are retained in `/tmp/tiramiss-s1-r12-doc-stamp-preimages.json` and `/tmp/tiramiss-s1-r12-metadata-frozen-docs/`. These two final document byte sequences are not claimed as measured inputs; all executable metadata, current evidence, assertions and inventory sources remain unchanged. Final review/publication are separate gates after this timestamp.
