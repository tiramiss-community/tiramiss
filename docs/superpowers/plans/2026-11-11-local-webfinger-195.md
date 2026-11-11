# Local WebFinger Discovery (#195) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a local account resource through WebFinger into a self link usable by the existing actor GET.

**Architecture:** Federation pure functions project a resource to a plain query and render plain User facts. A TypeORM adapter performs one constrained local lookup; a Hono adapter owns HTTP and negotiation; ordinary app composition supplies the DB and existing Meta reader.

**Tech Stack:** TypeScript ESM, Node 26.4.0, pnpm 12.9.1, Hono, TypeORM/PostgreSQL, installed accepts 1.3.8, Vitest; Fastify/inject and TypeScript AST for independent pinned-source oracle.

**Spec:** `docs/superpowers/specs/2026-11-11-local-webfinger-design.md`

## Global Constraints

- Cwd ONLY `/home/osamu/develop/tiramiss/.claude/worktrees/s1-federation-next9`; sole writable implementer; no nested workers.
- No Git mutations, commit, push, install, Docker, auth/config changes, or external sends; parent handles publication.
- Node `26.4.0`, PATH prefix `/tmp/tiramiss-s1-node26/bin`; pnpm `12.9.1`; reuse installed dependencies including `accepts`.
- No schema, entity, dependency, locale, CHANGELOG, or process lifecycle changes.
- Keep #176/#127/#195 partial, `notes/create:partial`, `postingComplete:false`, and formal issue order unchanged.
- Preserve all historic oracle JSON, probes and receipts byte for byte; no inventory, ROADMAP, or root proof helper edits without a later parent assignment.
- Business code uses plain facts; TypeORM lives in database adapters; cross-module imports use public federation exports.
- Product/test code starts only after `/tmp/tiramiss-s1-r10-plan-approved.json` exists and approves these plan/spec hashes.
- Freeze relevant executable inputs before broker validation; require a real PASS receipt before claiming validation success.

---

### Task 1: Publish local WebFinger through the ordinary HTTP composition

One cohesive test/review deliverable: discovery from a local account to the existing live actor, with bounded source equivalence. The parent owns preflight review, commits and PR operations; inline executing-plans overrides worker dispatch and commit suggestions.

**Files (all paths relative to repo root):**

| Action | Exact path | Responsibility |
| --- | --- | --- |
| Create | `packages/backend-next/src/modules/federation/local-webfinger.ts` | Plain query projection; JRD and literal-compatible XRD rendering |
| Modify | `packages/backend-next/src/modules/federation/public.ts` | Export narrow functions/types below |
| Create | `packages/backend-next/src/platform/database/local-webfinger.ts` | TypeORM findOne/select local non-suspended User, returning facts |
| Create | `packages/backend-next/src/http/webfinger-api.ts` | Query multiplicity, federation gate, accepts, method/status/header/error contract |
| Create | `packages/backend-next/src/composition/webfinger-http.ts` | Connect reader, readMeta and config.url |
| Modify | `packages/backend-next/src/composition/http-app.ts` | Mount discovery alongside existing actor; retain Role/Note/queue behavior |
| Create | `packages/backend-next/test/helpers/webfinger-source.ts` | Typed read-only source corpus/observations for direct current assertions |
| Create | `packages/backend-next/test/unit/federation/local-webfinger.test.ts` | Literal query/JRD/XML/source observations assertions |
| Create | `packages/backend-next/test/unit/federation/webfinger-api.test.ts` | HTTP status, Accept, CORS, HEAD/OPTIONS, bounded collaborator effects |
| Modify | `packages/backend-next/test/unit/composition/http-app.test.ts` | Expected new routes and real discovery status in existing composition regression |
| Create | `packages/backend-next/test/integration/webfinger.test.ts` | Real listenHttp/PG/User/Profile/Key, ordinary composition, self → actor |
| Create | `docs/superpowers/compatibility/remote-user/local-webfinger-source-probe.mjs` | Compact AST extraction, pinned Git byte/function checks, actual Fastify inject |
| Create | `docs/superpowers/compatibility/remote-user/local-webfinger-corpus.json` | Independent explicit request inputs and literal expected observations |
| Create | `docs/superpowers/compatibility/remote-user/local-webfinger-observations.json` | New pinned-source run only; never reuse/mutate historical observations |
| Create | `docs/superpowers/compatibility/remote-user/local-webfinger-results.md` | Contract, limitations and receipt-bound actual validation results |
| Create | `docs/superpowers/compatibility/remote-user/local-webfinger-runtime-evidence.json` | New actual receipt/log/input hashes and counts after broker PASS |
| Modify | `docs/superpowers/compatibility/remote-user/README.md` | Short link, bounded discovery capability and remaining scope |
| Modify | `packages/backend-next/README.md` | Short discovery validation command and remaining scope |

**Interfaces (plain business contract):**

```ts
export type LocalWebfingerQuery = { id: string } | { usernameLower: string };
export type LocalWebfingerFacts = { id: string; username: string };
export type LocalWebfingerDocument = {
  subject: string;
  links: [
    { rel: 'self'; type: 'application/activity+json'; href: string },
    { rel: 'http://webfinger.net/rel/profile-page'; type: 'text/html'; href: string },
    { rel: 'http://ostatus.org/schema/1.0/subscribe'; template: string },
  ];
};
export function localWebfingerQuery(resource: string, selfUrl: string): LocalWebfingerQuery | null;
export function renderLocalWebfinger(user: LocalWebfingerFacts, selfUrl: string): LocalWebfingerDocument;
export function renderWebfingerXrd(document: LocalWebfingerDocument): string;
// Adapter exports, with business types imported via federation/public:
export function createLocalWebfingerReader(manager: EntityManager):
  (query: LocalWebfingerQuery) => Promise<LocalWebfingerFacts | null>;
export function createWebfingerApi(parts: {
  selfUrl: string;
  federationEnabled(): Promise<boolean>;
  readUser(query: LocalWebfingerQuery): Promise<LocalWebfingerFacts | null>;
}): Hono;
export function createWebfingerHttp(resources: Pick<RuntimeResources, 'dataSource'>,
  config: Pick<RuntimeConfig, 'url'>): Hono;
```

Consumes existing `readMeta(EntityManager): Promise<MiMeta>`, normalized RuntimeConfig.url, public backend-upstream MiUser and TypeORM IsNull inside adapter, and `accepts` in HTTP only. Pure functions use no framework or Entity types; null query means foreign host, translated into 422 by HTTP. Produces mounted `GET`/implicit `HEAD` and `OPTIONS /.well-known/webfinger`.

**Source contract and independent expectations:**

| Input/condition | Literal assertion / prohibited regression |
| --- | --- |
| `ACCT:ALICE@LOCAL.TEST:8443`, `@Alice`, `Alice`, local `/@Alice`, local `/users/AB/nested/ID` | usernameLower alice or id id as applicable; whole-resource lowercase and last-segment selection |
| `alice@local.test:8443@ignored.test`, `alice@`, `@alice@local.test:8443` | accepted query alice; split('@', 2), empty host allowed |
| `alice@local.test` on port8443, `alice@foreign.test` | 422; no User lookup |
| missing resource / duplicated resource / `resource[x]=alice` | 400; no User lookup; empty resource is lookup usernameLower '' then 404 |
| federation none, malformed or missing resource | 403 first; no User lookup; OPTIONS remains 204 without Meta/User reads |
| local mixed-case stored Alice, suspended, remote and isDeleted rows | Alice in success subject/profile; suspended/remote hidden; deleted local still discoverable |
| JRD / XRD / weighted Accept / unsupported / both q=0 / absent Accept | XML only when xrd selected; otherwise JRD including fallback; fixed three links and subject |
| success/error/OPTIONS, GET and HEAD | Four exact CORS values always; success-only public max-age180/Vary Accept; HEAD body empty; DB failure500 has no cache/Vary |
| XML username with repeated special chars and `]]>` | Exact source bytes including first-occurrence-only attribute replacement and value removal of end-CDATA token |
| real WebFinger self href → GET with ActivityPub Accept | 200 actor id equals self; preferredUsername equals Alice; main-key owner/id/public PEM match stored key |

- [x] **Step 1: Add behavioral RED before implementation.** Add an ordinary composition test requesting `/.well-known/webfinger?resource=acct:alice@example.test` with the existing lightweight repository fixture returning no User. Expect 404 with discovery CORS; baseline returns404 without CORS, proving the missing mounted contract. Run the dedicated expectation, preserve `/tmp/tiramiss-s1-r10-red-http-app.log`, and confirm the assertion fails rather than import/setup error. Then write dedicated pure/HTTP tables and integration using literals from this source contract. Tests must name branch/output mutations they catch, and never compute expected JRD/XML via production renderers.

```ts
const response = await createBackendHttpApp(resources, testConfig()).request(
  '/.well-known/webfinger?resource=acct:alice@example.test');
expect(response.status).toBe(404);
expect(response.headers.get('access-control-allow-headers')).toBe('Accept');
```

Run: `PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next test test/unit/composition/http-app.test.ts`.

- [x] **Step 2: Establish independent pinned source observations.** Extract and fingerprint literal createServer, literal Acct module and XML module from fixed Git bytes using TypeScript AST/transpile, adapting only module/decorator evaluation. Register createServer with installed pinned Fastify/accepts; supply explicit Meta/User/URI/NodeInfo/OAuth doubles. Assert DB where host IsNull/isSuspended and exact id/usernameLower or rejection/early no calls. Corpus has explicit request/status/header/document/XML/lookup expectations. --write produces only the new observations file; --check recomputes and compares. Dedicated current units loop over every corpus case, asserting actual projected query and actual request response/body/headers directly, including any special rows/config/error cases. Use no new implementation when creating source expectations.

Run: `PATH=/tmp/tiramiss-s1-node26/bin:$PATH UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-webfinger-source-probe.mjs --write`.

- [x] **Step 3: Implement minimal pure projection and renderer, DB adapter and HTTP mount.** Apply literal source branches below; render only from id/username. Reproduce XML map iteration/first replace and value loop locally, confined to this renderer. Reuse accepts. Register CORS before all route handling. Catch DB/Meta errors inside discovery to avoid surrounding REST cache headers. Do not mount host-meta/NodeInfo or implement advertised authorize-follow/collections.

```ts
const resourceLower = resource.toLowerCase();
if (resourceLower.startsWith(`${selfUrl.toLowerCase()}/users/`)) {
  return { id: resourceLower.split('/').pop()! };
}
let acct = resourceLower.startsWith(`${selfUrl.toLowerCase()}/@`)
  ? resourceLower.split('/').pop()!
  : resourceLower.startsWith('acct:') ? resourceLower.slice(5) : resourceLower;
if (acct.startsWith('@')) acct = acct.substring(1);
const [username, host] = acct.split('@', 2);
return !host || host === new URL(selfUrl).host.toLowerCase()
  ? { usernameLower: username.toLowerCase() } : null;
// DB: findOne({ where: { ...query, host: IsNull(), isSuspended: false },
//               select: { id: true, username: true } });
// HTTP ordering: OPTIONS → federation → resource array length === 1
// → project → readUser → missing → document → Accept → cache/Vary/body.
```

- [x] **Step 4: Verify GREEN with dedicated unit and actual runtime tests.** Run three new/updated units, existing actor API and local actor regressions, then real integration WebFinger, existing HTTP-app and actor tests against dedicated PG55513/Redis56413/Meili57813. Use existing createTestDatabase/migrateDatabase/connectResources/listenHttp/closeHttp patterns, isolated per-file DB, a stable Meta singleton and real MiUser/Profile/Key rows. For actual DB fault, rename User/Meta tables only in this test-owned isolated DB and restore in finally (test preparation/fault SQL allowed); never change shared roles or permissions. Check suspended/remote/deleted selection and self-to-actor response via actual listening server. Sandbox EPERM is a failed execution and goes to history; parent broker must supply actual runtime PASS. Unit doubles are only bounded transport/DB collaborators; never substitute for runtime.

Run: `PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next test test/unit/federation/local-webfinger.test.ts test/unit/federation/webfinger-api.test.ts test/unit/composition/http-app.test.ts test/unit/federation/actor-api.test.ts test/unit/federation/local-actor.test.ts`.

Run: `PATH=/tmp/tiramiss-s1-node26/bin:$PATH BACKEND_NEXT_TEST_DB_PORT=55513 BACKEND_NEXT_TEST_REDIS_PORT=56413 BACKEND_NEXT_TEST_MEILI_PORT=57813 pnpm --filter backend-next test:integration test/integration/webfinger.test.ts test/integration/http-app.test.ts test/integration/activitypub-actor.test.ts`.

- [x] **Step 5: Freeze and obtain real broker validation.** Run dependency-order build/typecheck, focused units, source --check, changed-file eslint, SPDX and locale checks. Create `/tmp/tiramiss-s1-r10-validation-request-r1.json` with status FROZEN_READY, base SHA, SHA256 full relevant executable input map (source/tests/config/lockfile/new source corpus/probe), scope and commands `{id,command,log,artifact}`. Exclude all repository `scripts/` inputs, inventory JSON, descriptive MD and mutable runtime evidence from that map; keep the new docs-located executable source probe/corpus/observations as frozen test inputs. Command outputs use `/tmp/tiramiss-s1-r10-validation-r1-*`. After request freeze inputs; poll <=45 sec for parent `/tmp/tiramiss-s1-r10-validation-receipt-r1.json`, requiring actual PASS. Failures require revised inputs plus r2 request/logs/receipt; never overwrite r1 or earlier receipts.

Run: `PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next... build` and `PATH=/tmp/tiramiss-s1-node26/bin:$PATH pnpm --filter backend-next... typecheck`.

Run: source command above with `--check`; `PATH=/tmp/tiramiss-s1-node26/bin:$PATH node scripts/check-shipping.mjs --base 5699e5ce92595e7065665fa964d0854c3194cca4` (if root proof checks demand unassigned edits, report actual failure to parent and await scope assignment).

- [x] **Step 6: Bind evidence and hand off without Git/external operations.** Only after receipt PASS, write new results/runtime evidence with actual timestamps, log paths, case counts and receipt/input hashes. Add short README links. Preserve RED/EPERM history, explicit injected-Meta freshness difference, source-method/full-server distinction, and remaining issue scope. Write `/tmp/tiramiss-s1-r10-implementation.md` and `/tmp/tiramiss-s1-r10-ready.json` with changed-file SHA256s and actual receipt path/hash; parent handles task review, inventory/root proof, CodeRabbit, commits and PR.

## Review Focus

The spec is binding. Review exact literal source and independent expectations, HTTP early exits/headers/query semantics, plain DB boundaries, ordinary composition plus actual PG actor flow, all-case direct source/current assertions, immutable history and receipt binding. Test text must agree with implementation: missing/duplicate rejects, empty queries; fallback accepts even q=0; no isDeleted filter; options bypasses Meta; HEAD body empty. No mock-only runtime claims, false DONE, generic framework, placeholder endpoints, or new cache/guarantees. Source and runtime proofs remain separate.

## Preflight self-consistency ledger

| Tasks / shared boundary | Produces → consumes / internal check | Ruling |
| --- | --- | --- |
| Task 1 ↔ Task 1 (only task) | query union/null → HTTP422 or DB reader; id/username facts → renderer → JRD/XRD; HTTP factory → ordinary composition | Same signatures above; no cross-task pairs exist |
| Task 1 internal tests/code | full lowercase/last segment/split2, missing vs empty vs duplicates, Accept fallback, first-only XML, four CORS, success-only cache, HEAD/OPTIONS match literal branch plan | Consistent; independent expectations, not computed renderers |
| Task 1 internal files | every created/modified product/test/evidence path listed above; existing upstream and historical artifacts read only | Consistent; post-receipt docs/evidence excluded from executable freeze |
| Task 1 vs global constraints | Header's recommended SDD/commit suggestions vs sole implementer/no Git mutations | User explicitly selects inline executing-plans; parent preflight/review/publication replaces dispatch/commit steps |
| Task 1 vs evidence contract | literal source doubles vs actual normalHTTP/PG; EPERM vs brokerPASS; freeze vs subsequent docs | Separate claims and immutable revisions; only actual receipt authorizes PASS claim |

Source-execution clarification (2026-11-11): actual pinned Fastify inject showed XRD `application/xrd+xml` without charset (JRD has charset); a foreign actor URL with no `@` becomes a bare username lookup and normally404; equally weighted types follow client ordering. Initial source characterization failure is retained in `/tmp/tiramiss-s1-r10-source-initial.log`. These literal-source results refine the approved implementation, without expanding scope.

Execution completed through Step 6 using broker receipt r1 PASS (2026-11-11T12:43:05.265096+00:00); 227 units, 46 WebFinger integration, 55 existing HTTP/actor integration, 49 source cases; actual logs/hashes in [results](../compatibility/remote-user/local-webfinger-results.md). No Git mutations or external sends. Parent review/publication remain parent-owned.
