# Local actor stored fields: bounded results (#195, 2026-11-13)

Base: `6601944296f367e66fde8ecf3a2458c946ae2a6c` (PR #268 merged). Product/source pin: `efd6b94ea9911fc6b9aeaad0edeea04da3932da1`. Upstream: `8e07cf085adf7009583d234a208e30436f020e26`.

The existing public GET `/users/:id` and internal local actor acquisition now publish stored `isCat`, `_misskey_requireSigninToViewContents`, `_misskey_makeNotesFollowersOnlyBefore`, `_misskey_makeNotesHiddenBefore`, truthy `movedTo`, non-null `alsoKnownAs`, and the `featured` URL. Only the shared pure renderer and existing User reader changed in production. False, null/zero/positive/negative cutoffs, empty aliases, duplicate/raw URI order, empty movedTo omission and dotted-user Application precedence have source/unit/PG cases. See the [design](../../specs/2026-11-13-local-actor-fields-design.md) and [plan](../../plans/2026-11-13-local-actor-fields.md).

## Independent source and current runtime evidence

[Corpus](local-actor-fields-corpus.json), [literal-source probe](local-actor-fields-source-probe.mjs), and [observations](local-actor-fields-observations.json) preserve 21 cases: 16 serialized successes and 5 declared dependency rejections. The source is literal pinned `renderPerson`, with Git blob/full-file/method SHA256 and explicit profile/media/tag/key/MFM conversion doubles. These are source-method observations; upstream full HTTP/PG was not measured.

The [current evidence](local-actor-fields-current-evidence.json) embeds the actual parent PASS receipt, exact commands, request/receipt/log/artifact hashes, the canonical full 877-input-map hash, 14 relevant current input digests and 9 finite predecessor renewals. All 877 current bytes matched when Task2 began. The runner verified the map before and after each command. Host Node was v26.4.0, pnpm 12.9.1. The recorded overall window is `2026-11-13T06:37:28.083319+00:00` to `2026-11-13T06:38:00.307402+00:00`; the runner did not record per-command timestamps.

| Actual parent measurement | Result |
| --- | --- |
| `pnpm --filter backend-upstream sync:check` | PASS |
| `pnpm --filter backend-next... build` | PASS |
| `pnpm --filter backend-next... typecheck` | PASS |
| Selected actor/fields/profile/tags/images/API/WebFinger/composition/remote-user/package-import unit command in receipt | 283/283, 11 files; 0 failed, 0 skipped |
| `pnpm --filter backend-next test:integration test/integration/activitypub-actor.test.ts test/integration/remote-user.test.ts --reporter=default --reporter=json --outputFile=/tmp/tiramiss-s1-r11-validation-r1-actor-remote-integration.json` | 177/177, 2 files: actor 69 + remote-user 108; 0 failed, 0 skipped |
| `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-actor-fields-source-probe.mjs --check` | PASS, 21 literal cases |
| `node scripts/check-shipping.mjs --base 6601944296f367e66fde8ecf3a2458c946ae2a6c` | PASS: 11 changed package files quiet lint, SPDX, locale safety |

The 16 new actor PG cases seed existing User/Profile/Key columns and compare public HTTP plus the internal document passed to `validateActor`, retaining stored rows. No product tests were rerun for Task2 because their 877 inputs remain frozen. Logs contain expected injected failures and a pg query deprecation warning; successful totals do not imply absence of those diagnostics.

## Metadata validation and historical identities

The new [leaf validator](../../../../scripts/local-actor-fields-evidence.mjs) imports no predecessor helper. It accepts only each actual previously image-bound changed file's exact predecessor or measured current digest. Each predecessor equals both the immutable image record and the base Git bytes. The other 5 measured inputs (2 new test/helper files and 3 source artifacts) are evidence inputs, not fabricated predecessor renewals. Unknown predecessors are rejected; unrelated files pass through.

The current image/WebFinger and earlier emoji/tag/profile/removal comparisons carry injected reads to this leaf without recursive validation. Historical image identity projections and all earlier byte-pinned corpora, records, receipts and assertions remain intact. Optional host request/receipt/log/artifact bytes are checked when present; CI can validate the pinned record when those `/tmp` files are absent.

Task2 wrote rejection tests before the helper. Initial normal sandbox `node --test` reported one failed file without assertion details; direct invocation showed 27 RED cases (old image-byte mismatch, expected leaf rejection not reached, and absent new helper). The first GREEN attempt passed 26/27: a new test incorrectly assumed the WebFinger record contained the renderer. Its actual 14-file subset contains no changed field inputs, so the test was corrected to check its own bound bytes and the explicit WebFinger-to-fields hop separately. Final direct invocation passed 28/28, 0 skipped. Existing assertion files were not modified. The actual normal `node --test scripts/*.test.mjs` command exited 1: 14 files passed (including the new tests), while existing note-contract-posting/review files failed. Direct diagnostics identify `spawnSync git EPERM` and `spawnSync node EPERM`; neither existing assertions nor subprocess implementations were changed. Inventory `--write` and `--check` each exited 1 with `spawnSync git EPERM`, leaving generated files unchanged. Final local shipping and `git diff --check` passed. Normal root and generated inventory validation remain parent host gates; selected/direct tests do not substitute for them. This document claims no review/PR completion.

The parent subsequently ran the normal `node --test scripts/*.test.mjs`: **271/271 PASS, 0 failed/skipped**, including all 243 existing tests and 28 new tests. Inventory `--write`/`--check`, explicit inventory invariants, shipping and `git diff --check` also passed. The invariants verified all 1,432 audit and 2,119 contract identities/order/owners/statuses, exactly three partial row updates, unchanged old assertions and all 877 product inputs. This metadata run checked 1,063 frozen inputs before/after every command, allowing only the two generated inventory outputs to change. Its window was `2026-11-13T06:55:27.812174+00:00` to `2026-11-13T06:55:37.850715+00:00`. Host receipt: `/tmp/tiramiss-s1-r11-metadata-validation-receipt-r1.json`, SHA256 `a47d508fe530be65f4a81d770e67d79097b8c13d001bcefdc3f8b1007825e909`; request SHA256 `5d03e2e4a23695d7f96d91ad476d28392dec8c1d5bf183fde94a7c053a684e3e`. This paragraph and the plan's gate status were updated after that frozen metadata measurement; product inputs, proof helpers and their record were unchanged. The earlier sandbox gate failures above remain historical; review/PR completion is not claimed here.

## Remaining responsibilities

Publishing `featured` does not serve `/collections/featured`; that endpoint remains `not_implemented`. Publishing movedTo/aliases executes no account Move. Internal ingestion still reads unprefixed settings while publication uses `_misskey_…`; this evidence compares the internal rendered document and makes no settings roundtrip claim. Suspended-user public/internal distinctions, dependency error priority, uncached HTTP errors, Meta DB-read versus upstream cache freshness/failure behavior, and the existing internal remote-row guard qualification remain.

The five gap groups remain `media-emoji`, `instance-metadata`, `charts`, `rich-actor`, `remote-cache`. Drive/media fetching and image byte serving, other instance callers, charts, rich actor/featured endpoint/Move, inbox signature/activity handling, remote Notes/collections, and cache/remoteUserUpdated (#217) still need their scoped implementations and comparisons. #176/#127/#195 remain OPEN; `notes/create:partial`, `postingComplete:false`. Keep #249 → #176 → #195 inbox order and the [existing ownership table](README.md). The three updated inventory rows remain `partial`; all 1,432 audit and 2,119 contract IDs/order/owners/statuses are preserved.

CHANGELOG was not edited. Candidate: Fix: Publish stored local actor settings and migration references in ActivityPub actor documents.
