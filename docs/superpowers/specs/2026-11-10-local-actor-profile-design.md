# Local actor profile design (#195 bounded S1 slice)

Publish local actor description, followedMessage, fields, birthday and location from fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`. Existing identity/key/name behavior remains. This is a controller technical choice under delegated selection, not a user choice.

## Approach

Choose required flat Profile facts plus a pure renderer shared by HTTP and local acquireActor resolution. Combining Profile into the general User reader would break remote 301 and unnecessary reads on 403/404; separate caller renderers would drift. Read Profile only after local eligibility, then key, then render. Profile absence and DB errors propagate; MFM exceptions are not replaced with empty summaries.

`LocalActorProfileFacts` contains description/followedMessage/birthday/location as `string | null`, fields as readonly `{name:string; value:string}[]`. `renderLocalActor(facts, profile, selfUrl, publicKeyPem)` returns `Record<string, unknown>`. It uses mfm.parse plus existing public MFM toHtml with empty remote mentions. Summary is null for falsey description; raw summary retains null/empty. Attachment exists with undefined for empty fields (omitted by JSON); birthdays/locations are absent unless truthy. Source's leading lowercase HTTP(S) URL regex, normalized href, raw link label, attributes and trailing text remain exact; fields are not escaped or MFM-converted.

## Constraints

Node 24.20 / pnpm 12.9.1, installed fixed lock; no dependency, schema, migration, policy, queue or framework additions. Sole writer; no agents, Git mutations, external sends, Docker/install, secrets/settings/.config/.env reads, old backend/frontend/upstream-managed edits. Upstream checkout is read only. No product edits before parent preflight file. Network/process/DB EPERM is diagnosed once and delegated without retries. Parent owns Git, shipping, infrastructure, final broad validation and review.

Keep historical source95 profile-excluded identity corpus and receipts unchanged. Add an independent source probe executing real renderPerson/MfmService.toHtml/helpers with pinned literal hashes and declared I/O doubles, including raw undefined encoding and JSON results. Measured current renewals may supersede hashes only for actual runs. No fabricated current claims.

## Acceptance

Source comparison covers null/empty/newline/link/mention/hashtag descriptions; malformed and HTTP/HTTPS/uppercase/trailing/multiple fields; birthday/location null/empty/value; name; missing Profile, DB and MFM exceptions. HTTP early exits must not read Profile. Real PG→HTTP and actual createRemoteUsers.acquireActor local URI share the projection. A normal HTTP child process returns profile fields. Unit tests retain the explicit old identity-only projection separately.

All five actor gaps remain open: media/emoji (#188/#195), instance metadata/usersCount (#215), charts (#200), richer actor/featured/Move/inbox/remote Notes (#195), cache/remoteUserUpdated (#217). Keep notes/create:partial, postingComplete:false, #176/#127/#195 incomplete and existing remaining ownership. No changelog edit; small ROADMAP summary only after measured results.
