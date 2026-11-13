# Local actor stored fields (#195 bounded S1 slice)

Base: `6601944296f367e66fde8ecf3a2458c946ae2a6c`. Source: `8e07cf085adf7009583d234a208e30436f020e26`. Follow GOALS, ROADMAP and the existing pure projection/acquisition boundary; this contributes to #176 without completing it. Preserve #249 → #176 → #195 inbox order.

## Contract and approach

Extend required `LocalActorFacts` and the existing User reader with six plain values. Keep `renderLocalActor` pure with its existing signature; both HTTP actor GET and internal local acquisition already consume it. No composition or public export changes are needed.

| Facts input | Serialized actor output |
| --- | --- |
| `isCat: boolean` | Always `isCat`, including false |
| `requireSigninToViewContents: boolean` | Always `_misskey_requireSigninToViewContents` |
| `makeNotesFollowersOnlyBefore: number \| null` | Always `_misskey_makeNotesFollowersOnlyBefore`; retain null/zero/positive/negative seconds |
| `makeNotesHiddenBefore: number \| null` | Always `_misskey_makeNotesHiddenBefore`; same preservation |
| `movedToUri: string \| null` | `movedTo` only if truthy; omit null/empty string |
| `alsoKnownAs: readonly string[] \| null` | Omit null; retain empty arrays, order, duplicates and raw strings |
| Actor ID | Always `featured: "${id}/collections/featured"` |

No URI normalization, alias deduplication, cutoff conversion or renderer defaults. Dotted usernames still take Application precedence over bot Service. Internal ingestion reads unprefixed settings while publication uses `_misskey_…`; observe the rendered document at passthrough `validateActor`, without changing that separate ingestion contract.

## Evidence and constraints

Add independent `local-actor-fields-{corpus.json,source-probe.mjs,observations.json}` executing literal pinned `renderPerson` with verified Git bytes and hardcoded file/method hashes. Declare finite input bounds and profile/media/tag/key/MFM conversion doubles. Observe serialized JSON with absent keys preserved, plus representative dependency rejections. Historical probes, corpora, observations and receipts are immutable.

Pure tests compare the finite field projection to source outputs; obtain actual RED before product edits. PG tests seed User/Profile/Key, exercise real HTTP and `createRemoteUsers().acquireActor`, inspect the internal document, and verify retained rows. Reuse existing early response, suspension and error-order coverage. Preserve historical signer projection using its original explicit allowlist, retaining all earlier assertions.

Node 26.4.0 via `/tmp/tiramiss-s1-node26/bin`; frozen installed dependencies. Single writer in this dedicated worktree; no workers, Git mutations, external sends or CodeRabbit. Only two production files may change. No old backend, synchronized entities, schema, dependencies, locales, CHANGELOG, root proof helpers, inventory, remote README, ROADMAP or final results edits in this task. Dedicated infrastructure only: PostgreSQL 55514, Redis 56414, Meili 57814; never touch misskey-infra.

If genuine RED is sandbox-blocked, record NEEDS_HOST_RED and stop before product edits. After stable implementation freeze executable/source/build inputs in an R11 validation request; parent runs the host receipt. Parent owns metadata renewal, review, shipping, commits, push and PR.

`featured` endpoint remains `not_implemented`; publishing `movedTo` executes no Move. Preserve current Meta/cache and remote-row qualifications, all historical chain hops through image removal, local images and WebFinger, five gap groups, #176/#127/#195 OPEN, `notes/create:partial`, `postingComplete:false`. This is source-method evidence with doubles, not an upstream full-server comparison.

## Alternatives and tradeoff

Keep the existing shared pure renderer and User reader: per-caller mapping would duplicate serialization and risk HTTP/internal divergence; adding featured serving, Move or other rich actor behavior now would exceed this bounded stored-field slice. The additive evidence leaf preserves historical projections at the cost of one explicit, finite current-byte hop.
