# Posting notifications and stream (#173) implementation plan

> **For agentic workers:** Use superpowers:executing-plans; implement task-by-task with behavioral tests.

**Goal:** Connect the fixed upstream posting notification conditions, poll-ended notification publication and posting/deletion Redis stream publications to the existing runtime.

**Architecture:** Note creation/deletion own their post-save boundaries. A narrow notification reception policy consumes fetched recipient facts, while persistence retains the approved direct PG save/flush contract. Redis publications use upstream channel/envelope names; no durable effect/claim/capacity infrastructure is added.

**Tech stack:** TypeScript, TypeORM, Hono, ioredis, BullMQ, Vitest.

**Spec:** `docs/backend-next/GOALS.md`, `docs/backend-next/posting-contract.md`, [issue #173](https://github.com/tiramiss-community/tiramiss/issues/173), fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`.

## Constraints and review focus

- No UseCase intercall, cyclic public contract, ORM/HTTP/queue type in business code.
- Preserve upstream independent subscriber and mention/reply/renote notification branches, mention replacement and specified-only filtering.
- Distinguish pre-save reception suppression from post-save packed notification suppression. No invented block/word-mute filter.
- Saved notifications remain saved on stream/render failure; no retry ledger or exactly-once behavior.
- Poll-ended reads current state and duplicates remain possible; deleted polls do not notify.
- Native WebSocket server/auth/channel expansion belongs to #189; shared process fanout/cache work belongs to #217 unless needed to observe this slice's actual external contract; Redis Pub/Sub receiving proves publications directly.

## Tasks

### 1. Reception and producer policy

- [x] Write failing tests for receive modes, self/muting, manager replacement, thread mutes, subscription and pure-Renote muting.
- [x] Add narrow pure policies and note post-save application orchestration.
- [x] Sync only required upstream relation Entities mechanically (Muting, RenoteMuting, NoteThreadMuting, UserListMembership).
- [x] Implement DB facts through TypeORM repositories and direct PG notification save.

### 2. Exact stream payloads and runtime integration

- [x] Write failing tests for notes/main/note deletion envelope, notification packed output and failure-after-save.
- [x] Add upstream Redis publisher, note rendering options needed for guest skipHide, notification renderer and best-effort tracked publication.
- [x] Connect creation/deletion and poll-ended paths, retain independent errors and shutdown drain.

### 3. Compatibility and real runtime validation

- [x] Compare fixed upstream conditions/payload with existing fixtures and targeted probe where new cases need independent evidence.
- [x] Test real HTTP/PG/Redis subscribers, current condition updates, failures, poll worker and deletion publications.
- [x] Run nearest unit/integration/process tests, build/typecheck, upstream sync checks and shipping checks.
- [x] Update roadmap/README/compatibility references with implemented scope and remaining #177/#217/#174/#175/#176 work.

## Execution record

The implementation and validation below were completed in an isolated worktree based on merged PR #228 (`f0580ef4846c1e54a6a5b19511157d4daeab47fe`). The controller owns commits, inventory synchronization and PR creation.


## Implemented scope and remaining work

This PR is the producer slice of #173 (`Refs`, not `Closes`). Reply/mention/quote/renote/subscribed-note reception, current settings/follow/list/muting facts, sequential thread-mute decisions, approved PG body save, and Redis `notesStream`/`mainStream`/`noteStream` publication are connected to ordinary HTTP/worker startup. It adds no ledger/effect/capacity state or durable snapshot protocol. Four existing upstream Entities are mechanically synchronized without changing the fixed SHA or migrations.

Subscription is independent of the mention/reply/renote manager. Manager notification reasons replace mention then reply then quote/renote; specified visibility filters recipients, followers visibility intentionally does not. Subscribed-note selection has no follower-host filter and pure Renote muting does not suppress quotes. There is no invented block or keyword-mute condition at body-save time; WebSocket mention filtering remains a consumer concern.

Pre-save `never`/self/user-mute/receive-mode conditions suppress the body. Suspended/deleted/muted-instance notifiers suppress packed publication after the body is saved. A publication failure retains the body, logs failure and does not turn a successful HTTP save into an error. The producer drain waits for every started subscription save even when another fails.

Saved Note fields and immediate related Note facts remain in memory for posting events, preserving intent and preincrement nested counts when the DB changes before deferred execution. Poll and PollVote are still read at rendering time; a deleted Poll fails rendering. Global/mention/thread preparation errors stop later manager/AP startup, while already-started subscription work finishes. Counts and poll-job scheduling remain independent. Deletion publishes before AP rendering/physical DELETE, including a later DELETE failure, and drains publication during shutdown.

Full WebSocket transport/auth/channels and recipient filtering/actual client reception remain #189 and the #173/#176 acceptance work; shared fanout/cache synchronization remains #217. Notification APIs/read state/unread timer/push/retention migration remain #177. TL/search #174, webhook #175 and charts #200 are unchanged. This producer slice does not complete the whole notification/stream domain.

## Validation evidence

- PASS: clean baseline install/build and unit 1,677 tests.
- PASS: `pnpm --filter backend-next... build` and `... typecheck` (final logs `/tmp/tiramiss-next173-{build,typecheck}-final.log`).
- PASS: full unit 49 files / 1,706 tests (`/tmp/tiramiss-next173-unit-final.log`). The initial full run exposed the expected Entity metadata count change (26→30); assertions now validate the four new table/relation registrations.
- PASS: related integration 4 files / 133 tests (`/tmp/tiramiss-next173-integration-final1.log`): notification producer, poll-ended job, create relations and deletion. The expanded notification file separately passes 13 tests (`/tmp/tiramiss-next173-integration-snapshots.log`), adding saved-Note/current-Poll and remote-subscriber regressions. Dedicated DB/Redis ports 55473/56373, Compose project `backend-next-notification173-test`.
- PASS: process 3 files / 10 tests (`/tmp/tiramiss-next173-process-final.log`): ordinary note deliver/delete and poll-ended process entrypoints/shutdown.
- PASS: schema equality in real notification integration, upstream `sync:check`, parent upstream sync tests 5, note contract checks 8.
- Existing fixed upstream C10 deletion stream observation is normalized and compared to the real Redis subscriber output. Existing poll-ended fixed processor cases remain replayed in unit tests. New receipt/producer edge cases are explicitly fixed-source-derived (NoteCreateService/NotificationService/NotificationEntityService/GlobalEventService at `8e07cf085adf7009583d234a208e30436f020e26`), rather than a claim that every new case was remeasured in upstream runtime.
- The first integration attempts failed in fixture setup (overlong and then non-16-character local token), not a product RED. Behavioral RED→GREEN was observed for reception/module absence, renderer skipHide/pair-cache options, deletion publication order, posting orchestration and poll after-save publication. Independent source review found thread timing, orphan classification, per-candidate mute decisions, drain and current-Poll concerns; targeted regression tests now cover them.
- Nonfatal existing `pg client.query()` deprecation appears in DB tests. No old-backend API definition, migration or locale YAML is edited; old misskey-js API generation is not applicable.
- PASS: final changed-file lint (28 files), SPDX (3,103 files), locale safety and `git diff --check`. Committed inventory synchronization is performed by the controller before the PR. No CHANGELOG edit; candidate: `新バックエンドの投稿通知・投票終了通知と投稿/削除のRedis stream配信を接続。`

## Independent review

Native in-session source reviewers covered notification conditions and stream/render/lifecycle contracts, then a fresh completeness reviewer checked the final test evidence. No unresolved functional blocker remains. Ultracode subprocess launch was rejected by automatic approval review before any worker executed; no subprocess output is claimed. Native reviewers were used as the safer alternative within this session, without retrying the rejected external execution.
