# Local followers/following collection slice (2026-11-13)

Product `8f200fc583f40eda2455f2196013b976c39b937d` (current unmerged feature); base `50ffa6157c557f72ca10857201f390b5855c8016` after merged PR #270; pinned upstream `8e07cf085adf7009583d234a208e30436f020e26`. Scope is #195's local actor collection reading. The available public #182 snapshot assigns Follow/Accept/Reject/Undo/Block activity renderers and relationship mutations to #182; this slice does not implement or change those contracts. #176's direct posting gap remains open.

The ordinary backend-next HTTP root now serves `/users/:id/followers` and `/users/:id/following`, index and every page. Framework handling, domain facts/policy/pure representation, TypeORM reads and composition are separated. Saved counts are retained; pages read eleven descending relation IDs and return ten, with next cursor from the tenth retained relation. Visibility, federation/error ordering, missing profile/member behavior and local/remote/null member URIs follow pinned methods. There are no relation mutations, new cache, schema changes or global service.

| Evidence | Actual result | Limits |
| --- | --- | --- |
| Current source corpus/probe/observations after P2 | 138 cases, write/check PASS; Node 26.4.0, TypeScript 6.0.3, Fastify 5.12.5, accepts plugin 5.0.6, TypeORM 1.1.1; pinned file/method and parser hashes recorded | Literal source methods + actual Fastify injection with deterministic repositories, not full upstream server/PG |
| P2 RED then GREEN | 28 failures / 110 passes before the fix; 138 / 138 after the fix | Actual Hono app.request comparisons against literal-source output, both directions |
| P2 closest units/typecheck | 250 tests / 4 files PASS; product and test typecheck PASS on Node 26.4.0 / TypeScript 6.0.3 | No DB/TCP or broad suite in this worker |
| P2 shipping components | Direct changed-file ESLint quiet, SPDX and locale/scope PASS | Aggregate shipping interrupted: pnpm exec unexpectedly attempted dependency fetches in the isolated clone; no aggregate PASS claimed |
| Parent R1 validation (pre-P2 history) | ACTUAL PASS, 987 frozen inputs: 3,485 unit / 1,081 integration / 65 acceptance, source 80, sync/upstream/build/typecheck/shipping | `/tmp/tiramiss-s1-r13-validation-receipt-r1.json`; these inputs precede this query fix |
| Parent R2 post-P2 validation | ACTUAL PASS, 987 frozen inputs: sync/upstream5/build/typecheck, whole units 3,543 / integration 1,139 / acceptance 65 / source 138 / shipping; zero failed/pending/drift | 144 real PostgreSQL/listening HTTP collection tests are included in 1,139; local parent execution, no CI result claimed |
| Historical worker RED then GREEN (pre-P2) | All 80 new product unit comparisons failed with the empty router, then all 80 passed | Hono request tests, no TCP/DB |
| Historical worker closest unit files (pre-P2) | 192 tests / 4 files PASS, including updated normal root route registration and GET/HEAD/OPTIONS tests | No broad-suite success inferred |
| Historical worker build/typecheck (pre-P2) | backend-next dependency build and product/test typecheck PASS | Actual integration execution still required |
| Historical worker integration (pre-P2) | 86 tests authored under CI's existing integration glob; initial 84 and final 86 attempted, beforeAll blocked by `connect EPERM 127.0.0.1:55516` | No test bodies ran, including the final two member-deletion cases |
| Historical worker full units (pre-P2) | Attempted once, interrupted exit 130 after network/subprocess failures/hangs; no final counts | Composition route-list failure was corrected and near suite passed; full suite needs parent rerun |
| Historical worker shipping (pre-P2) | Changed-file lint, SPDX and locale safety PASS | Run in worker Node 24, no Node 26 validation |

The source observations settle duplicate query behavior, negotiation, HEAD and OPTIONS: repeated cursor returns 400 even on index; repeated page selects index; explicit empty cursor remains in page id; HEAD performs reads with an empty response; OPTIONS returns 404 with JSON type and no collection CORS headers or reads. Index caches for 180 seconds, denied visibility for 30, pages/errors have no collection cache header. Full Fastify diagnostic text and global server hooks are not compared.

P2 adds 58 source cases, including mixed valid/malformed percent escapes, invalid/truncated/overlong/surrogate/out-of-range UTF-8, plus and encoded-plus controls, encoded/repeated/invalid keys, bare/empty values and error precedence in both directions. Fastify's default find-my-way parser uses fast-querystring 1.1.2 and fast-decode-uri-component 1.0.1 (verified against the pinned lockfile and installed implementation). It replaces `+` with space before all-or-nothing decoding of each key/value; invalid input retains the entire component after plus replacement. For `?page=true&cursor=r%30z%`, the relation cursor is `r%30z%` and page ID cursor is `r%2530z%25`. Only these two collection routes use the helper; no dependency or global parser was added. The probe records the actual relation query cursor and parser source hashes.

Source repository doubles use JavaScript ID comparison. For every observed non-ID query cursor the real-PG test uses an independent SQL query with the source-observed cursor to assert the database's comparison, while keeping source URL/representation expectations. It does not use URLSearchParams or the product helper to parse the expected SQL cursor. This does not regenerate historical source evidence. Actual missing members are checked by deleting a member after relation retrieval; normal FK cascade is preserved. Stable reads check User/Profile/Following snapshots. Existing absent-Meta initialization is tested separately.

Meta is read directly through the existing reader, unlike upstream's injected cache; freshness/failure/notification equivalence remains #217. Full upstream PostgreSQL parity remains unestablished. Parent R1 passed on pre-P2 inputs and remains historical. Parent R2 now validates the post-P2 product; the P2 parser fix and minor tool-tuple documentation correction received an independent scoped APPROVED verdict (`/tmp/tiramiss-s1-r13-query-rereview-report.md`). Final current-product CodeRabbit review is PENDING; no final review PASS is claimed. Metadata adds only a finite successor record; historical evidence bytes remain unchanged. #176/#127/#195/#215 stay OPEN, `notes/create:partial` / `postingComplete:false`; media/Drive #188, chart #200, Move #199, remote Note/featured/inbox #195 and cache #217 remain unfinished.

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

Parent R2 actual measurement: 2026-11-13 **21:23:05.211777 → 21:26:38.674719 UTC**, Node **v26.4.0**, pnpm **12.9.1**, project `backend-next-s1-r13`, PostgreSQL **55516**, Redis **56416**, Meili **57816**. Request `/tmp/tiramiss-s1-r13-r2-validation-request.json` SHA256 `92d8b5fe7ed0c814b33484dbfe9a23d62ffb906aa8712a425cfc829fa11d657b`; receipt `/tmp/tiramiss-s1-r13-r2-validation-receipt.json` SHA256 `24e9c5a939673b4807dab72a8e02b4b06fa4f7ce4ac5bc489909b0ad6dde158d`; canonical complete 987-input map SHA256 `ecb7e16899f6cd3918f5bddc3ab78a218927fb6f01e9f08c93a3784ef3b18473`. All nine actual commands, exact logs/artifact hashes and test counts are embedded in [current evidence](local-follow-collections-current-evidence.json). Each log and artifact was read and hash-verified during metadata integration; per-file artifact assertions confirm collection HTTP **144**, current collection units **138**, composition **8**, and affected old regressions.

Actual commands (with the Node 26 PATH and dedicated service ports above):

```sh
pnpm --filter backend-upstream sync:check
pnpm --filter backend-upstream test
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test --reporter=json --outputFile=/tmp/tiramiss-s1-r13-r2-unit-results.json
pnpm --filter backend-next test:integration --reporter=json --outputFile=/tmp/tiramiss-s1-r13-r2-integration-results.json
pnpm --filter backend-next test:acceptance --reporter=json --outputFile=/tmp/tiramiss-s1-r13-r2-acceptance-results.json
node docs/superpowers/compatibility/remote-user/local-follow-collections-source-probe.mjs --check
node scripts/check-shipping.mjs --base 50ffa6157c557f72ca10857201f390b5855c8016
```

Proof renewal is bounded to three pre-existing identities (`http-app.ts`, federation `public.ts`, composition `http-app.test.ts`) after the featured hop. New product/source/test paths are frozen inputs, without invented predecessors. The record checks a finite 55-input subset plus immutable predecessor bytes, while binding the complete 987-input map digest. It deliberately does not compare all 987 current bytes after inventory/docs updates. Historical digest projections and evidence JSON bytes remain intact; missing temporary host artifacts are allowed only with canonical/byte seals and current-input guards. Available artifacts must verify. The metadata host gate and final aggregate shipping are distinct from this product receipt.

Exact Fastify diagnostic strings, global ServerService hooks, Content-Length/Location, Meta/cache freshness/failure/notification, and full upstream server/PG remain unproven. The product source corpus is **138 cases / 138 injections**, literal methods and Fastify repository doubles; the separate independent oracle remains **80 cases / 86 injections** (`/tmp/tiramiss-s1-r13-oracle-fixed-report.md`), and neither is a full upstream boot/PG measurement. No CI claim is made. This collection read slice does not complete #176 direct posting or #182 Follow mutations. Drive/media #188, chart #200, cache #217, Move #199, remote Note/featured/inbox #195, all five gap groups and the formal shared root → #176 → inbox order remain.

Changelog candidate: local actorのfollowers/followingコレクションとページをActivityPubで取得できるようにしました。
