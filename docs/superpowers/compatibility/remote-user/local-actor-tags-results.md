# Local actor emoji/hashtag publication (#195)

Local actor GET `/users/:id` and `createRemoteUsers.acquireActor` local resolution now publish `tag` from stored `User.emojis` and `User.tags`. Emoji names preserve input order/duplicates, missing and localOnly rows are omitted, remote rows cannot supply a local emoji. Emoji precede raw ordered hashtags; empty actors publish `tag: []`. MIME null fallback, empty MIME preservation, publicUrl `||` originalUrl, license and dates follow the fixed source. Each visible undated emoji samples its own rendering time before key acquisition. Profile, emoji query and rendering errors propagate; early HTTP branches never acquire tags. The existing Note helper consumer retains hashtag→mention→emoji order and its supplied snapshot clock.

## Independent source observation

Pinned read-only upstream `8e07cf085adf7009583d234a208e30436f020e26`, complete `ApRendererService.ts` SHA256 `8e4bcdcb5d062ffb707b0e038e5e1f62f0afca2ac4ddaa44c10e1b21bcbf1098`. The [probe](local-actor-tags-source-probe.mjs) executes literal `renderPerson`, `getEmojis`, `renderEmoji`, `renderHashtag` with separate literal method guards, producing [12 observations](local-actor-tags-observations.json). Explicit Profile/cache-Map/clock/key/media/URI doubles and exclusions are in the corpus. Null summary avoids unrelated MFM execution. A ticking Date constructor and key clock advance observe time before the key wait. This is source-method evidence, not an upstream HTTP server or database comparison.

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-actor-tags-source-probe.mjs --check
```

The direct source consumer runs each recorded input through the real actor HTTP adapter, composition tag reader, local emoji DB adapter with a repository double, and pure renderers. It compares independently recorded tag JSON/errors and Profile/query/clock/key order. The actual PG/HTTP test separately proves the database query and both real composition wires, observing local resolve output at its next remote-emoji extraction boundary. That extraction boundary is doubled in this one local publication test; remote ingestion itself remains covered by its older corpus/tests.

## Measured current runtime, revision 1

Base `e6d422d4ee728fcccbd9a435f8560a9042addd68`, dirty tree; no implementation commit is invented. Node24.20.0 / pnpm12.9.1. Parent broker used dedicated PG55509, Redis56409, Meili57809. The [additive evidence](local-actor-tags-runtime-evidence.json) records exact commands, artifact/log paths, SHA256s, 16 current file bindings, and preserved hashes of all 15 preceding remote-user corpora/probes/receipts. Its 822-entry runtime source/test/dependency input map stays in `/tmp/tiramiss-s1-r6-validation-request-r1.json`; mutable docs/evidence/inventory JSON are excluded, while the new immutable source probe/corpus is included. No giant input maps are duplicated here.

| Check | Actual result | UTC, 2026-11-11 | Artifact/log |
| --- | --- | --- | --- |
| Behavioral RED before product edits | 0 pass / 3 expected failures | before GREEN | `/tmp/tiramiss-s1-r6-red-unit.json`, `.log` |
| Dependency-order build | exit0 | 02:32:19–02:32:20 | `/tmp/tiramiss-s1-r6-r1-build.log` |
| Dependency-order typecheck incl. tests | exit0 | 02:32:20–02:32:21 | `/tmp/tiramiss-s1-r6-r1-typecheck.log` |
| Focused actor/profile/Note unit | 127 pass / 5 files / 0 failed or skipped | 02:32:21–02:32:23 | `/tmp/tiramiss-s1-r6-r1-focused-unit.json`, `.log` |
| Actual actor HTTP/PG + Note PG regression | 145 pass / 2 files / 0 failed or skipped | 02:32:23–02:32:36 | `/tmp/tiramiss-s1-r6-r1-integration.json`, `.log` |
| Full unit (shared exports, Note reader/rendering and composition) | 3021 pass / 93 files / 0 failed or skipped | 02:32:36–02:33:08 | `/tmp/tiramiss-s1-r6-r1-full-unit.json`, `.log` |
| Pinned source replay | 12 identical cases, exit0 | 02:33:08 | `/tmp/tiramiss-s1-r6-r1-source-probe.log` |
| Scoped package lint / diff check before freeze | exit0 / no errors | before broker | `/tmp/tiramiss-s1-r6-scoped-lint-final.log`, `/tmp/tiramiss-s1-r6-diff-check.log` |

Broker receipt `/tmp/tiramiss-s1-r6-validation-receipt.json` completed `2026-11-11T02:33:08.978325+00:00`, SHA256 `022a5324094895656e890d2349fa431b245cbf75a2f7eec94a7aea5648cc65d6`. All frozen hashes matched before/after every command and again when this evidence was recorded. Initial lint found 34 formatting violations; formatting fixes preceded the frozen measurement. Extended RED (4 pass/16 failures, including unavailable new modules) is retained separately at `/tmp/tiramiss-s1-r6-red-extended-unit.json`. No runtime revision failed or was superseded. Integration retains the existing `pg` concurrent-query deprecation warning; it is not counted as a failure or silently removed.

## History, limits and remaining owners

All older corpora/probes/receipts remain byte-for-byte intact. The final identity hop in `scripts/local-actor-tags-evidence.mjs` accepts only known preceding hashes and successful current runs. It extends the existing actor/profile/metadata/remote-emoji chain without relabeling old process or public remote-mention runs as current tag evidence. Historical publication tests explicitly project out the new tag property; the new corpus owns that projection.

Direct DB reads deliberately retain the existing Note architecture. Upstream uses Redis30min/memory3min local emoji caching: freshness, cache-hit DB outage behavior and cache population are not equivalent; #217 remains an initial functionality gap. Multiple stored local rows with the same name, cache invalidation and malformed unrelated Profile fields are outside these measurements. No new lifecycle/background work was added, so no dedicated new process suite was run. Full upstream server equivalence and all actor fields are not claimed.

Root contract checks, inventory generation/pin, SPDX/locale/shipping, independent review, CodeRabbit and Git/PR belong to the parent completion gates and are requested separately; runtime success above does not claim those gates already passed. Inventory is limited to local actor HTTP/rendering and the shared emoji/hashtag rendering rows; the parent must advance the pin after a real normal implementation commit before generation.

Formal shared roots → #176 → #195 inbox ordering and other owners remain. #176/#127/#195 stay incomplete, `notes/create: partial`, `postingComplete:false`. Media/Drive (#188/#195), remaining rich actor/featured/inbox/remote Notes (#195), Move (#199), Follow renderer (#182), other instance paths (#215), charts (#200) and cache/events (#217) remain with their owners. This local-publication foundation does not directly complete the public remote-mention residuals.
