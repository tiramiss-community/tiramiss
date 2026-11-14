# Finite posting proof reconciliation — #272 (2026-11-14)

The [current index](posting-proof-272.json) reconciles exactly **62 contract / 59 audit IDs** assigned to `176-posting-proof` in [the catalogue](../../../../backend-next/backlog.json). Each ID has its own named posting subcontract, upstream source, unchanged inventory kind/status and (where assigned) historical audit A/B classification. Subcontracts reference shared `evidenceBindings` containing current consumer/declaration, finite fixture keys/parameters, assertion projection, provenance, source hash, execution reference and limits. An explicit `reviewed-but-unproved` disposition reconciles an obligation without certifying it.

This meets #272's finite evidence-index acceptance: response, authorization, saved deltas, post-save start, deletion failure and ordinary retry are traced to existing assertions. It supplies a reviewable basis for closing **only #272** after parent integration. No issue state was changed. **#176/#127 remain OPEN, `notes/create:partial`, `postingComplete:false`.** D7 remains **64 depth / 256 Notes**. Approved PG notification persistence remains an intentional storage difference. Strong Create/Delete ordering remains deferred. Whole-service parity is not inferred.

## Current coverage

Binding names below resolve to exact declaration titles, finite input IDs, hashes and measurements in the JSON. `create` consumes 42 named inputs; `n3` consumes 102 named relation/extraction cases. The lifecycle file proves only the two counter histories, not delivery/stream/retry.

| Contract | Shared bindings and asserted projection | Provenance / boundary |
| --- | --- | --- |
| C1 | `create`, `plain-show`, `user-count`: HTTP/Note/Poll/immediate show and complete before/create/delete count object | Recorded upstream HTTP/DB versus current runtime |
| C2 | `create`, `read-auth`, `moved-delete`, `rate`: credential precedence and whole rate Note DB delta | Four existing C2/C10 direct comparisons are supplemented, not unresolved |
| C3 | `create`, `n3`: validation, CW/file precedence and saved deltas | Finite local create inputs; Drive upload not claimed |
| C4 | `create`, `correction`: public→home in HTTP/storage and corrected AP audiences | **Mixed** original HTTP/storage + source-method `home-plain` + new-runtime delivery; no new corrected-operation upstream full-server comparison |
| C5 | `show`, `detail`, `show-errors`, `show-time`, `batch`, `d7`, `d7-http` | Full fixed JSON plus source-derived runtime graph/budget assertions; bounded `notes/show:verified` only |
| C6 | `create`, `n3`, `count`: reference correction, reply/quote/pure Renote and counters | Recipient arrays in `N3-MN-visible-order` are sets |
| C7 | `create`, `n3`, `reject`, `poll`: saved Poll fields, vote projection and insert rollback | Relative expiry bounded by request time; rollback does not recover never-enqueued work |
| C8 | `create`, `n3`, `channel-count`: channel/extraction/specified and historical `(3,2)→(3,2)→(4,3)` | Retained historical counter behavior, not repaired counters |
| C9 | `delivery`, `render`: Create/Announce, destinations, RSA/Digest and accepted-relay LD signatures | Actual HTTP/worker process; file/hashtag/mention/poll/emoji cases additionally consume source-method fixtures |
| C10 | `delete-http`, `delete-audit`, `stream`, `delete-ap`, `cascade`, `delete-fail`, `concerned`, `select-fail`, `delete-drain` | Direct response/audit/stream/Delete/Undo/fallback/F8 plus physical deletion, failure ordering and drain assertions |

`N3-HE-nfkc-expanding` separately asserts `QueryFailedError`/`22001` before excluding dynamic internal error details. Prohibited words examine CW + untrimmed text followed by newline-separated poll choices (`keyword-content`, `keyword-scope`). Sensitive words instead examine `cw ?? text` and ignore poll choices; `keyword-matching` separately asserts AND/RE2/invalid-expression behavior. MFM extraction is distinct from HTML rendering. Hashtag `hiddenTags` filters ranking, not generic create rejection; `hashtag-source` binds the actual source DB/Redis producer projections alongside the inline filter assertions. Activity mention order is normalized as a set where documented; digest equality is conditional on exact activity bytes.

| Failure contract | Existing proof | Retained limitation |
| --- | --- | --- |
| F1 | `reject`: Note/Poll transaction rollback | No commit→queue loss-zero recovery |
| F2 | `restart`: already-enqueued identity/options/due scores across stop/restart | No never-enqueued recovery or Redis reconstruction |
| F3 | `reject`, `delete-http`, C10 failure bindings | No new cross-operation locking; DELETE rejection is not atomic rollback |
| F4 | `restart`, `terminal`: natural AP503/webhook429 retries, terminal404 classification | No stronger Create/Delete ordering or unknown-send cancellation |
| F5 | `restart`, `channel-count`: delayed effects and retained history | No purge/replay/exactly-once reconstruction |
| F6 | `terminal`, historical `handoff` | Handoff was not rerun in the fresh selection; no capacity admission |
| F7 | `cleanup`: finite frozen-Supervisor cleanup and ordinary lifecycle | No claim/lease/fencing guarantee |
| F8 | `delete-ap`: nonpublic late-follower/relay destinations and signatures | No fixed-recipient strengthening; public restart alone does not establish F8 |

`deliver-queue` uses `promote()`; that proves classification/payload retention, not natural elapsed backoff. The real Supervisor assertion waits the ordinary 60–72 seconds. Creation direct-author lookup failure starts neither followers nor relay; deletion starts independent followers/direct/relay branches despite one rejection. An overlapping follower/direct inbox is not globally deduplicated across deletion branches.

## Explicit residual subcontracts

All 62 rows are individually scoped in `assignments`; the following are especially easy to overclaim from shared profile membership.

| ID | Proven slice or source finding | Unproved remainder / existing owner |
| --- | --- | --- |
| `responsibility:packers:04` | Pure Renote classification through saved inputs/activities | Appearance-ID aggregation — #176/#322 |
| `responsibility:packers:07` | Invalid saved remote reaction emoji host omission | General valid remote reaction emoji resolution/callers — #176/#322 |
| `responsibility:packers:08` | Title composition exists at `packages/backend-next/src/modules/note/render-note.ts:63` | No title-bearing assertion identified — #176/#322 |
| `responsibility:packers:10` | Graph recursion, cycle rejection, D7 budgets | Upstream DebounceLoader scheduling is distinct — #176/#322 |
| `responsibility:packers:13` | Actual channel summary fields | Pinned-note ordering — #176/#322 |
| `responsibility:misc-utils:06` | Notification author-host filtering is a different consumer | Packed-note root/reply/renote muted-instance checks — #176/#277 |
| `responsibility:misc-utils:31` | Frontier batching has bounded SQL assertions | Same-key Promise reuse/deferred same-tick loader contract — #176/#322 |

These residuals are not new product work in #272. Existing broader effects remain with [#277](https://github.com/tiramiss-community/tiramiss/issues/277); actor comparison remains with [#322](https://github.com/tiramiss-community/tiramiss/issues/322) and existing #188/#195/#200/#215/#217 dependencies. Current actor slice records in [the remote-user entrypoint](../../remote-user/README.md) supersede only their proven parts; historical six-gap records stay intact and do not erase the five remaining actor gaps. No baseline `not_implemented` status is promoted by newer scoped runtime evidence.

The index lists all **17** [deletion source cases](../delete-integration/README.md). Only `success` and `db-delete-reject` have the ordinary deletion process's direct six-state projections plus stream/activity types. The other 15 are explicitly source-method-only in this reconciliation, even where a separate narrower runtime assertion exists. The harness uses repository/renderer/producer/scheduler doubles; its delayed successful cases are non-poll inputs with successful packer doubles. It does not prove full upstream HTTP/PG parity, real cascade behavior or successful rendering after Poll deletion. Those properties require their separately named runtime assertions. The original-SELECT failure uses a selective repository spy, not a PostgreSQL server SELECT rejection.

## Source and execution identity

Runtime baseline is **`b4f28f6ceef458575f203c19d4ede37d7311468c`**, fixed upstream **`8e07cf085adf7009583d234a208e30436f020e26`**. No invented implementation head is used. `sourceInputs` records the inspected parent runtime manifest plus fixture/consumer inputs; membership establishes identity, not execution of every listed test. `upstreamSourceHashes` binds every assigned upstream source to the fixed Git object. Historical N7 consumers remain bound to **`f556283b8536592e77f0d76b046d0cb300fa70de`**; [coverage.json](coverage.json), observations, seals and receipts were not rewritten.

Parent validation actually ran on 2026-11-14 using Node **v26.4.0**, dedicated services recorded under `environment`. Source-only scouts did not run tests. The isolated writer inspected the actual logs and private receipt; raw logs remain private, with SHA-256 identifiers in `measurements`. The current runtime source matched the receipt, so documentation/index work does not require repeating all runtime tests.

| Parent run | Result |
| --- | --- |
| dependency-order build / typecheck / upstream sync check | exit 0 |
| `integration` | 216 passed / 7 files |
| `notifications` | 14 passed / 1 file |
| `process` | 20 passed / 4 files |
| `delete-process` | 2 passed / 1 file |
| `unit` | 726 passed / 23 files |
| pre-change root structural baseline | 93 passed; the log has no command header, so no exact command is reconstructed |

The first-line commands actually executed are preserved below (package cwd `packages/backend-next` for Vitest). Build/typecheck logs contain both dependency and consumer commands: `backend-upstream` ran `tsc -p tsconfig.json && tsc-alias -p tsconfig.json` and `tsc -p tsconfig.json --noEmit`; `backend-next` ran `tsc -p tsconfig.json` and `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`. Sync's recorded command was `node scripts/sync.mjs --check` in `packages/backend-upstream`.

```sh
vitest run --config vitest.integration.config.ts test/integration/note-create.test.ts test/integration/note-posting-lifecycle.test.ts test/integration/note-create-relations.test.ts test/integration/note-show.test.ts test/integration/note-delete.test.ts test/integration/deliver-queue.test.ts test/integration/user-webhook.test.ts
vitest run --config vitest.integration.config.ts test/integration/note-notifications.test.ts
vitest run --config vitest.process.config.ts test/processes/note-delete-integration.test.ts test/processes/note-deliver.test.ts test/processes/posting-websocket.test.ts test/processes/poll-ended.test.ts
vitest run --config vitest.process.config.ts test/processes/note-delete.test.ts
vitest run --config vitest.config.ts test/unit/note test/unit/federation/note-delivery.test.ts test/unit/federation/note-deletion.test.ts test/unit/job-queue/deliver.test.ts
```

## Reproduction and drift checking

Use Node 26.4.0 with full Git objects, and prepare **dedicated** services following [the package guide](../../../../../packages/backend-next/README.md#検証). From repo root the equivalent runtime selections use `pnpm --filter backend-next test:integration`, `test:process` or `test` followed by the same file arguments above; run dependency-backed selections serially. In particular retain **both** `note-notifications.test.ts` (C10 stream) and **`processes/note-delete.test.ts` (F8)**. They are not replaced by the lifecycle file.

```sh
node --check scripts/note-contract-posting-proof.test.mjs
node --test scripts/note-contract-posting-proof.test.mjs
node --test scripts/note-contract-*.test.mjs scripts/backend-contract-inventory.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base b4f28f6ceef458575f203c19d4ede37d7311468c
```

The new checker is an integrity/drift gate, not a replacement behavior suite. It checks assignment identity/count/classification, real fixture keys, current/historical declarations and source hashes, provenance/parameter bindings, residual scope, C/F coverage, original upstream source hashes and the inspected input manifest. Reviewed seals prevent an existing key or title being redirected to an unsupported claim. Updating a seal requires reviewing the associated assertions and provenance, not merely hashing changed text.

The writer first observed the absent-artifact failure, then added the index/checker and negative mutations. Writer-local validation and sandbox limitations are recorded in [the short implementation plan](../../../plans/2026-11-14-posting-proof-272.md). Parent runtime results above are independent of those structural checks. No production runtime code, dependency installation, new behavior tests, configuration or inventory classifications are part of this change.
