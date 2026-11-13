# Local Actor Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Single writer; parent owns subsequent review and Git operations.

**Goal:** Publish the selected stored local actor fields through both existing callers with independent source and PG evidence.

**Architecture:** Add six required plain facts and map existing User columns. Keep the shared renderer pure; keep all composition paths unchanged.

**Tech Stack:** TypeScript, TypeORM, Hono, Vitest, Node 26.4.0, installed frozen pnpm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-local-actor-fields-design.md`

## Global Constraints

- Base `6601944296f367e66fde8ecf3a2458c946ae2a6c`; pinned source `8e07cf085adf7009583d234a208e30436f020e26`.
- Node 26.4.0 via `/tmp/tiramiss-s1-node26/bin`; no installs or dependency/schema changes.
- Single writer; only `src/modules/federation/local-actor.ts` and `src/platform/database/local-actors.ts` production edits under backend-next.
- No historical fixture/receipt edits, workers, commits, external sends or CodeRabbit. Parent owns metadata/proof helpers, review, push and PR.
- No old backend, synchronized entities, locales, CHANGELOG, inventory, remote README, ROADMAP or final results edits in Task 1.
- RED before product edits; genuine sandbox-blocked RED means NEEDS_HOST_RED and immediate stop. Dedicated PG55514/Redis56414/Meili57814 only; never touch misskey-infra.
- Preserve the ingestion prefix mismatch, source qualification and historical evidence hops. Featured serving and Move execution remain unimplemented; #176/#127/#195 OPEN, notes/create partial, postingComplete:false.

## Review Focus

- False/zero/negative cutoffs must survive serialization and DB reads (Task 1 source/unit/PG cases).
- Empty aliases stay present; duplicate raw URI order stays exact (Task 1 source/unit/PG cases).
- Empty movedTo is omitted; dotted bot users retain Application precedence (Task 1 source/unit/PG cases).
- Dependency failures retain priority and uncached HTTP errors (Task 1 representative source failures and existing actor/profile/tag/media tests).
- Historical signer allowlist and later evidence hops remain intact (Task 1 historical unit assertions; Task 2 provenance contracts).

### Task 1: Publish selected local actor fields with independent evidence

**Files:** Create the spec/plan, remote-user `local-actor-fields-{corpus.json,source-probe.mjs,observations.json}`, `test/helpers/local-actor-fields.ts`, and `test/unit/federation/local-actor-fields.test.ts`. Modify the two production files above, `test/integration/activitypub-actor.test.ts`, and typed test consumers only as needed.

**Interfaces:** Consumes unchanged `renderLocalActor(facts, profile, selfUrl, publicKeyPem, tag, media): Record<string, unknown>` and `createActorReader(manager, options)`. Produces six required facts with spec types, serialized actor fields, and a frozen validation request for Task 2.

- [x] Capture literal pinned renderPerson outputs with explicit doubles and verified source identity. Run `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-actor-fields-source-probe.mjs --write`, then `--check`; expected exact replay.
- [x] Add pure oracle comparisons and PG HTTP/internal-document cases covering booleans independently, each cutoff null/zero/positive/negative, move null/empty/value, aliases null/empty/ordered duplicates, ordinary/bot/system. Run `pnpm --filter backend-next test test/unit/federation/local-actor-fields.test.ts`; expected actual missing-field assertions RED before product edits.
- [x] Add required facts and exact source output rules; pass stored columns through reader. Add explicit defaults to typed callers and restore historical explicit signer allowlist without editing historical oracle bytes.
- [ ] Run closest actor fields/actor/profile/tags/images/API/composition/WebFinger consumers, pinned `--check`, sync:check, build/typecheck, integration actor+remote-user and shipping as applicable; expected PASS or recorded one-time sandbox block.
- [ ] Freeze current executable package/test/config, oracle and required sync/schema/build inputs in `/tmp/tiramiss-s1-r11-validation-request-r1.json`; report files, RED, outcomes and remaining risks. Stop for parent validation; no commits.

### Task 2: Measured metadata renewal (fresh writer after host receipt)

**Files:** Parent-owned root evidence helper/contracts, new current receipt, results/remote README, applicable inventory rows and ROADMAP.

**Interfaces:** Consumes Task 1 frozen sha256 map and actual successful host receipt; produces a finite additive evidence hop retaining all predecessors through WebFinger, with exact command timestamps/counts/artifact hashes.

- [ ] Fresh metadata writer tests unknown predecessors, altered bytes, missing/inapplicable/failed/skipped measurements and tampered provenance before adding the leaf validator; no predecessor helper imports or recursive validation.
- [ ] Update only measured partial inventory rows and scope/result links; retain historical return identities and receipts. Parent performs review/CodeRabbit/shipping/commits/PR with `Refs #195, #176` after validation. This task is intentionally deferred from the implementation writer.
