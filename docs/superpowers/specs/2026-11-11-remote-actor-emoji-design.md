# Remote actor emoji ingestion (#195)

## Scope and source

Connect actor emoji extraction, `emoji` persistence and `User.emojis` to the existing public `notes/create` remote-mention create/canonical-recovery/stale-refresh paths. Source: read-only `/tmp/tiramiss-relay171-upstream`, fixed `8e07cf085adf7009583d234a208e30436f020e26`; implementation base `65a4506d14c2bb74931ae131fdbce9ecf8eff205`. Follow the selector recorded at `/tmp/tiramiss-s1-r5-selection.md`.

The oracle executes literal `ApNoteService.extractEmojis`, repository `miRepository.insertOne`, actual `getApType`/`isEmoji`/array/Utility helpers and real `ApPersonService.createPerson/updatePerson` with extraction connected. Guard source files and extracted methods with literal hashes before recording observations. Repository, clock, ID, actor transport/transaction/media/featured/chart/cache doubles are explicit. These are source-method observations, not an upstream server or real upstream DB comparison. Preserve historical source95/actor/profile/metadata corpora and receipts; new bindings and measurements are additive.

## Behavior

- Apply source `toPuny(host)` and `toArray(tags).filter(isEmoji)`. Type arrays use their first element; icon arrays are excluded; missing icon/null tag and malformed names may throw. Do not add string checks, URL sanitization or deduplication. Remove every colon from names. Even empty input queries once with the empty names list.
- Query existing host/names once; every tag uses that snapshot and starts concurrently. Return order follows input. Existing duplicate tags remain duplicate results. Do not add upsert, serialization, all-tag transaction or retry.
- Update when stored `updatedAt == null`, supplied ID fills null URI, tag timestamp is newer, or icon URL differs from `originalUrl`. License-only, publicUrl-only and ID-only changes to a nonnull URI do not trigger writes. Update URI, both URLs, current time and `_misskey_license?.freeText ?? null`, then refetch by host/name; missing refetch rejects. Preserve undefined URI versus explicit null.
- Insert generated ID, host/name, URI, both URLs, current time, empty aliases and license, then refetch by INSERT identifier as source `insertOne` does. Preserve INSERT success followed by read failure. Existing MiEmoji defaults own all other columns.
- Create performs attachments/tags/collections/birthday/URL checks first, extracts and maps names with a catch to `[]`, then creates actor time/ID and enters User/Profile/Key transaction. Input URI supplies host. Successful emoji writes survive actor rollback, later Note failure and canonical duplicate fallback. Canonical fallback retains the existing User and its emoji names; emoji constraint errors stay inside extraction catch.
- Refresh extracts immediately after validated actor and URI-entry existing User acquisition, before attachment/tag/collection/birthday/URL handling; use entry User.host. Extraction catch gives `[]`. A successful User update clears old names on extraction failure. Later URL failure or deleted skip leaves earlier emoji writes intact. Local/fresh short circuits, stale attempt/WebFinger/URI repair and entry reread remain intact.
- `Promise.all` rejects early while other started tag operations may continue. Track those complete operations separately and drain them before DB release, without changing the response to await `allSettled`. No durable job, cancellation or stronger retry guarantee.

## Interfaces and ownership

`RemoteEmoji` is plain `{ id, name, host, uri, originalUrl, publicUrl, updatedAt, aliases, license }` (nullable stored host/URI/time/license). `RemoteEmojiPatch` has `{ uri: string | null | undefined, originalUrl: string, publicUrl: string, updatedAt: Date, license: string | null }`; `RemoteEmojiInsert` adds `{ id, host: string, name, aliases: string[] }`.

`extractRemoteEmojis(tags: unknown, host: string, ports: RemoteEmojiPorts): Promise<RemoteEmoji[]>` owns predicates, decisions and parallel work. Ports: `find(host: string, names: string[]): Promise<RemoteEmoji[]>`, `update(host: string, name: string, patch: RemoteEmojiPatch): Promise<void>`, `findOne(host: string, name: string): Promise<RemoteEmoji | null>`, `insert(input: RemoteEmojiInsert): Promise<RemoteEmoji>`, `now(): number`, `newId(): string`, `track(work: Promise<RemoteEmoji>): void`.

`createRemoteEmojiRepository(manager)` implements the four DB ports with Repository and maps entities to plain facts; insert uses insert identifiers then `findOneOrFail`. `createRemoteEmojis(repository, { now, newId })` returns `extract(tags, host)`, `idle()` and `close()`, tracking tag settlement including rejection. Assembly in `connect-resources.ts` registers close before connection release and supplies the controller to `createRemoteUsers`. No framework/ORM imports in federation business code.

`RemoteActorMaterial.emojis?: string[]` supplies measured names to the existing plan; default `[]` preserves old direct planner consumers. Split source-order preflight from projection as needed: `validateActorProfileUrl(material, refresh): void` checks URL and birthday before create extraction; refresh calls extraction before any profile material work. Actor clock/ID are taken only after extraction. `createRemoteUsers` keeps separate create/refresh catch boundaries.

## Verification

New source corpus and focused units cover predicates, malformed tags/icon/name/license, all update and no-update conditions, empty query, IDN/port host, URI undefined/null, duplicate snapshot, query/update/insert/refetch failure, parallel start, ordered results and rejection with remaining work. Boundary cases cover create/refresh validation ordering, rollback, canonical retention and deleted skip. Old expectations remain frozen; changed consumers receive new current identities rather than altered historical seals.

Real PG/Redis plus fake AP and native-token HTTP cover create, fresh, stale, canonical duplicate, actor and Note failure, URL rejection, duplicate/partial emoji writes and DB defaults. Create a fixture Note authored by the acquired remote user and read its packed author emoji URLs; this tests existing read integration, not remote Note ingestion.

Built HTTP process cases hold emoji operations with DB locks and independently observe waiting queries/lock owners. Prove successful extraction gates posting; separately make one tag reject while another stays blocked, observe posting response then SIGTERM waiting, release the lock and verify persistence and clean exit. Controller units prove dynamic pending-work drain.

Parent runs real integration/process/build/full-unit and root Node26 contracts/inventory/shipping. Freeze actual source/test/dependency input SHA256s before broker validation; record exact command/log/counts and retain failed revisions. No inferred pass or reused baseline counts.

## Alternatives and limits

Oracle/adapter alone leaves the public gap. Local actor emoji publication needs different facts and both render callers. Featured/Move/inbox/remote Notes and Drive/chart/cache broaden ownership; defer them. Source URL population has a 12-hour cache and extraction does not invalidate it; current direct DB reads are not cache-freshness parity (#217).

Media/emoji #188/#195 remains partial (avatar/banner/Drive, local publication, other callers); other instance paths #215, charts #200, rich actor/inbox/remote Notes #195 and cache/events #217 remain incomplete. Keep #176/#127/#195 open, `notes/create: partial`, `postingComplete:false`; no formal reorder.

## Global constraints

- Node24.20.0 and pnpm12.9.1; fixed lockfile, no installation.
- Sole writer; no agents, external sends, Docker, Git mutation, secrets/auth/settings/.config/.env/security reads.
- No old backend/frontend edits, upstream-managed hand edits, Entity/migration/API schema changes or CHANGELOG edits.
- Parent owns infrastructure, validation broker, final reviews, Git and PR. Do not commit.
- Wait for `/tmp/tiramiss-s1-r5-plan-go` after plan-ready; implement through final evidence after GO.
