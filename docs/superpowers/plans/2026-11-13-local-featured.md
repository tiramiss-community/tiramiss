# Local Featured Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. This worker dispatch excludes child workers; parent reviews independently and owns Git.

**Goal:** Publish the actor featured collection and linked ActivityPub Note GET as a coherent function.
**Architecture:** Narrow federation facts/contracts, source-ordered acquisition and pure renderer; Hono HTTP adapter, TypeORM facts adapter and composition. Sync only pinned upstream Entity definitions.
**Tech Stack:** TypeScript, Hono, TypeORM, PostgreSQL, Vitest; independent literal-source probe with Fastify.
**Spec:** `docs/superpowers/specs/2026-11-13-local-featured-design.md`

## Global constraints

Spec requirements 1–9 apply in full. Dedicated next11 worktree and base0b5ab105 only. No Git/external sends/children. Historical artifacts and old ROOT assertion files remain unchanged; extend the composition route enumeration by exactly two routes. Parent owns host validation and Task2 metadata after receipt.

## Review focus

Broken excluded pin, authorless/inner reply, competing lazy failures, Accept/HEAD/cache/redirect headers, Entity/schema ownership: Task1 tests each.

### Task1: Product, literal-source oracle, tests

**Files:** new `modules/federation/local-featured.ts`, `http/activitypub-notes-api.ts`, `composition/featured-http.ts`, `platform/database/local-featured.ts`; new `composition/published-note.ts`; extend `note-activity.ts` reader/renderer and federation public exports, wire `composition/http-app.ts`; upstream manifest only plus generator outputs. New `local-featured-{corpus.json,source-probe.mjs,observations.json}` and focused unit/real DB HTTP tests.
**Interfaces:** existing NoteActivityMaterials/NoteDeliveryMaterials remain supported. Add prepared reply material with explicit dive choice, staged Note facts reader; public functions assemble featured and Note publication without framework types. Route composition supplies federation, selfHost, reads, time.

- [x] Read selection report if available; record material conflict before implementation.
- [x] Execute literal pinned methods/Fastify handlers on finite corpus and record hashes/doubles/limits.
- [x] Write source-comparison unit and actual HTTP/PG behavior tests for requirements 1–7. Run before code; save raw expected RED logs, correcting infrastructure-only failures separately.
- [x] Manifest-add UserNotePining; run normal sync or write parent sync-ready marker on EPERM. Never hand-edit generated code.
- [x] Implement staged source fact acquisition, one-level pure reply rendering, featured and Note GET branches including headers; preserve delivery false and existing qualified differences.
- [x] Run focused tests; record each fix iteration. Add meaningful tests for newly discovered boundaries before fixes. Run closest delivery/actor and schema regressions via parent host broker when sandbox blocks.
- [x] Freeze exhaustive executable input hash map and exact command list in `/tmp/tiramiss-s1-r12-validation-request-r1.json`. Parent runs sync:check/upstream tests/build/typecheck/units/DB HTTP/schema/source probe/shipping. Stop editing frozen inputs while run is pending.

### Task2: Actual evidence and metadata (parent-owned)

**Files:** root metadata helpers/inventory/ROADMAP/README/results, outside writer scope.
**Consumes:** Task1 frozen request, actual host receipt, review findings and implementation report.
**Produces:** measured receipts and accurate capability/remaining ownership text; no completion inflation.

- [x] Parent validates frozen hashes and actual exit/test/skip counts; fixes require a new frozen request. R1 FAIL is retained; corrected fixture R2 measured all 1080 stable inputs with zero failed/skipped tests.
- [x] Parent updates metadata only from actual R3 receipt, retains notes/create partial, postingComplete:false and five gap groups/formal order; separate metadata-host validation passed.
- [ ] Parent handles final review, Git, CodeRabbit and PR. Writer supplies changed interfaces, TDD/source provenance, failures and limitations in `/tmp/tiramiss-s1-r12-implementation-report.md`.

Self-review: all numbered spec requirements map to Task1 except parent-owned Task2 evidence/metadata. No test PASS is asserted in this plan.

Writer execution notes: behavior RED recorded in r12-red-r2.log (3 expected failures); source comparison now includes literal redirect guard and ID parsing. Initial DB execution was EPERM with skipped tests, never PASS. Parent completed normal sync/build through sync-done.json. The initial exhaustive composition assertion failed for two new paths; parent ruled that its enumeration should be extended without removing existing assertions. Task2 remains parent-owned.

Historical R2 product gates: then-current source pin `b0d08179e20b98f0f1356d49e110f8fc0eb83d1f` contains the full 23-file implementation in two ordinary commits. Parent R2 `2026-11-13T08:45:07.807224+00:00` → `08:45:36.570334+00:00` passed sync/upstream5/build/typecheck, units255, realDB/listening HTTP202, migration/schema6, source98, shipping and separate composition6, all zero failed/skipped tests. Receipt SHA256 `349563567d2c943b4082c26798b99383dd236511cfe67429f00e17799d3c304d`. R3 supersedes this R2 receipt as the current product measurement; metadata host validation and final review/PR remain pending. The earlier overbroad composition ruling permitted extending exactly two paths; it was not a user requirement that assertion bytes be immutable or a user child-worker prohibition. This Task2 dispatch independently requires no child workers and unchanged old root assertions.

## Current R3 source and metadata gate

Current source pin `bcb828e878c5d14cb5be7b9ebf743fd452cca648`, base PR #269 `0b5ab105952292ea1ac63ea54cefc638cbf88012`. Parent R3: 1,084 inputs, units 257, separate composition 6, HTTP/PG 203, schema 6, source 100 and shipping PASS; see [results](../compatibility/remote-user/local-featured-results.md) for exact receipt and R1/R2 history. The full review found the Unicode P2; scoped fix review is spec PASS / quality APPROVE. Root metadata edited after R3 requires a separate host gate. This plan and results may receive parent factual stamps after that gate; those stamps are outside the measured executable proof.

Parent metadata checkpoint `2026-11-13T09:26:57.298237+00:00`: 1,101 inputs, normal generator write/check, root311 (old271+new40, zero failures/skips), invariants, shipping and diff check PASS. Receipt SHA256 `9c8498f3c188eb06e167a7e4b1070939a191fd59c7702a72dd716db04c85f8cb`. This factual plan/results stamp is post-measurement; exact preimages are archived as described in the results. The unchecked final review/publication gate records this pre-publication checkpoint, not a claim about later GitHub state.
