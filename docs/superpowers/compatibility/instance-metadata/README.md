# Current-caller instance metadata (#215 / #216)

Fixed source `8e07cf085adf7009583d234a208e30436f020e26`; base `a57e1e456ea448335a8a3a3c37e333302ff4bebe`. [Design](../../specs/2026-11-10-instance-metadata-design.md) and [one-task plan](../../plans/2026-11-10-instance-metadata-215.md).

The operation serves public actor creation/canonical duplicate recovery and successful delivery. Actor increment and metadata start independently after registration; delivery uses nextTick and starts metadata independently of responding-state update. Existing caller pending sets diagnose and drain work before shared connections close. Both compositions share their ledger with metadata, keeping local cache replacement visible. No new queue, entity, migration, public endpoint, setting or broad cache framework.

[Source probe](source-probe.mjs) runs literal hash-guarded FetchInstanceMetadataService methods, HttpRequestService.getHtml and DeliverProcessorService.process from the pin. Source-installed parser/tinycolor are real; HTTP, Redis, ledger, logger, clock, chart and nextTick execution are explicit doubles. [Observations](observations.json) hold 27 operation cases and five successful delivery scheduling cases. Historical actor source11 already measures normal/canonical recovery and separately held increment; its metadata operation remains a double. None of these is full upstream server/DB equivalence. Source diagnostics from failed NodeInfo helpers are not copied as new logging plumbing; operation errors and caller rejections have explicit diagnostics.

Preserve SET EX30 GET without NX, contender TTL renewal/skip without unlock, cached freshness strictly less than24h (including future timestamps), force bypass with unconditional unlock, acquisition/inside-try/unlock failure boundaries, and source expiry races. Legacy mutex cleanup remains nonwaiting, with rejection observation added; v2 acquisition proceeds independently. Sources and derived fields fail independently; selected NodeInfo document failure never tries a lower schema. Empty metadata strings block fallback without a write; invalid higher-priority color does not fall through. Manifest description falls back to name/short_name. Raw NodeInfo values reach persistence without truncation; undefined and null remain distinct. An all-fetch failure still attempts timestamp persistence.

getHtml uses existing protected send, GET, source Accept/header override semantics, a5s body-inclusive deadline and10MiB limit. Integration uses a real HTTPS peer with a generated test CA and explicit process trust; successful populated fields and existing note-author instance projection are asserted. A timestamp-only HTTP fixture would not establish acquisition.

Source uses synchronous in-memory Meta. Actor registration retains asynchronous DB settings reading, with possible failure and start after hashtags. Delivery rereads settings in the success callback, but that DB read is also asynchronous; concurrent setting changes and synchronous-snapshot equivalence remain unproven. Existing first-registration orIgnore and cross-process cache staleness remain. Raw increment alone does not refresh cache; simultaneous metadata update legitimately caches the whole updated row, including whatever usersCount DB returned. Dedicated raw-increment tests hold the real metadata mutex to isolate that ownership.

## Validation provenance

Parent frozen revision1 (Node24.20.0/pnpm12.9.1) verified all934 inputs before/after every command. Actual 2026-11-10 UTC runs: integration **144/5files** at11:36:38–11:37:03; built process **14/3files** at11:37:03–11:37:27; full unit **2,939/90files** at11:37:27–11:37:59, all with0 failures/skips. Source27 operation+5 delivery scheduling cases, build and typecheck also passed. [Runtime evidence](runtime-evidence.json) preserves original commands, timestamps, artifact digests and finite measured consumer renewals; historical corpus/receipt bytes remain intact. Local focused211/4files and changed-package/root-script quiet lint, SPDX/locale/diff checks passed before freeze. Root Node26 gate and immutable inventory generation remain separate and pending.

Earlier development runs retain RED4/25, sandbox EPERM with six skipped, dev1 six fixture failures, dev2 107PASS/4FAIL and dev3 integration111 plus process2PASS as separate executions. Source-check initially failed cross-realm deepStrictEqual despite equal observed JSON; comparison now serializes JSON without changing expected results. That intermediate failure log was overwritten by the successful rerun; its tool transcript remains, and no immutable failure artifact is claimed. Existing pg concurrent-query deprecation was already in baseline and remains in real integration/process logs.

Reproduce with installed dependencies and separately provisioned test infra:

```sh
node docs/superpowers/compatibility/instance-metadata/source-probe.mjs --check
pnpm --filter backend-next test test/unit/federation/instance-metadata.test.ts test/unit/federation/actor-instance-registration.test.ts test/unit/federation/deliver-job.test.ts test/unit/note/create-note.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
BACKEND_NEXT_TEST_DB_PORT=55506 BACKEND_NEXT_TEST_REDIS_PORT=56406 BACKEND_NEXT_TEST_MEILI_PORT=57806 pnpm --filter backend-next test:integration test/integration/instance-metadata.test.ts test/integration/remote-user.test.ts test/integration/deliver-processor.test.ts test/integration/note-application.test.ts test/integration/activitypub-actor.test.ts
BACKEND_NEXT_TEST_DB_PORT=55506 BACKEND_NEXT_TEST_REDIS_PORT=56406 BACKEND_NEXT_TEST_MEILI_PORT=57806 pnpm --filter backend-next test:process test/processes/instance-metadata.test.ts test/processes/remote-mentions.test.ts test/processes/note-deliver.test.ts
```

All five gap groups remain incomplete: media/emoji #188/#195; metadata other acquisition paths #215; chart #200; rich actor/featured/Move/inbox/remote Notes #195; remote cache/remoteUserUpdated #217. This satisfies only the measured current-caller metadata slice. #176/#127/#195/#215 remain incomplete; `notes/create:partial`, `postingComplete:false`. Formal S1 order remains #176 then #195 inbox core with #215 stage4. No issue closure or PR publishing is performed by the writer.
