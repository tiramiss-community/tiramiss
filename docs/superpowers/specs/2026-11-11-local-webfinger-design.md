# Local WebFinger discovery design (#195)

Date: 2026-11-11. Base: `5699e5ce92595e7065665fa964d0854c3194cca4` (PR #267 merged).
Source: read-only `/tmp/tiramiss-relay171-upstream`, pinned `8e07cf085adf7009583d234a208e30436f020e26`.
Input: `/tmp/tiramiss-s1-r10-selection.md`. Parent scope/order: #114, #176 → #195; this is a bounded adjacent discovery slice.

## Goal and choice

An external peer can request local WebFinger, select its ActivityPub self link, and GET the already implemented local actor with the same id, stored username, and public key. This produces an externally usable flow from an account address, without introducing another federation framework.

Alternatives considered: publishing the remaining actor fields leaves the featured collection unreadable; remote featured synchronization needs remote Note creation, image acquisition, recursive replies/quotes and poll/vote dependencies. WebFinger has existing User/Meta/config prerequisites and connects directly to actor GET. host-meta, NodeInfo, authorize-follow handling, collections, inbox/signature verification and remote Notes stay outside this slice.

## Global constraints

- Cwd ONLY `/home/osamu/develop/tiramiss/.claude/worktrees/s1-federation-next9`; sole writable implementer; no nested workers.
- No Git mutations, commit, push, install, Docker, auth/config changes, or external sends; parent handles publication.
- Node `26.4.0`, PATH prefix `/tmp/tiramiss-s1-node26/bin`; pnpm `12.9.1`; reuse installed dependencies including `accepts`.
- No schema, entity, dependency, locale, CHANGELOG, or process lifecycle changes.
- Keep #176/#127/#195 partial, `notes/create:partial`, `postingComplete:false`, and formal issue order unchanged.
- Preserve all historic oracle JSON, probes and receipts byte for byte; no inventory, ROADMAP, or root proof helper edits without a later parent assignment.
- Business code uses plain facts; TypeORM lives in database adapters; cross-module imports use public federation exports.
- Product/test code starts only after `/tmp/tiramiss-s1-r10-plan-approved.json` exists and approves these plan/spec hashes.
- Freeze relevant executable inputs before broker validation; require a real PASS receipt before claiming validation success.

## Source contract

The binding implementation is `WellKnownServerService.createServer` and the literal backend `misc/acct.ts` and `misc/prelude/xml.ts` at the pin, not a selector summary or generic protocol interpretation.

1. OPTIONS at `/.well-known/webfinger` returns 204 without reading Meta/User, even when federation is none. GET and HEAD read federation before inspecting resource; none gives 403. Missing or duplicated `resource` gives 400, while empty resource proceeds to the username lookup. Hono query arrays must preserve that distinction; brackets remain ordinary names rather than an object parser.
2. Lowercase the entire resource. Match `${config.url.toLowerCase()}/users/` first and use its final slash segment (including an empty final segment); then local `/@`, then strip `acct:`, then bare account. Account parsing removes one initial `@` and uses `split('@', 2)`; later segments are ignored. A missing/empty account host is allowed; otherwise compare exactly with lowercased URL host, including its port. Do not add strict URI validation or decoding beyond the normal query parser.
3. Database lookup is local `host: IsNull()`, `isSuspended: false`, and either id or usernameLower. No `isDeleted` condition. Select and return only `{ id, username }`, without entities crossing the adapter boundary. One User lookup after valid resource; early exits do not query User or actor/profile/key tables.
4. Success subject is `acct:${storedUsername}@${new URL(selfUrl).host}`. Links are exactly self (`application/activity+json`, `${selfUrl}/users/${id}`), profile-page (`text/html`, `${selfUrl}/@${username}`), subscribe (template `${selfUrl}/authorize-follow?acct={uri}`). No aliases or extra fields.
5. Use installed `accepts.type([jrd, xrd])`. Only selection of `application/xrd+xml` emits XML. Missing/unsupported Accept, both q=0 choose JRD. Equal weights follow accepts client ordering; absent Accept uses JRD. Successful responses have `Vary: Accept`, `Cache-Control: public, max-age=180`, and JRD Content-Type with UTF-8 charset; XRD Content-Type has no charset. HEAD returns corresponding headers/status with empty body.
6. All responses carry exactly these four CORS values: Allow-Headers `Accept`, Allow-Methods `GET, OPTIONS`, Allow-Origin `*`, Expose-Headers `Vary`. Do not add cache/Vary to 400/403/404/422/500 or OPTIONS. Catch discovery infrastructure failure locally so the surrounding REST API error handler cannot add its private cache policy; return 500 with these CORS headers. Error-body compatibility is limited to status/headers, not Fastify's diagnostic JSON text.
7. XRD uses the pinned element/link order, declaration and self-closing formatting. Attribute escaping replaces only the first occurrence of each of `& < > " '` in that order. Subject value escaping replaces each map character and skips `]]>` as the source does; retain this surprising behavior, with independent literal expected XML. Do not replace it with a general XML serializer.

## Boundaries and data flow

HTTP adapter checks method/federation/query multiplicity, calls the pure resource projection through federation/public, asks a narrow DB reader for plain facts, then renders JRD or XRD from those facts. Composition supplies existing readMeta and normalized config URL, and mounts discovery in createBackendHttpApp beside existing actor routes. No DB access occurs during rendering; no writes, generic repositories, or caches are introduced.

The existing readMeta reads DB afresh per request (and retains its existing missing-row initialization); upstream receives an injected Meta object refreshed by notifications. Compare stable persisted Meta. Notification delay/cache-failure equivalence remains unproven and owned by #217; this slice does not build a cache.

## Evidence and acceptance

Dedicated units cover resource projections, literal documents, negotiation, CORS, errors, HEAD/OPTIONS and early DB boundaries. Actual ordinary HTTP composition with a listening Node HTTP server and dedicated PostgreSQL uses real local, suspended, deleted and remote User rows plus Profile/Key rows. Test all resource forms, host case/port, foreign and extra hosts, missing/empty/duplicate/non-string query semantics, negotiation, escaping, stable federation none and DB fault. Follow the returned self href to actor GET and verify id, preferredUsername and publicKey owner/id/PEM.

A new compact pinned source oracle uses actual createServer mounted in Fastify with inject and real installed pinned accepts dependency. Literal Acct/XML source is evaluated, complete source bytes are checked against pinned Git objects and SHA256s, and extracted function bodies have fingerprints. Repository, Meta, URI service, NodeInfo and OAuth collaborators are explicit doubles. Fixed expected observations are independent of backend-next; current tests directly assert each source case's HTTP/logic behavior. This proves the bounded source method, not upstream full-server/PG equivalence.

Run focused units including existing composition/http-app and actor consumers, build/typecheck, actual WebFinger integration and existing HTTP-app/actor regression as appropriate, source --check, changed-file eslint and SPDX/locale safety. Keep behavioral RED and any sandbox EPERM logs. Do not replace inaccessible network tests with mocks and call them runtime success. Freeze executable source/test/config/lockfile/source-oracle inputs in the validation request, excluding all repository `scripts/` inputs, inventory JSON, descriptive Markdown and mutable runtime evidence; include the new docs-located executable source probe/corpus/observations. Parent broker executes frozen commands and supplies immutable revisioned receipts; only afterward bind timestamps/counts/logs into new evidence/results.

## Review focus

Check source quirks literally, especially last-segment ids, split-at-two, port/casing, empty vs missing/duplicate query, first-occurrence XML escaping, negotiation fallbacks, CORS on failure and ordering of DB work. Check ordinary composition reaches discovery and actor with real DB rows, direct current assertions cover every oracle case, and the source oracle does not import new implementation to compute expected observations. Reject scope growth, business Entity imports, generic framework scaffolding, historic evidence mutation, fabricated PASS or claims closing #176/#127/#195.

Source-execution clarification (2026-11-11): actual pinned Fastify inject showed XRD `application/xrd+xml` without charset (JRD has charset); a foreign actor URL with no `@` becomes a bare username lookup and normally404; equally weighted types follow client ordering. Initial source characterization failure is retained in `/tmp/tiramiss-s1-r10-source-initial.log`. These literal-source results refine the approved implementation, without expanding scope.


## Final diagnostic format correction (2026-11-11)

The first task-review fix diagnosed exceptions with `console.error(error)` (R2). The later verified format finding applies the existing backend-next stdout JSON contract to that diagnostic. WebFinger now receives the existing `resources.logger` through composition; the HTTP dependency is `Pick<Logger, 'error'>`. It emits one error-level `webfinger.failed` event with constant `classification: unexpected-failure` and an adapter-selected `stage` (`meta-read`, `request`, `user-read`, or `render`). Arbitrary thrown values, message and stack are not passed to the logger. The empty local500, four CORS headers, absent failure cache/Vary and HEAD behavior remain the contract. Pure federation modules and the shared logger are unchanged. R1/R2 remain historical measurements; R3 measures the revised inputs separately.
