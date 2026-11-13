# Local Follow Collections Implementation Plan

> **For agentic workers:** The user selected controller execution and expressly prohibited subagents, commits, and approval questions; follow that instruction over the writing-plans handoff and commit steps.

**Goal:** Serve local actor followers and following collection indexes and every page with pinned upstream behavior.

**Architecture:** Keep relation reading and URI projection separate from HTTP transport, using existing backend-next composition and database boundaries. Fix executable upstream evidence before using it as the expected output of independent runtime tests.

**Tech Stack:** TypeScript, Hono, TypeORM, PostgreSQL, Fastify source probe.

**Spec:** `docs/superpowers/specs/2026-11-13-local-follow-collections-design.md` (actual parent R3b runtime/source validation PASS; Phase 2 evidence binding; final scoped re-review/PR checks separate, CI UNRUN).

## Global Constraints

Pinned upstream `8e07cf085adf7009583d234a208e30436f020e26`; base `50ffa6157c557f72ca10857201f390b5855c8016`. Do not change #182 interfaces, mutation paths, upstream managed files, or old backend; do not claim #176 complete. No commits or external writes. Preserve historical compatibility evidence.

## Review Focus

- Repeated cursor and repeated page parameters: inject literal query strings, verify actual parsed types and error order.
- Empty, encoded, and non-ASCII cursor values: preserve source comparison and generated query encoding.
- Missing profile or referenced user: reproduce failure instead of silently omitting data.
- Eleven rows and stale saved counts: next cursor is tenth retained relation, count is saved user count.
- HEAD, OPTIONS, negotiation, and errors: compare source response status, headers, body and evaluation order.

## File structure and tasks

### Task 1: Obtain executable source evidence

**Files:** Create `docs/superpowers/compatibility/remote-user/local-follow-collections-corpus.json`, `local-follow-collections-source-probe.mjs`, and `local-follow-collections-observations.json` in that directory.

- [x] Restore the specified pinned upstream checkout and its dependencies, Node 26, and the supplied issue snapshots; verify checkout bytes against Git blobs. Read both issue snapshots and the decision/journal.
- [x] Follow `local-featured-source-probe.mjs` conventions, executing literal `followers`, `following`, renderer, URI and HTTP server methods with Fastify inject and explicit deterministic repository doubles. Record source-file and method hashes, double limitations, ordered events, response status, headers and body. Never derive expected results from backend-next.
- [x] Enumerate all318 meaningful cases (initial80 + query58 + path180) covering both routes, all five review-focus classes, federation/visibility precedence, every pagination boundary, local and remote users, absent references, and errors. Execute every case without a silent cap.
- [x] Run with `--write`, then `--check`; record exact commands and results. Update the preliminary design from observed output, retaining uncertainty about full-server and DB behavior.

### Task 2: Implement and verify the read path

**Files:** Add focused collection domain, persistence, composition, HTTP and test files under `packages/backend-next`, following existing local featured route boundaries; connect them in `packages/backend-next/src/composition/http-app.ts`. Exact signatures require inspection of those existing boundaries by the implementing controller.

- [x] Add tests consuming all fixed source observations and separate real PostgreSQL cases for saved count, ordered cursor pagination, both relation ends, missing references, and no writes beyond existing Meta initialization. Verify failures before implementation.
- [x] Implement the sequence and representations in the completed design. Reuse existing AP context and HTTP response conventions; do not reuse #182 activity rendering interfaces.
- [x] Run targeted backend-next tests and integration tests, including HEAD/OPTIONS and raw repeated query values; compare all source observations and report mismatches without silently rewriting historical evidence.
- [x] Run `node scripts/check-shipping.mjs` and report actual lint, SPDX and locale results; record any unavailable validation separately.

## Product-lane execution ledger (2026-11-13)

- Applied the entire oracle patch at base `50ffa6157c`; its two new documents are included in the standalone product patch.
- Task 1: complete for source methods + real Fastify inject, 80 cases, `--write` and `--check` PASS. Source checkout bytes match pinned objects, file/method SHA-256 and dependency/runtime versions are in observations. Public issue #182 snapshot confirms Follow/Accept/Reject/Undo/Block activity renderers belong to #182; URI reads for the #195 publication slice are distinct.
- Ruling: use installed Node 24.20.0 (accepted package engines) because requested Node 26 directory is absent. This is not Node 26 validation; parent should repeat there if required. The specified journal path was also absent; the available decision and issue snapshots were read.
- Task 2 RED: empty Hono collection router and domain signature stub; all 80 new comparison tests failed on missing route behavior/content type. Actual log: `/tmp/tiramiss-s1-r13-product-red.log`.
- Task 2 GREEN: implementations pass all 80 source comparisons. Ordinary root composition test expectations updated for the two new routes; two additional tests cover GET/HEAD federation precedence and OPTIONS at the normal composition root. Closest four files pass 192 tests.
- Task 2 verification: build/typecheck PASS; lint/SPDX/locale PASS. Full units attempted once, then interrupted (exit 130) following network/subprocess failures and hangs; no final suite count or success claim. Its route-enumeration failure was fixed and the entire composition file rechecked.
- Ruling: unusual non-ID cursor collation is PostgreSQL's responsibility. The integration tests keep source representation expectations but compare those member sets to an independent SQL query. Source JS comparator doubles alone cannot establish that behavior; cost if wrong is a parent-detected collation mismatch, not silently changed product filtering.
- Task 2 integration: 86 tests authored in CI's existing integration glob. Both the initial 84-case and final 86-case executions could not connect to 127.0.0.1:55516 (EPERM); no test bodies ran. The final file passed typecheck. Real upstream full-server/PG parity and Meta cache/notification timing remain unverified.
- Review: author boundary/contract pass only; the user-appointed controller supplies independent review. No subagents, external writes, commits or other worktree changes were made.
- Historical evidence, inventory metadata and completion statuses remain unchanged. #176/#127/#195 remain open, notes/create partial and postingComplete:false.

## P2 query-contract fix wave (2026-11-13)

- Fix round 1 only; no subagents, commits or external sends. Delta baseline is the complete supplied 16-file current-product snapshot, saved byte-for-byte before edits under `/tmp/tiramiss-s1-r13-query-preimages`, not base `50ffa6157c`.
- Ruling: source-contract P2 is valid. Read the actual Fastify 5.12.5 default router and fast-querystring 1.1.2 / fast-decode-uri-component 1.0.1 implementations and the fixed upstream lockfile before changing the product. Replace Hono partial decoding only for the two collection routes with pair/key/value decoding that preserves the entire component on malformed percent/UTF-8, after plus replacement. No dependency/global parser added.
- Current source execution uses restored Node 26.4.0 and actual TypeScript 6.0.3. The preceding Node 24 worker runs and unavailable-path observations remain pre-P2 history. Correct the current results/design/reproduction tuple; the harness alias package version is 6.0.2 but its delegated compiler reports 6.0.3.
- TDD: original 80 source checks and actual API unit comparisons PASS before changes. Add 58 literal-source cases and actual query-cursor capture: source `--write` / `--check` PASS for all 138; unchanged product RED is 28 failed / 110 passed. Only then implement the narrow decoder: GREEN 138/138. Both directions include malformed percent/UTF-8, keys, plus controls and repeated-parameter/federation/missing-user precedence. Original 80 response/event observations and literal-source manifest remain identical.
- Product/test typecheck PASS; closest Hono/representation/composition units PASS, 250 tests / 4 files. Supplemental pinned-parser differential PASS for 1,260 queries; these are not extra source corpus cases. Final direct changed-file quiet lint PASS after correcting a curly-brace lint error; SPDX/locale/scope PASS. Aggregate shipping was interrupted (130): its pnpm exec unexpectedly tried dependency retrieval, blocked by DNS. Direct checks were used instead; no aggregate PASS claimed. Shared library trees had no recent file/directory metadata changes in the read-only audit.
- Integration now consumes 138 source cases plus six existing independent cases. Its non-ID cursor SQL comparison uses the literal source query's captured cursor, independently of both URLSearchParams and the product decoder. PostgreSQL collation versus JS-double ordering remains qualified. No DB/TCP or full-suite runs in this worker.
- Parent R1 receipt `/tmp/tiramiss-s1-r13-validation-receipt-r1.json` is ACTUAL PASS on 987 frozen pre-P2 inputs: 3,485 unit / 1,081 integration / 65 acceptance, source 80, sync/upstream/build/typecheck/shipping. Parent post-P2 R2 full validation subsequently PASS; see the current ledger below. Independent source oracle 80 cases / 86 injections is separate parent evidence and was not rerun here.
- Author scoped verification: P2 and minor tool-tuple documentation mismatch addressed in implementation; independent scoped re-review subsequently APPROVED P2 and the minor tool-tuple correction. Historical proof scripts/evidence/inventory and partial posting/open issues are unchanged. Fix report and manual delta patch: `/tmp/tiramiss-s1-r13-query-fix-report.md`, `/tmp/tiramiss-s1-r13-query-fix.patch`; full-base backup: `/tmp/tiramiss-s1-r13-product-after-query.patch`.

## Historical pre-path parent R2 and metadata integration (2026-11-14)

- Product `8f200fc583f40eda2455f2196013b976c39b937d` at base `50ffa6157c557f72ca10857201f390b5855c8016` after PR #270 MERGED. Current read-collection feature remains unmerged.
- ACTUAL R2 PASS: 987 frozen post-P2 inputs, nine commands sync/upstream5/build/typecheck/whole units3543/integration1139/acceptance65/source138/shipping, zero failure/pending/input drift. 144 collection real-PG/listening HTTP instances are part of 1139. Node26.4.0/pnpm12.9.1, compiler6.0.3 (alias package6.0.2); ports55516/56416/57816, 2026-11-13 21:23:05→21:26:38 UTC.
- Request `/tmp/tiramiss-s1-r13-r2-validation-request.json` SHA256 `92d8b5fe7ed0c814b33484dbfe9a23d62ffb906aa8712a425cfc829fa11d657b`; receipt `/tmp/tiramiss-s1-r13-r2-validation-receipt.json` SHA256 `24e9c5a939673b4807dab72a8e02b4b06fa4f7ce4ac5bc489909b0ad6dde158d`. [Current results](../compatibility/remote-user/local-follow-collections-results.md) list exact commands and limits. Pre-P2 R1 3485/1081/65, original Node24/EPERM/interrupted unit and shipping attempts above remain history, not current proof.
- Product literal-source/Fastify doubles:138 cases/138 injections; separate independent source oracle:80 cases/86 injections. Neither is full upstream server/PG. Independent scoped fix review APPROVED P2/minor; pre-path product/metadata CodeRabbit completed (16/14 files, 0 findings each). No CI PASS claimed.
- Metadata Task2 adds the Node-only leaf, finite three-identity hop, sealed R2 request/receipt and 55 mandatory current inputs; old evidence JSON bytes and historical digest projections stay intact. Inventory promotes only GET followers/following rows to partial, with implementation references resolved at the actual product tree. Root contract/inventory/shipping-component host results are recorded separately in `/tmp/tiramiss-s1-r13-metadata-report.md`; parent subsequently completed the pre-path root366/366, inventory and aggregate shipping gates; see the Phase 1 boundary below.
- Exact diagnostics/global hooks/Content-Length/Location/MetaCache/full upstream server are unproven. #176/#127/#195/#215 OPEN, notes/create:partial/postingComplete:false, five gaps and formal order unchanged. Drive188/chart200/cache217/Move199/remote Note-featured-inbox195/Follow mutations182 remain; collection reads do not finish direct #176 posting.

## Final raw-path fix wave — Phase 1 (2026-11-14)

- Ruling: whole-review P2 is valid. Fastify rejects malformed raw user components before route CORS/federation; Hono partial param decoding allowed reads/403/404. Strictly decode the raw path exactly once before CORS/Meta. Keep query parsing, user→Profile→relations/member order, perPage and cache rules unchanged. The source double must check actual lookup IDs.
- Same single implementer/fix wave spans this turn and Phase 2. User instructions override fix-loop delegation/reviewer dispatch and commit steps. No new reviewer or CodeRabbit run. Read whole/query/metadata/metadata-review reports and saved preimages before edits.
- TDD: source318 write/check before production edit; API RED48/270, then minimal guard GREEN318/318. Existing138 outcomes unchanged except new lookupIds/metaEntries instrumentation. New180 cases cover both directions, GET/HEAD, malformed percent/UTF-8, federation all/none, encoded-valid/double-encoded/literal-percent/Unicode controls and repeated-cursor precedence.
- Near units430/430 (4 files), product/test typecheck PASS. Source all318 uncapped. Integration declares324 instances with new actual lookup-ID/Meta/repository-read guards; DB/TCP and full suites belong to parent R3 and were not run here. GET malformed errors compare statusCode/error only; diagnostic message/global hook and raw malformed HEAD inject-payload equality remain qualified in results.
- Preserve old seven evidence files plus R2 eighth, with R2 c3559a2c… byte-identical. Root helper and R2 record remain unchanged in Phase 1; no proof guard relaxed. Phase 2 will archive/bind only actual parent R3 data, then update proof/docs. R2 cannot validate the new path code.
- Pre-path product CodeRabbit completed on 16 files with 0 findings; metadata CodeRabbit completed on 14 files with 0 findings. Parent pre-path root contracts passed 366/366, inventory PASS, aggregate shipping PASS (metadata-only ESLint SKIPPED). These are completed reviews/gates for their earlier snapshots, not reviews or validation of the new path fix. CI remains UNRUN.
- Final direct changed-package ESLint quiet, SPDX and locale/scope checks PASS; aggregate worker shipping SKIPPED to avoid dependency retrieval, no aggregate PASS claimed.
- Minor stale review/host-gate PENDING wording corrected as time-scoped completed facts. #176/#127/#195/#215 OPEN; notes/create:partial, postingComplete:false, five gaps, owners and formal order unchanged.

## Actual R3b and Phase 2 evidence/docs binding (2026-11-14)

- [x] Verify host-ready product `498009e4d8bdfc0afc581fbcf5954da2c2953fed`, actual R3b request/receipt/logs/artifacts/full988 map, all9 exit0/no drift; units3723, integration1319, acceptance65, source318, upstream5, build/typecheck/shipping PASS. Collection units318 and PG/HTTP324 are real per-file counts.
- [x] Preserve failed initial R3 integration1315/1319 with four encoded-page member-count failures as history. Correct only the test's JS/PG collation expectation using source-observed cursor + independent SQL for GET/HEAD; actual fresh R3b passed those cases. Runtime/source stays unchanged in Phase 2.
- [x] Preserve old7 records plus exact C355 R2 record. New path evidence keeps unchanged three featured-hop bindings and current/historical projections, explicitly binds7 changed finite inputs and complete10-path request difference,988 full map/55 current inputs, parser/lookup/Meta and original138 projection. Root tests retain all49 old guards and add16 R3/history guards. Original R2 validator from Git949e validates real Git8f200fc frozen inputs.
- [x] Point inventory implementationCommit at actual measured product498009e4d8bdfc0afc581fbcf5954da2c2953fed, resolve all refs in that Git tree and regenerate/check existing catalog. Only the same two HTTP collection rows stay partial.
- [x] Update ROADMAP/results/design/README with actual R3b and time-scoped R2/R1/Node24/EPERM history, source318 vs independent80/86 and unproven boundaries.
- [x] Worker root382/382 and near105/105, inventory write/check, SPDX/locale/scope. Root commands use the unchanged /tmp stdio transport preload; no assertion skipped.
- [ ] Parent native post-integration metadata root/aggregate shipping gate and final scoped re-review of the complete runtime+evidence+docs fix; worker results are reported separately and cannot approve the whole branch.
- [ ] CI execution (UNRUN).

Pre-path CodeRabbit product16/metadata14 files each had 0 findings, on their earlier committed scopes. The complete final fix (runtime + evidence + docs) has not yet received the controller’s final scoped re-review or new CodeRabbit/PR checks; those gates remain to be run by the controller. CI is UNRUN. #176/#127/#195/#215 OPEN, notes/create:partial/postingComplete:false, five gaps/owners/formal order unchanged. No agent/commit/staging/external review or send.
