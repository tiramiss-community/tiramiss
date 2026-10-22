# Local job execution ownership (J2b1) implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task, then independent review until findings converge.

**Goal:** Establish the DB execution boundary for the initial local AP expansion and notification items, preserving finite attempts and rejecting stale owners.

**Architecture:** The dispatch adapter remains unchanged. A platform DB adapter validates a persisted dispatch envelope against the DB, locks note → item → queue controls, and obtains a separate execution lease. Completion is bound to a caller-owned transaction so future business adapters can commit their result with progress; no handler or production worker is activated in this increment.

**Tech Stack:** TypeScript, TypeORM QueryBuilder, PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-job-persistence-design.md` §§3–4, 6, 9; `2026-10-21-note-flow-design.md` §6.

## Global constraints

- DB time is authoritative. Execution lease 60 seconds, renewal cadence for the future runner 10 seconds, local attempt limit 8.
- Waiting consumes no attempt. A successful execution claim consumes exactly one, including a claim followed by process death.
- Backoff: min(60 seconds × 2^(n−1), 1 hour), plus 0–20% jitter; never extend the original deadline.
- No business/transport types cross into each other. Routine CRUD uses QueryBuilder. No applied migration edits.
- Only initial `ap.expand` and `notification.create` are claimable here; `ap.send` requires host leases and is rejected without mutation. `ap.expand.page` is reserved for the recipient-page increment and rejected without mutation.
- J2b2 still owns actual saved Note producer, recipients/pages/host leases, business notification storage/effects, BullMQ execution, 5-second scan/10-second renewal lifecycle, Redis generation recovery. J3 administration/cleanup remains separate. #124 stays open.

## Review focus

- Forged/stale transport envelopes must not quarantine or consume a valid saved item.
- A lease expiring during business result writes must roll those writes back.
- Multiple local items settling in parallel must not leave a request open or falsely settled.
- Deadline/attempt exhaustion must remain discoverable even when scanner excludes expired items.
- Transaction callbacks must not retain a usable completion scope after transaction end.

### Task 1: Execution ownership and validation

Files: create `src/platform/jobs/local-execution.ts`, `src/platform/database/post-work/local-execution.ts`, `test/integration/post-work-local-execution.test.ts`.

Interfaces: `LocalExecutionClaim` contains workId/requestId/noteId/kind/owner/epoch/attempt/deadline, validated request and item payload. `PostWorkLocalExecutionStore.claim(envelope, owner)` returns a claim or null; `.renew(claim)` returns boolean. Envelopes contain workId, kind, schemaVersion, dispatchSeq, queueGeneration, as emitted by J2a. Scope supports only the initial local kinds.

- [x] Write tests for parallel claim (one owner/one attempt), initial local payload reconstruction, wrong/stale/released dispatch/generation, future/pause/active lease, cancellation, damaged payload/hash and unknown saved version.
- [x] Run the new tests and observe failure from missing execution behavior.
- [x] Implement DB-local checks, note/item/control lock order, immutable validation using preparePostWork, 8 attempts and 60-second lease; implement fenced renewal.
- [x] Verify claim/reclaim preserves epoch, cumulative attempts and deadline; old owner and expired renewal fail.

### Task 2: Transactional completion and bounded recovery

Files: same DB adapter, new `src/platform/database/post-work/local-execution-state.ts` for shared state/aggregation, new unit policy test if pure policy extracted.

Interfaces: `withLocalWorkCompletion(manager, claim, work)` locks note/item in an active caller transaction before invoking result writes, then conditionally completes/retries; it throws on lost ownership so the caller rolls the transaction back. Store `.finish(claim,outcome)` wraps progress-only completion. `.expire(limit=100)` settles expired/attempt-exhausted local items only when no valid execution lease remains. Terminal request aggregation locks the parent after item mutation, queries sibling state, and commits together.

- [x] Write tests for effect+progress rollback, stale owner rollback, completion after deadline, retry jitter bounds/terminal budget, skipped/cancelled/permanent outcomes, request attention vs settled and concurrent sibling completion.
- [x] Observe failures then implement owner/epoch/lease/deadline fencing and final conditional update.
- [x] Verify maximum100 recovery candidates, unknown/corrupt quarantine, unchanged execution counters on waiting and no reset during recovery. No external-send unknown recovery is implemented by this local adapter.

### Task 3: Reviewable delivery

Files: update backend-next README and this plan with outcomes.

- [x] Run near integration tests plus typecheck/build; shipping script lint/SPDX/locale and diff check.
- [x] Independent agent reviews the complete branch; reproduce and address findings, repeat until no actionable findings remain.
- [ ] Commit/push/create PR using project template, relating #124 without closing it. State the remaining J2b2/J3 work plainly.

## Execution record

- Base: develop `4b01f8d963` (merged PR151); isolated worktree `/tmp/tiramiss-job-worker-124`.
- Initial test run failed because the execution adapter did not exist. After implementation, the first run passed31 cases and exposed two test-fixture parameter casts, corrected without changing the intended assertions.
- Independent review identified renewal after an unchanged row-lock wait: the real-DB regression returned true before the fix, then false after acquiring the row lock before checking time in a fresh statement.
- Completion was changed before delivery to acquire note/item locks before invoking business writes. The callback and progress share a caller-owned transaction; errors must propagate to that boundary.
- An additional regression demonstrated that a premature item schedule could bypass request.not_before. Checking both DB timestamps fixed it (RED→GREEN).
- Final near integration:42 PASS. Full integration before the last not-before regression:120 PASS. Unit:174 PASS. Build/typecheck/shipping lint4/SPDX/locale:PASS. No entity/migration/API/locale changes; no legacy backend generation or process tests required for this DB-only increment.
- Existing upstream-migration pg concurrent-query deprecation warning remains unchanged.
- Test-only execution_probe verifies rollback of arbitrary DB effects; it is not a product Note/notification producer or proof of completed J2.
- J2b1 is intentionally DB-only; J2b2 and J3 remain necessary before #124 can close. No handler is automatically activated.
