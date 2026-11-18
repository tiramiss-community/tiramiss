# host-meta and well-known OPTIONS/CORS (#531 slice)

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. This slice adds the normal HTTP composition's `GET`/`HEAD /.well-known/host-meta` and `host-meta.json`, plus `OPTIONS /.well-known/*`. This historical slice left NodeInfo 2.0/2.1, its statistics/cache and `/.well-known/nodeinfo` to the [NodeInfo completion](../nodeinfo/README.md). #193 remains open.

The existing shared Meta cache gates host-meta on `federation !== 'none'`. XML attributes preserve the pinned XML helper's first-occurrence escaping, including repeated special characters. Existing WebFinger value escaping and all discovery behavior retain their regression tests. Successful host-meta responses have no Cache-Control or Vary. XML has `application/xrd+xml`; JSON has `application/json; charset=utf-8`. Disabled federation returns empty403; Meta failures return empty500 with CORS, no cache/Vary and a fixed `host-meta.failed` JSON diagnostic through the runtime logger.

The common middleware adds the four pinned CORS headers to registered well-known routes, including handlers registered afterward. Unknown OPTIONS returns204 without reading Meta. Unknown GET/HEAD and the bare `/.well-known` prefix keep their existing404 without discovery CORS. The trailing `/.well-known/` and nested unknown paths receive OPTIONS204. This distinction is required by Fastify's encapsulated hook and wildcard behavior. OAuth/password stand-ins verify registration order and header composition only; their business implementations are outside this slice.

## Reproduce

Install isolated dependencies and build `backend-upstream` per the package guide. Replay the source with a checkout at the pin and its installed backend dependencies:

```sh
UPSTREAM_ROOT=/path/to/pinned-upstream node docs/superpowers/compatibility/well-known/source-probe.mjs --check
pnpm --filter backend-next test test/unit/federation/well-known-api.test.ts test/unit/composition/http-app.test.ts test/unit/federation/webfinger-api.test.ts test/unit/federation/local-webfinger.test.ts
pnpm --filter backend-next test:integration test/integration/well-known.test.ts test/integration/webfinger.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
node scripts/check-shipping.mjs --base origin/develop
```

`UPSTREAM_DEPENDENCIES_ROOT` can point to a separate dependency checkout. The source probe verifies complete SHA256 and pinned Git bytes for WellKnownServerService and XML, transpiles the literal source method and helper, and runs listening Fastify with actual fetch requests. Its [144 observations](observations.json) record dependency versions. The source side injects stable Meta, a throwing Meta getter and an OAuth issuer stand-in; it is not the full upstream application or upstream PostgreSQL. On 2026-11-18 the replay used `/tmp/tiramiss-relay171-upstream` and read-only dependencies from `/home/osamu/develop/tiramiss`; the implementation's dependencies were independently installed in `/tmp/tiramiss-wellknown531`.

Unit tests directly compare status, selected headers, successful bodies and Meta-read counts against these observations. The HTTP/PG suite compares the normal composition against the applicable source observations with persisted Meta, and renames the test-owned Meta table to exercise warm cache, cold failure and preflight bypass. Framework-specific404 diagnostic bodies and their Content-Type are excluded from differential equality. Pinned host-meta reads the already-injected Meta object: it performs no request-time DB query. The source probe's throwing Meta getter is an abnormal injected fault, not a normal upstream cold-cache DB failure. Fastify serializes this particular injected error as `application/json; charset=utf-8` with `{ statusCode: 500, error: 'Internal Server Error', message: 'injected Meta failure' }`; HEAD suppresses that body while retaining its JSON Content-Type. The probe asserts and retains the GET body in `injectedFailureBody`. Its message depends on the injected exception. The new composition's actual cold-cache PG failure instead follows existing WebFinger behavior: empty500, absent Content-Type and safe constant JSON logging. Unit and integration tests explicitly assert this difference, while status and CORS/cache/Vary remain equal. This is not a claim that upstream cold-cache DB failures were executed or matched. Existing unknown-route behavior is retained. Notification propagation latency and cache freshness across processes are not established by these stable-Meta and fault cases.

## Local verification

2026-11-18, Node v24.20.0 / pnpm12.9.1. Dependencies were installed with `pnpm install --frozen-lockfile --filter backend-next...`. Dedicated Compose project `tiramiss-wellknown531` used PG55531 / Redis56531 / Meili57531 and test-created random databases. No shared service was changed.

- Source replay: 144 listening HTTP observations.
- Focused unit selection: 265 passing tests, no skipped tests.
- Normal listening HTTP/PG: 87 passing tests (41 new well-known, 46 existing WebFinger), no skipped tests.
- Dependency-order build, typecheck and shipping checks: PASS.

Logs are `/tmp/wellknown531-{units,integration,build,types,shipping}-r3.log`. The final added empty500 unit assertion also passed147/147 in `/tmp/wellknown531-unit-fault-r4.log`, followed by shipping in `/tmp/wellknown531-shipping-r4.log`. The first behavioral RED expected host-meta200 and received404 (`/tmp/wellknown531-red.log`). Differential testing caught a missing JSON charset and then the bare-prefix OPTIONS204 versus upstream404; both were fixed before the final run. Integration emits an existing pg concurrent-query deprecation warning; no unrelated connection changes were made. CHANGELOG was not edited; candidate: “backend-next: host-meta discoveryとwell-knownのOPTIONS/CORS応答を追加”.

The CI contract follow-up preserves historical evidence without renewing it. [compatibility-predecessor.json](compatibility-predecessor.json) binds only the exact new `composition/webfinger-http.ts` and `test/unit/composition/http-app.test.ts` bytes to their `e045cf2e70` predecessors. Existing Meta and shared-composition history readers apply this finite transition; unknown bytes reach their existing drift guards. A dedicated root contract test checks the actual current hashes, old identity, unrelated inputs and fresh reads. Historical receipts, results and seals remain unchanged. The host-meta XML renderer is private to the new HTTP adapter, so the original federation module and public exports remain byte-identical.

The final adapter arrangement was revalidated in `/tmp/wellknown531-{units,integration,build,types,source,shipping}-r5.log`: unit265, normal HTTP/PG87, build/typecheck/source144 and shipping PASS. R3/R4 runs above remain historical for their own inputs. The initial CI product checks, integration and process lanes passed; its contracts/foundation failure prompted this bounded transition and a new whole-root contract run.
