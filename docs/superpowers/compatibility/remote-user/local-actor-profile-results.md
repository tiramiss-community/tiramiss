# Local actor profile publication (#195, bounded slice)

Fixed oracle: `8e07cf085adf7009583d234a208e30436f020e26`. Controller selected the required flat Profile reader and shared pure renderer; this is not a user policy decision. The public MFM module has no federation imports, so this dependency introduces no public cycle.

## Source evidence

`local-actor-profile-source-probe.mjs` executes the real `ApRendererService.renderPerson`, `MfmService.toHtml`, `escapeHtml`, `concat` and `intersperse`. Whole-source SHA256 literals reject drift before extracting methods; extracted literal bindings are recorded independently. Profile repository errors, absent media, empty emoji/tags, dummy key rendering and local URI generation are declared doubles. No new renderer supplies expected values. This is not a full upstream HTTP server comparison.

Run from repository root:

```sh
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-actor-profile-source-probe.mjs --write
UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-actor-profile-source-probe.mjs --check
```

Both ran successfully (13 observations). Eleven successful/MFM-failure profile inputs are consumed by the pure-renderer tests; the remaining two repository-failure observations are pinned by the validator and tested at actual adapter boundaries. Raw own `attachment: undefined` is distinct from missing JSON attachment; null and empty raw summary remain distinct.

## Runtime behavior and verification

HTTP reads Profile only after federation, User existence and remote-user redirect checks. Missing Profile, DB failure and malformed ruby MFM fail instead of publishing substituted empty facts. Both actual PG-backed HTTP and `createRemoteUsers(...).acquireActor(localUri, ...)` use the shared projection. The normal built HTTP child also publishes it. Original source95 and hashtag corpora and historical receipts remain byte-for-byte intact; the old identity assertions explicitly exclude this new profile projection.

RED: `pnpm --filter backend-next test test/unit/federation/local-actor-profile.test.ts` observed 15 failed / 3 passed before product edits: missing summaries/attachments/vcard/raw properties, swallowed Profile/MFM failure and missing name-preserving HTTP profile projection. GREEN: nearest five unit files passed 161 tests; backend-next dependency build and source/test typecheck passed. Final changed-file quiet ESLint passed.

The first broker run passed integration66/2 files, process5/1 file and full-unit2873 tests. Final whitespace normalization changed file identities; the first full-unit result is preserved as a historical pre-normalization snapshot. The parent subsequently measured the final identities too: integration66/2 files, process5/1 file and full-unit2873/88 files passed. Current measurements and their exact commands, artifact hashes and renewed source identities are in `local-actor-profile-runtime-evidence.json`. Existing pg concurrent-query deprecation warning remains a baseline warning. A single TCP diagnosis returned EPERM; runtime was brokered without network retries. Node contract validation's Git subprocess also encountered EPERM and was delegated. The parent's exact three-script contract run used `/tmp/tiramiss-s1-node26/bin/node --test scripts/local-actor-profile-contract.test.mjs scripts/remote-user-contract.test.mjs scripts/note-contract-posting.test.mjs` and passed 123 tests (runtime/build/unit measurements remain Node24.20). Quiet changed-file lint, SPDX and locale safety passed; final shipping and review remain parent-owned.

## Remaining ownership

This publishes description, followedMessage, fields, birthday and location only. Media/emoji #188/#195, instance metadata/usersCount #215, charts #200, richer actor/featured/Move/inbox/remote Notes #195 and cache/remoteUserUpdated #217 remain open. The richer-actor gap is incomplete. Keep `notes/create:partial`, `postingComplete:false` and #176/#127/#195 incomplete. No persistence, migration, queue, policy or framework was added. Parent owns task/whole-branch review, CodeRabbit, final shipping, Git and PR; no commit or external send was made here.

The earlier three-contract receipt binds the results document before the successful contract outcome was appended; its original source map remains historical and is not relabelled. The fix1 focused five-file run passed 161 tests and records the updated test identity separately in runtime evidence. Integration and process r3 remain applicable to their unchanged product and test bindings. The earlier full-unit r3 measurement predates the fix1 test change and remains historical for that test identity. Parent runs full units after the test freeze and final root contracts after all public bytes are frozen.
