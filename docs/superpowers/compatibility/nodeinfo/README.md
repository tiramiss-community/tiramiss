# NodeInfo 2.0/2.1 and discovery (#531)

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. Base: develop `db1f3652fb832889bf2e34575420a6ff61477041`, which already includes [host-meta and common well-known responses](../well-known/README.md). This completes the remaining #531 endpoints through the normal HTTP composition: `GET`/`HEAD /nodeinfo/2.1`, `/nodeinfo/2.0` and `/.well-known/nodeinfo`. It does not complete parent #193 or the wider migration.

Documents read the saved hourly notes chart, saved hourly users chart, fresh Meta (`fetch(true)`), then the existing proxy system-account capability, in that order. Local totals come from charts rather than direct table counts; buffered chart updates remain subject to the existing flush behavior. Proxy creation uses the existing isolated transaction and writes the user, profile, keypair, used username and system-account relationship. No schema, migration, dependency or API type-generation change is required.

The endpoints preserve the pinned shared mutable ten-minute cache, including these externally visible behaviors:

- A hit at exactly 600,000ms remains valid; a later hit refreshes. Expiry is measured from completed generation. Failed generation is not cached. Concurrent cold misses run independently.
- The first version to fill the cache determines `software.homepage`: 2.1 uses `repositoryUrl`; 2.0 uses `https://misskey-hub.net`. Reading 2.0 deletes the cached `software.repository`, including for subsequent 2.1 reads. This is recorded as [UF-019](../../../backend-next/upstream-findings/packages/backend/src/server/NodeinfoServerService.md).
- Documents remain available when `federation=none`. Discovery instead returns empty403 and otherwise advertises 2.1 before 2.0. Discovery has no document cache or HTTP Cache-Control.
- Successful documents include the version-specific JSON profile, UTF-8 charset, public max-age600 and the four discovery CORS headers. Document OPTIONS retains the existing404. The existing well-known wildcard handles discovery OPTIONS204 without reading Meta, including during DB failure.

The renderer exposes all pinned metadata fields, policy defaults/overrides, nullable values, empty strings, repository URLs, registration settings, captcha/email/service-worker settings and the 3,000-character note limit. Active-user counts remain null and localComments0 as upstream.

## Comparison and limits

[observations.json](observations.json) contains 36 listening HTTP observations: 27 document observations and9 discovery observations. [source-probe.mjs](source-probe.mjs) checks Git bytes against the pin for six source files, transpiles the literal NodeinfoServerService methods, MemorySingleCache, WellKnownServerService method and XML helpers, and uses the actual pinned policy defaults and note limit. It runs real listening Fastify with explicit chart, Meta and proxy doubles. It is not an execution of the full upstream application or upstream PostgreSQL; system-account persistence is verified on the new implementation separately.

Unit tests compare selected headers, full successful JSON bodies, read order/arguments and source observation sequences. Coverage includes version order, HEAD-first generation, the exact cache-expiry boundary, null metadata/repository and empty theme color, federation none, and each sequential read failure followed by recovery. A controlled concurrent-miss test checks the existing uncoalesced behavior.

The normal listening HTTP/PG suite compares the version sequences against the same source corpus using real saved chart rows, persisted Meta and actual lazy proxy creation. It checks discovery CORS, successful document generation with federation disabled, and each cold DB-read failure by temporarily renaming one table in the test-owned random database. The same HTTP app recovers after table restoration; a warm document remains available during those failures.

Error bodies retain the existing backend-next WebFinger/host-meta boundary: empty500 and a constant structured `nodeinfo.failed` diagnostic identifying the stage, without the underlying exception. The literal source emits Fastify JSON `{statusCode:500,error:"Internal Server Error",message:<injected error>}` and JSON Content-Type for the injected faults; framework-specific error/404 bodies and their Content-Type are excluded from equality, and the new empty body is asserted explicitly. Source failure inputs are doubles; the implementation DB-failure checks do not establish upstream DB-failure equivalence. Stable-Meta discovery checks inherit the existing cache's freshness behavior and do not establish cross-process notification latency. Existing OAuth/password business implementations remain outside scope; their registration-order/common-header regression tests are retained by the earlier well-known suite.

The two shared composition changes are recorded in [compatibility-predecessor.json](compatibility-predecessor.json) and registered with the existing `parallel-inputs` mechanism. Only the exact added NodeInfo import, mount, route assertion and composition test are projected to their original bytes. Unknown changes still reach the existing drift guards. Historical measurements and receipts are not renewed.

## Reproduce

Use the package guide's isolated dependency installation and dedicated PostgreSQL/Redis project. For the source replay, set `UPSTREAM_ROOT` to a checkout at the pin; installed dependencies can be supplied separately with `UPSTREAM_DEPENDENCIES_ROOT`.

```sh
UPSTREAM_ROOT=/path/to/pinned-upstream UPSTREAM_DEPENDENCIES_ROOT=/path/to/dependencies node docs/superpowers/compatibility/nodeinfo/source-probe.mjs --check
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test test/unit/federation/nodeinfo-api.test.ts test/unit/composition/http-app.test.ts test/unit/federation/well-known-api.test.ts test/unit/federation/webfinger-api.test.ts test/unit/federation/local-webfinger.test.ts test/unit/chart
pnpm --filter backend-next test:integration test/integration/nodeinfo.test.ts test/integration/well-known.test.ts test/integration/webfinger.test.ts
node --test scripts/*-contract*.test.mjs
node scripts/check-shipping.mjs --base db1f3652fb
```

Local results are recorded below after final verification. CHANGELOG is unchanged; candidate: “backend-next: NodeInfo 2.0/2.1とdiscoveryを追加”.

2026-11-19 local product validation used Node v24.20.0 / pnpm12.9.1, independently installed dependencies and dedicated Compose project `tiramiss-nodeinfo531` (PG55631 / Redis56631 / pubsub56632 / Meili57631). Test databases and Redis prefixes are random per suite. Fixed-source replay used `/tmp/tiramiss-relay171-upstream` with read-only dependencies at `/home/osamu/develop/tiramiss`.

- Source replay:36 observations PASS (`/tmp/nodeinfo531-source-final.log`).
- Focused unit selection:316 tests /9 files PASS (`/tmp/nodeinfo531-units-final.log`).
- Listening HTTP/PG:94 tests /3 files PASS (`/tmp/nodeinfo531-integration-final.log`). After fixture preparation switched from insert/update to save for TypeORM's JSONB typing, the changed NodeInfo suite passed again:7 tests (`/tmp/nodeinfo531-db-final2.log`). The other two suites were unchanged.
- Build PASS (`/tmp/nodeinfo531-build-final.log`), typecheck PASS (`/tmp/nodeinfo531-types-final3.log`) and shipping PASS (`/tmp/nodeinfo531-shipping-final.log`).

The initial discovery test observed404 before implementation (`/tmp/nodeinfo531-red.log`). The first shipping run found test formatting errors, and typecheck found the integration fixture's JSONB DeepPartial mismatch; both were corrected before these final results. Existing pg concurrent-query deprecation warnings remain separate from passing test results. Initial root tests rejected the new shared composition bytes before the bounded predecessor was registered. One unbounded root run was stopped (exit130) under concurrent host memory pressure; the final root run uses bounded test concurrency. These are not represented as passing runs.
