# Public remote profile conversion (#195, 2026-11-11)

The existing public `POST /api/notes/create` remote-mention caller now selects **all** PropertyValue attachments before converting their values. An invalid URL in an earlier field no longer outranks a later null attachment's type-selection failure. This is the confirmed before/after difference. Both failures omit the mention in the public caller; a changed HTTP response or persisted outcome from this priority fix has **not** been demonstrated.

The existing HTML converter remains unchanged. [Design](../../specs/2026-11-11-remote-profile-design.md), [plan](../../plans/2026-11-11-remote-profile-195.md), [source corpus](remote-profile-observations.json), [source probe](remote-profile-source-probe.mjs) and [additive runtime receipt](remote-profile-runtime-evidence.json) keep independent expectations separate from actual product measurements.

## Independent source and finite consumers

The 68 observations execute literal methods and helpers from upstream `8e07cf085adf7009583d234a208e30436f020e26`: `MfmService.fromHtml`, `ApMfmService.htmlToMfm`, `ApPersonService.analyzeAttachments`, `validateActor`, `createPerson`, `updatePerson`, type/tag/normalization/truncation helpers, and the Profile description column declaration. Source bytes and method fingerprints are fixed. The source checkout's installed real node-html-parser 9.0.4 and stringz are used. There are no transformer doubles on these paths.

| Corpus area | Cases | Actual consumer |
| --- | ---: | --- |
| HTML formatting, ruby/fallback, code/pre, quote, entities, blocks, malformed markup, mention/rel/link forms and invalid URL | 20 | Real `htmlToMfm` unit calls |
| Actor create/refresh: summary precedence, empty/missing/type errors, 2048/2049 and Unicode, truncated/expanded HTML, single/array/NFKC tags, fields, attachment/summary/Profile failure | 42 | Real `createRemoteUsers().acquireActor`, `insertActor` and `createActorRefresher` unit calls; successful conversion and six conversion-failure cases additionally exercise real HTTP/PG |
| Array-only attachment input, missing/empty/invalid fields, first AP type | 5 | Real acquisition unit calls |
| Canonical duplicate Profile retention | 1 | Real public alias acquisition/PG |

All 68 source cases have explicit consumers; this is not 68 upstream HTTP cases. The new unit file runs 69 tests: 67 source cases plus two priority regressions with resolvable following/followers URLs and separately recorded outbound requests. Its database Meta and outbound responses are external-material doubles; validation/conversion/acquisition/write orchestration are real. Unit write ports record operations and inject failures; they do not establish transaction rollback. The integration file binds existing Profile-save failure tests to source create/refresh traces and adds 37 tests to the historical 63.

The source-method harness reuses the existing extraction pattern and bounded create/update dependencies. Repositories record attempted writes; transaction callbacks record begin/commit/rollback. Resolver, fixed time/IDs, empty emoji acquisition, images, featured, cache, charts, global events and disabled instance effects are declared doubles. Source traces therefore establish conversion and operation order, never PostgreSQL constraints/defaults/rollback or a full upstream server.

## Actual measurements

The coordinator's frozen revision 3 receipt verifies 311 source/test/dependency/oracle inputs before and after every command, including 226 product source files. No input changed during revision 3. Revision 1 also passed; revision 2 stopped before execution after a fixture hash mismatch and is preserved as a failed attempt. Runtime Node 24.20.0, pnpm 12.9.1; dedicated PG 55510, Redis 56410 and Meili 57810. The receipt records original artifacts, timestamps, hashes and exact commands.

| Check | Actual result |
| --- | --- |
| `pnpm --filter backend-next... build` | PASS |
| `pnpm --filter backend-next... typecheck` | PASS |
| Focused unit: remote-profile, remote-emojis, remote-actor | 195 passed / 3 files, 0 failed/skipped |
| Real token HTTP/fake remote HTTP/PG: remote-user | 100 passed / 1 file, 0 failed/skipped |
| Fixed Git-object source probe `--check` | 68 cases PASS |
| Local byte-verified source fallback `--check` | 68 cases PASS |
| Scoped package `eslint --quiet`, `git diff --check` before freeze | PASS |
| Parent Node 26.4.0 root contract glob | 176 passed, 0 failed/skipped |
| Parent shipping: quiet lint / SPDX / locale safety / diff check | PASS |

The integration run retains the baseline pg concurrent-query deprecation warning. Full-unit and process suites were not rerun: the product change is one attachment acquisition expression and changes no lifecycle/shared runtime contract. Historical process runs remain historical.

TDD RED rejected both create and refresh with `Invalid URL`, contradicting the later-null type-selection expectation. The minimal two-phase fix made both pass. The first local integration attempt stopped before tests with socket EPERM and was handed to the parent broker without retries. Parent preflight then recorded 96 passed / 4 failed; those four test expectations incorrectly equated conversion success with database write success. Those artifacts and their failed status remain in the additive receipt; they are not relabeled PASS.

### Conversion versus storage boundary

Truncation happens **before** HTML conversion and no extra post-conversion limit is applied. Two representative inputs produce 2049 and 2401 characters from source conversion. The pinned Profile `varchar(2048)` declaration is independently observed; the source repository double does not enforce it. Actual new-implementation PG rejects these oversized writes: create rolls back the actor, while refresh retains the earlier User update and the previous Profile. This tests the source conversion plus current real storage boundary; it is not an upstream real-PG measurement.

The HTTP failure tests also cover attachment selection/conversion before actor writes, refresh attempt timestamp persistence and Profile/Key/Following retention; summary failure rolls back create, while refresh retains earlier User/Key commits and leaves Profile/Following untouched. Canonical duplicate acquisition retains the existing Profile. Public Note text survives and failed mentions are omitted. Source and actual DB evidence remain separate.

## Reproduction and remaining work

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/remote-profile-source-probe.mjs --check
UPSTREAM_SOURCE_MODE=verified-files UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/remote-profile-source-probe.mjs --check
node --test scripts/remote-profile-contract.test.mjs
```

CI's existing `scripts/*-contract*.test.mjs` glob discovers the new root contract automatically. It checks the reviewed finite corpus/source fingerprints, source storage/failure boundaries, actual consumer hashes, measured runs and predecessor identity chain. Earlier corpora/receipts are byte-preserved; a new measured identity hop follows local actor tags without repinning old measurements. Parent root-wide contracts (176), shipping and diff check passed in their historical revision 1 receipt on Node 26.4.0; final checks after this fix remain parent-owned. The final immutable inventory pin remains coordinator-owned and waits for the implementation commit.

This is bounded real remote-profile conversion comparison, not a rich-parser rewrite or completion of remote actor functionality. Images/Drive (#188/#195, S5), featured/remote Note/other actor/object callers and inbox (#195), Move (#199), other instance paths (#215), charts (#200, S3), and cache/events/freshness (#217, S3) remain. `notes/create:partial`, `postingComplete:false` and #176/#127/#195 unfinished are preserved. Formal order remains shared root → #176 → inbox core; no other owner's work is implemented here.
