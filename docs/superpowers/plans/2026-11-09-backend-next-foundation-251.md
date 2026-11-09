# [tiramiss-community/tiramiss] Backend-next #251 Stage 1 Implementation Plan

実行状況（2026-11-09）: Task 1/2 を実装・統合し、親 worktree で build/typecheck・単体2,801件・DB28件・Role acceptance65件・停止時2件を検証済み。個別ステップの以下のチェック欄と Expected は実行前の計画を保持する。最新結果と未移行責任は[運用 inventory](../../backend-next/application-foundation-inventory.md)を参照。隔離 worker の DB 検証は EPERM で実行できず、親側で補完した。commit・push・Issue 更新は行っていない。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; do not create child agents or Codex goals.

**Goal:** Centralize transaction lifetime management, apply it to Role updates, and extract narrow Role show/update composition without changing business behavior.

**Architecture:** Keep `TransactionRunner<Scope>.run(work)` and existing UseCases unchanged. The platform runner owns per-invocation lifetime state; Role binds its existing operations directly to that runner. A new Role composition factory constructs business operations, and the existing Role HTTP composition delegates to it.

**Tech Stack:** TypeScript, TypeORM `1.1.1`, Hono `4.13.13`, Vitest `5.0.3`, PostgreSQL 18, Redis 8; existing dependencies only.

**Spec:** [Application foundation design](../specs/2026-11-09-backend-next-application-foundation-design.md), limited by the authorized stage 1 scope in [#251](https://github.com/tiramiss-community/tiramiss/issues/251).

**Plan destination:** `docs/superpowers/plans/2026-11-09-backend-next-foundation-251.md`

**Baseline:** `develop` at `5fe478de46039437f4f74a4be765c6670b6a645d`. Planning investigation only: no edits, commits, external sends, runtime tests, or child agents. The pre-existing untracked design document remains untouched.

## Global Constraints

- Read root and `packages/backend-next/AGENTS.md`, GOALS, ROADMAP, the spec, and the supplied #251/#114 issue snapshots before implementation. The user’s stage 1 authorization supersedes their older “timing undecided” wording.
- Preserve business APIs, authorization/error ordering, saved values, audit snapshots, and post-commit behavior. Keep `src/application/transaction.ts` and `src/modules/**` unchanged.
- Keep `manager` and `TransactionLifetime` within platform/composition; expose neither through business scopes. Add no Hono, ORM, BullMQ, or DI types to business.
- Add no dependencies, implicit transactions, AsyncLocalStorage, decorators, dynamic Proxy, automatic discovery, automatic retries, or UseCase-to-UseCase calls.
- A synchronous binder uses the transaction callback’s manager. Its failure and awaited callback completion both expire the lifetime before control returns to TypeORM.
- Reject new operations after expiry before database access. Already-started promises are neither cancelled nor collected; callers must await them.
- Preserve the rejection supplied by `source.transaction`; do not reinterpret an uncertain COMMIT as confirmed rollback.
- Stage 2 Note/Poll, remote-user guard migration, notification guard expansion, full `connectResources` extraction, and stage 3 mokuroku remain deferred.
- Preserve BullMQ `6.3.11`, existing three-worker registration, ten management queue names, stored jobs/options/results, and shutdown ordering.
- Change no schema, migration, upstream-managed files, locale YAML, compatibility expectations, CHANGELOG, package manifest, or lockfile.
- Use Node `26.4.0` and pnpm `12.9.1`. Use a dedicated Compose project and unused ports; never operate on `misskey-infra`.
- This plan authorizes no commit, push, Issue update, or external publication. Keep any proposed #114/#251 update as local handoff text.

## Review Focus

1. **Binder throws after capturing a guard:** expire the captured guard, preserve the error, and never invoke work. Task 1 runner unit test.
2. **Callback remains pending or overlaps another run:** keep its own operations active until settlement; completing another run must not expire it. Task 1 runner unit tests.
3. **Callback, COMMIT, or rollback reports failure:** expire operations, propagate the source rejection once, and preserve uncertain-acknowledgement semantics. Task 1 unit and Role integration tests.
4. **Authorization accidentally uses the global manager:** authorization must observe transaction-local Role changes, while another connection cannot; authorization, lock/update, and audit must use one QueryRunner. Task 1 real-DB test.
5. **Production composition or cleanup drifts:** authenticated Role HTTP must reach the extracted factory’s operations; preserve Note-before-Role construction, missing-authorization rejection, and accepted work during client disconnect/shutdown. Task 2 root, gate, acceptance, and process regressions.

---

## File Map and Implementation Interfaces

Exactly four production files change:

| File under `packages/backend-next/` | Responsibility |
| --- | --- |
| Modify `src/platform/database/transaction-runner.ts:8` | Own per-run lifetime state and expiry. |
| Modify `src/platform/database/role-update.ts:19` | Bind existing Role operations directly; remove its second `run` and local lifetime. |
| Create `src/composition/role.ts` | Construct only Role show/update operations from explicit dependencies. |
| Modify `src/composition/role-http.ts:16` | Delegate business assembly; retain codec, authentication, endpoints, and logging. |

Tests and documentation:

| File | Change |
| --- | --- |
| `packages/backend-next/test/unit/transaction-runner.test.ts` | Extend lifetime and failure coverage. |
| `packages/backend-next/test/unit/role/role-update-transactions.test.ts` | Create four-operation expiry checks before adapter/database access. |
| `packages/backend-next/test/integration/transaction-runner.test.ts` | Extend escaped-operation checks against PostgreSQL. |
| `packages/backend-next/test/integration/role-update.test.ts` | Extend exceptional exits and transaction-bound authorization evidence. |
| `packages/backend-next/test/integration/role-application.test.ts` | Create factory round-trip and dependency-injection tests. |
| `packages/backend-next/test/integration/http-app.test.ts` | Add authenticated Role requests through the canonical root. |
| `docs/backend-next/application-foundation-inventory.md` | Create operational inventory, ownership, deferred decisions, and measured results. |

Existing `http-app.ts`, direct `createRoleHttpApp` callers, acceptance fixtures, and process wiring remain compatible without edits.

### Platform lifetime contract

In `src/platform/database/transaction-runner.ts`:

```ts
export interface TransactionLifetime {
	assertActive(): void;
}

export function createTransactionRunner<Scope>(
	source: DataSource,
	bind: (
		manager: EntityManager,
		lifetime: TransactionLifetime,
	) => Scope,
): TransactionRunner<Scope>;
```

Inside each TypeORM callback, create fresh state and a guard that throws `Error('The transaction has ended')` after expiry. The critical algorithm is:

```ts
try {
	return await work(bind(manager, lifetime));
} finally {
	active = false;
}
```

Binding belongs inside `try`; `return await` preserves validity through asynchronous work. Existing one-argument bind callbacks remain assignable and receive no automatic operation wrapping.

Installed TypeORM awaits the callback before COMMIT and attempts rollback on rejection: `packages/backend-next/node_modules/typeorm/entity-manager/EntityManager.js:81`. This does not prove that an uncertain COMMIT failed.

### Role composition contract

In new `src/composition/role.ts`:

```ts
export interface RoleApplicationDependencies {
	dataSource: DataSource;
	ids: {
		createdAtFromId(id: string): number;
		newAuditId(atMs: number): string;
	};
	clock: () => number;
	changes: RoleChanges;
}

export type RoleApplication =
	ReturnType<typeof createShowRole> &
	ReturnType<typeof createUpdateRole>;

export function createRoleApplication(
	parts: RoleApplicationDependencies,
): RoleApplication;
```

Use public Role exports. Return exactly `{ showRole, updateRole }`; borrow resources without opening or closing connections.

Narrow the existing HTTP entry parameters:

```ts
export function createRoleHttpApp(
	resources: Pick<RuntimeResources, 'dataSource' | 'logger'> & {
		roleMaterials: Pick<RuntimeResources['roleMaterials'], 'changes'>;
	},
	config: Pick<RuntimeConfig, 'id'>,
);
```

Retain its inferred Hono return type. HTTP composition creates the codec and passes `codec.createdAtFromId`, `codec.newId`, `Date.now`, and `resources.roleMaterials.changes` into `createRoleApplication`.

## Task 1: Centralize Lifetime Management and Migrate Role Updates

**Files:** The two database production files, runner/Role transaction tests, and operational inventory listed above.

**Interfaces:**

- Consumes unchanged `TransactionRunner<Scope>.run<T>(work: (scope: Scope) => Promise<T>): Promise<T>`.
- Produces the `TransactionLifetime` binder contract above.
- Preserves:

```ts
createRoleUpdateTransactions(
	source: DataSource,
	ids: {
		createdAtFromId(id: string): number;
		newAuditId(occurredAtMs: number): string;
	},
): TransactionRunner<RoleUpdateScope>;
```

- Task 2 uses this adapter without another transaction wrapper.

### Step 1: Create the operational inventory before changing production code

- [ ] Create `docs/backend-next/application-foundation-inventory.md` with baseline SHA, stage 1 owner `#251`, and columns **evidence/caller, owner, stage, old → new path, status, verification, re-evaluation condition**.
- [ ] Populate the tables below. Start in-scope rows as `planned`; retained/deferred rows must remain explicit after implementation.

Paths in these tables are relative to `packages/backend-next/`.

**Transactions**

| Evidence and caller | Owner / disposition | Verification and re-evaluation |
| --- | --- | --- |
| `src/platform/database/transaction-runner.ts:8` | #251/1: `source.transaction → bind → work` gains shared lifetime. | Runner unit/integration tests. |
| `src/platform/database/role-update.ts:19` → `src/modules/role/update-role.ts:25` | #251/1: identity binder → second `run` → local lifetime becomes direct scope binding. | Role adapter/update tests; evaluate usefulness before expansion to #181/#182. |
| `src/platform/database/note-writer.ts:102` → `src/modules/note/create-note.ts:337`; direct insert at `:334` | #251/2, #170/#176/#178: retain both current paths and local wrapper. | `test/integration/note-create.test.ts`; reconsider with stage 2 authorization and Note-gate coordination. |
| `src/platform/database/poll-ended.ts:42` → `src/modules/note/created-events.ts:49` and `src/modules/notification/poll-ended.ts:60` | #173/#162/#177: retain one-argument binder; no expanded guarantee. | Notification, note-notifications, poll-ended integration. Persistence already checks active QueryRunner at `src/platform/database/notification/persistence.ts:8`; reconsider with notification owner. |
| `src/platform/database/remote-users.ts:42` → `src/modules/note/create-note.ts:260` | #195/#251: retain local wrapper and separate actor transaction. | `test/integration/remote-user.test.ts:186,198,209`; reconsider with actor slice, preserving race recovery and partial refresh behavior. |
| `src/platform/database/system-account.ts:52,55` ← `src/composition/federation-keys.ts:26` | #215: retain documented independent lazy-creation transaction. | `test/integration/federation-keys.test.ts:71,113,147`; reconsider only if `docs/backend-next/federation-base-contract.md:30` changes. |

Record migrations (`database/migrate.ts:13,24`) and Redis MULTI/pipelines separately from application ORM transactions. Baseline sweep: two ORM transaction-opening sites, four common-runner adapters, five business `.run()` callsites.

**Composition**

| Existing files / caller evidence | Owner / disposition | Verification / re-evaluation |
| --- | --- | --- |
| `composition/role-http.ts:16` | #251/1: delegate show/update assembly to new `composition/role.ts`. | Factory integration, canonical root, Role acceptance. |
| `composition/http-app.ts:12`, `note-http.ts:5`, `note-routes.ts:23,49` | PR #249, #176/#178: retain Note preparation before Role and compatibility re-export. | `test/unit/composition/http-app.test.ts:29,63`; Note composition deferred to stage 2. |
| `composition/create-runtime.ts:11` → `platform/connect-resources.ts:52` | #114/#251 later: retain resource ownership and current platform-to-composition imports. | `test/integration/resources.test.ts:37,95,135`; revisit when a feature assembly actually moves. |
| `composition/remote-users.ts:15` | #195/#215: retained. | Remote-user integration; coordinated actor slice. |
| `composition/posting-notifications.ts:19`, `posting-role-timelines.ts:7` | #173/#174/#177/#181/#189: retained. | Note notification/Role-timeline integration; stage 2 or owning feature. |
| `composition/posting-search.ts:13`, `posting-hashtags.ts:9`, `posting-featured.ts:9`, `posting-timelines.ts:10`, `posting-antennas.ts:8` | #172/#174/#185/#186: retained. | Corresponding Note integration tests; preserve post-save start/drain boundaries. |
| `composition/federation-keys.ts:16`, `outbound-http.ts:14`, `ap-request.ts:11`, `actor-http.ts:11` | #215/#216/#160/#195: retained. | Existing federation/AP/actor tests; owning slices. |
| `composition/queue-workers.ts:19`, `poll-ended-job.ts:13`, `deliver-job.ts:17` | PR #249, #162/#171/#175, #251/3: retain static registry. | Queue registry/startup unit tests; mokuroku deferred. |
| `composition/queue-http.ts:18`, `posting-websocket.ts:13` | #163/#189: retained. | Queue administration/stats and posting-WebSocket integration; revisit only if assembly/lifetime changes. |

The baseline contains 22 composition files; stage 1 adds one. Do not claim that the remaining platform-to-composition imports have been eliminated.

**Queues**

| Evidence | Owner / retained behavior | Verification / re-evaluation |
| --- | --- | --- |
| `platform/job-queue/ended-poll-notification.ts:63,97`; registry `composition/queue-workers.ts:22` | #162: note-ID job name and current scheduling/options. | Poll-ended integration. |
| `platform/job-queue/deliver.ts:112,154`; registry `composition/queue-workers.ts:38` | #171/#160: dynamic destination name, default 12 attempts, custom backoff, string result. | Deliver queue/processor integration. |
| `platform/job-queue/user-webhook.ts:29,96`; registry `composition/queue-workers.ts:25` | #175/#197: webhook-ID name, snapshot payload, four attempts, `"Success"` result, worker stop then processor idle. | User-webhook integration/startup tests. |
| `platform/job-queue/administration.ts:34`; `platform/queue-stats.ts:102` | #163/#164: ten management Queue handles; QueueEvents for deliver/inbox. These are not worker registrations. | Queue admin/retention/stats tests. |
| `platform/job-queue/handoff.ts:124,132`; `handoff-policy.ts:46` | #165/#139: raw inspection, supported-handler checks, unsupported-job/scheduler rejection. | Handoff integration/process tests. |

Record eight constructor sites: three producers, three workers, administration, and QueueEvents. Producers open at `platform/connect-resources.ts:237`; worker startup remains at `processes/worker.ts:20`.

Record the remaining queue owners from `modules/queue/contracts.ts:5`: system (#199/#200), postScheduledNote (#183), inbox (#195), db (#199), relationship (#182), objectStorage (#188/#199), systemWebhookDeliver (#198).

Stage 3 re-evaluation requires fixed-artifact compatibility for saved dynamic names, success results, BullMQ 6, ready/failure/close behavior, and drain ordering. This task makes no adoption decision.

### Step 2: Establish the implementation baseline

- [ ] In an implementation session, verify HEAD and preserve unrelated work:

```sh
git rev-parse HEAD
git status --short
node --version
pnpm --version
```

Expected baseline: the SHA above, Node `v26.4.0`, pnpm `12.9.1`. Record differences before proceeding.

- [ ] Prepare dependencies and isolated services using the setup section below.
- [ ] Run existing targeted tests before adding new tests:

```sh
pnpm --filter backend-next test test/unit/transaction-runner.test.ts test/unit/role/update-role.test.ts test/unit/role/show-role.test.ts test/unit/composition/http-app.test.ts test/unit/http/api-endpoint.test.ts
pnpm --filter backend-next test:integration test/integration/transaction-runner.test.ts test/integration/role-update.test.ts test/integration/http-app.test.ts
pnpm --filter backend-next test:acceptance
pnpm --filter backend-next test:process test/processes/role-http.test.ts
```

Record failures as baseline failures with command and cause; do not report an unexecuted baseline as passing.

### Step 3: Write failing common-runner lifetime tests

- [ ] Extend `test/unit/transaction-runner.test.ts`, importing `vi` and `TransactionLifetime`. Use a transaction test double that distinguishes callback execution from subsequent simulated COMMIT/rollback.

| Test name | Required assertions |
| --- | --- |
| `keeps capabilities active through awaited work and expires before commit` | Block work on a deferred promise; guarded DB spy remains callable while pending. Immediately after the ORM callback resolves, `expect(() => lifetime.assertActive()).toThrow('The transaction has ended')`. The outer run returns only after simulated COMMIT. |
| `expires a captured lifetime when bind throws` | Binder captures lifetime then throws sentinel; `rejects.toBe(sentinel)`; work spy never runs; captured guard throws afterward. |
| `expires capabilities when work rejects` | Callback throws sentinel; `rejects.toBe(sentinel)`; later guarded call rejects before DB spy runs. |
| `preserves source rejection after commit or rollback failure without retry` | Parameterize successful and rejected callbacks followed by source rejection; `rejects.toBe(sourceFailure)`; transaction/work execute once; guard is expired. Preserve existing uncertain-COMMIT test. |
| `isolates overlapping lifetimes` | Keep A pending, finish B: B’s guard throws, A’s guard succeeds. Finish A: its guard then throws. |
| `retains one-argument binder compatibility` | Existing `(manager) => scope` binder receives the callback manager and returns its result unchanged. |
| `propagates transaction-open failure without binding` | Source rejects before callback entry; original rejection preserved; binder/work not called. |

Every guarded test operation must call `lifetime.assertActive()` before its database spy. Explicitly assert unchanged spy counts after escaped calls.

- [ ] Extend `test/integration/transaction-runner.test.ts` with `test.each(['commit', 'rollback'])('rejects escaped writes after %s', ...)`. Bind guarded `append(value: number): Promise<void>` to the real manager. Capture it, settle the transaction, and attempt another append:

```ts
await expect(escaped.append(99)).rejects.toThrow('The transaction has ended');
expect(await source.query(
	'SELECT value FROM transaction_test.values WHERE value = 99',
)).toEqual([]);
```

Use values distinct from existing tests. Preserve existing same-connection, rollback, and concurrent-transaction tests.

- [ ] Run the new runner tests:

```sh
pnpm --filter backend-next test test/unit/transaction-runner.test.ts
pnpm --filter backend-next test:integration test/integration/transaction-runner.test.ts
```

Expected red: the binder receives no lifetime, so new guarded operations cannot run. Existing regressions should retain their baseline result.

### Step 4: Implement shared lifetime management

- [ ] Implement the platform contract and `try`/`finally` algorithm above in `src/platform/database/transaction-runner.ts`. Allocate state inside each ORM callback; preserve the existing no-retry explanation.

- [ ] Repeat the two runner commands. Expected: all runner tests pass, including expiry before simulated COMMIT and binder-failure cleanup.

### Step 5: Pin all four Role guards and connection behavior

- [ ] Create `test/unit/role/role-update-transactions.test.ts`. Use a fake source invoking work with a manager containing repository spies. Capture a real `RoleUpdateScope` through `createRoleUpdateTransactions`; parameterize successful and rejected callbacks.

After settlement, clear construction-time spy calls and invoke all four operations:

```ts
await expect(scope.roles.getForUpdate(roleId))
	.rejects.toThrow('The transaction has ended');
await expect(scope.roles.savePatch(roleId, {}, atMs))
	.rejects.toThrow('The transaction has ended');
await expect(scope.authorizationFacts.read(actorId))
	.rejects.toThrow('The transaction has ended');
await expect(scope.auditLogs.appendRoleUpdate(record))
	.rejects.toThrow('The transaction has ended');
```

Use a complete `RoleDefinition` fixture following `test/unit/role/update-role.test.ts:16`; `record` contains `{ actorId, roleId, before, after, occurredAtMs: atMs }`. Assert no repository/query/helper ID access after closure. This pins adoption of the common guard’s diagnostic; the old adapter has a different error message.

- [ ] Extend `test/integration/role-update.test.ts:219` to cover audit append and callback rejection as well as success. Verify rows and audit count do not change after escaped calls.

- [ ] Add `authorization reads transaction-local changes and all capabilities share one QueryRunner` in that integration file:

  1. Observe actual query calls using a forwarding spy on `source.logger.logQuery`; retain the third `QueryRunner` argument.
  2. Inside the adapter scope, lock the existing role, patch `isAdministrator: true`, read authorization facts, and append a complete audit record.
  3. Assert the returned authorization facts include that uncommitted flag; `source.manager` on another connection still sees the original flag.
  4. Assert authorization queries, target lock/update, and audit insert carry the same QueryRunner.
  5. Throw a sentinel; assert the exact rejection, original stored Role, no audit, and expired capabilities.

This test-only sequence exercises read-your-writes. It does not change the production UseCase’s authorization-before-lock sequence.

- [ ] Run:

```sh
pnpm --filter backend-next test test/unit/role/role-update-transactions.test.ts
pnpm --filter backend-next test:integration test/integration/role-update.test.ts
```

Expected red: new unit expectations expose the adapter’s local guard message. Existing rollback/authorization tests and new characterization cases may already pass; record that accurately.

### Step 6: Flatten the Role adapter

- [ ] In `src/platform/database/role-update.ts`, directly return:

```ts
return createTransactionRunner<RoleUpdateScope>(
	source,
	(manager, { assertActive }) => {
		// Bind existing repositories and return the existing scope.
	},
);
```

Remove the identity binder, outer wrapper, second `run`, local `active`, local guard, and local `finally`.

Keep `assertActive()` first in `getForUpdate`, `savePatch`, `authorizationFacts.read`, and `auditLogs.appendRoleUpdate`. Preserve their queries, mapping, pessimistic lock, manager arguments, and ID functions.

Production boundary remains `src/modules/role/update-role.ts:20–49`: snapshot input → credentials → transaction authorization → validation → lock → patch → audit → successful transaction completion → invalidation/publication. Do not reauthorize after waiting for the lock; `test/integration/role-update.test.ts:258` deliberately permits completion after revocation following the authorization read.

### Step 7: Verify Task 1 and update its inventory status

- [ ] Run:

```sh
pnpm --filter backend-next test test/unit/transaction-runner.test.ts test/unit/role/role-update-transactions.test.ts test/unit/role/update-role.test.ts test/unit/role/show-role.test.ts
pnpm --filter backend-next test:integration test/integration/transaction-runner.test.ts test/integration/role-update.test.ts
pnpm --filter backend-next test:integration test/integration/note-create.test.ts test/integration/notification.test.ts test/integration/poll-ended-job.test.ts test/integration/remote-user.test.ts
pnpm --filter backend-next... typecheck
```

Expected: passing new guards and real-DB checks; existing shared-runner consumers remain compatible.

Retain actual Role/audit storage rollback (`role-update.test.ts:126`), lock serialization (`:179`), uncertain acknowledgement **after actual commit** (`:229`), publisher failure (`:246`), and revoke-after-read (`:258`).

- [ ] Update inventory with exact commands/results and before/after paths: Role lifetime owners `1 → 0` locally; shared runner gains the owner. Note/remote-user local lifetime wrappers remain. Mark only verified Task 1 rows complete.

## Task 2: Extract Narrow Role Composition and Verify Production Use

**Files:** Create `src/composition/role.ts` and `test/integration/role-application.test.ts`; modify `src/composition/role-http.ts`, `test/integration/http-app.test.ts`, and the inventory.

**Interfaces:**

- Consumes Task 1’s unchanged `createRoleUpdateTransactions` API.
- Produces `RoleApplicationDependencies`, `RoleApplication`, and `createRoleApplication` exactly as defined above.
- Keeps existing `createRoleHttpApp(resources, config)` calls assignable through structurally narrower inputs.

### Step 1: Write failing factory integration tests

- [ ] Create `test/integration/role-application.test.ts`. Initialize an isolated migrated database and seed it with existing `test/helpers/role-http.ts:9`’s `seedRoleHttp`.

Define these tests:

| Test name | Assertions |
| --- | --- |
| `constructs only show and update operations without opening a transaction` | `expect(Object.keys(application).sort()).toEqual(['showRole', 'updateRole'])`; transaction spy has zero calls after construction. |
| `shows a role without starting a transaction` | Use real root credentials with a moderator/read access request and an evaluation; assert Role ID, injected `createdAtFromId` result, assigned count, `access.authorized === true`, and zero transaction calls. |
| `updates and audits using injected clock and audit ID before notifying` | Inject a fixed clock and a valid fixed audit ID; assert stored `updatedAt`, audit ID/snapshots, one transaction, and authorized access. Publication reads Role/audit through another connection and sees both committed. |
| `preserves success when publication rejects` | Throw from injected publisher; update resolves, Role and audit remain committed. |
| `uses current transactional authorization for update` | Remove DB administrator qualification before calling update; assert `ADMINISTRATOR_REQUIRED`, unchanged Role/audit, and no publication. |

Use `createAccessRequest` with existing endpoint requirements and `createAttemptEvaluation(atMs)`. Close every evaluation in `finally`; use public module contracts.

- [ ] Run:

```sh
pnpm --filter backend-next test:integration test/integration/role-application.test.ts
```

Expected red: `src/composition/role.ts` / `createRoleApplication` does not exist.

### Step 2: Implement the feature factory

- [ ] Create `src/composition/role.ts` with the specified interfaces and SPDX header. Move existing show/update construction from `role-http.ts:19–26` into it.

Show binds its readers to `parts.dataSource.manager`. Update receives `createRoleUpdateTransactions(parts.dataSource, parts.ids)`, `parts.clock`, and `parts.changes`. Return only the two operation functions. Add no resource ownership, cleanup API, or generic feature registry.

- [ ] Run the factory integration command again. Expected: all new cases pass.

### Step 3: Delegate existing HTTP composition

- [ ] Narrow `createRoleHttpApp`’s parameters as specified. Retain codec creation, authentication, `createRoleEndpoints`, and `createApiEndpoints`; replace inline business assembly with `createRoleApplication`.

Pass the returned application directly to `createRoleEndpoints`. Remove obsolete reader/UseCase/transaction imports and duplicated construction.

The unchanged production route is:

`processes/http.ts:120` → `composition/http-app.ts:14` → `composition/role-http.ts` → `composition/role.ts` → existing UseCases/adapters.

### Step 4: Add authenticated canonical-root coverage

- [ ] Extend `test/integration/http-app.test.ts:19` to call `seedRoleHttp` before app construction. Replace its standalone singleton Meta insert with that helper’s insert, then update federation to `'all'`; retain the remote actor seed.

- [ ] Add `canonical root performs authenticated Role show and update`:

  1. Call show with the seeded root token; expect `200` and the seeded Role.
  2. Call update with a distinctive name; expect `204` and empty body.
  3. Assert persisted name, one additional `updateRole` audit, and the next show returning the changed name.
  4. Keep the existing unauthenticated requests, actor redirect, Note behavior, optional queue handling, and unknown-route assertions.

- [ ] Run the root/gate regressions:

```sh
pnpm --filter backend-next test test/unit/composition/http-app.test.ts test/unit/http/api-endpoint.test.ts test/unit/composition/queue-workers.test.ts
pnpm --filter backend-next test:integration test/integration/role-application.test.ts test/integration/http-app.test.ts
```

Expected: authenticated production-root operations work; Note preparation still precedes Role; missing authorization still produces `500`. Successful HTTP doubles must call `access.authorize`.

### Step 5: Verify acceptance and resource lifetime

- [ ] Rebuild before tests using built fixtures:

```sh
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test:acceptance
pnpm --filter backend-next test:process test/processes/role-http.test.ts
```

Expected: fixed Role HTTP expectations, policy effects, audit rollback, pre-publication process-death/TTL recovery, and both connected/disconnected shutdown cases pass.

Do not update direct callers or `test/fixtures/role-before-publish.mjs`; its publisher override must still precede application construction. Preserve resource cleanup ordering at `processes/lifecycle.ts:23,31` and accepted-handler draining at `processes/http.ts:109`.

### Step 6: Finish the operational record and repository checks

- [ ] In the inventory, record the composition path before/after, removed duplicate assembly, and actual verification results. State whether Role’s route became easier to trace and whether this supports reconsidering stage 2; do not infer automatic authorization to expand.
- [ ] Include local handoff text for #114/#251: stage 1 result, inventory path, stage 2/3 deferred, remaining platform-to-composition imports, and re-evaluation conditions. Do not send it or change global blocked-by/order.
- [ ] Run repository safety checks last:

```sh
node scripts/check-shipping.mjs --base 5fe478de46039437f4f74a4be765c6670b6a645d
git diff --check
git diff --name-only 5fe478de46039437f4f74a4be765c6670b6a645d
git status --short
```

Expected: changed-file `eslint --quiet`, SPDX, locale safety, and whitespace checks pass. Inspect the file list against this plan; preserve the pre-existing design document unchanged.

No legacy backend test configuration, misskey-js generation, or migration/schema validation is required because this slice changes neither API contracts nor entities/migrations.

## Implementation Environment Setup

Run from repository root in a writable implementation session. Install only if dependencies need preparation:

```sh
pnpm install --frozen-lockfile --filter backend-next...
pnpm --filter backend-upstream sync:check
pnpm --filter backend-next... build

export BACKEND_NEXT_TEST_DB_PORT=55433
export BACKEND_NEXT_TEST_REDIS_PORT=56380
docker compose -p backend-next-251 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
```

Confirm the project name and ports are unused; substitute session-specific values if occupied. Keep the same environment for subsequent commands.

Tests create/drop random databases and apply existing migrations themselves (`test/helpers/database.ts:38`, `test/integration/role-update.test.ts:50`). They require database-creation permission and loopback/process execution. Meilisearch and legacy `.config/test.yml` are unnecessary for the selected commands.

After verification, stop only the project this implementation session created:

```sh
docker compose -p backend-next-251 -f packages/backend-next/compose.test.yml down
```

## Completion Checklist

- [ ] Four production files changed; business APIs and UseCases unchanged.
- [ ] Shared runner expires each lifetime across success, binder/work failure, and source rejection.
- [ ] All four Role operations reject escaped calls before adapter/database access.
- [ ] Real DB proves shared connection, transaction-local authorization, rollback, and no escaped writes.
- [ ] Authorization-before-lock and existing uncertain-COMMIT/publication semantics preserved.
- [ ] Narrow Role factory is consumed by production HTTP; old assembly and Role wrapper removed.
- [ ] Root, acceptance, process, build/typecheck, changed-file lint, SPDX, locale, and whitespace results recorded.
- [ ] Operational inventory names every retained/deferred path, owner, reason, verification, and re-evaluation condition.
- [ ] Stage 2/3 and full platform composition extraction remain open; #251 is not declared wholly complete.
- [ ] No unauthorized commits, external sends, child agents, or Codex goals.

## Plan Self-Review

- [x] **Spec coverage:** Stage 1 transaction/composition requirements map to Tasks 1–2. Note/Poll, queue migration, and full resource extraction are explicitly deferred.
- [x] **Step scan:** Steps name concrete files, interfaces, test assertions, red conditions, commands, and deliverables. Existing characterization tests are distinguished from new failures.
- [x] **Type consistency:** One lifetime interface and one Role application factory; existing business and HTTP callers remain compatible.
- [x] **Review Focus:** All five failure classes have assigned tests, including binder cleanup, concurrent lifetime isolation, source rejection, same-connection authorization, and production/shutdown behavior.
- [x] **Proportion:** Two independently testable tasks; no new framework, generalized registry, dependencies, or commit steps.
- [x] **Evidence limits:** Runtime validation remains unexecuted during planning; all implementation test outcomes above are expected results, not claimed passes.