# Remote posting measurements (#195)

Measured core runtime: `33e67182e3dea5a39bd2b7c251ba9ee9ec4e0f45`; original branch base: `f556283b8536592e77f0d76b046d0cb300fa70de`; fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. These are actual executions in the parent worktree during the final repair wave; the runtime bytes are present at that commit. Refs #195, Refs #176, Refs #127: all remain incomplete. #242 merged and closed #124; its audit-time OPEN state in N7 remains historical.

## Provenance and actual gates

Paths under `/tmp` in this document and `runtime-evidence.json`, including the
case map and raw test logs/JSON, identify **nonpersistent local execution
artifacts**. They are not committed, uploaded or guaranteed to exist in another
environment or a later session. Their SHA256 values identify the original bytes
only while those bytes are available; the repository validator checks declared
bindings, not the existence or contents of those temporary artifacts. The durable
records are the commands, snapshots, assertions, counts and limitations committed
here. To obtain independently inspectable raw output, rerun the listed commands
at the stated snapshot and retain that new run's artifacts and provenance;
timings and raw artifact hashes may differ.

The unchanged [95 source-method cases](observations.json) have SHA256 `7427c62abb63c7a7414d9ad571450eb66bce15856ad0be9a5f4b02e1d554b8eb`. They execute extracted methods with explicit doubles. Two full pinned Git-object runs of `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --check` passed after the ephemeral RSA key-generation repair (`/tmp/tiramiss-next243-keygen-check1.log` and `check2.log`); the 15 source Node checks passed. Publication uses a fixed **public-only** SPKI input, while signing generates an ephemeral RSA key. No upstream full HTTP server was run.

[Compact runtime bindings](runtime-evidence.json) connect actual consumer declarations, selected case IDs, expected-value assertions and source digests to successful run IDs. The fresh parent map `/tmp/tiramiss-next243-finalfix-case-map.json` at `33e6718…` was checked against the actual passing assertion names in the unit JSON: all 95 distinct IDs have a passing consumer. Unit projections include injected conversion/HTTP/DB boundaries; **95 consumed unit cases do not mean 95 real HTTP comparisons**. The publication integration subset consumes 14 cases with identity/key expectations adjusted for real generated users and keys. Hashes and source/title binding detect drift; actual assertions, review and measured runs provide the proof.

Actual environment: Node **24.20.0**, pnpm **12.9.1**, within package engines; requested `.node-version` is **26.4.0**, unverified. Parent-owned dependencies used project `backend-next-remote243`, DB/Redis/Meili **55491/56391/57791**, random test databases and owned Redis prefixes. Every integration/process command below had prefix `BACKEND_NEXT_TEST_DB_PORT=55491 BACKEND_NEXT_TEST_REDIS_PORT=56391 BACKEND_NEXT_TEST_MEILI_PORT=57791`.

| Exact repo-root command (prefix as above where applicable) | Fresh outcome after the local URI parser repair | Raw execution artifact |
| --- | --- | --- |
| `pnpm --filter backend-next test test/unit/federation/remote-user.test.ts test/unit/federation/remote-actor.test.ts test/unit/federation/activity-fetch.test.ts test/unit/federation/local-actor.test.ts test/unit/note/create-note.test.ts --reporter=json --outputFile=/tmp/tiramiss-next243-finalfix-units.json` | PASS **254 / 5 files**, 0 failed/skipped | `/tmp/tiramiss-next243-finalfix-units.json` and `.log` |
| `pnpm --filter backend-next test:integration test/integration/remote-user.test.ts test/integration/activitypub-actor.test.ts` | PASS **61 / 2 files**, **13.71s** (remote-user 39, actor 22) | `/tmp/tiramiss-next243-finalfix-integration.log` |
| `pnpm --filter backend-next test:process test/processes/remote-mentions.test.ts` | PASS **3 / 1 file**, **7.31s** | `/tmp/tiramiss-next243-finalfix-process.log` |
| `pnpm --filter backend-next... build` | PASS; repaired runtime built before native process test | `/tmp/tiramiss-next243-finalfix-build.log` |
| `pnpm --filter backend-next... typecheck` | PASS production and test types | `/tmp/tiramiss-next243-finalfix-typecheck.log` |
| `node scripts/check-shipping.mjs --base 77b6c40562a406be6467e5f179fc48ea49562b2a` | PASS four runtime files' package-root quiet lint, SPDX **3225**, locale safety | `/tmp/tiramiss-next243-finalfix-shipping-phase1.log` |
| `git diff --check f556283b8536592e77f0d76b046d0cb300fa70de` | PASS full original-base diff including the repaired working tree; the earlier blank EOF line was removed | `/tmp/tiramiss-next243-finalfix-diff-green.log` |

These are separate runs, without adding overlapping counts. The prior **243 closest units / 57 integration / 3 process** run belongs to `e133a0fdebf0cfd538a07f264a4de1050486cb23` after the first three P2 repairs; its artifacts remain `/tmp/tiramiss-next243-reviewfix1-{units.json,integration.log,process.log}`. The **2693 / 74-file** full-unit result at `77b6c40562a406be6467e5f179fc48ea49562b2a` predates the local URI parser fix and is reference evidence only. The broader 2687-unit/74-file result belongs to pre-fix `1887cb1e09303270fb0834f0d5ec36953b941ab2`; earlier integration115/4 files and processes8/2 files also predate the first three repairs. The legacy-delivery5 PASS belongs to that earlier process aggregate, not a fresh eight after repair. Child EPERM/skipped/uv-interface failures are blocked or failed measurements, never counted as PASS. Successful DB/process logs retain a pg concurrent-query deprecation warning.

The previous scoped `/tmp/tiramiss-next243-runtime-rereview1.md` reports Task2 Spec PASS / Quality APPROVE at e133a0f; it does not approve the later parser change. Whole-branch review at `77b6c40562a406be6467e5f179fc48ea49562b2a` found local-user URI parsing and EOF whitespace issues and reported **WITH FIXES**, not approval. CodeRabbit at that same snapshot reported zero findings over58 files, before this repair. Post-fix independent re-review and CodeRabbit difference confirmation are parent-owned and are not yet recorded here.

The unchanged95 source cases explicitly double local parsing. The final repair adds **11 composition parser cases and4 real-DB self-link cases**, separate from those95 observations. Literal expectations follow pinned `ApDbResolverService.parseUri:64–80` and `getUserFromApId:105–120`: `/users/<id>`, `/users/<id>/` and `/users/<id>/inbox` resolve the same first user ID, while suffixes are ignored for that lookup. Deleted targets remain omitted; other families, missing/empty IDs and foreign/near-match/port hosts do not resolve another user. These additions do not expand the95-case dataset or claim full local object acquisition.

## What the fresh tests establish

- Actual posting caller resolves each occurrence before successful-ID deduplication, handles self/IDN/cross-host WebFinger, inclusive 24h freshness, retains timestamp/URI writes on failed refresh and omits the failed occurrence. A later lookup can use the newly fresh row. Authorization/noExtract avoid acquisition. Real DB checks preserve input, actor creation rollback, canonical-URI races, Note/Poll failure boundaries and Following direction.
- Actor validation and core User/Profile/Publickey plans preserve supported scalar/default/optional-key branches. Refresh uses ordered independent writes: User, supplied existing-key UPDATE, Profile, Following. Failures retain earlier commits; missing key refresh never becomes insertion. Deleted local resolution is rejected without changing the source's deleted-row publication projection. Malformed supplied AP IDs reject before actor writes. Malformed description/followed-message conversion fails after the source-visible User/Key boundary; actor creation rolls back through its caller transaction.
- Actual transport tests distinguish signed 10MiB and unsigned 256KiB streaming caps, real 5000ms cancellation, context/type/identity/redirect checks, one same-host absolute HTML alternate and swallowed alternate failure. Native HTTP/worker processes acquire cold system/author PEM through actual endpoints, verify signed GET/POST and digest, persist mentions, and deliver to the refreshed Following sharedInbox. Disconnect/SIGTERM drains accepted work through restart; the shutdown deadline terminates blocked work without inventing retry promotion.

## Acquisition destination guards after review 5817026033

The source-pinned measurements above describe the original core snapshot. The
following guards are intentional changes from that source, proposed in this PR
after [review 5817026033](https://github.com/tiramiss-community/tiramiss/pull/243#pullrequestreview-5817026033);
the unchanged 95 observations do not establish parity for these new refusals.

- Signed HTML acquisition refuses an HTTP alternate when the original URL is
  HTTPS, before fetching that alternate. The original HTML is then validated
  through the existing fallback. Permitted same-host alternates remain supported.
- WebFinger and AP acquisition check the current federation policy before the
  initial outgoing request and every followed redirect. A denied destination
  receives no request, rather than relying on final object identity validation.
  Each `send` reads one policy snapshot and uses it throughout that redirect
  chain; this is not a promise of observing a policy change during an active chain.
- This transport check compares normalized DNS hostnames, including the configured
  local hostname, separately from ports. It removes a terminal DNS root dot from
  the destination, local hostname and blocked/allowed list entries; list casing
  and suffix rules otherwise remain unchanged. Existing source-compatible DB/business
  host helpers remain unchanged. The narrow `OutboundSendOptions.validateUrl`
  callback runs in node-fetch's agent-selection hook before each network request;
  automatic redirect/header, timeout, response-size and status handling remain
  owned by the existing HTTP client.

When WebFinger or the Actor itself fails to resolve because of a refusal, the
existing per-occurrence posting failure path retains literal text and omits that
failed mention. Policy-guard refusals during collection acquisition have a different
outcome: `collectionVisibility` catches them, using `private` on creation and retaining the previous visibility
on refresh (an own `undefined` patch). Actor acquisition can therefore continue
and the mention can still be saved. Existing refresh-attempt writes precede
acquisition and are not rolled back by a guard failure. There is
no new setting, retry, queue or capacity policy. The new
`test/unit/federation/acquisition-policy.test.ts` uses actual composition and
HTTP/proxy redirects with a supplied Meta repository; protocol-pair alternate
checks use real signing with an injected HTTP boundary, not a measured TLS peer.

Follow-up review 5817115107 also aligns the Actor-entry allowlist check with the
same terminal-dot policy normalization used by sending. AP self-routing and local
user URI lookup compare normalized URL authorities including nondefault ports,
so different ported hosts cannot alias through an empty DB-host projection. These
are AP-boundary changes; the existing DB host projection and general host helpers
remain unchanged. The source observations do not establish parity for this
ported self-routing correction.

## Mention-resolution concurrency

There is no shared concurrency or waiting-count limit for mention resolution.
`create-note.ts` starts every extracted occurrence through `Promise.all`, catches
each resolution failure separately and deduplicates successful user IDs afterward.
This follows pinned `NoteCreateService.extractMentionedUsers` (lines 1051–1066).
The successful-mention limit is checked later, after reply/specified-recipient
augmentation; failed resolutions do not count toward it. Consequently many
distinct unresolved mentions, including across posts, can cause concurrent HTTP
and database work. Shared outbound agents, per-request limits and posting rate
limits do not establish a process-wide concurrency or waiting-count bound. No
load benchmark or bounded-resource guarantee was measured for this slice.

Review [5816986990](https://github.com/tiramiss-community/tiramiss/pull/243#pullrequestreview-5816986990)
proposes a shared bounded resolver that omits overflow occurrences. That policy
is not adopted here: a queue-full rejection would omit an otherwise resolvable
mention based on other posts' load, changing the source's saved recipients and
potential delivery. Serializing work can also change the observed freshness,
write and independent duplicate-occurrence outcomes. The existing catch handles
actual resolution failures; it is not evidence that new admission rejections
are source-compatible. Under GOALS' source-equivalent initial scope and this
plan's exclusion of capacity work, resource admission is a separate policy
decision, requiring explicit limits, sharing scope, overload behavior and
compatibility validation. The concurrency/load concern remains unmitigated;
this disposition does not claim it is impossible or already controlled.

## Actor effects and remaining initial scope

| Effect | Concrete current state | Remaining compatibility gap / owner |
| --- | --- | --- |
| Core User/Profile/Publickey, Following | Implemented and measured via `remote-actor.ts`, `platform/database/remote-users.ts` and the fresh unit/DB/process files | Full actor effects below remain #195; core success is a bounded projection |
| Media/avatar/banner and custom emoji | Drive/emoji acquisition remains unresolved. New actor creation initializes absent media; refresh preserves unsupported supplied media and clears explicitly absent images. Remote emoji acquisition is absent (`emojis: []`) | Actual acquisition, persistence and full image/emoji behavior **unresolved #188/#195**; this can affect mention/profile output |
| Attached user hashtags | Scalar User tag extraction and summary hashtag conversion exist; note hashtag producer remains the existing concrete #174 implementation | User↔hashtag attached/detached relationships and counters **unresolved #195**; note hashtag success does not prove these effects |
| Instance usersCount / metadata | Existing instance registry and posting notesCount are concrete #215/#174 paths | Actor-driven usersCount and metadata **unresolved #215**; no actor-path count parity claim |
| Charts | Existing producer ownership retained | Actor/user/instance chart side effects **unresolved #200** |
| Featured, Move, full actor publication | Scalar featured URI / movedTo / movedAt and minimal Person/Service/Application public-key projection exist | Featured Note acquisition, Move effects, rich actor fields/collections/outbox/inbox, remote Notes and general acquisition **unresolved #195** |
| Cache / remoteUserUpdated | Existing process-event/cache responsibilities retained; actor core refresh has concrete DB writes | Cross-process actor cache invalidation and `InternalEvent.remoteUserUpdated` publication/consumption **unresolved #217** |
| HTML/MFM | Real HTML parser conversion measured for the supported formatting/link/mention/paragraph subset | Full rich HTML/MFM behavior remains #195, not implied by tagged source conversion doubles |

None of these missing initial features is an accepted blanket difference or a deferred enhancement. General inbox/remote Notes/collections/WebFinger publication/relay management remain #195. Seven missing queue handlers, nine system schedulers and cutover retain the owners in [N7](../note/n7/README.md) and [posting contract](../../../backend-next/posting-contract.md). Qualified N7 C2 whole rate DB-delta and C10 audit/stream comparison gaps remain #176. `notes/create` stays **partial**, `postingComplete` stays **false**, and GOALS' full initial scope remains unchanged.


## #253 consumer remeasurement (2026-11-09)

PR #256 expanded the render-settlement characterization in `test/unit/note/create-note.test.ts`. The source identity used by the mentions and canonical-URI duplicate consumers therefore changed, while those assertions and source case IDs remained unchanged. The root contract suite detected this second stale identity after the C2/C10 comparison renewal.

The five frozen unit files were rerun at execution HEAD `c952ec7a5d8fa0adfc8f939eaf5c0b94bbd6d423`, with only comparison records dirty. Command:

```sh
pnpm --filter backend-next test test/unit/federation/remote-user.test.ts test/unit/federation/remote-actor.test.ts test/unit/federation/activity-fetch.test.ts test/unit/federation/local-actor.test.ts test/unit/note/create-note.test.ts --reporter=json --outputFile=/tmp/tiramiss-256-review/remote-units.json
```

Observed **257 passed / 5 files**, 0 failed and 0 skipped, 2.02 seconds, finished `2026-11-09T06:53:20.268825+00:00`, Node 26.4.0 / pnpm 12.9.1. Consumer digests were identical before and after the run; the JSON artifact SHA256 is `4a94d88d69d3d953270950106a5d91b7eba4f2091178e2492beaab13facffbdb`. The three extra cases relative to the original 254 come from the expanded render-settlement matrix.

`runtime-evidence.json` preserves the original 254-unit, integration and process records and their environment. Its new `closest-units-foundation-253` receipt records the current execution commit, Node environment, five source digests and result separately; only the two consumers in the changed Note unit file point to it. `implementationCommit` remains the historical remote-core pin, while `executionCommit` identifies the actual current run. The validator checks this additional receipt and rejects missing, failed or unmeasured renewed evidence. This adds no source cases, upstream HTTP comparisons or completion claims; the 95-case dataset, remaining ownership and core-only scope stay unchanged. Temporary artifacts have the same nonpersistent status described above.

## Public actor user hashtags (2026-11-10)

The public `notes/create` remote-mention path now performs the attached hashtag effect for actor create, canonical duplicate and stale refresh. A fresh canonical URI snapshot after WebFinger supplies the old tags; Profile success starts refresh work before Following. Create commit and duplicate fallback start it independently of later Note success. Duplicate canonical User.tags remains unchanged while its attached membership uses the fetched actor tags.

New tags are added in order, then missing old raw tags are removed, with normalization per operation and no normalized deduplication. DB writes are atomic per membership; mentioned columns and empty rows survive. Each operation launches existing positive ranking independently, including removal. DB failure stops subsequent tags while started ranking remains; settings/Redis failure cannot gate the DB sequence. The runtime diagnoses failures and drains all started work before freeing DB/Redis.

Evidence is additive in [user-hashtags-runtime-evidence.json](user-hashtags-runtime-evidence.json); execution HEAD/base is `cb1feb3e713c00c992f0d5ad2705edc24b439d33` with the recorded dirty source hashes. Runtime Node24.20.0 / pnpm12.9.1 was measured; Node26 runtime compatibility is not claimed. Fixed upstream remains `8e07cf085adf7009583d234a208e30436f020e26`.

| Actual execution | Result | Evidence boundary |
| --- | --- | --- |
| New source-method probe/check | 10 cases PASS | Pinned actor methods with explicit repository/transport/hashtag doubles; caller settlement with held Promise, no full HTTP/DB claim |
| Scoped units | 310 / 7 files PASS | Original source95 consumers, new source10 boundaries, profile5 operations and tracker failure/drain tests |
| Real PG/Redis integration | 101 / 4 files PASS | Remote caller43, actor HTTP22, hashtag28, Note assembly8; includes unchanged profile5 DB/Redis expectations |
| Native process | 4 / 1 file PASS | Existing3 plus pending attached DB operation after actor and posting HTTP have settled; SIGTERM waits for the held PG lock, release persists attachment and permits clean exit |
| Full unit suite | 2,855 / 87 files PASS | Final parent broker run after adapting the HTTP app test runtime fixture |

Exact commands, JSON artifact digests, consumer/product hashes and broker receipt digest are in the additive record. Final artifacts are `/tmp/tiramiss-s1-next-current-remote-units-r7.json`, `/tmp/tiramiss-s1-next-current-integration-r7.json`, `/tmp/tiramiss-s1-next-current-process-r7.json`, `/tmp/tiramiss-s1-next-full-unit-r7.json`; the broker verified frozen file hashes before and after execution. Temporary files have the same nonpersistent status as older measurements.

Before product edits, the actual refresher test failed because `hashtags` was missing between Profile/Following (58 passed / 1 failed), and actual posting caller tests failed on duplicate launch and missing URI-entry read (127 passed / 2 failed). The first broker integration attempt then had 96 passed / 5 failed: profile score expectations used a fixture clock but the constructed runtime had captured the original Date.now. A built-ranking diagnostic reproduced the clock-key mismatch; supplying the existing ranking clock dependency explicitly fixed the harness without changing product code or oracle data. The first full unit run had 2,852 passed / 3 failed because an untyped HTTP app fixture omitted the new required port; its fixture was adapted, focused3 and final full2,855 passed. All earlier failures remain recorded, not relabeled PASS. The existing pg concurrent-query deprecation warning matches baseline.

This evidence fulfills only the **public remote actor user-hashtag gap** in the older table. That table, source95, original receipts and N7's six-gap baseline are retained; the new receipt explicitly supersedes this one gap. Media/emoji #188/#195, actor instance usersCount/metadata #215, charts #200, featured/Move/full actor #195 and cache/remoteUserUpdated #217 remain unresolved. Local profile API, general inbox/remote Notes/collections and full upstream HTTP comparisons are not added. `notes/create:partial`, `postingComplete:false`, #176/#127/#195 incomplete and GOALS remain unchanged.
