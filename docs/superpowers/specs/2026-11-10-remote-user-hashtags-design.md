# Remote actor user hashtags (#195)

## Scope and source

Implement the attached user hashtag effect reached by public `notes/create` remote mention resolution, including actor creation, canonical-URI duplicate fallback and stale refresh. Source is read-only `/tmp/tiramiss-relay171-upstream`, pinned to `8e07cf085adf7009583d234a208e30436f020e26`: `ApPersonService.createPerson/updatePerson` and `HashtagService.updateUsertags/updateHashtag`. Base is `cb1feb3e713c00c992f0d5ad2705edc24b439d33`; sole-writer branch is `feat/backend-next-actor-followup-195` in the isolated worktree.

The existing five profile cases in `compatibility/note/hashtag` remain the source oracle for attached add/remove, absent rows and normalization collisions. A separate actor boundary corpus will observe actor normalization, duplicate canonical tags, refresh snapshot and detached settlement. Preserve all historical corpora, seals and receipts. New evidence describes actual executions separately.

## Behavior

- Create starts hashtag work after actor transaction commit. Duplicate insert obtains the canonical User and starts with its stored old tags and fetched actor's new tags, without replacing canonical User.tags. Other creation failures never start it.
- Refresh reads the current User by canonical URI after WebFinger/URI repair, at updatePerson entry and before fetching actor material. Copy its tags into the plan. Do not reuse the earlier account lookup snapshot; concurrent WebFinger changes must be visible. Missing URI rows skip refresh acquisition; source cache parity remains #217.
- User update/deleted guard, Key and Profile must succeed before launch. Launch is immediately after Profile and before Following. Following failure leaves launched work running. Actor and Note responses never await hashtag DB/Redis completion; later Note failure does not cancel actor effects.
- Iterate new tags in order, then old tags absent by raw string membership in the new array. Normalize each operation through the import-free `modules/hashtag/public.ts` contract shared with note. Do not deduplicate after normalization. Each operation independently launches ranking then awaits its DB write; DB failure stops later operations while started ranking remains. Ranking/settings delay or failure cannot gate DB progress.
- Attached total and local/remote ID arrays and counters change atomically per membership. Preserve mentioned columns and rows after removal; missing-row removal creates nothing. No whole-sequence transaction, retry, queue or generic all-user service.
- Hidden/sensitive suppress Redis only, including on removal. Ranking uses existing note Redis keys and positive increments for both add/remove. Record failures with user/tag context; track both DB sequence and launched ranking promises. Runtime shutdown drains them before releasing DB/Redis, including work started while another drain is pending.

## Interfaces and ownership

`RemoteUserFacts.tags: readonly string[]` carries a detached copy. `RemoteActorPlan.hashtagUser: UserHashtagSnapshot` holds `{ id: string; host: string | null; tags: readonly string[] }`; new actor snapshot uses its own new tags, refresh uses the entry snapshot. `RemoteUserPorts.startUserHashtags(user: UserHashtagSnapshot, tags: readonly string[]): void` is a required connected port, never an optional no-op. `createActorRefresher(writes, startUserHashtags)` invokes it at the Profile boundary.

`planUserHashtags(user, tags): UserHashtagChange[]` in federation produces `{ tag, userId, userHost, attached: boolean }`. `createUserHashtagWriter(manager, newId).change(input): Promise<void>` owns only attached columns. Prefer TypeORM QueryBuilder; a parameterized PostgreSQL conditional-array conflict expression is allowed only when QueryBuilder cannot express the atomic upsert (as documented by note-hashtags).

`createUserHashtags({ change, ranking, readSettings }, logger)` in composition exposes `start(user, tags): void`, `idle(): Promise<void>`, `close(): Promise<void>`. `connectResources` supplies the real writer, existing ranking and settings, registers cleanup and returns the owner to `createRemoteUsers`. Work begins immediately, without notePostSave's deferred scheduling.

## Acceptance and boundaries

Source probes, focused unit, real PG/Redis integration and native process evidence jointly prove the slice. The process test must hold hashtag DB work after actor HTTP has replied, observe a pending SIGTERM drain, release the DB gate and observe successful shutdown and persisted attachment. Holding only the actor HTTP response does not prove this.

No edits to old backend, frontend, upstream-managed files, GOALS, dependency lock, secrets/settings or environment files. No Docker, Git mutation, external send or helper/reviewer agents. Parent owns commit, shipping and final integration validation; use the validation broker after one diagnosed network EPERM.

Only mark the user-hashtag gap fulfilled after all evidence is verified. Other five actor gaps remain: media/emoji #188/#195; instance usersCount/metadata #215; charts #200; featured/Move/full actor #195; cache/remoteUserUpdated #217. Keep #176/#127/#195 incomplete, `notes/create:partial` and `postingComplete:false`. ROADMAP gets only a small final summary linking evidence.
