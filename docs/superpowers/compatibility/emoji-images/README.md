# Emoji images — #555

Scope: `/fluent-emoji/:path`, `/twemoji/:path`, `/twemoji-badge/:path` only. Parent #196 and the complete backend #114 remain incomplete. Custom emoji management, avatar images, other static frontend routes and global HTTP headers are separate work.

The source probe reads the three literal `ClientServerService.createServer` route callbacks from fixed Misskey `8e07cf085adf7009583d234a208e30436f020e26` through `git show`, registers them on a listening Fastify server with the real static plugin, and sends 29 native Node HTTP requests. It does not boot the full upstream application. The temporary fixture copies the actual emoji-assets `1f600.png` / `1f600.svg`, fixes their mtime to 2000-01-01 for reproducible static validators, supplies one corrupt SVG, and leaves missing files absent. Asset input hashes and package versions are in `observations.json`. The dependency versions match the pinned manifest/lock: Fastify 5.12.5, static 10.1.5, send 4.1.1, Sharp 0.35.5 and emoji-assets 17.0.3.

The next implementation's targeted test runs its HTTP adapter on a listening Hono Node server with the same fixture and consumes every observation: successful PNG/SVG bytes and badge PNG hashes; format, CSP and 30-day cache; GET and HEAD; invalid filename, raw versus encoded slash, one decoding step, invalid percent encoding/UTF-8; missing static image versus missing/corrupt badge; Range 206/416, conditional 304 and precondition 412. Native HTTP is intentional: `fetch` adds no-cache for conditional requests and would obscure the static 304 behavior. Dynamic temporary root names in missing badge messages, and the corresponding Content-Length, are normalized to `<assets>`; other observed fields are compared literally. Date, connection and other transport-dependent headers are outside this comparison.

Static serving reuses the pinned `@fastify/send` engine directly to preserve ranges and cache preconditions without a Fastify server or legacy backend runtime dependency. HTTP owns name validation and response serialization; the platform adapter owns filesystem roots/static acquisition; Sharp transformation is separate. The composition resolves exported image subpaths from this package's direct emoji-assets dependency, so deployment does not use `packages/backend/node_modules` or depend on the working directory. The package lookup test checks actual deployed image bytes and PNG metadata. The existing ordinary app route inventory receives only the three new expected paths.

The badge pipeline retains the source's density 1000, grayscale/normalise/contrast, black flatten/12px padding, monochrome XOR and `.resize(96, 96)` call. With the measured fixed image and Sharp version its resulting PNG is **512×512**, byte-equal on both sides. This observed behavior is preserved and bounded to this fixture/version; see [UF-014](../../../backend-next/upstream-findings/packages/backend/src/server/web/ClientServerService.md).

Replay with an isolated installation containing the pinned Fastify/static/ms versions (Sharp and assets are loaded from backend-next's direct dependencies):

```sh
BACKEND_NEXT_UPSTREAM_PATH=/path/to/fixed/upstream \
BACKEND_NEXT_SOURCE_DEPENDENCIES=/path/to/isolated/source-deps/package.json \
node docs/superpowers/compatibility/emoji-images/source-probe.mjs --check
pnpm --filter backend-next test test/unit/emoji-images.test.ts test/unit/composition/http-app.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next typecheck
```

The initial test collection failed because the new API module did not yet exist; this was a missing-feature collection failure, not a failed behavior assertion. After implementation, the 29 comparisons passed. The independent dimension assertion initially expected 96px, exposed the literal source pipeline's 512px output, and was corrected to the measured source result without changing the pipeline.

`current-evidence.json` binds eleven finite runtime/test/corpus inputs before and after the final recorded runs. `predecessor.json` contains only exact removals for three changed shared files (package dependencies, ordinary HTTP registration and its expected route inventory). One evidence leaf checks the current inputs before projecting those exact preimages through the existing public-emoji and package terminal readers. Requested-path drift is checked on later calls in the same validation scope, and a fresh public call rechecks all inputs. Other files pass through. Historical receipts are unchanged, and these projections do not claim older tests were rerun. Proof metadata, inventory and shipping checks remain separate from runtime measurements.

Only the five contract rows and two audit rows assigned by #555 are updated. Fixed callback comparison, listening HTTP, build/typecheck and nearest tests establish this slice; PostgreSQL/Redis, full upstream boot, the rest of #196 and production deployment are outside the measured scope. No DB or migration behavior changes, and no DB/Redis test environment is required.
