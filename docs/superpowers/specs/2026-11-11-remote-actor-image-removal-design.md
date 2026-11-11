# Remote actor image removal after creation and canonical recovery

## Contract

The public notes/create remote-mention caller must continue after either successful insertion or canonical duplicate recovery. Launch instance registration first and hashtags second, preserving creation's plan.hashtagUser snapshot and recovery's current canonical snapshot. Do not await hashtags. When both images are absent, await clearActorImages(resolved.id), catch/report its failure, and still return the resolved actor. Preserve transaction failure handling.

Normalize image arrays to their first item with a truthy url; null/undefined or objects with null/undefined url are absent. Direct {url: ''}, URL strings and mixed present/absent images are outside this slice. Derive RemoteActorPlan.bothImagesAbsent using the existing classifier. Keep refresh behavior unchanged.

The database operation updates by ID only, setting exactly avatarId, avatarUrl, avatarBlurhash, bannerId, bannerUrl, bannerBlurhash to null; propagate failure. Do not filter isDeleted or modify Profile/key/tags/Drive rows. The caller owns the failure boundary; composition binds diagnostics.

## Scope constraints

- Work only in the assigned worktree at base `6a4cc93bde543a7456467414611518c29f549ee6`; no git mutations, external sends, install, Docker, auth or config changes; no agents.
- Preserve historical observations/probes/evidence byte-for-byte; new evidence is additive.
- No CHANGELOG, locales, schema/entity, lifecycle, inventory/audit/domain/ROADMAP changes.
- Keep #176/#127/#195 partial, `notes/create:partial` and `postingComplete:false`.
- Source pin: `8e07cf085adf7009583d234a208e30436f020e26`; no Drive acquisition or mixed-image policy implementation.

## Proof

Unit tests pin classification, both creation outcomes, canonical ID, current hashtag snapshot/order, pending hashtags, awaited update, caught failure and exclusions (fresh/local/refresh/failed transaction/present images). HTTP/PG tests seed all six image fields and Drive references, recover via an unknown alias, verify persisted canonical mention and all six nulls with unchanged Profile/key/tags/Drive rows, and show an existing authored Note before/after. A targeted BEFORE UPDATE fault must leave INSERT and unrelated actor writes usable, retain old images, log failure and preserve the mention. Cover normal creation and mixed exclusion.

An additive source corpus/probe executes literal pinned createPerson and resolveAvatarAndBanner with explicit external doubles and Git-verified source. It records absent and mixed policy boundaries independently of the new implementation. Source doubles do not prove actual HTTP/PG behavior. Build/typecheck and focused suites validate the implementation; final parent frozen validation is required.

## Source and approaches

Pinned [ApPersonService.ts](https://github.com/misskey-dev/misskey/blob/8e07cf085adf7009583d234a208e30436f020e26/packages/backend/src/core/activitypub/models/ApPersonService.ts#L255) classifies absent images; canonical recovery at L427 continues to the caught, awaited image update at L459. The Note caller is `src/modules/note/create-note.ts` and the public avatar consumer is `src/platform/database/note-authors.ts`.

Builder choice: select the direct #176 absent-image repair because canonical recovery currently preserves observable stale media. Local actor media publication is deferred to its own slice. Zero-Note featured synchronization would add entity coordination and leave a larger unsupported branch. These choices narrow this implementation; they do not represent new user-agreed completion scope.
