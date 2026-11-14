# Remote-user fixed-source comparison and runtime evidence (#195)

These are **source-method observations**, pinned to upstream
`8e07cf085adf7009583d234a208e30436f020e26`. The unchanged 95 expectations are consumed by the measured core runtime at
`33e67182e3dea5a39bd2b7c251ba9ee9ec4e0f45`; [measured results and remaining owners](runtime-results.md)
and [compact consumer bindings](runtime-evidence.json) record that separate evidence.
The local URI parser repair adds 11 literal composition and 4 real-DB regressions backed by pinned ApDbResolverService parsing; these supplement the 95 observations and are documented in runtime results.
No upstream full HTTP server was measured. `notes/create` remains partial; #195/#176/#127 remain incomplete.
No product dependencies are required for the default validator:

```sh
node scripts/remote-user-contract.test.mjs
node --test scripts/remote-user-contract.test.mjs
```

The direct invocation avoids Node's test-runner child spawn in restricted sandboxes.
`node --test --test-isolation=none scripts/remote-user-contract.test.mjs` is another option.

## Importing and comparing

`observations.json` is standalone: `schemaVersion`, `upstreamCommit`, `methods`
(literal-source SHA256 fingerprints), `bindings`, `doubles`, `exclusions`, and
`cases`. Each stable case ID has `area`, `input`, `expected`, `methods`,
`provenance` and individually declared `doubles`. Import this JSON directly;
do not import the regeneration script or rewrite expected values in a second oracle.

```js
import { readFileSync } from 'node:fs';
const fixtures = JSON.parse(readFileSync(
  new URL('../../../../../docs/superpowers/compatibility/remote-user/observations.json', import.meta.url),
  'utf8',
)); // Adjust relative depth to the consuming file.
const selected = fixtures.cases.filter(c => c.area === 'actor');
const profileCase = fixtures.cases.find(c => c.id === 'actor-create-profile-key');
const expectedUser = profileCase.expected.events.find(e => e.op === 'User.save').args;
const expectedProfile = profileCase.expected.events.find(e => e.op === 'Profile.save').args;
const expectedKey = profileCase.expected.events.find(e => e.op === 'Key.save').args;
```

Expected is an independent projection: `{result, events}` or `{error, events}`;
resolve cases also expose retained `state`. Events preserve observable order.
A failed write event means an **attempt**, not a successful commit. Transaction
begin/commit/rollback events describe control flow through a transaction double.
`User.save`, `Profile.save`, `Key.save` contain constructor arguments; `.update`
events contain `{query, patch}`. They do not invent entity/database defaults.
Refresh returns `'skip'` even after successful core updates; compare its patches.
Use a consumer adapter to project actual results/writes into these shapes.

`{"$undefined":true}` encodes an own property with value undefined, including
TypeORM patches that omit an update; a missing JSON key means no own property,
and `null` means explicit null. Decode recursively when comparing raw objects,
or encode the actual projection with this convention. Dates are ISO strings.
The tag object is reserved by this schema. Input patches use the same convention. Inputs are serialized before source execution
can mutate them; the foreign sharedInbox saved input is replayed against its output.

The actor profile case uses intentionally tagged conversion doubles
(`converted:` / `field:`). Compare converted fields with the same injected
boundary at unit level; real HTML conversion and real database outcomes need
separate integration assertions. Never persist those tags in product data.

Current consumers (Task3 checks current source hashes, actual fixture selections, expected-value assertion anchors and successful parent measurements):

| Area | Consumer files |
| --- | --- |
| resolve | `packages/backend-next/test/unit/federation/remote-user.test.ts`, `packages/backend-next/test/unit/note/create-note.test.ts` |
| actor | `packages/backend-next/test/unit/federation/remote-actor.test.ts`, `packages/backend-next/test/integration/remote-user.test.ts` |
| fetch | `packages/backend-next/test/unit/federation/activity-fetch.test.ts` |
| publication | `packages/backend-next/test/unit/federation/local-actor.test.ts`, `packages/backend-next/test/integration/activitypub-actor.test.ts` |

Keep IDs stable when adding consumers. An intentional source-pin or behavior
change requires review of affected cases and their consumers, not blind regeneration.
The validator checks integrity, boundary declarations, selected outcomes and write
order; `--check` provides the full optional source replay comparison.

## Regeneration

`scripts/remote-user-contract.test.mjs` intentionally seals the reviewed finite
`runtime-evidence.json` object with the `reviewed finite runtime binding drift`
assertion. JSON formatting whitespace is ignored by parsing and serialization;
object key order, array order and values remain part of this seal. When evidence
changes, first inspect the diff, verify the affected source/consumer hashes and
case selections, and rerun the affected measurements. Update their provenance and
results without attributing old runs to new code.

When replacing the measured implementation snapshot, confirm the new runtime
commit exists and matches the code actually measured. Update `implementationCommit`
and each measurement's commit in `runtime-evidence.json`, then update the
`implementationCommit` constant in `scripts/remote-user-contract.test.mjs` and
the `current runtime pin` assertion in `validateCurrent` in
`scripts/note-contract-posting.test.mjs` to that same verified commit. In the former
script, also reconcile the `measured environment` expectation and the
`closest-units` / `integration` / `process` passed-count and file-count table with
the actual new runs; retain zero-failure/zero-skip requirements and the individual
source, selection and assertion checks. Do not change fixed values merely to make
a test pass, or repin historical measurements that were not rerun.

Update N7's current `runtimeEvidence.remoteCore` implementation binding and any
affected current applicability references separately. Preserve its historical
source pin, historical measurements and sealed audit evidence; a new runtime
snapshot does not replace that independent historical verification. Review any
legitimate changes to N7's current bindings and their seals independently.
Only after these provenance and fixed-value checks, compute the candidate seal
from the repository root:

```sh
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { createHash } from "node:crypto"; const value = JSON.parse(readFileSync("docs/superpowers/compatibility/remote-user/runtime-evidence.json", "utf8")); console.log(createHash("sha256").update(JSON.stringify(value)).digest("hex"));'
```

Review that candidate and replace only the expected SHA256 in the named assertion;
keep its individual checks intact. If N7's separately sealed evidence changes,
review and update its bindings independently rather than bypassing a failing seal.
Run `node --test scripts/remote-user-contract.test.mjs scripts/note-contract-posting.test.mjs`
afterward. A new hash alone does not validate new evidence.

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --write
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --check
```

By default the script reads `git show <pin>:<path>`. It extracts literal method
parameters and bodies using TypeScript AST, transpiles them and executes them in
VM contexts with explicit boundaries. Helpers, including StatusError retryability, execute their pinned source too;
the signer executes the extracted ApRequestCreator class, including private methods.
The route handler/negotiation are extracted AST bodies. No handwritten resolver
or actor implementation supplies expected values.

If Node's Git spawn is denied, use the byte-verified checkout fallback:

```sh
UPSTREAM_SOURCE_MODE=verified-files UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --write
UPSTREAM_SOURCE_MODE=verified-files UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/source-probe.mjs --check
```

The fallback verifies Git blob hashes of **every read source file** against IDs
obtained from `git ls-tree -r 8e07cf085adf7009583d234a208e30436f020e26 packages/backend/src`.
It refuses changed/unpinned source bytes. Fingerprints and observations are the
same in either mode. The initial source worker used the fallback; the parent later
repeated full pinned Git-object `--check` twice successfully (see runtime results).

Regeneration explicitly resolves TypeScript from the upstream root's installed
node_modules, and node-html-parser, slacc, stringz, accepts and vary from that
checkout's backend installation. These are source-environment tools, never a
borrowed product dependency tree. No install, symlink or dependency-directory
modification is performed. slacc is initialized with one thread. Signing uses a
fresh RSA 2048-bit pair generated at execution time; no private key is embedded.
Only redacted signature headers and verification booleans enter observations.
The publication renderer separately receives the existing fixed public SPKI as
an injected input, preserving its six public-key projections byte for byte.
The dataset's historical `keys` boundary label stays stable; signing and renderer
inputs follow this split. SPKI export/signing/verification execute real code.
Observed environment: Node 24.20.0; repository `.node-version` requests 26.4.0.
This is not Node 26 verification.

## Scope and limits

Account cases cover local/self/IDN, first case-insensitive self link without MIME
filtering, cross-host new accounts, local self links, exact age boundaries,
pre-attempt timestamp/URI retention, missing self, WebFinger failure and invalid
repair. Mention occurrences independently resolve before ID deduplication; the
first identical occurrence fails while later occurrences and an alias succeed.
The 95 cases include creation/refresh HTTP 429 collection failures: creation
projects private visibility while refresh retains visibility with an own undefined
patch. Actor cases execute validation and core creation/refresh for all five actor
types, optional key writes, profile fields/defaults, truncation, collection error
asymmetry, URL asymmetry, foreign sharedInbox stripping, duplicate recovery,
deleted skip and partial write failures. Missing key refresh attempts an UPDATE,
never insertion. Attachment and collection decisions execute literal methods.

Fetch cases execute resolver, signed/unsigned transport methods, content-type
and identity validation: context, history, exact recursion boundary, fragments,
www normalization, downgrade, mismatch and one same-host absolute alternate.
Alternate fetch failures are swallowed by the source's HTML catch, then the
original HTML content type fails. Recorded timeout/size are transport arguments;
actual streaming caps and timer cancellation are not measured. Signer lazy
acquisition and repeated resolution use the same resolver session. Local-user
resolution executes the literal local switch with supplied facts/rendering.

Publication executes source Accept quality negotiation, route suspension filter,
Vary, federation/missing/remote policies, cache and content type, then the literal
renderer projected to consumed signer/identity fields. System Application,
bot Service, local Person and deleted local rows are covered. `addContext` is
an identity double: this fixture makes no claim about the context envelope.
HTML routes fall through; HTML site rendering is excluded.

UtilityService host/policy predicates are supplied URL-based doubles; these cases
do not establish the full transitive UtilityService contract. Logger output is discarded.
All DB/HTTP/clock/token/conversion/transitive actor boundaries are named in the
dataset. Media, emojis, hashtags, cache/events, instance metadata/counts, charts,
featured and Move are incomplete external dependencies with explicit doubles;
these are **not compatibility PASS results**. No real PostgreSQL defaults,
constraints, rollback, actor concurrency, upstream HTTP, DNS/SSRF, TLS, streaming
limits, queue delivery, rich actor publication or full MFM parsing is established.
[Runtime results](runtime-results.md) separately establish the supported unit projections,
real transport/DB and native posting-to-delivery slice. Their actor-effect table names
implemented paths, existing concrete ownership and unresolved initial compatibility scope.
All 95 unit cases are consumed; they are not 95 real HTTP cases. Hashes, titles and
source bindings detect drift, not semantic parity. #195/#176/#127 remain incomplete.

## Public actor user hashtags follow-up (2026-11-10)

The bounded public remote-mention caller now starts attached user hashtag work on actor create commit, canonical duplicate fallback and refresh Profile success. [Design](../../specs/2026-11-10-remote-user-hashtags-design.md), [plan](../../plans/2026-11-10-remote-user-hashtags-195.md) and [current measured results](runtime-results.md#public-actor-user-hashtags-2026-11-10) define this scope.

`user-hashtags-source-probe.mjs` / `user-hashtags-observations.json` are a **separate 10-case source-method corpus**, not edits to the historical 95 cases. It records actor-normalized duplicates, canonical old tags, URI-entry snapshot, deleted/failed writes and settlement while hashtag work is held. Reproduce it with:

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream UPSTREAM_SOURCE_MODE=verified-files node docs/superpowers/compatibility/remote-user/user-hashtags-source-probe.mjs --check
```

The existing five `profile` cases in `../note/hashtag/source-observations.json` remain unchanged. `packages/backend-next/test/unit/federation/user-hashtags.test.ts` consumes their operations; `packages/backend-next/test/integration/note-hashtags.test.ts` consumes their real attached rows and shared Redis outputs using the fixture's explicit clock. Actor boundary consumers are `packages/backend-next/test/unit/federation/remote-actor.test.ts` and `packages/backend-next/test/unit/note/create-note.test.ts`. Real public caller/failure coverage is in `packages/backend-next/test/integration/remote-user.test.ts`; native pending-hashtag DB shutdown coverage is in `packages/backend-next/test/processes/remote-mentions.test.ts`.

`user-hashtags-runtime-evidence.json` adds actual current measurements and renewed consumer identities. The original `runtime-evidence.json`, its source95 bindings/receipts and N7 six-gap capture remain historical evidence. This additive result supersedes **user-hashtags alone for the public caller**; the other five actor gaps and local profile API remain outside this slice. `notes/create` stays partial, `postingComplete:false`, and #195/#176/#127 stay incomplete. Source doubles are not full upstream HTTP evidence.

### Actor instance usersCount（2026-11-10）

[新しい独立source観測・実測と残責任](actor-instance-registration-results.md)を参照。元の95ケース・hashtag/profile corpusと過去の測定件数は保持し、現在のファイルidentityは新しい加算専用receiptへ投影する。五つのactor gapと投稿partialは維持する。

## Public actor emoji ingestion (#195)

[Independent source observations, actual runtime proof and remaining scope](remote-emojis-results.md) cover extraction/persistence on the existing public remote-mention create/canonical/refresh caller. Historical corpora/receipts remain unchanged; current identities are additive. Drive/local emoji publication/other callers/cache parity and the five broader actor groups remain incomplete. `notes/create` stays partial with `postingComplete:false`.

## Local actor emoji/hashtag publication (#195, 2026-11-11)

[Additive tag source and runtime results](local-actor-tags-results.md) cover existing actor GET and local acquireActor, with 12 new pinned-source method observations, a real PG/HTTP consumer and shared Note regressions. Earlier corpora/receipts remain immutable; the new [current bindings](local-actor-tags-runtime-evidence.json) extend their identity chain and do not turn historical process runs into current tag measurements. Direct DB reads retain the cache-freshness/cache-hit failure gap (#217). Full actor/media/inbox and #176/#127/#195 remain incomplete; notes/create stays partial.

## Public remote profile real HTML conversion (#195, 2026-11-11)

[Additive source/runtime results](remote-profile-results.md) compare 68 finite pinned-source observations using real HTML transformers with actual acquisition and public notes/create create/stale-refresh persistence. The confirmed product fix selects all attachments before mapping HTML, preserving source error priority. The converter itself is unchanged. Conversion can exceed the source Profile column limit; source trace and actual PG failure are explicitly distinguished. Earlier corpora and receipts remain unchanged; the new current identity hop follows local actor tags. This bounded comparison does not finish rich actor/featured/media/cache/inbox, #176/#127/#195, or posting; notes/create stays partial and postingComplete:false.

## Local WebFinger discovery (#195)

The ordinary HTTP app now exposes local WebFinger GET/HEAD/OPTIONS and connects its self link to existing actor GET. The historical R1 [bounded source/runtime results](local-webfinger-results.md) separate 49 pinned createServer/Fastify-inject cases from 46 new real HTTP/PG cases, 55 existing HTTP/actor regressions and 227 focused units, with immutable broker receipt/input hashes. Those 55 regressions were not rerun in R3; current R3 results are listed below. Whole-resource lowercase, permissive account parsing, exact JRD/XRD/CORS/cache behavior and source XML quirks are preserved. Stable Meta is compared; notification/cache freshness remains #217. host-meta/NodeInfo/authorize-follow handlers, collections, inbox and #176/#127/#195 completion remain outside this slice. Historical observations and raw measurement receipts are retained.

Historical R2 task-review follow-up: discovery exceptions used the console diagnostic path while preserving local500/CORS/no cache/no Vary and empty HEAD. The [R2 logging evidence](local-webfinger-logging-runtime-evidence.json) records231 units,46 real HTTP/PG WebFinger cases and49 source cases passing; the existing actor55 remains a separate R1 result. R1 artifacts are preserved, with two amended inputs explicitly superseded by R2. Expected injected-fault stacks and the baseline pg warning remain in raw output; see the appended [results clarification](local-webfinger-results.md#task-review-diagnostic-fix-r2-2026-11-11). The current R3 implementation instead uses `resources.logger` for stdout JSON, as described below.


Final format follow-up: [R3 structured logging evidence](local-webfinger-structured-logging-runtime-evidence.json) records build/typecheck,235 units,46 actual HTTP/PG WebFinger and49 unchanged source cases PASS. The adapter uses the existing resource Logger with a fixed error event and safe constant fields; six tests prove its default stdout JSON sink and two test ordinary composition. [R3 results](local-webfinger-results.md#final-diagnostic-format-fix-r3-2026-11-11) preserve the earlier console-error chronology and enumerate four changed R2 inputs. The exact [R2 current-record archive](local-webfinger-r2-current-evidence.json) is pinned history before current-record renewal; R1/R2 raw artifacts remain unchanged. Actor55 remains separate R1 history and all previously listed scope limits remain.

## Local actor stored fields (2026-11-13, limited #195 slice)

[Scope, actual host measurements and remaining responsibilities](local-actor-fields-results.md), [independent source observations](local-actor-fields-observations.json), and [finite current evidence](local-actor-fields-current-evidence.json) bind product `efd6b94ea9911fc6b9aeaad0edeea04da3932da1` to the 877-input parent PASS: selected units 283, real actor/remote-user HTTP/PG 177 and literal source 21. Existing HTTP and internal callers publish six stored facts plus featured URL; featured serving, Move, Drive/media, remote Notes, inbox and cache gaps remain. Source-method doubles are separate from upstream full-server evidence. Five gap groups, #176/#127/#195 OPEN, `notes/create:partial` and `postingComplete:false` remain. Historical results, totals and hashes above are retained.

## Local featured collection and linked AP Note GET (#195, 2026-11-13)

[Current bounded results](local-featured-results.md) and the [finite evidence record](local-featured-current-evidence.json) cover saved local pins → embedded Note documents → AP Note GET on the ordinary HTTP app, including one embedded reply level and distinct delivery/GET reply depth. The fixed 100-case oracle executes literal methods and actual Fastify inject with declared doubles; it is not full upstream HTTP/PG. Parent R3 measured 1,084 frozen inputs: upstream5, build/typecheck, selected units257, separate composition6, real DB/listening HTTP203, migration/schema6, source100 and shipping, with zero failed/skipped tests. R1 DB198/202 (four fixture Meta-default failures) remains a separate failed receipt.

This local publication does not ingest remote featured/Notes or implement the inbox object lock, Move or pin mutation (#180). HTML frontend (#196), generic global headers and Fastify diagnostic strings are outside the probe. Meta/cache freshness (#217) and saved mention order differences remain. All five actor gap groups, #176/#127/#195/#215 OPEN, notes/create:partial, postingComplete:false and the formal shared roots → #176 → inbox order remain. Earlier corpora, receipts and result documents retain their historical scope; the new result supersedes only this local publication boundary. Metadata host validation and final review/PR completion remain separate gates. The full source review found a Unicode P2; the scoped correction received spec PASS and quality APPROVE.


## Local followers/following collection reads (#195, current R4)

Runtime product **`10c0d76c3724cd4e52a0a17c24ed92accaa10f75`**; actual parent R4 **991 frozen inputs**, units**3735/3735**, integration**1319/1319** (collection324), acceptance**65/65**, source**318/318**, upstream5/sync/build/typecheck/shipping PASS, all9 exit0/no drift. Domain unit12 and collection source unit318 are measured per-file counts. Node26.4.0/pnpm12.9.1, 2026-11-13 **23:24:01.526576→23:27:00.670092 UTC**. [Fresh R4 record](local-follow-collections-review-current-evidence.json) binds request SHA256 `00e2f798beef4e0012ff360433f7c08a6f7761bbb801f4066a41db5c7041b353`, receipt `28ca271d4ae339e67ae36886896c28475294f3137beae15958f7abd1fb31e6fd`, full991 map `ca3f63e4b7b0f2871e725b996f94da4f9a9ed9e329e7c905ea87d96c8b8fb9c2`, canonical seal `0ce2723dc26193a14b6254bcd240e03a12c855b09108d7fca05f7f4a4bf0c824` and byte seal `09e17bdc0b6681fc73db0c7c17cf68d34b2ee598d132ac8bf189257791f1eeff`. Actual artifacts/commands/per-file counts are embedded; optional host files must match when present.

Business/public follow result now returns collection data; absent/private owners throw identifiable domain errors. HTTP adapter alone owns404/403/cache30/index180/uncached pages. Source318 outcomes, query/path rules, order/mandatory failures/URI/paging remain unchanged. Original R2 validator and55 frozen inputs live in the independently sealed compact static fixture, not test-time Git reads, so squash/rebase/branch deletion does not break historical validation. Old original validator bytes/map and fixture seals are verified.

Current finite measured subset is57 inputs: prior55 plus domain unit and history fixture. Exactly3 runtime paths changed from R3b (API/domain/public). R3→R4 public digest renewal has an explicit pointer to the unchanged R3 raw record; original featured predecessors and historical projection returns stay intact, and the other2 identities remain unchanged. All9 old records, including C355 R2 and df5f R3 path-current, remain byte-identical. The whole R3→R4 request-map delta is8 paths: runtime3, added domain unit/fixture2, added R3 raw history1, inventory context2. Later inventory/proof/docs edits are outside current-byte comparison of the full991 map, never falsely attributed to R4 runtime measurement.

R3b3723/1319/65/source318 and R2/R1/Node24/EPERM are history, not amended-code proof. The prior internal18-file scoped review was APPROVED and CLI16/14/12/11-file reviews reported0 findings on their earlier scopes. All4 CI checks at5acf07914f2c4225bf49ed382a45e47441cd58de were green (controller-provided history). The two later GitHub CodeRabbit findings are author-fixed; controller targeted review, inline replies, ordinary push and new-head [PR271 checks](https://github.com/tiramiss-community/tiramiss/pull/271/checks) remain pending. No new review or CI success is claimed. Worker near proof110/110, full root387/387, Git-free history4/4, inventory write/check and SPDX/locale/scope passed; exact logs are in the new evidence report. Parent native post-integration gates follow. Independent80/86 remains distinct from318 literal methods/Fastify doubles and product real PG/HTTP324. Full upstream server/PG, exact diagnostic/global hooks/Content-Length/Location and Meta/cache timing/failure/notification remain unproven. #176/#127/#195/#215 OPEN, notes/create:partial/postingComplete:false, five gaps/owners/formal order unchanged.

## Actor alias / public key #323（2026-11-14）

#323はPR #587でマージ済み・CLOSED。[43eの実測・再現と限界](local-actor-alias-key-results.md)を参照。保存済acct別名と公開鍵を通常HTTPへ接続し、source-method観測172と実HTTP/PG216を区別して記録する。

## Local outbox / activity #324（2026-11-14）

#324は `1e75c5b2b3be158fba8afb14a9c1c30809825127` で実装し、[PR #588](https://github.com/tiramiss-community/tiramiss/pull/588) でマージ待ち。次は#325。[契約・実測・再現と限界](local-outbox-activity-results.md): 親実測の単体2113/42 files、実HTTP/PG/Redis707/7 files（新outbox23）、literal source115、source-contract12。22入力の実バイトと6 raw logを検証し、6原文だけを#323より下で履歴投影する。旧JSON/receiptは保持。sourceの明示doubles/real Fastifyと実製品PG/Redisを区別する。親root検査491件・shipping成功、CodeRabbitの指摘1件は修正・再レビュー済み。CI状態はPRのchecksを参照。#176/#127/#195 OPEN、notes/create:partial・postingComplete:false・D7/PG通知保存/強い順序保留を維持する。

## #325 local Emoji object GET（2026-11-14）

上の#324段落は当時の引き継ぎ。#325はruntime `140acaf7d0283a76cc4de4a9f0227ae130a86ccd` で通常GET/HEAD `/emojis/:emoji` に接続した。[有限の契約・実測と残責任](local-emoji-object-results.md): 単体115/4 files、実HTTP/PG42/2 files（Emoji19）、literal source53、source-contract6、sync/build/typecheck/shippingがPASS。固定14入力・無drift・実log hashを保持し、既存outboxの過去入力へ新旧のroot2ファイルだけを投影する。旧receipt/sealは保持する。malformed HEADのinject本文差、stable Meta/Meta不在時の既存初期化、source-methodと実PGの境界を明記し、他caller・画像配信・管理・cache#217と親#195/#176/#127未完了、投稿partialを維持する。

## instance 管理更新・metadata 強制更新（#362）

通常管理 HTTP の停止/メモ更新・独立監査・cache、既存 metadata の force 取得を接続した。[限定比較・実測と境界](instance-admin-results.md)を参照する。#195/#176/#127 全体は未完了。
