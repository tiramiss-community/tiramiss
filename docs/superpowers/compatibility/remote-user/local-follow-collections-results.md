# Local followers/following collection slice (2026-11-13)

Base `50ffa6157c557f72ca10857201f390b5855c8016`; pinned upstream `8e07cf085adf7009583d234a208e30436f020e26`. Scope is #195's local actor collection reading. The available public #182 snapshot assigns Follow/Accept/Reject/Undo/Block activity renderers and relationship mutations to #182; this slice does not implement or change those contracts. #176's direct posting gap remains open.

The ordinary backend-next HTTP root now serves `/users/:id/followers` and `/users/:id/following`, index and every page. Framework handling, domain facts/policy/pure representation, TypeORM reads and composition are separated. Saved counts are retained; pages read eleven descending relation IDs and return ten, with next cursor from the tenth retained relation. Visibility, federation/error ordering, missing profile/member behavior and local/remote/null member URIs follow pinned methods. There are no relation mutations, new cache, schema changes or global service.

| Evidence | Actual result | Limits |
| --- | --- | --- |
| Current source corpus/probe/observations after P2 | 138 cases, write/check PASS; Node 26.4.0, TypeScript 6.0.3, Fastify 5.12.5, accepts plugin 5.0.6, TypeORM 1.1.1; pinned file/method and parser hashes recorded | Literal source methods + actual Fastify injection with deterministic repositories, not full upstream server/PG |
| P2 RED then GREEN | 28 failures / 110 passes before the fix; 138 / 138 after the fix | Actual Hono app.request comparisons against literal-source output, both directions |
| P2 closest units/typecheck | 250 tests / 4 files PASS; product and test typecheck PASS on Node 26.4.0 / TypeScript 6.0.3 | No DB/TCP or broad suite in this worker |
| P2 shipping components | Direct changed-file ESLint quiet, SPDX and locale/scope PASS | Aggregate shipping interrupted: pnpm exec unexpectedly attempted dependency fetches in the isolated clone; no aggregate PASS claimed |
| Parent R1 validation (pre-P2 history) | ACTUAL PASS, 987 frozen inputs: 3,485 unit / 1,081 integration / 65 acceptance, source 80, sync/upstream/build/typecheck/shipping | `/tmp/tiramiss-s1-r13-validation-receipt-r1.json`; these inputs precede this query fix |
| Parent post-P2 validation | PENDING | Parent must repeat real PG/listening HTTP and full suites on the amended inputs |
| Historical worker RED then GREEN (pre-P2) | All 80 new product unit comparisons failed with the empty router, then all 80 passed | Hono request tests, no TCP/DB |
| Historical worker closest unit files (pre-P2) | 192 tests / 4 files PASS, including updated normal root route registration and GET/HEAD/OPTIONS tests | No broad-suite success inferred |
| Historical worker build/typecheck (pre-P2) | backend-next dependency build and product/test typecheck PASS | Actual integration execution still required |
| Historical worker integration (pre-P2) | 86 tests authored under CI's existing integration glob; initial 84 and final 86 attempted, beforeAll blocked by `connect EPERM 127.0.0.1:55516` | No test bodies ran, including the final two member-deletion cases |
| Historical worker full units (pre-P2) | Attempted once, interrupted exit 130 after network/subprocess failures/hangs; no final counts | Composition route-list failure was corrected and near suite passed; full suite needs parent rerun |
| Historical worker shipping (pre-P2) | Changed-file lint, SPDX and locale safety PASS | Run in worker Node 24, no Node 26 validation |

The source observations settle duplicate query behavior, negotiation, HEAD and OPTIONS: repeated cursor returns 400 even on index; repeated page selects index; explicit empty cursor remains in page id; HEAD performs reads with an empty response; OPTIONS returns 404 with JSON type and no collection CORS headers or reads. Index caches for 180 seconds, denied visibility for 30, pages/errors have no collection cache header. Full Fastify diagnostic text and global server hooks are not compared.

P2 adds 58 source cases, including mixed valid/malformed percent escapes, invalid/truncated/overlong/surrogate/out-of-range UTF-8, plus and encoded-plus controls, encoded/repeated/invalid keys, bare/empty values and error precedence in both directions. Fastify's default find-my-way parser uses fast-querystring 1.1.2 and fast-decode-uri-component 1.0.1 (verified against the pinned lockfile and installed implementation). It replaces `+` with space before all-or-nothing decoding of each key/value; invalid input retains the entire component after plus replacement. For `?page=true&cursor=r%30z%`, the relation cursor is `r%30z%` and page ID cursor is `r%2530z%25`. Only these two collection routes use the helper; no dependency or global parser was added. The probe records the actual relation query cursor and parser source hashes.

Source repository doubles use JavaScript ID comparison. For every observed non-ID query cursor the real-PG test uses an independent SQL query with the source-observed cursor to assert the database's comparison, while keeping source URL/representation expectations. It does not use URLSearchParams or the product helper to parse the expected SQL cursor. This does not regenerate historical source evidence. Actual missing members are checked by deleting a member after relation retrieval; normal FK cascade is preserved. Stable reads check User/Profile/Following snapshots. Existing absent-Meta initialization is tested separately.

Meta is read directly through the existing reader, unlike upstream's injected cache; freshness/failure/notification equivalence remains #217. Full upstream PostgreSQL parity and controller review remain unestablished. Parent R1 passed on pre-P2 inputs; parent post-P2 integration/full-suite validation is PENDING. No historical proofs or inventory metadata were refreshed. #176/#127/#195/#215 stay OPEN, `notes/create:partial` / `postingComplete:false`; media/Drive #188, chart #200, Move #199, remote Note/featured/inbox #195 and cache #217 remain unfinished.

Current source reproduction (exact observed tool tuple above; no install/rebuild required):

```sh
export PATH=/tmp/tiramiss-s1-node26/bin:$PATH
export UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream
export FOLLOW_PROBE_PACKAGE=/tmp/tiramiss-s1-r13-probe/package.json
node --version # v26.4.0
node docs/superpowers/compatibility/remote-user/local-follow-collections-source-probe.mjs --write
node docs/superpowers/compatibility/remote-user/local-follow-collections-source-probe.mjs --check
```

The harness declares the TypeScript alias 6.0.2, whose installed implementation reports `ts.version === "6.0.3"`; this actual version is recorded and checked. Original Node 24 worker failures/blocked runs above remain historical entries. The independent-source oracle (80 cases / 86 injections) is a separate parent artifact, outside this product probe, and was not rerun here.

Parent post-P2 rerun, PENDING (dedicated project `backend-next-s1-r13`, with its dependencies already started; use the Node 26 PATH above):

```sh
BACKEND_NEXT_TEST_DB_PORT=55516 BACKEND_NEXT_TEST_REDIS_PORT=56416 BACKEND_NEXT_TEST_MEILI_PORT=57816 pnpm --filter backend-next test:integration test/integration/local-follow-collections-http.test.ts
pnpm --filter backend-next test
```

Changelog candidate: local actorのfollowers/followingコレクションとページをActivityPubで取得できるようにしました。
