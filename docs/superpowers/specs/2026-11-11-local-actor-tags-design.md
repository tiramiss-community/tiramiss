# Local actor emoji and hashtag publication (#195)

## Selected scope and source boundary

Publish `User.emojis` and `User.tags` from existing local actor GET `/users/:id` and `createRemoteUsers.acquireActor` local resolution. Base `e6d422d4ee728fcccbd9a435f8560a9042addd68`; upstream read-only `/tmp/tiramiss-relay171-upstream` at `8e07cf085adf7009583d234a208e30436f020e26`. Selection: `/tmp/tiramiss-s1-r6-selection.md`; current issue snapshot: `/tmp/tiramiss-s1-r6-issues.json` (#114/#176/#195 and adjacent owners; #128 is referenced by ROADMAP, not included in that snapshot). This is one narrow #195 foundation, not completion of remote mentions or #176.

Execute literal `ApRendererService.renderPerson`, `getEmojis`, `renderEmoji`, `renderHashtag` in a new independent source probe. Guard complete source bytes and extracted method hashes. Observe tag JSON, Profile/cache/render/key ordering, advancing clock and failures. Explicit doubles: required Profile repository, local emoji cache Map/throw, URI, no avatar/banner, unrelated key/media/MFM projection, Date with advancing zero-argument constructor and key delay. Projection excludes other actor fields, cache TTL and full upstream HTTP/DB. Existing source corpora and measurement receipts stay immutable.

## Behavior and errors

Profile finishes before emoji acquisition. Empty names skip the emoji query; otherwise read local emoji rows only (`host IS NULL`), reconstruct `User.emojis` order and duplicates, omit missing names and `localOnly`. Render emojis before hashtags, retaining hashtag order and duplicate/raw spelling. Hashtag href uses `encodeURIComponent`; no new normalization. Always publish `tag: []` when empty.

Emoji shape: local `/emojis/<name>` id, `:name:`, Image icon, `type ?? 'image/png'`, `publicUrl || originalUrl`, license freeText including null. Preserve empty MIME string. Stored dates render exactly; each visible emoji lacking a date samples its own rendering time before key lookup. Duplicated null-date emojis can have different times. A later key wait must not change those dates. Query/date/hashtag encoding errors propagate; no empty fallback and no key read after tag failure. Existing summary conversion still occurs after key lookup. Profile field URL conversion remains owned by the existing actor renderer; malformed persisted field structures are outside this tag projection.

## Architecture and interfaces

Keep TypeORM out of federation business code; rendering receives acquired facts and an explicit number. Move the existing Note emoji facts and literal single-emoji/hashtag shapes into narrow `modules/federation/ap-tags.ts`. `renderApEmoji(emoji: ApEmojiFacts, selfUrl: string, now: number)` and `renderApHashtag(name: string, selfUrl: string)` are pure. `LocalActorTag` is their return-type union. Preserve the public `ApEmojiFacts` export and Note order (hashtags, mentions, emojis) and Note's existing `options.now` fallback.

`platform/database/local-emojis.ts:createLocalEmojiReader(manager: EntityManager): (names: readonly string[]) => Promise<ApEmojiFacts[]>` owns the existing Note local lookup, plain projection and name-order reconstruction. No writes/cache/Drive access. Both Note and actor use it.

`composition/local-actor-tags.ts:createLocalActorTagReader(manager: EntityManager, selfUrl: string, now: () => number = Date.now): (user: Pick<LocalActorFacts, 'emojis' | 'tags'>) => Promise<LocalActorTag[]>` acquires emoji facts, filters localOnly, invokes each pure render with `updatedAtMs ?? now()`, then renders hashtags. It owns no transaction, lifecycle or background work.

`LocalActorFacts` adds required `emojis: readonly string[]; tags: readonly string[]`. DB actor reader returns these columns. `renderLocalActor(facts, profile, selfUrl, publicKeyPem, tag: readonly LocalActorTag[])` requires pre-rendered tags. HTTP parts add `readTags(user: LocalActorFacts): Promise<LocalActorTag[]>`. HTTP and local resolve perform Profile → readTags → key → actor rendering. Composition wires a real tag reader in both places. Do not duplicate complete actor acquisition or add a generic resolver.

## Alternatives and intentional limits

Actor-only duplicate DB/render code loses existing Note reuse; reject it. Shared cache construction introduces #217 ownership and new lifetimes; use the existing Note direct-read approach permitted by ROADMAP. This differs from upstream Redis30min/memory3min freshness and cache-hit DB-failure behavior; it is not cache parity. A generic cache/Drive service or full actor implementation is unnecessary. Media #188/#195 needs Drive download, chart #200 owns producers, cache/events #217 owns subscribers, Follow renderer #182 and Move #199 remain with their owners. Other rich actor fields could be independent work, but tag publication is a cohesive caller-backed gap now.

Formal shared roots → #176 → #195 inbox order remains. #176/#127/#195 remain incomplete, `notes/create: partial`, `postingComplete:false`. Remaining initial work includes media, other rich actor/featured/Move/inbox/remote Notes, other instance paths, charts and cache/events.

## Verification and evidence

New source observations independently generated from pinned methods; source-consuming unit assertions compare their JSON and order/error traces. Literal boundary tests cover HTML/disabled/missing/remote short circuits, Profile/query/render failures, key wait and empty query. Real PG+HTTP tests insert User and local/remote same-name Emoji rows, verify both real compositions and query failures. Shared Note unit/source and PG tests prove unchanged order/time/URL fallback. No new asynchronous lifetime or process ownership: no new process suite; parent may run existing process regressions if warranted.

Freeze runtime source/test/dependency inputs before parent broker validation with revisioned sha256 map and exact commands/log/report paths. Exclude mutable documentation/evidence/inventory JSON from the input map to avoid circular receipts. Preserve failures and old receipts; changed inputs require a new revision. Parent owns build/typecheck/integration/source replay, root contracts/inventory/shipping and implementation commit pin. Do not fabricate old-pin files or attribute baseline runs to changed inputs.

## Global constraints

- Node24.20.0 and pnpm12.9.1; fixed lockfile, no installation.
- Sole writer; no child agents, external sends, Docker, Git mutation, secrets/auth/settings/.config/.env/security reads.
- No old backend/frontend edits, upstream-managed hand edits, dependency/Entity/migration/API schema changes or CHANGELOG edits.
- Parent owns infrastructure, validation broker, CodeRabbit/reviews, Git and PR. Do not commit.
- Wait for `/tmp/tiramiss-s1-r6-plan-go` after plan-ready; continue through implementation and measured handoff after GO.
