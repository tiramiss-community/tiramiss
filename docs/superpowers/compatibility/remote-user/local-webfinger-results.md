# Local WebFinger discovery: bounded source and real runtime results (#195)

`GET` / `HEAD /.well-known/webfinger` now resolves a local account or local actor/profile URL into JRD/XRD, through the ordinary `createBackendHttpApp`. Its self link reaches the existing actor GET with the same id, stored username and published key. OPTIONS returns204. No entity/schema/dependency/config/lifecycle changes were needed.

Base: `5699e5ce92595e7065665fa964d0854c3194cca4` (PR #267 merged), upstream `8e07cf085adf7009583d234a208e30436f020e26`. The measured checkout was dirty; no implementation commit is invented. #176/#127/#195 remain incomplete; `notes/create:partial`, `postingComplete:false` and formal ordering remain unchanged.

## Literal source contract

The new [source probe](local-webfinger-source-probe.mjs) checks complete checkout bytes against pinned Git objects and hardcoded SHA256/function fingerprints. It executes the actual `WellKnownServerService.createServer` in Fastify inject using the installed upstream Fastify/accepts, plus literal Acct and XML modules. Repository rows/failure, stable injected Meta, URI service, NodeInfo and OAuth are explicit doubles. It asserts the exact User predicates and no extra lookup on early returns. This is source-method HTTP evidence, **not an upstream full-server or upstream PG comparison**.

All **49** [source observations](local-webfinger-observations.json) have direct current HTTP/status/header/body/lookup assertions in `test/unit/federation/webfinger-api.test.ts`; expectations originate from the independent [corpus](local-webfinger-corpus.json), never from new renderers. Pure query/JRD/XRD tests supplement those assertions.

The implementation preserves whole-resource lowercasing, last segment for local `/users/`, one initial `@` removal and `split('@', 2)`, stored username case, non-default host port, local/non-suspended filtering without an extra isDeleted predicate, and exactly three links. A foreign URI without `@` is a bare username query (normally404), not a strict URI rejection. Missing/bracket-only/duplicate resource gives400; empty goes through lookup (normally404). Federation none gives403 before parsing; OPTIONS skips Meta/User entirely. Only XRD selection returns XML: unsupported Accept and both q=0 fall back to JRD; equal weights follow client ordering. XRD Content-Type has no charset, while JRD has UTF-8. XML attribute replacement affects the first occurrence of each map character; value escaping also retains the pinned `]]>` removal quirk.

All responses have the pinned four CORS headers. Only200 adds `Vary: Accept` and public max-age180; HEAD sends no body. DB/Meta fault500 retains CORS and no cache/Vary. Fastify diagnostic error body text is outside the comparison contract.

## Actual broker validation

Receipt: `/tmp/tiramiss-s1-r10-validation-receipt-r1.json`; SHA256 `3fc49b573d5815c9085828b2e4c0ad29e27094c0b1907ecb181bd61452c565b7`. Request: `/tmp/tiramiss-s1-r10-validation-request-r1.json`; SHA256 `4b485aaed3eac93173178ce826b2ceabeb13516e90607a4aa04eb94669982db4`. Full receipt/log/artifact hashes and the measured code/input hashes are in [runtime evidence](local-webfinger-runtime-evidence.json).

Window: **2026-11-11T12:42:37.420488+00:00 → 2026-11-11T12:43:05.265096+00:00**. Node `v26.4.0`, pnpm `12.9.1`; dedicated PG55513 / Redis56413 / Meili57813. The broker verified **846** frozen inputs before and after each command. Repository `scripts/`, inventory JSON, descriptive Markdown and mutable runtime evidence are outside that input map; the new docs-located executable source probe/corpus/observations are included.

| Check | Actual result | Log/artifact prefix |
| --- | --- | --- |
| Dependency-order build / typecheck | PASS / PASS | `/tmp/tiramiss-s1-r10-validation-r1-build`, `-typecheck` |
| Focused new/modified units + existing actor consumers + package imports | PASS **227/227**, 9 files | `-units.log`, `-units.json` |
| New ordinary listening HTTP + actual PG WebFinger integration | PASS **46/46**, 1 file | `-webfinger-integration.log`, `-webfinger-integration.json` |
| Existing ordinary HTTP-app + actor integration | PASS **55/55**, 2 files (2 + 53) | `-existing-http-actor-integration.log`, `.json` |
| Pinned source --check | PASS **49** directly asserted cases | `-source-check.log` |
| Changed-file eslint / SPDX / locale safety | PASS / PASS / PASS | `-shipping.log` |

The 46 new integration cases use real User rows (local, remote same-name, suspended, deleted, special-character), Profile and Key rows, persisted stable Meta, and the normal app mounted via listenHttp. They cover account/URL forms, casing/ports/extra hosts, missing/empty/duplicate/bracket query, JRD/XRD weights/fallbacks/escaping, HEAD and OPTIONS, and an actual fetch of the returned self href with ActivityPub Accept verifying actor id/preferredUsername/key owner/id/PEM. Test-owned User/Meta table renames provoke actual DB failures, restored in finally, and demonstrate early exits without querying those unavailable tables. No shared role/permission changes or mock-only E2E were used.

Reproduce the focused commands from the evidence measurements; run source replay with `UPSTREAM_ROOT=/tmp/tiramiss-relay171-upstream node docs/superpowers/compatibility/remote-user/local-webfinger-source-probe.mjs --check`. Use the repository Node PATH and dedicated test-port environment variables.

## Failure history and limits

- Behavioral RED `/tmp/tiramiss-s1-r10-red-http-app.log`: ordinary composition returned404 without discovery CORS; assertion expected `Accept` and received null.
- Initial source characterization failed on the incorrect assumed XRD charset; corrected against actual pinned Fastify output and retained `/tmp/tiramiss-s1-r10-source-initial.log` and `-source-characterization-r2.log`.
- Initial typecheck caught an untyped JSON/Vitest.each overload; a typed test-only corpus reader fixed it. Initial changed-file lint found five blank-line violations; fixed before the frozen run. All logs/hashes are retained in evidence history.
- Sandbox direct PG attempt failed `connect EPERM 127.0.0.1:55513`; all46 were skipped, not passed. A separate sandbox package-import attempt failed `spawnSync EPERM` while226 other units passed. The actual broker subsequently passed all227 units and the real runtime suites; those earlier failures remain recorded.
- Actual runtime logs emit an existing pg concurrent-query deprecation warning. No unrelated connection/lifecycle refactor was added.

Upstream reads an injected notification-refreshed Meta object; current composition deliberately reuses the existing fresh DB reader, including its established missing-row initialization. The tests establish stable-Meta equality only. Notification delay/cache failures remain unproven and owned by #217; no cache is introduced here. Neither source nor current evidence completes host-meta/NodeInfo/authorize-follow handling, collections/full actor, inbox/signature verification, remote Notes/media/featured/Move, or #176/#127/#195.

Parent owns task review, root proof/inventory follow-up, CodeRabbit, commit and PR. Historic oracle JSON/probes/receipts remain unchanged. CHANGELOG was not edited; candidate: “backend-next: ローカルアカウントのWebFinger discoveryを既存actor GETへ接続”.
