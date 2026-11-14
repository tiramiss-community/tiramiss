# Local outbox / activity #324 — 2026-11-14

Implementation **`1e75c5b2b3be158fba8afb14a9c1c30809825127`**, base `5981cce83b9243bf22102b2f0ba1b866b1ed03da`; fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`. #323 is CLOSED after PR #587 merged. #324 implementation is complete; its PR has not been created. Next: #325. This report records parent-host measurements, without claiming worker execution, CI or CodeRabbit approval.

| Parent measurement at 1e75 (Node 26.4.0 / pnpm 12.9.1) | Result |
| --- | --- |
| Build / typecheck | both exit 0 |
| Federation/composition and outbox units | 2113 passed / 42 files |
| Listening HTTP / PostgreSQL / Redis plus nearby regressions | 707 passed / 7 files, including 23 new outbox cases |
| Literal upstream methods / real Fastify inject | 115 observations |
| Source contract checks | 12 passed, 0 failed/skipped/cancelled/todo |

The unchanged [actual receipt](local-outbox-current-evidence.json) records the exact commands, timestamps, 22 before/after input SHA256s and six `*-measured.log` paths/hashes. All 22 current input bytes and all six available raw logs were verified against it during metadata binding. The measurement window is 2026-11-14 11:59:03–11:59:45 UTC. Product tests were run by the parent on that revision, not rerun by the metadata worker.

## Behavior and comparison boundary

Local owner lookup retains suspended users and requires `host IS NULL`. The index uses stored `notesCount`, reads neither Notes nor Redis, and supplies first/zero-ID last links. A page validates cursor presence/multiplicity before lookup, uses exclusive boundaries and the nearest 20 newer rows for since, reverses output, normalizes navigation URLs and keeps both links on nonempty pages. Federation `none` wins before query/lookup after routing.

The DB path applies **only owner ID, public/home and `localOnly=false`**. It adds no host, suspension, blocked-host or visitor predicate. Fanout reads both complete Redis lists, filters boundaries, merges/deduplicates/sorts, hydrates with source joins and applies author/related suspension, blocked-host and visitor rules. Cached hydration has no owner-ID predicate or universal local-root restriction. Empty/insufficient-since coverage falls back with original boundaries; partial refill continues below the **last consumed** candidate, including rejected/deleted IDs. Fallback rows bypass cached-path filters. Redis rejection, command error and null payload fail without DB recovery; `exec() === null` produces empty candidates and ordinary fallback.

Standalone activity GET requires a local public/home, non-localOnly root. Create uses existing Note preparation with `dive=false`; pure Renote independently requires its local/remote target and yields Announce before mention/media/poll preparation. Missing pure targets fail; missing quotes remain tolerated. Outbox activities are bare inside the collection's context; standalone Create/Announce receives context at the activity root. Existing delivery fallback remains separate.

Matched GET/HEAD retains source CORS, negotiation, cache/Vary and failure precedence; HEAD executes work with an empty body. OPTIONS remains framework 404 without AP CORS, including 101-character parameters; GET/HEAD at 101 still return 414. The prior OPTIONS boundary defect and actual-DB fixture token length (16)/visibility reset defects were fixed before the final product measurement.

The repaired oracle has **22 manifest entries / 39 method digests**, unchanged from its extracted-source binding. The source-audit P2 contradictory joined facts were corrected by identity-keyed users/Notes and covered by the 12 contract tests. Earlier rejected 104-case observations are not final evidence. The product source consumer has **116 tests: 115 pinned cases plus fixture identity**. One VM-realm TypeError serializes as `{}` in the probe; the consumer separately expects product 500 error JSON while still comparing status, headers, reads and absence of fallback. Exact diagnostic-string parity is not established.

Source runs use real Fastify inject, extracted literal route/packer/collection/pagination/fanout/render methods and explicit Repository/QueryBuilder/Redis/user/file/poll/emoji doubles. They do not boot a full upstream server or upstream PG/Redis. ASCII double ordering does not establish PG collation; global server hooks, full security headers/HTML and Meta cache lifecycle remain outside this comparison. Actual new-backend HTTP/PG/Redis measurements are the separate 707-case run.

## Schema and replay

- [Corpus](local-outbox-activity-corpus.json): `{source, defaults, limits, datasets, cases}`. Cases carry finite route/query/entities/failure inputs; `buildFixture` resolves joins by identity and rejects contradictory facts.
- [Observations](local-outbox-activity-observations.json): `{source, dependencies, probeSha256, manifest, corpusSha256, limits, cases}`. Manifest entries are `{path, gitBlob, sha256, methods}`; case rows are `{id, expected:{status, headers, body, events, errors}}`. Empty bodies, JSON diagnostics and captured source errors remain distinct.
- [Receipt](local-outbox-current-evidence.json): `{runtimeRevision, baseRevision, upstreamRevision, startedAt, finishedAt, node, pnpm, inputs, inputsAfter, noInputDrift, runs}`. Each run carries name/command/exitCode/timestamps/log/logSha256, with measured passed/files, sourceCases or nodeTests where applicable. No synthetic suite results were added.

The probe requires the pinned Git objects plus installed harness/upstream dependencies recorded in observations. `PROBE_HARNESS` selects the directory containing the harness `package.json` (Fastify/TypeScript); `UPSTREAM_ROOT` selects the upstream checkout containing `packages/backend/package.json` and the fixed Git objects. Defaults and exact replay commands:

```sh
PROBE_HARNESS=/tmp/tiramiss-s1-r13-probe UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream \
  /tmp/tiramiss-s1-node26/bin/node docs/superpowers/compatibility/remote-user/local-outbox-activity-source-probe.mjs --check
/tmp/tiramiss-s1-node26/bin/node --test scripts/local-outbox-activity-contract.test.mjs
/tmp/tiramiss-s1-node26/bin/node --test scripts/local-outbox-evidence.test.mjs scripts/local-actor-alias-key-evidence.test.mjs
/tmp/tiramiss-s1-node26/bin/node scripts/backend-contract-inventory.mjs --check
```

Use `--write` instead of `--check` only when intentionally recapturing source observations, then review the resulting provenance/output changes. A sandbox unable to spawn test children can run the evidence tests with `--test-isolation=none`; Git-based checks still require parent-host replay.

## Historical binding and remaining work

The Node-builtin-only [readPreOutbox leaf](../../../../scripts/local-outbox-evidence.mjs) seals the original receipt and [six exact base strings](local-outbox-predecessor.json), verifies all 22 current inputs and available actual logs, then projects only those six paths. It composes beneath `readPreAliasKey`: **#324 → #323 → older readers**. #323 validates its original 43e current inputs even with an injected reader. Old JSON/corpora/seals/receipts remain byte-identical; no new universal manifest or Git-dependent product helper was introduced. #272 retains dated classifications and unchanged seals. The root run exposed the older N7 checker comparing its dated `activitypub:09` classification with live inventory; that one comparison now uses its existing `f556283b` historical reader. Its live `notes/create:partial` gate and all evidence JSON remain unchanged.

Inventory changes are exactly HTTP contracts `ActivityPubServerService.ts:690` and `:716`, and responsibilities `activitypub:08` / `:09` (the latter two audit rows), pinned to the actual 1e75 implementation tree. No backlog/parent classifications change. Subsequent parent checks passed all 491 canonical root tests, the direct inventory generator and shipping. CodeRabbit reviewed the 23 product files without findings; its one finding in the 15 metadata files was repaired and the three changed files were re-reviewed without findings. The metadata audit has no unresolved findings. These checks remain separate from the 1e75 product measurement.

#176/#127/#195 remain OPEN; `notes/create:partial`, `postingComplete:false`, D7 64-depth/256-Note, approved PG notification storage and deferred strong ordering/recovery guarantees remain unchanged. Inbox, remote Note ingestion and broader actor/cache/media responsibilities are not completed by #324.

[PR #588](https://github.com/tiramiss-community/tiramiss/pull/588) closes #324 on merge. Its checks tab records CI status.
