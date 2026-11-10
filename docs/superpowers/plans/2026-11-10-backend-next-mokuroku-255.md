# [tiramiss-community/tiramiss] #255 mokuroku-js 0.2.0 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace backend-next’s three business queue wrappers and `WorkerStarter` registry with published mokuroku-js 0.2.0 while preserving existing jobs, business effects, administration, and process lifecycle.

**Architecture:** Declare the three queues and typed jobs explicitly, expose narrow producer capabilities, and register one default handler per queue. Each child owns a producer runtime; worker children additionally own a separate worker runtime. Existing feature factories, `ResourceScope`, process deadlines, and Supervisor remain the lifecycle boundaries.

**Tech Stack:** TypeScript, `@mokurokujs/core@0.2.0`, `@mokurokujs/bullmq-adapter@0.2.0`, BullMQ `6.3.11`, ioredis `5.11.1`, existing TypeORM/Hono infrastructure, Vitest, isolated PostgreSQL/Redis.

**Spec:** [Approved foundation design](../specs/2026-11-09-backend-next-application-foundation-design.md), [#255 requirements](https://github.com/tiramiss-community/tiramiss/issues/255), [#251 staged foundation scope](https://github.com/tiramiss-community/tiramiss/issues/251), and [redesign queue boundaries](../specs/2026-10-15-misskey-backend-redesign-design.md).

## Global Constraints

- Use published, exact `@mokurokujs/core@0.2.0` and `@mokurokujs/bullmq-adapter@0.2.0`. Preparation tarballs and reference checkouts are historical/source evidence.
- Retain BullMQ `6.3.11` and ioredis `5.11.1`; do not bypass incompatible peers.
- Migrate only `endedPollNotification`, `deliver`, and `userWebhookDeliver`.
- Preserve saved jobs in place: names, IDs, payloads, options, priorities, retry history, timestamps, terminal results, and namespace.
- Business code receives concrete capabilities; mokuroku runtime/context and BullMQ `Job` remain inside platform/composition.
- HTTP prepares producers and enqueues jobs; it never registers or starts business workers.
- Preserve global administration through `Queue.pause()`/`resume()`. mokuroku’s pause APIs control local workers.
- Preserve no-reconnect behavior, readiness, failure propagation, follow-up drain, and existing process deadlines.
- Add no schema migration, outbox, durable job state, scheduler abstraction, automatic discovery, or stronger delivery guarantee.
- Seven other handlers and nine system schedulers retain their existing owners. This PR does not complete #139, #176, or #127.
- Source references under `/tmp/mokuroku-release-pr33` or `/home/osamu/develop/mokuroku-js` are read-only.
- Routine implementation choices need no further design approval; the user has requested implementation, CodeRabbit review, and PR creation. No merge or npm publication is authorized.

These boundaries follow [GOALS](../../backend-next/GOALS.md), the [foundation exclusions](../specs/2026-11-09-backend-next-application-foundation-design.md), and the [queue inventory](../../backend-next/application-foundation-inventory.md).

## Review Focus

1. Stored follow/unfollow/followed webhook snapshots must still execute despite the narrower current producer type — Tasks 1 and 3.
2. A manager cleanup notification must not incorrectly suppress a successfully closed worker’s follow-up drain — Tasks 1 and 2.
3. Loss after queue readiness but before later initialization completes must prevent readiness — Tasks 2 and 4.
4. Empty bulk delivery, null single delivery, negative poll delay, and configured zero values must retain existing behavior — Tasks 1 and 3.
5. A completed job with a blocked background PG update must keep dependencies alive through shutdown, until completion or the overall deadline — Task 4.

## Requirements, assumptions, and source findings

The baseline is branch `refactor/backend-next-mokuroku-255`, HEAD `d3eed2edad0bbcb262358963f4eab534e11f4a6c`, with a clean working tree. Recheck this before implementation and reconcile any newly added handlers without silently expanding #255.

The latest user instruction authorizes this bounded migration and supersedes preparation-era installation wording and older requests to schedule another design decision.

### Findings retained or corrected after source inspection

| Claim | Source conclusion and implementation consequence |
| --- | --- |
| Dynamic stored names require a compatibility dispatcher | Refuted. The adapter selects an exact registration, then the queue default, passes saved `job.data`, and returns the handler result. Register one default per queue; do not rewrite or replay jobs. [Adapter routing](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/backend.ts). |
| One manager can safely own producers and workers through shutdown | Rejected for this application. Its stop closes workers and then its queues; it does not know about `deliver.idle()`, webhook status writes, or post-save/delete enqueue work. Separate producer and worker lifetimes preserve those dependencies. [Manager cleanup](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/queue-manager.ts), [current role cleanup](../../../packages/backend-next/src/processes/lifecycle.ts). |
| Prefix-only `queueOptions` is sufficient | Runtime merge permits it, but the declared `QueueOptions` requires `connection`. Pass complete `baseQueueOptions(...)`; the manager replaces connection with its authoritative connection. Worker prefix inherits the queue prefix. [Types](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/types.ts), [merge order](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/queue-manager.ts). |
| `ready()` prepares all declared business queues | Refuted. Without arguments it prepares the backend default queue. Always call `ready(definitions.queues, { timeout })`. [Backend readiness](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/backend.ts). |
| Manager `cleanup` events identify rejected `Worker.close()` calls exactly | Refuted. They also include emitted errors during cleanup. BullMQ can emit an error and still fulfill close. Events alone cannot preserve the existing close-success/drain rule. [Manager tracking](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/queue-manager.ts), [BullMQ close](../../../packages/backend-next/node_modules/bullmq/dist/esm/classes/worker.js). |
| mokuroku stop timeout means resources are closed | Refuted. Deadline rejection does not cancel cleanup. Production shutdown must await actual cleanup and rely on `runChild`’s single overall deadline. [Deadline implementation](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/lifecycle-operation.ts), [process deadline](../../../packages/backend-next/src/entrypoints/run-child.ts). |
| An application logger bridge is necessary | Optional. Omit optional library loggers; use manager diagnostics and existing processor logging. This avoids inventing `debug`/`warn` behavior or forwarding unsafe metadata. |
| Local source version proves published package identity | Refuted. Local manifests and declarations establish intended APIs, not npm bytes. Published exports, integrity, packed dependency rewriting, and installed resolution remain a Task 1 gate. |

### APIs to use

Use public root exports:

```ts
new BullMQQueueManager(connection, { onError });
new JobRuntime(createBullmqBackend({ queueManager }));

defineQueueForBullMQ(name, { queueOptions, workerOptions }).build();
defineJob<TPayload, TResult>(name, { queue });

runtime.handle(definition, handler, { defaultForQueue: true });
runtime.enqueue(definition, payload, { jobName, ...options });
runtime.enqueueBulk(definition, [{ payload, options }]);
runtime.ready(queues, { timeout });
runtime.start({ timeout });
runtime.stop();
```

The concrete signatures are present in [JobRuntime](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/core/src/runtime.ts), [defineJob](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/core/src/job.ts), and [BullMQ helper](https://github.com/mokuroku-community/mokuroku-js/blob/42db4d9fdf0053c237c4c84dd6b0299f0b1abddc/packages/bullmq/src/helper.ts). Verify them again against the installed published declarations.

## File ownership and execution order

Paths below are relative to `packages/backend-next/` unless prefixed with `docs/`, `scripts/`, or another repository-root path.

The lanes describe possible writer ownership; this investigation starts no agents.

| Owner | Exclusive files |
| --- | --- |
| Coordinator | `packages/backend-next/package.json`, root `pnpm-lock.yaml`, conditional exact release-age exceptions in root `pnpm-workspace.yaml`; all documentation and contract-validator/evidence updates |
| Runtime lane A | New `src/platform/job-queue/business-jobs.ts` and `runtime.ts`; existing `connection.ts`, `deliver.ts`, `ended-poll-notification.ts`, `user-webhook.ts`; `src/platform/connect-resources.ts`, `src/composition/queue-workers.ts`, `src/processes/worker.ts`; related unit tests |
| Verification lane B | Integration tests importing removed wrappers; process tests; `test/fixtures/slow-worker.mjs`; new process failure fixture; narrowly required test helpers |

Coordinator installs and freezes the shared interfaces first. A and B may then write disjoint files concurrently. B records the new tests’ failing state before A supplies the behavior. Coordinator merges the lanes, runs final validation, and renews evidence after the measured source has settled.

Retain unchanged unless a demonstrated failure requires a scoped correction:

- `administration.ts`, `handoff.ts`, `handoff-policy.ts`, and `platform/queue-stats.ts`.
- Business UseCases and existing `composition/deliver-job.ts` / `poll-ended-job.ts`.
- `ResourceScope`, `startManagedProcess`, `runChild`, and Supervisor.

## Shared interfaces

Freeze these names before parallel writing.

```ts
type BusinessQueueName =
  | 'endedPollNotification'
  | 'deliver'
  | 'userWebhookDeliver';

interface BusinessJobConfig {
  redis: RedisConfig;
  connectTimeoutMs: number;
  deliverJobMaxAttempts?: number;
  deliverJobConcurrency?: number;
  deliverJobPerSec?: number;
}

interface BusinessJobDefinitions {
  // Producer preparation order: poll, deliver, webhook.
  readonly queues: readonly [
    BullMQQueueDefinition,
    BullMQQueueDefinition,
    BullMQQueueDefinition,
  ];
  readonly pollEnded: JobDefinition<PollEndedJob, void>;
  readonly deliver: JobDefinition<DeliverJob, string>;
  readonly userWebhook: JobDefinition<StoredUserWebhookJob, string>;
}

interface BusinessJobProducers {
  schedulePollEnded(input: {
    noteId: string;
    delayMs: number;
  }): Promise<void>;
  deliverMany(batch: DeliverBatch): Promise<void>;
  deliverOne(input: DeliverOne): Promise<void>;
  enqueueWebhook(
    hook: UserWebhookTarget,
    type: UserWebhookEvent,
    note: Record<string, unknown>,
  ): Promise<void>;
}

interface OwnedBusinessJobRuntime {
  readonly runtime: JobRuntime;
  assertOpen(): void;
  stop(): Promise<void>;
  // Call after stop, including a rejected stop, has settled.
  closedWorkerQueues(): Promise<ReadonlySet<BusinessQueueName>>;
}

function createBusinessJobDefinitions(
  config: BusinessJobConfig,
): BusinessJobDefinitions;

function createBusinessJobRuntime(options: {
  redis: RedisConfig;
  connectTimeoutMs: number;
  onError(event: BullmqManagerError): void;
}): OwnedBusinessJobRuntime;

function createBusinessJobProducers(
  owner: OwnedBusinessJobRuntime,
  definitions: BusinessJobDefinitions,
  config: Pick<BusinessJobConfig, 'deliverJobMaxAttempts'>,
): BusinessJobProducers;

function startQueueWorkers(
  resources: RuntimeResources,
  config: RuntimeConfig,
  reportFailure: (error: Error) => void,
): Promise<WorkerStop>;
```

`StoredUserWebhookJob` retains the current common envelope and distinguishes:

```ts
type StoredUserWebhookJob =
  Omit<UserWebhookJob, 'type' | 'content'> & (
    | {
        type: UserWebhookEvent;
        content: { note: Record<string, unknown> };
      }
    | {
        type: 'follow' | 'unfollow' | 'followed';
        content: { user: Record<string, unknown> };
      }
  );
```

This widens saved transport input, not current producer functionality. The seven stored forms are already accepted by [handoff policy](../../../packages/backend-next/src/platform/job-queue/handoff-policy.ts).

The three processor factories retain their names but return `JobHandler<Payload, Result>` and accept `(payload, context)`. Poll/delivery still parse the incoming payload. Context is used only inside these platform adapters.

### Close-result observation

Implement a private manager subclass in `runtime.ts` that delegates `createWorker` to `super.createWorker` and records the returned Workers. After runtime stop settles, inspect and await their public `Worker.closing` promises; only fulfilled, defined promises count as successful closes.

Use `Parameters<BullMQQueueManager['createWorker']>` and its return type to avoid private package imports. Do not replace Worker construction or wrap `Worker.close`. BullMQ exposes `closing` in its [public declaration](../../../packages/backend-next/node_modules/bullmq/dist/esm/classes/queue-base.d.ts).

The owner adds only a terminal boolean and memoized stop promise. Producer capabilities call `assertOpen()` before runtime access, preventing stale calls from reopening a stopped runtime. Set that flag when producer cleanup begins, after feature drains.

## Queue contracts to preserve

| Contract | Poll | Delivery | User webhook |
| --- | --- | --- | --- |
| Physical name | `endedPollNotification` | `deliver` | `userWebhookDeliver` |
| Dynamic job name | Note ID | Existing first-match URL replacements | Webhook ID |
| Payload | `{ noteId }` | Existing serialized body/digest/user/destination/shared-inbox flag | Captured destination, secret, content, event ID, creation time |
| Attempts | No explicit value | Configured value `?? 12` | `4` |
| Backoff | None | Existing custom strategy | Same custom strategy |
| Concurrency | BullMQ default `1` | Configured value `?? 128` | `64` |
| Limiter | None | Configured value `?? 128` per `1000ms` | `64` per `1000ms` |
| Success result | `void`, stored as `null` | Original result string | `"Success"` |

All three retain:

- Per-job successful retention `{ age: 604800, count: 30 }`.
- Per-job failed retention `{ age: 604800, count: 100 }`.
- `MetricsTime.ONE_WEEK`.
- No Queue/Worker retention fallback.
- Automatic IDs for current producers.
- Existing queue-specific prefix and Redis selection.
- Sanitized connection options: remove ioredis `keyPrefix`; retain `retryStrategy: () => null`, `maxRetriesPerRequest: null`, and configured connection timeout.

Preserve signed poll delay, including negative values. Delivery serializes and hashes once per batch, calls bulk enqueue for an empty inbox map, and keeps the null checks in `deliverOne`. Webhook captures `Date.now()` and `randomUUID()` at enqueue time.

Backoff remains capped **before** rounded jitter:

```ts
base = Math.min((2 ** attemptsMade - 1) * 60000, 28800000);
delay = base + Math.round(base * random() * 0.2);
```

Sources: [poll options](../../../packages/backend-next/src/platform/job-queue/ended-poll-notification.ts), [delivery options/backoff](../../../packages/backend-next/src/platform/job-queue/deliver.ts), [webhook snapshot/options](../../../packages/backend-next/src/platform/job-queue/user-webhook.ts).

---

## Task 1: Published dependency adoption and queue primitives

**Owners:** Coordinator for dependencies; A for platform primitives/unit tests.

**Files:**

- Modify: `package.json`, root `pnpm-lock.yaml`.
- Conditionally modify: root `pnpm-workspace.yaml`.
- Create: `src/platform/job-queue/business-jobs.ts`, `runtime.ts`.
- Modify: helper literal typing and stored webhook type in existing queue feature files.
- Create: `test/unit/job-queue/business-jobs.test.ts`, `runtime.test.ts`.

**Interfaces:** Produces the shared definitions, runtime owner, and producer interfaces above.

- [ ] **Step 1: Establish the published-package receipt.**

  Use Node `26.4.0` and repository-pinned pnpm `12.9.1`. Install:

  ```sh
  pnpm --filter backend-next add --save-exact --strict-peer-dependencies @mokurokujs/core@0.2.0 @mokurokujs/bullmq-adapter@0.2.0
  ```

  Verify registry version, tarball integrity, root ESM exports, public declarations, and the packed adapter’s core dependency. Confirm root and adapter resolve the same core `0.2.0` and BullMQ `6.3.11`, with ioredis `5.11.1`.

  Preserve the [seven-day release-age policy](../../../pnpm-workspace.yaml). If it blocks these authorized versions, add only exact-version exceptions for these two packages. Never disable the policy globally.

- [ ] **Step 2: Write failing primitive tests.**

  Add cases named:

  - `prepares exactly three queues without creating workers`
  - `preserves dynamic names and producer options`
  - `submits an empty delivery bulk and ignores null single delivery`
  - `rejects producer calls after owned stop begins`
  - `distinguishes fulfilled close with emitted error from rejected close`

  Assertions include:

  ```ts
  expect(workerCreations).toHaveLength(0);
  expect(bulkItems).toEqual([]);
  expect(pollOptions.delay).toBe(-1);
  expect(successfulCloses.has('deliver')).toBe(true);
  ```

  Add compile-time positive and `@ts-expect-error` negative payload/result checks against the installed public APIs.

- [ ] **Step 3: Run the tests and capture RED.**

  ```sh
  pnpm --filter backend-next test test/unit/job-queue/business-jobs.test.ts test/unit/job-queue/runtime.test.ts
  ```

  Expected initial failure: missing new implementation exports. Registry or infrastructure failure is a blocker, not RED.

- [ ] **Step 4: Implement the shared interfaces.**

  Build definitions with explicit queue assignment and complete queue options. Keep job-definition defaults limited to queue assignment; reuse existing builders for per-job policies.

  Convert builder output directly:

  ```ts
  { name, data, opts }
  // single
  runtime.enqueue(definition, data, { ...opts, jobName: name });
  // bulk item
  { payload: data, options: { ...opts, jobName: name } }
  ```

  Narrow `backoff.type` with explicit types or `satisfies`; avoid broad casts and a general `JobsOptions` translator.

  Implement terminal ownership and close-result observation as specified above.

- [ ] **Step 5: Verify GREEN and review the dependency diff.**

  Rerun the focused tests and package typecheck. Confirm no tarball/source aliases, peer-ignore settings, unrelated upgrades, or new default queue resources.

  Commit checkpoint: `refactor(backend-next): define mokuroku business queue primitives`.

## Task 2: Connect the normal producer/worker lifecycle and remove wrappers

**Owner:** A.

**Files:**

- Modify: `src/platform/connect-resources.ts`.
- Modify: `src/composition/queue-workers.ts`, `src/processes/worker.ts`.
- Modify: `src/platform/job-queue/{connection,deliver,ended-poll-notification,user-webhook}.ts`.
- Modify: `test/unit/job-queue/{deliver,ended-poll-notification,user-webhook,retention}.test.ts`.
- Modify: `test/unit/composition/queue-workers.test.ts`, `test/unit/worker-startup.test.ts`.

**Interfaces:** Consumes Task 1; produces `startQueueWorkers(...)` and the migrated processor signatures.

- [ ] **Step 1: Write failing behavior tests at the composition boundary.**

  Replace registry-shape assertions with:

  - Three default handlers registered before worker startup, in poll/webhook/delivery order.
  - Startup waits for readiness.
  - Ordinary errors remain diagnostics.
  - Fatal manager events retain queue identity and map as follows:

    | Event | Diagnostic |
    | --- | --- |
    | `connection-ended` | `JOB_QUEUE_REDIS_ENDED` |
    | `run-fulfilled` | `JOB_WORKER_STOPPED` |
    | `run-rejected` | `JOB_WORKER_FAILED` |

  - Fatal events before startup completion reject startup; later events reach `reportFailure`.
  - Intentional stop does not report runtime failure.
  - One close failure does not skip other closes or successful-worker drains.
  - A queue-close failure does not suppress a successful worker’s drain.
  - Worker close rejection skips only that worker’s idle; emitted error plus fulfilled close still drains.
  - Startup failure remains primary even when cleanup fails.

  Preserve the behavior currently pinned by [worker startup/drain tests](../../../packages/backend-next/test/unit/worker-startup.test.ts).

- [ ] **Step 2: Run the focused unit group and record meaningful failures.**

  ```sh
  pnpm --filter backend-next test test/unit/job-queue test/unit/composition/queue-workers.test.ts test/unit/worker-startup.test.ts
  ```

- [ ] **Step 3: Migrate producer composition.**

  Replace the three producer constructors with one owned producer runtime, explicit definitions, and four capabilities.

  Register cleanup before awaiting readiness, retaining cancellation checks and the startup-loss latch. Keep these existing connections:

  - Webhook enqueue → `openUserWebhooks`.
  - `deliverOne` → relay delivery.
  - `schedulePollEnded` → post-save.
  - `deliverMany` → created/deleted note delivery.

  The current wiring and cleanup position are visible in [connect-resources.ts](../../../packages/backend-next/src/platform/connect-resources.ts).

  The producer terminal guard begins only when its own cleanup executes; accepted feature work may still enqueue while earlier cleanup drains.

- [ ] **Step 4: Migrate worker composition and processor adapters.**

  `startQueueWorkers` constructs a separate runtime, assembles existing handlers, registers three defaults, and starts it with the configured startup timeout.

  Adapt logging to `ctx.jobId`, `ctx.jobName`, and `ctx.attempt - 1`. Preserve:

  - Delivery done → original string.
  - Delivery stop → original `UnrecoverableError` classification/message.
  - Delivery retry → original error.
  - Webhook nonretryable status → `UnrecoverableError`.
  - Webhook retryable status → existing formatted error.
  - Other webhook failures → original error.

  Omit optional library loggers. Route manager diagnostics through existing safe logging.

  Prefer the existing `resources.outboundHttp.send` for webhook assembly, giving the shared resource owner responsibility for its agents. Do not create an unowned additional HTTP client.

- [ ] **Step 5: Implement cleanup and startup-failure handling.**

  Await worker runtime stop without a shorter independent cleanup timeout. After it settles, drain delivery/webhook processors whose Worker close fulfilled. Collect stop and drain failures, wait for all eligible drains, then throw the aggregate.

  On startup failure, await cleanup and eligible drains; record cleanup diagnostics while preserving the primary startup error, including a library aggregate’s startup cause.

  Keep role cleanup ahead of `resources.close()`. Simplify `processes/worker.ts` to delegate through `startManagedProcess`.

- [ ] **Step 6: Remove obsolete paths and verify GREEN.**

  Remove:

  - `createPollEndedQueue`, `createDeliverQueue`, `createUserWebhookQueue`.
  - `startPollEndedWorker`, `startDeliverWorker`, `startUserWebhookWorker`.
  - `WorkerStarter`, `createQueueWorkers`, the duplicate process starter loop/`stopAll`.
  - `runWorker` after its final consumer disappears.

  Retain payload builders, parsers, settlement helpers, `baseQueueOptions`, `baseWorkerOptions`, and `onConnectionEnd`. Administration, QueueStats, and inspection still need direct BullMQ support.

  Run the focused unit group and typecheck after B’s import migrations land. Commit this integration only at a coherent green checkpoint.

## Task 3: Reuse real queue compatibility suites

**Owner:** B.

**Files:**

- Modify: `test/integration/{deliver-queue,poll-ended-job,user-webhook,queue-retention,queue-admin,resources,note-notifications}.test.ts`.
- Create: `test/integration/business-job-runtime.test.ts`.
- Modify only if required: other direct test consumers found by import search.
- Test retained suites: `queue-stats`, `queue-handoff`, `deliver-processor`.

**Interfaces:** Uses Task 1 factories; production behavior comes from Task 2.

- [ ] **Step 1: Capture baseline and add migration-specific failing assertions.**

  Keep existing compatibility expectations. Add installed-package tests for dynamic default routing, exact producer storage, generated distinct IDs, string/void results, and no producer-created workers.

  Move the readiness injection seam in `resources.test.ts` from the removed `createDeliverQueue` wrapper to `createBusinessJobRuntime`; wrap its runtime readiness in the test mock only.

- [ ] **Step 2: Adapt fixtures to the new ownership boundary.**

  Retention tests that stop/restart must construct fresh owned worker runtimes and handlers. Keep producers separate so worker stop does not terminate later enqueue operations.

  Preserve the existing assertions for 31 successes/101 failures trimming to 30/100, lazy age cleanup, logs removal, unfinished-job protection, and absent fallback. [Retention suite](../../../packages/backend-next/test/integration/queue-retention.test.ts).

- [ ] **Step 3: Preserve administration and handoff coverage.**

  Reuse #163–165 fixtures and consumers. Ensure at least one global-pause case controls a migrated worker, rather than only a raw test Worker.

  Retain all 14 administration APIs and ten selectors, authorization/scopes, response limits, secret redaction, return values/logs/metrics, awaited versus detached operations, and shutdown drain.

  QueueStats retains deliver/inbox observation, public access, immediate/10-second samples, and newest-first 200-entry history.

  Handoff remains raw read-only inspection: DUMP equality, namespace/DB isolation, paging, unsupported work, schedulers, and malformed/active/dependency records remain covered. Do not clear, replay, promote, or transform rejected work.

- [ ] **Step 4: Run focused real-dependency groups.**

  ```sh
  pnpm --filter backend-next test:integration test/integration/business-job-runtime.test.ts test/integration/resources.test.ts test/integration/queue-admin.test.ts test/integration/queue-stats.test.ts test/integration/queue-retention.test.ts test/integration/queue-handoff.test.ts
  pnpm --filter backend-next test:integration test/integration/poll-ended-job.test.ts test/integration/deliver-queue.test.ts test/integration/deliver-processor.test.ts test/integration/user-webhook.test.ts test/integration/note-notifications.test.ts
  ```

  Expected: all selected tests pass against isolated real dependencies. Controlled retention handlers establish transport/retention behavior; retain real business-handler suites separately.

## Task 4: Prove process failure, saved-job consumption, and drain

**Owner:** B.

**Files:**

- Modify: `test/processes/{queue-handoff,queue-admin,poll-ended,note-deliver,children}.test.ts`.
- Modify: `test/fixtures/slow-worker.mjs`.
- Create: `test/processes/queue-runtime.test.ts`.
- Create: `test/fixtures/queue-runtime-failure.mjs`.

**Interfaces:** Launches built normal entrypoints; test fixtures may instrument behavior without production hooks.

- [ ] **Step 1: Extend saved-job process assertions before implementation completes.**

  Reuse the existing original BullMQ fixtures and normal worker launch. Add explicit stored return values:

  ```ts
  expect(delivery.returnvalue).toBe(expectedDeliveryResult);
  expect(webhook.returnvalue).toBe('Success');
  expect(poll.returnvalue).toBeNull();
  ```

  Retain original IDs/names/data/options, seven webhook envelopes, AP signatures, PG effects, and normal exit.

  Keep the real old-Worker 60-second retry continuation and its explicit 100-second timeout. A newly enqueued imitation or promoted job is insufficient. [Existing process cases](../../../packages/backend-next/test/processes/queue-handoff.test.ts).

- [ ] **Step 2: Add real follow-up drain tests.**

  Parameterize delivery instance updates and webhook `latestStatus` updates:

  1. Hold the relevant PG row lock in an independent transaction.
  2. Let the normal built worker finish the queue job and block its background write.
  3. Confirm the write is waiting, then send SIGTERM.
  4. Assert the child has not exited and required dependencies remain available.
  5. Release the lock; assert the update persists and the child exits `0`.

  Add a held-lock deadline case: keep the write blocked and require bounded abnormal exit. Existing unit idle checks alone do not prove this property.

- [ ] **Step 3: Cover failure boundaries.**

  Add or extend cases for:

  - Redis failure before ready.
  - Loss after producer ready while later initialization is blocked.
  - Command and blocking connection termination.
  - Webhook worker connection loss.
  - Unexpected run fulfillment and rejection.
  - Partial startup and cleanup failure.
  - Producer-only HTTP shutdown returning Redis client count to baseline.
  - Supervisor sibling shutdown and nonzero exit without restart.

  Use the failure fixture to control acquisition-loop settlement through a test-only BullMQ `run` override installed before importing the built worker. Keep actual connections and normal process cleanup. Do not add production failure switches.

- [ ] **Step 4: Update the slow-worker fixture and run the process group.**

  ```sh
  pnpm --filter backend-next... build
  pnpm --filter backend-next test:process test/processes/queue-runtime.test.ts test/processes/queue-handoff.test.ts test/processes/queue-admin.test.ts test/processes/poll-ended.test.ts test/processes/note-deliver.test.ts test/processes/children.test.ts test/processes/supervisor.test.ts test/processes/posting-websocket.test.ts
  ```

  Expected: selected process tests pass; deadline cases pass by observing the specified abnormal exit.

## Task 5: Renew evidence and document actual adoption

**Owner:** Coordinator.

**Files:**

- Modify: `docs/backend-next/application-foundation-inventory.md`, `docs/backend-next/ROADMAP.md`, `packages/backend-next/README.md`.
- Save/update: this dated implementation plan.
- Create: `docs/superpowers/compatibility/queue-runtime/README.md`, `package-receipt.json`.
- Append current measurements: queue-admin, queue-retention, and queue-handoff compatibility READMEs.
- Renew affected N7 evidence: `docs/superpowers/compatibility/note/n7/{coverage.json,README.md}` and `scripts/note-contract-posting.test.mjs`.
- Conditionally renew remote-user evidence only when its bound consumers/helpers change.

**Interfaces:** Consumes final source hashes, package receipt, and measured results from Tasks 1–4.

- [ ] **Step 1: Freeze measurement inputs.**

  Record execution HEAD, dirty-tree identity, before/after consumer hashes, Node/pnpm versions, installed package resolution/integrity, isolated dependency environment, exact commands, counts, failures/skips, and relevant receipts.

  Never copy preparation-tarball hashes into the npm adoption receipt.

- [ ] **Step 2: Renew the changed N7 consumer evidence.**

  Changing `note-notifications.test.ts`, including imports, invalidates its whole-file digest. Run:

  ```sh
  pnpm --filter backend-next test:integration test/integration/note-create.test.ts test/integration/note-delete.test.ts test/integration/note-notifications.test.ts
  ```

  After a successful measurement, add a #255 measurement and update current bindings, receipt seals, and README together. Preserve historical measurements, fixtures, Git-object evidence, and historical seals.

  The validator checks whole-file source identity and measured provenance. [Validator](../../../scripts/note-contract-posting.test.mjs), [prior renewal](../compatibility/note/n7/README.md).

- [ ] **Step 3: Preserve upstream observations and distinguish evidence classes.**

  Keep #163–165 frozen observations unchanged. Record new consumer/process measurements separately from upstream-source checks and controlled-handler tests.

  Renew binding/generator evidence if its code changes. Run pinned-source mode only when the fixed upstream checkout and its installed BullMQ are available; otherwise mark that mode SKIPPED.

  Do not rewrite remote-user evidence merely because the queue runtime changed. Renew it if bound consumer/helper hashes actually changed.

- [ ] **Step 4: Update adoption and remaining ownership.**

  Document:

  - Exact published versions/integrities.
  - Old → new producer and worker paths.
  - Removed wrappers and registry.
  - Separate runtime ownership and shutdown order.
  - Actual verification and its limits.
  - Remaining seven handlers/nine schedulers with existing owners and reevaluation conditions.

  Append current stage-3 status to ROADMAP; preserve prior stage-1/2 records as history. Do not claim elimination of all platform→composition imports.

## Task 6: Final verification, cleanup, and handoff

**Owner:** Coordinator.

- [ ] **Step 1: Use isolated test infrastructure.**

  Follow the [README setup](../../../packages/backend-next/README.md). Select a unique Compose project and checked-unused DB/Redis/Meili ports; record them. Use `packages/backend-next/compose.test.yml`.

  Never operate on `misskey-infra` or production/development databases. No old-backend `.config/test.yml` is required.

- [ ] **Step 2: Verify installation, build, types, and retained unit contracts.**

  ```sh
  pnpm install --frozen-lockfile --filter backend-next... --strict-peer-dependencies
  pnpm --filter backend-upstream sync:check
  pnpm --filter backend-next... build
  pnpm --filter backend-next... typecheck
  pnpm --filter backend-next test test/unit/job-queue test/unit/composition/queue-workers.test.ts test/unit/worker-startup.test.ts test/unit/queue/source-compat.test.ts test/unit/stream/queue-stats.test.ts
  node --test scripts/*-contract*.test.mjs
  ```

  Build backend-upstream before backend-next; dependency-ordered build must preserve this. Retain full Git history needed by historical evidence validators.

- [ ] **Step 3: Complete the real suites from Tasks 3–5.**

  Do not rerun broad suites after documentation-only changes unless their source bindings or results were affected. Expand testing only for failures or additional exposed changes.

- [ ] **Step 4: Check removal and repository safety.**

  Search source and fixtures for removed constructor/start functions, `WorkerStarter`, `createQueueWorkers`, and `runWorker`. Require zero executable references.

  Run `git diff --check`, then final changed-file quiet lint/SPDX/locale checks using:

  ```sh
  node scripts/check-shipping.mjs --base <actual-pr-base>
  ```

  Correct violations and rerun only affected checks. No schema change or old-backend misskey-js generation is expected.

- [ ] **Step 5: Clean up only owned infrastructure.**

  Stop test children and fake servers, close connections, and remove temporary files/databases/prefixes created by this run. Tear down only the recorded dedicated Compose project.

- [ ] **Step 6: Prepare the reviewable handoff.**

  Record `PASS / FAIL / BASELINE / SKIPPED` for every gate, with reasons. Failed infrastructure setup, missing published-package verification, and unexecuted runtime tests never count as passes.

  Preserve CHANGELOG unchanged. Candidate line: “backend-next: migrate the three existing business queues to mokuroku-js while retaining stored-job and lifecycle compatibility.”

  This plan authorizes no external publication, PR merge/close, or production operation.

## #255 completion matrix

| #255 condition | Required evidence |
| --- | --- |
| Fixed artifact; three handlers connected; old paths removed | Tasks 1–2 package receipt, normal entrypoint tests, removal search |
| Saved names/payload/options; results/retry/retention/admin/QueueStats | Task 3 real suites and Task 4 original-job process tests |
| Before-ready failure; runtime loss; producer-only close; partial startup; run termination; multiple cleanup failures | Tasks 1–2 lifecycle tests plus Task 4 process cases |
| Accepted work/follow-up drain; dependency release; deadline; Supervisor | Task 4 real PG barriers, deadline and sibling-stop assertions |
| Global pause distinct from local worker pause | Task 3 migrated-worker administration case |
| Reuse #163–165; nearby handlers; build/types/lint/SPDX/locale | Tasks 3, 4, and 6 |
| Adopted versions, paths, measurements, remaining owners | Task 5 inventory/README/ROADMAP/evidence |
| No scope expansion or false completion | Global constraints and final evidence review |

## Investigation receipt

- **PASS:** Required guides, issue snapshots, foundation design/inventory, relevant redesign boundaries, README, and relevant application/library source inspected.
- **PASS:** `node scripts/check-shipping.mjs --base HEAD` — SPDX passed for 3,253 files; locale safety passed.
- **PASS:** `git diff --check`; working tree remains clean.
- **SKIPPED:** Changed-file lint — no files changed.
- **UNVERIFIED:** Published npm bytes, integrity, and installed resolution. Registry reads failed in this environment.
- **NOT RUN:** Installation, implementation builds, Redis/PG compatibility suites, and process tests. The supplied lanes’ earlier results remain separately reported evidence; migration compatibility is not yet established.
- No files changed, production operations performed, or external messages sent.

## Integration notes (2026-11-10)

The investigation receipt above is historical. The coordinator subsequently verified npm tarball integrities and packed adapter core dependency `^0.2.0`; see the adoption receipt added after validation. Dedicated Compose project: `backend-next-255`, DB `55455`, Redis `56395`, Meili `57795`; Node `26.4.0`, pnpm `12.9.1`. Parent baseline build, 144 unit tests, and 62 integration tests passed before production edits.
