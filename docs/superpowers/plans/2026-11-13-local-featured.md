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

- [ ] Read selection report if available; record material conflict before implementation.
- [ ] Execute literal pinned methods/Fastify handlers on finite corpus and record hashes/doubles/limits.
- [ ] Write source-comparison unit and actual HTTP/PG behavior tests for requirements 1–7. Run before code; save raw expected RED logs, correcting infrastructure-only failures separately.
- [ ] Manifest-add UserNotePining; run normal sync or write parent sync-ready marker on EPERM. Never hand-edit generated code.
- [ ] Implement staged source fact acquisition, one-level pure reply rendering, featured and Note GET branches including headers; preserve delivery false and existing qualified differences.
- [ ] Run focused tests; record each fix iteration. Add meaningful tests for newly discovered boundaries before fixes. Run closest delivery/actor and schema regressions via parent host broker when sandbox blocks.
- [ ] Freeze exhaustive executable input hash map and exact command list in `/tmp/tiramiss-s1-r12-validation-request-r1.json`. Parent runs sync:check/upstream tests/build/typecheck/units/DB HTTP/schema/source probe/shipping. Stop editing frozen inputs while run is pending.

### Task2: Actual evidence and metadata (parent-owned)

**Files:** root metadata helpers/inventory/ROADMAP/README/results, outside writer scope.
**Consumes:** Task1 frozen request, actual host receipt, review findings and implementation report.
**Produces:** measured receipts and accurate capability/remaining ownership text; no completion inflation.

- [ ] Parent validates frozen hashes and actual exit/test/skip counts; fixes require a new frozen request.
- [ ] Parent updates metadata only from actual receipt, retains notes/create partial, postingComplete:false and five gap groups/formal order.
- [ ] Parent handles final review, Git, CodeRabbit and PR. Writer supplies changed interfaces, TDD/source provenance, failures and limitations in `/tmp/tiramiss-s1-r12-implementation-report.md`.

Self-review: all numbered spec requirements map to Task1 except parent-owned Task2 evidence/metadata. No test PASS is asserted in this plan.

Writer execution notes: behavior RED recorded in r12-red-r2.log (3 expected failures); source comparison now includes literal redirect guard and ID parsing. Initial DB execution was EPERM with skipped tests, never PASS. Parent completed normal sync/build through sync-done.json. The initial exhaustive composition assertion failed for two new paths; parent ruled that its enumeration should be extended without removing existing assertions. Task2 remains parent-owned.
