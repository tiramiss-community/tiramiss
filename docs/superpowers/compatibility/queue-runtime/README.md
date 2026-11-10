# Business queue runtime adoption (#255)

backend-next now uses published `@mokurokujs/core@0.2.0` and `@mokurokujs/bullmq-adapter@0.2.0` for `endedPollNotification`, `deliver`, and `userWebhookDeliver`. BullMQ remains `6.3.11`, ioredis `5.11.1`. The [package receipt](package-receipt.json) records actual npm tarball SHA-256, SHA-1, SHA-512 integrity, sizes, packed dependencies/exports, installed manifest/lock identity and parent measurements. Preparation artifacts are historical and supply none of these hashes. The frozen strict-peer install passed; only these two exact releases bypass the existing 10080-minute release-age delay.

Implementation and current compatibility gates pass. The initial four failures were corrected in the process-test fixture/observations, and all 18 new process cases passed on rerun; the other seven unchanged process files passed 43 cases in the initial run. These are separate executions over unchanged production code.

## Paths and ownership

Paths below are relative to `packages/backend-next/src/`.

| Previous path | Current path |
| --- | --- |
| Three `create*Queue` wrappers in `platform/job-queue/{ended-poll-notification,deliver,user-webhook}.ts` | `createBusinessJobDefinitions` and `createBusinessJobProducers` in `platform/job-queue/business-jobs.ts`; owned runtime in `platform/job-queue/runtime.ts` |
| `connect-resources.ts` creates individual queues | One producer-only owner, cleanup registered before explicit three-queue readiness; features receive `schedulePollEnded`, `deliverMany`, `deliverOne`, `enqueueWebhook` |
| Three `start*Worker` wrappers, `WorkerStarter` / `createQueueWorkers`, `runWorker`, process `stopAll` loop | `composition/queue-workers.ts:startQueueWorkers` registers three queue defaults before start; `processes/worker.ts` delegates through `startManagedProcess` |

Every child owns its producer runtime. Worker children additionally own a separate worker runtime: poll, webhook, then delivery registration. HTTP starts no business worker. Payload builders, parsers, settlement, base queue/worker options and direct BullMQ administration/QueueStats remain. Dynamic stored job names select the queue's default handler; no job replay, ID replacement or Redis transformation is introduced. Current webhook producers accept four posting events; stored follow/unfollow/followed snapshots remain consumable (seven envelopes in total).

Worker stop waits for runtime cleanup, then delivery/webhook background writes whose public `Worker.closing` promise fulfilled, then shared-resource release. A worker-close rejection excludes only that worker's drain; a queue-close error or diagnostic alone does not exclude a successfully closed worker. Cleanup errors are collected after eligible drains; startup failure remains primary. Producer ownership ends at its own cleanup, after earlier accepted feature work drains. The existing process shutdown deadline bounds the whole sequence. Manager errors/cleanup are diagnostics; unexpected connection end or acquisition-loop fulfillment/rejection remains fatal. No reconnect or independent shorter stop deadline is added.

## Integrated measurements (2026-11-10)

Parent: Node v26.4.0 / pnpm 12.9.1; isolated Compose `backend-next-255`, PostgreSQL `55455`, Redis `56395`, Meili `57795`. Exact commands and raw artifact hashes are in the receipt. These runs used uncommitted implementation, not a clean committed revision.

| Gate | Observed result |
| --- | --- |
| Dependency-ordered build / typecheck | PASS (parent `integrated-build.log`, `integrated-typecheck.log`) |
| All unit tests | PASS: 2,828 tests, 86 files, zero failed/pending |
| Queue real-dependency integration | PASS: 185 tests, 10 files, zero failed/pending; serial run separate from process suite |
| Current C2/C10 consumers | PASS: 88 tests, 3 files, zero failed/pending; [dirty-tree/source receipt](../note/n7/README.md#255-queue-runtime-consumer-remeasurement-2026-11-10) |
| Initial process run | FAIL: 57 passed, 4 failed, 8 files; failures confined to new `queue-runtime.test.ts` cases |
| Final process gate | PASS: unchanged 7 files / 43 cases plus corrected new file / 18 cases, in separate executions |

The first integration run (184 passed / 1 failed) overlapped the process suite and encountered globalSubscriber test interference; the separate serial rerun passed. It is retained as failed history, not counted as a second successful run. Controlled retention handlers establish transport/retention behavior; existing poll persistence, signed AP and webhook suites establish their separate business behavior. The passing handoff process cases are part of the initial process run and do not make its overall gate pass. #163–165 fixed observations, generators and bindings remain unchanged; no new pinned-source execution is claimed.

CodeRabbit completed its submitted 33-file review with zero findings. Local-cache persistence failed with EROFS after review completion; that is separate from review outcome. This review predates these documentation updates and the process-test fixes.

## Remaining owners

| Unimplemented handler | Owner |
| --- | --- |
| `system` | Maintenance / announcement archive #199; charts / aggregation #200; buffered reactions #184 |
| `postScheduledNote` | #183 |
| `inbox` | #195 |
| `db` | #199 |
| `relationship` | #182 |
| `objectStorage` | #188, remote maintenance coordination #199 |
| `systemWebhookDeliver` | #198 |

All nine system schedulers remain unimplemented: `tickCharts`, `resyncCharts`, `cleanCharts`, `aggregateRetention` (#200); `bakeBufferedReactions` (#184); `clean`, `checkExpiredMutings`, `checkModeratorsActivity`, `cleanRemoteNotes` (#199, coordinating feature owners). Their age-only retention and obsolete-definition cleanup belong to their implementation slice. Reevaluate each new handler against saved payloads/options, dynamic names, results, retry, lifecycle and [stopped handoff](../queue-handoff/README.md); a management handle is insufficient.

Notification bodies/API/read/push/migration remain #177; other webhook producers/API #197, final stopped cutover #139 and posting #176/#127 remain incomplete. `postingComplete: false`, `notes/create: partial`, six actor gaps and remaining platform-to-composition dependencies are preserved.

The startup failure probe now targets manager worker creation, the fake webhook explicitly returns HTTP 204, and deadline tests release their own PG lock before observing the captured server backend disappear. Deadline exit does not establish query cancellation or rollback. Normal-stop tests still require persisted business updates before successful exit.
