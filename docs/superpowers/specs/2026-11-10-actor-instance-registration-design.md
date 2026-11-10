# Actor instance registration after public remote mentions

Fixed source: `8e07cf085adf7009583d234a208e30436f020e26`, read-only `/tmp/tiramiss-relay171-upstream`. Scope: one #195 caller / #215 instance-ledger slice, following #176 ownership without completing it.

## Contract and evidence

`ApPersonService.createPerson` (`packages/backend/src/core/activitypub/models/ApPersonService.ts:304–467`) computes `host = utilityService.punyHost(uri)` before actor resolution. After committed User/Profile/Publickey creation or 23505 canonical URI recovery, it synchronously checks Meta and starts `fetchOrRegister(host)`. That promise callback starts Repository.increment({id}, 'usersCount', 1), chart/metadata, without awaiting increment. User charts and hashtag launch follow the register launch. Register resolution/actual increment need not precede hashtags. Duplicate recovery increments too; missing canonical and failed transaction do not. Account host and canonical user host must not replace the input URI authority.

The public `notes/create` caller in `src/modules/note/create-note.ts` owns the same post-transaction / duplicate boundary. Local, fresh, stale refresh and failed actor acquisition must not start registration. A later Note write failure must leave the committed actor and started increment intact.

## Approach and interfaces

Choose a dedicated `createActorInstanceRegistration` controller in composition, matching existing `createUserHashtags` pending/diagnostic/drain ownership. Alternatives: inline fire-and-forget in the caller hides lifetime and ORM; expanding metadata/chart now couples unrelated HTTP/mutex/worker work and exceeds this slice. No generic retry/exactly-once framework.

`RemoteUserPorts.startActorInstanceRegistration(host: string): void` launches before `startUserHashtags` in both create branches. Caller uses existing federation `punyHost(uri)`. Controller consumes `enabled(): Promise<boolean>`, `fetchOrRegister(host: string): Promise<{id: string}>`, `increment(id: string): Promise<void>` and Logger; returns `start(host): void`, `idle(): Promise<void>`, `close(): Promise<void>`. Settings read starts immediately; pending promise spans settings, registration and increment, catches/logs stage+host failure, drains before connection release. `connect-resources.ts` injects readMeta, existing ledger and direct MiInstance repository increment. `remote-users.ts` wires the start port. Cache is never updated by increment; ledger registration cache remains unchanged.

## Explicit differences and exclusions

Source synchronously reads its in-memory Meta. Current real asynchronous DB Meta reader adds a timing and failure boundary: hashtags may launch before register, settings changes while DB read is pending are not proven equivalent, and settings rejection is diagnosed without failing actor/posting. This is an explicit compatibility limit, not synchronous-source equivalence. Preserve the established `fetchOrRegisterInstance` first-registration `orIgnore` difference documented in federation-base-contract. Diagnosed failures and finite shutdown drain add no durable retry guarantee.

Metadata and charts receive no placeholder implementation. All five gaps remain incomplete: media/emoji #188/#195; instance metadata/other paths #215; charts #200; rich actor/featured/Move/inbox/remote Notes #195; remote cache/events #217. #176/#127/#195/#215 remain open, `notes/create:partial`, `postingComplete:false`.

## Acceptance and oracle

New independent source probe executes pinned real createPerson and necessary actual helpers with literal full-file and method hashes, explicit repository/transport/media/chart/metadata doubles and separately held register/increment promises. New observations never rewrite historical corpora/counts. Assert new/duplicate stats true/false, origin host, transaction failures/missing canonical, launch order and nonwaiting boundaries. Runtime units compare supported projections and separately pin async Meta/failure/drain. Real-token HTTP with PG/Redis/fake AP verifies actor/Profile/key, instance usersCount, duplicate recovery, raw concurrent increments, cache staleness, rollback, increment failure and Note failure. Built HTTP process gates DB work via locks, observes pg_stat_activity, proves response then SIGTERM waits through register/increment DB gates before connection release using events, not sleep guesses; settings pending/failure/drain is covered by controller units only; no built-process settings gate is claimed. Source synchronous Meta versus asynchronous DB Meta timing and concurrent settings-change equivalence remain unproven.

## Global constraints

Node24.20.0 and pnpm12.9.1; fixed lockfile, no installation. Sole writer, no subagents/reviewers, external sends, Git mutations, Docker, settings/secrets/.config/.env/security reads, old backend/frontend/upstream managed edits. No Entity/migration or public API/schema change. Parent owns infrastructure, shipping, final integration/process/full-unit/root Node26 validation and reviews. Freeze product/test inputs after hash-bound request; changes invalidate revision. ROADMAP gets only a small summary/link; retain historical source95 bindings. No commit.
