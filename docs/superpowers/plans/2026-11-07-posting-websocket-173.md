# Posting WebSocket reception Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; parent delegates one product writer and independent review. Steps use checkbox syntax for tracking.

**Goal:** Deliver existing posting, notification and deletion publications to authenticated real clients through main, homeTimeline and note subscriptions (#173, bounded #189).

**Architecture:** Pure stream policies consume published note snapshots and refreshed relationship facts. Database adapters provide authentication, relationship materials and selective hidden-note rendering through existing note public read/render contracts; platform owns ws, Redis, timers and socket lifecycle. Composition attaches one shared Redis subscriber to the existing HTTP process.

**Tech Stack:** TypeScript, ws 8.22.0 / @types/ws 8.18.2, TypeORM, Redis, Vitest.

**Spec:** `docs/backend-next/posting-contract.md`; fixed upstream `8e07cf085adf7009583d234a208e30436f020e26` StreamingApiServerService, Connection, main/home-timeline and NoteStreamingHidingService. `/tmp/tiramiss-next-scope.md` records inspected source boundaries; durable comparison docs will record the same evidence.

## Global Constraints

- Preserve ordinary post-save/worker semantics and PG notification storage; add no durability/configuration contract.
- Never edit old backend or managed upstream files directly. Mechanically sync ChannelMuting only if required.
- Native/application grants, case-sensitive Bearer priority, read:account, 401 challenge and suspended 403 follow fixed source.
- main/homeTimeline only; 32 channels, 1536 note LRU, reference counts and existing aliases. #189/#176/#172 remain open.
- Relationship snapshot initially and every 10s; activity initially/every 5min; heartbeat every minute and >2min timeout.
- Stop admission, drain accepted work, then dispose sockets/subscriber/timers before database resources.

## Review Focus

- Rejected/malformed upgrades and shutdown during authentication must release sockets and await DB work (Task 2/3).
- Published snapshot nested hiding and reactions must stay isolated per viewer (Task 1/3).
- main notification/mention filters must not accidentally change reply/renote delivery (Task 1/3).
- Followers deleted-note authorization differs from timeline mention/reply exceptions (Task 1/3).
- Refresh after mute/follow changes and hibernation wake-up must be observable (Task 2/3).

### Task 1: Pure receiver policies and protocol state

**Files:** Create `src/modules/stream/{public,policy,connection}.ts`, `test/unit/stream/receiver.test.ts` under backend-next.
**Interfaces:** `StreamFacts` contains viewer/following/mute/channel/visitor facts; `StreamNote` models JSON published payload. `createStreamConnection` consumes facts getter, hidden-note repacker/reaction getter and send callback; produces serializable outgoing envelopes via receive/onPublication.

- [x] Write failing tests for visibility, home routing/options/replies/renotes, nested hiding without mutation, main type differences, deleted envelope/refcounts/LRU, malformed aliases/connect/replacement/limits/ack.
- [x] Run `pnpm --filter backend-next test test/unit/stream/receiver.test.ts` and record missing implementation RED.
- [x] Implement pure policies and protocol state with no transport/ORM types.
- [x] Run same command; expected PASS.

### Task 2: Database materials and owned transport

**Files:** Create `src/platform/database/streaming.ts`, `src/platform/streaming-server.ts`, `src/composition/posting-websocket.ts`; modify `src/processes/http.ts`, authenticate adapter and dependency manifests. Mechanically sync ChannelMuting if needed.
**Interfaces:** composition returns `close(): Promise<void>` after initial shared subscription; DB adapter exposes authenticate/readFacts/repack/readReaction/touchActivity. HTTP owns the close hook and rejects upgrades during drain.

- [x] Write real WS integration tests for token statuses/Bearer priority, scope/app/suspended and distinct recipients/guest; real DB/Redis test supplies actual materials and existing publications.
- [x] Run focused integration test and record RED before transport exists.
- [x] Implement bounded transport and adapters, attach to normal process; capture/await pending upgrade/event/refresh/activity reads. Heartbeat and 5-minute activity intervals are owned and cleared.
- [x] Run focused integration test; expected PASS. Add deterministic clock transport tests for refresh/heartbeat/activity and shutdown while reads are pending.

### Task 3: Product acceptance and handoff

**Files:** Create `test/processes/posting-websocket.test.ts`, compatibility README/probe/fixtures and update this execution record.
**Interfaces:** normal HTTP + worker binaries, real PG/Redis/ws, existing real token seeds and create/delete APIs.

- [x] Write process tests for create→home/main mention+notification→subNote→delete, normal poll worker→WS, connected WS SIGTERM and reconnect; observe RED where applicable.
- [x] Compare fixed-source literal methods/probes for filters, protocol envelopes and aliases; distinguish partial source harness from full upstream server.
- [x] Run focused unit/integration/process, dependency build/typecheck, upstream sync/check/schema for new entity and shipping checks. Parent independently reviews and updates completion inventories after product commit.
- [x] Record exact commands/results/limitations and commit tested product checkpoint. No push/PR/external writes.

## Execution record

Baseline: isolated worktree at `8d3ca17349b95b5d587d71c195c8e0c1b64420ec`; frozen filtered install passed (567 packages). Parent owns dedicated compose `backend-next-ws173-test`, DB55477/Redis56377.


### Final execution evidence (2026-11-07)

- Baseline dependency build and unit suite PASS: 54 files / 1,745 tests. Initial receiver test RED: stream public module absent; implementation GREEN 7 tests, then 9 after privacy/failure regressions.
- Quote poll/reply gates, current following hiding and sibling listener reaction failure each observed RED, fixed and GREEN. Independent pinned-source comparison: 191 literal-method observations, 80 comparisons, zero differences for the selected behavior. Durable CI fixture: 64 source cases.
- Real upgrade/auth/create/delete integration initially failed on missing ws/composition. Final integration (posting WS, lifecycle, existing note-show and note-notifications): 4 files / 47 tests PASS; includes current schema comparison with newly registered ChannelMuting. Snapshot/reaction fixture initially lacked required visibility; fixed test seed, then all 4 WS product tests passed.
- Runtime reviewer independently reproduced raw upgrade reset ECONNRESET and fail-fast query drain. Reset process regression RED then GREEN; query drain unit2 RED then GREEN. settleAll now waits sibling queries in stream facts/activity and existing note material reads. Independent repeat: raw reset has no uncaught exception; close/repack rejection wait until deferred sibling settles.
- Final unit suite: 57 files / 1,820 tests PASS. First broad run failed only the existing entity-count assertion (32→33 required by mechanical ChannelMuting addition); updated count and asserted channel relation target, then full suite green.
- Normal binary process tests: 2 PASS (HTTP create→main/home/mention/notification, normal poll worker→pollEnded WS+PG, subNote→HTTP delete→noteUpdated, reconnect/SIGTERM, reset during pending upgrade). Lifecycle tests:4 PASS with real Redis/WS and explicit minute/five-minute timers, pending auth/render drain.
- `pnpm --filter backend-upstream sync:check`: PASS; `pnpm --filter backend-upstream test`:5 PASS; `pnpm --filter backend-next... build` and `typecheck`:PASS.
- `node scripts/check-shipping.mjs --base 8d3ca17349b95b5d587d71c195c8e0c1b64420ec`: changed-file lint19 PASS, SPDX OK, locale safety PASS. `git diff --check`:PASS. No CHANGELOG edit.
- Exact commands and stdout logs retained in `/tmp/tiramiss-ws173-implementation.md` and `/tmp/tiramiss-ws173-*.log`; durable behavior evidence is in `../compatibility/stream/README.md` and tests. Parent owns final independent review, inventory/roadmap completion metadata and publication.

Rulings: preserve safe-ignore for literal JSON null frames, always clone per receiver (documented narrow upstream differences); current DB following reads replace only the separate content-hiding cache, while routing/mute facts keep the 10s snapshot. No additional channels or durability/config contract. User authorized full inline implementation; no new design approval flow was introduced.


### Final independent review correction

Whole-branch review of product checkpoint `5e46444a01` found one P2: hidden main notification/mention repack returned null if its root disappeared after publication, unlike fixed upstream pack rejection. Actual-adapter unit2 and real WS queue regression were RED, then missing-root `EntityNotFoundError` suppressed the malformed event through existing listener/session isolation. A following valid publication still reaches the same client. This is the single authorized final fix wave; no metadata inventory files are part of its commit.

Focused stream unit4files/77tests and posting WS integration1file/5tests pass; dependency build/typecheck and canonical shipping pass. Earlier full1820 and integration47 evidence remains attached to the product checkpoint; the focused correction adds2unit+1integration cases and does not claim a repeated full-suite run. Logs: `/tmp/tiramiss-ws173-{red-missing-main,red-missing-main-ws,fix-unit,fix-integration,fix-build,fix-typecheck,fix-shipping}.log`.

Controller verification at corrected product commit `6f4a5444ca9f02634972e81b5ffe7368302f7335`: full unit58files/1,822tests, selected integration4files/48tests and normal process1file/2tests all PASS. Commands match the earlier full unit, four-file integration and posting-websocket process selections, with the dedicated DB55477/Redis56377 environment. Logs: `/tmp/tiramiss-ws173-controller-{unit,integration,process}.log`. The final reviewer independently reran the missing-root counterexample, confirmed no malformed events and successful subsequent delivery, and approved the scoped fix with no open P1/P2.
