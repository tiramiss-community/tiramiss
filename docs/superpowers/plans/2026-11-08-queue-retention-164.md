# Queue History Retention and Cleanup #164 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete #164 for the three connected business queues and all ten management selectors with pinned upstream evidence, real Redis retention/cleanup tests, and explicit ownership of future handlers.

**Architecture:** Preserve the existing producer-owned BullMQ `removeOnComplete`/`removeOnFail` options and the existing queue administration adapter. Source reconnaissance found no missing queue-history timer: automatic removal occurs during terminal transitions, while administrator `clear` uses normal BullMQ APIs. Add runtime code only if the comparisons demonstrate a defect; this may correctly finish as tests and documentation.

**Tech Stack:** TypeScript, BullMQ 6.3.11, Redis, Vitest, existing Hono queue administration, pinned-source CommonJS probes.

**Spec:** [Current posting contract](../../backend-next/posting-contract.md#通常ジョブ162), [GOALS](../../backend-next/GOALS.md), [ROADMAP](../../backend-next/ROADMAP.md), live [#164](https://github.com/tiramiss-community/tiramiss/issues/164) under [#124](https://github.com/tiramiss-community/tiramiss/issues/124). Basic redesign §§6.3–6.4/11 supplies the adapter and process boundaries; its superseded PG ledger and retention guarantees do not override current scope.

## Global Constraints

- Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`; worktree base: `6246c3605a5d150c61ba8b4f965db651f70c7138`.
- Connected producers/workers: `deliver`, `endedPollNotification`, `userWebhookDeliver`; each currently supplies success `{ age: 604800, count: 30 }`, failure `{ age: 604800, count: 100 }` at enqueue.
- All ten queue names remain manageable. Management handles neither consume nor assign retention to existing jobs; all upstream Workers have no removal fallback overriding job options.
- Age retention is lazy cleanup during relevant terminal transitions, not a seven-day expiry deadline for an idle queue. Do not add a periodic queue-history cleaner or global default that homogenizes other job types.
- Ordinary automatic retention and terminal-state cleanup must preserve waiting, delayed, paused, prioritized, and locked active work. Explicit administrator `clear` of those states or `*` retains its existing destructive source semantics.
- Do not edit old backend, managed upstream definitions, merged migrations, locales, CHANGELOG, dependencies, or revive removed PG request/item/dispatch/effect/recipient/host ledgers and charged-byte accounting.
- Isolated verification resources only: this session uses PostgreSQL `55486`, Redis `56386`; never operate the user's `misskey-infra` project.
- User already authorized implementation and the normal next-PR workflow; parent owns review, final verification, commits, push and PR. Do not insert a new approval menu.

## Review Focus

- A quiet old completed/failed job stays observable until a matching terminal transition removes it; test both quiet visibility and the later trigger.
- Success cleanup must not remove failures, and failure cleanup must not remove successes or unfinished work; test both state independence and age boundaries.
- Count limits are per queue and terminal set, not per job name; test mixed names at 30/31 completed and 100/101 failed.
- A failed job still being retried is delayed/waiting rather than terminal history; test it survives terminal cleanup and completes through the real Worker adapter.
- Administrator history reads and terminal-only clearing apply to all ten selectors, preserve neighboring queues/prefixes, and keep locked active work; test actual Redis states and subsequent HTTP visibility.

---

## Reconnaissance and completion boundary

`src/platform/job-queue/deliver.ts:27`, `ended-poll-notification.ts:24`, and `user-webhook.ts:20` already implement the upstream retention options. `src/processes/worker.ts:24` connects exactly their three Workers. `src/platform/job-queue/administration.ts:34` opens all ten names; its `clear` implementation at line 79 already uses `clean(0, 0, state)` and the source seven-state expansion of `*`. Existing #163 tests cover API authorization, real retry, selected cleanup, foreign-prefix isolation and lifecycle, but do not establish all producer retention age/count semantics.

Pinned `QueueService.ts` registers nine system schedulers. The `clean` job is business maintenance (user IPs, antenna inactivity, expired Role assignments, Reversi); it does not scan BullMQ terminal history. Obsolete **system job scheduler definitions** are cleaned during constructor setup, which belongs with future system scheduler installation and stopped-state compatibility, not an invented retention timer.

Full current #164 closure requires all four live checklist items: per-queue source investigation, actual ordinary retention/cleanup connection, real Redis behavior with management visibility, and explicit notification/maintenance handoff. It does **not** claim all ten business handlers have shipped. Keep these residual owners visible:

| Queue / data | Current status and residual owner |
| --- | --- |
| `deliver` | Connected; retained history covered here. Future AP producers remain with their feature owners. |
| `endedPollNotification` | Connected; queue history covered here; PG notification body/read/push retention remains #177. |
| `userWebhookDeliver` | Connected posting slice; queue history covered here; other webhook events/management remain #197. |
| `system` | Management only. Business clean/muting/moderator/remote cleanup and the single announcement archive job remain #199; chart/aggregate/buffer jobs #200 and their feature owners. Install scheduler-specific age-only retention and obsolete-scheduler reconciliation with the real scheduler implementation. |
| `postScheduledNote` | Management only; scheduler/business handler remains #183. |
| `inbox` | Management only; receive handler and producer policy remain #195. |
| `db` | Management only; import/export/account deletion remains #199. |
| `relationship` | Management only; relationship handlers/policies remain #182. |
| `objectStorage` | Management only; object deletion/storage handler remains #188; remote-file maintenance coordinates with #199. |
| `systemWebhookDeliver` | Management only; system webhook producer/handler remains #198. |
| Existing Redis payloads/schedulers | #165 determines consume/drain/transform and rollback/backup requirements; #139 owns final stopped cutover. No existing work is silently discarded here. |
| Operational information | #138 consumes exact age/count, lazy removal, counts/history visibility and explicit clear behavior documented here; no new monitoring service is required. |

Future producers must carry their **own pinned source** retention, including deliberate no-removal cases, rather than inheriting the three connected producers' count limits.

### Task 1: Pin the actual retention, scheduler and manual cleanup contract

**Files:**
- Create: `docs/superpowers/compatibility/queue-retention/reference-queue-retention.cjs`
- Create: `docs/superpowers/compatibility/queue-retention/observations.json`
- Create: `docs/superpowers/compatibility/queue-retention/README.md`
- Test: `packages/backend-next/test/unit/job-queue/retention.test.ts`

**Interfaces:**
- Consumes: pinned `git show` blobs for `QueueService.ts`, `QueueProcessorService.ts`, `QueueModule.ts`, `queue/const.ts`, `NoteCreateService.ts` and actual maintenance processors.
- Produces: a reproducible source observation JSON with fixed commit, source hashes, enqueue removal policies, Worker fallback absence, scheduler registration/removal and manual `clean` arguments. Test the actual public producer helpers `deliverJobs`, `pollEndedJobOptions`, `userWebhookJob` against its relevant projections.

- [x] Execute pinned production methods with explicit queue/Worker/clock doubles; cover all ten queue families and special policies, not just the three equal default cases. Preserve the real source method bodies and record the observed boundary.
- [x] Regenerate into `/tmp` and byte-compare the committed JSON. Document that this is source execution with doubles, not upstream full-server or real Redis comparison.
- [x] Add direct comparisons of all three current producer options and all ten actual upstream Worker removal-fallback observations. Do not normalize a mismatch into the expected fixture.
- [x] Run `pnpm --filter backend-next test test/unit/job-queue/retention.test.ts` and the existing `test/unit/job-queue/{deliver,ended-poll-notification,user-webhook}.test.ts` files. Expected: all pass and deliberate option mutation fails the new comparison.
- [x] Review the source oracle independently before runtime implementation. Parent commits a coherent oracle/test change after checks.

### Task 2: Prove real retention and safe terminal cleanup through existing adapters

**Files:**
- Create: `packages/backend-next/test/integration/queue-retention.test.ts`
- Modify: `packages/backend-next/test/integration/queue-admin.test.ts` only for the all-selector terminal history/cleanup cases.
- Conditional defect fix only: the demonstrated responsible file in `src/platform/job-queue/`; no new production abstraction or worker is planned.

**Interfaces:**
- Consumes: production `createDeliverQueue`/`startDeliverWorker`, `createPollEndedQueue`/`startPollEndedWorker`, `createUserWebhookQueue`/`startUserWebhookWorker`; existing Redis prefix construction, isolated test settings, and `openQueueHttp` integration setup.
- Produces: real Redis evidence for job-level options at enqueue, successful/failed finalization, lazy age/count removal, retry preservation, management reads and explicit cleanup. Handler doubles may decide success/failure; do not replace the production producer/Worker adapters or mutate production removal options.

- [x] Enqueue through each real producer, pause/inspect as needed, and assert persisted `job.opts` equals the source success/failure policies. Process through each real Worker with a controlled handler result; assert retained terminal state, attempt/result/error fields and distinct success/failure sets.
- [x] For each connected queue finalize 31 successes and 101 terminal failures with distinct job names. Assert exactly 30 completed and 100 failed remain, and pruned hashes/logs disappear. Compare survivor/deletion counts unless terminal timestamps are deliberately distinct: same-millisecond ties do not establish insertion order. Use unrecoverable failure to reach terminal failure without changing production attempts/backoff; retain at least one ordinary retry case separately.
- [x] Seed valid retained jobs through the real paths, stop the Worker, then age only test fixture terminal sorted-set scores and matching hash `finishedOn` to just inside/outside `604800000` ms (use ±60000 ms). Restart without new work and assert reads alone leave old history present; a subsequent success removes only eligible completed history and a subsequent failure removes only eligible failed history. Exact-cutoff equality requires a controlled passed clock at completion; avoid fake global timers. Document test-only Redis writes and never add production age controls.
- [x] Include old-looking waiting/delayed/prioritized/paused jobs and a gated locked active job; after automatic retention and targeted terminal `clear`, assert their IDs/states survive. Release and drain active handlers in `finally` before closing resources. Confirm queue and prefix isolation.
- [x] Exercise ordinary transient failure with a real Worker and its existing retry policy; terminal cleanup must preserve the delayed/waiting retry job and the later successful terminal record. Inspect the actual job state rather than using fixed sleeps.
- [x] Add one no-policy control: a raw job with no removal options survives the source-equivalent Worker without fallback; a later policy-bearing terminal job may trim it through the shared queue/state set. Verify the neighboring queue/prefix remains unchanged. This is evidence for #165, not permission to rewrite old job options.
- [x] Extend all ten management selectors with synthetic completed/failed records, existing HTTP `show-job`/`jobs`/`queue-stats`, and `clear` limited to `completed` or `failed`. Assert matching records disappear, the opposite terminal state and unfinished jobs remain, and HTTP sees actual removal. Preserve `clear('*')` and non-awaited204 semantics already covered by #163.
- [x] Run `BACKEND_NEXT_TEST_DB_PORT=55486 BACKEND_NEXT_TEST_REDIS_PORT=56386 pnpm --filter backend-next test:integration test/integration/queue-retention.test.ts test/integration/queue-admin.test.ts`. Expected: all pass without modifying application behavior. If a genuine mismatch fails, add the narrow regression, fix only its owner, and rerun the closest tests.
- [x] Parent reviews and commits the runtime evidence/fix. Reuse existing #162/#163 process lifecycle tests; new process tests are needed only if production lifecycle changes.

### Task 3: Record complete current scope and hand off future work accurately

**Files:**
- Modify: `docs/superpowers/compatibility/queue-retention/README.md`
- Modify: `docs/backend-next/posting-contract.md`
- Modify: `docs/backend-next/ROADMAP.md`
- Modify: `packages/backend-next/README.md`
- Modify if its tracked retention rows need evidence: backend inventory source records and generated documentation through their existing generator, never hand-edit generated output.

**Interfaces:**
- Consumes: Task1 source observations, Task2 actual commands/results, and the ten-queue ownership table above.
- Produces: source/new-runtime evidence clearly separated; #164 completion criteria and exact residual ownership; no assertion that #165/#176/#177/#199 or parent #124 is finished.

- [x] Document all ten queue names, all currently connected producers, per-job special retention policies in the oracle, absence of Worker fallback, lazy age/count behavior and administrator visibility/removal. Explain that idle history has no hard expiry and explicit `*` can remove unfinished work.
- [x] Replace current misleading “周期清掃 #164” next-step text with the measured upstream behavior and current completion status. Link future scheduler/business-clean obligations to #199/#200, data-body retention to #177, and existing jobs/schedulers/cutover to #165/#139. Retain chronology of older progress entries.
- [x] Record only observed results and the scope limits: controlled handlers/source doubles versus real BullMQ/Redis/HTTP; no upstream full-server claim; no count-based completion percentage. Add exact focused commands to the package README.
- [x] Run `pnpm --filter backend-next... build`, `pnpm --filter backend-next... typecheck`, the focused unit/integration commands above, and `node scripts/check-shipping.mjs --base 6246c3605a5d150c61ba8b4f965db651f70c7138`. Expected: changed-file lint, `SPDX: OK`, locale safety and relevant tests pass. Parent records PASS/FAIL/BASELINE/SKIPPED, independent whole-branch review and final `git diff --check`.
- [x] Parent prepares the PR body and target branch for the normal push/PR workflow with `Closes #164` only after all four current checklist items have evidence. State that #165 remains the next required queue work, and do not close #124 or unrelated feature owners.


## Execution evidence (2026-11-08)

Task1/2 independent source/runtime reviews: PASS/APPROVE, including the all-ten failed-only-clear preservation correction; no open findings at those gates. Evidence commit: `2549ec263662c10cdd238448482f325c1693c035`. Source24 observations/8 files/32 producer methods; new28 direct unit comparisons and18 integration cases. Focused unit4 files/97 tests PASS; real dependency integration2 files/49 tests PASS after the correction; build/typecheck and evidence-commit shipping checks PASS. No production code changed. Source execution uses explicit doubles; runtime tests retain real producer/Worker/BullMQ/Redis/HTTP with controlled handler outcomes. Neither substitutes for an upstream full-server/business comparison.

The all-ten integration first clears completed history, creates a fresh completed sentinel via a gated real test Worker, then clears failed history and checks that sentinel and its logs/HTTP visibility survive. New process tests are SKIPPED because lifecycle is unchanged; existing #162/#163 coverage is reused. API generation and migration checks are not applicable.

Final independent whole-branch review: PASS/APPROVE after the two documentation corrections (system webhook owner #198 and announcement archive under system). No open or parked findings remain. PR body and target branch `develop` are prepared for publication with `Closes #164`; actual publication is not claimed by this record.
