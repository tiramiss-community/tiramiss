# Instance Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Native execution by sole writer; parent owns independent review. No subagents or commits.

**Goal:** Persist source-compatible metadata from both current public actor and delivery-success callers without waiting in their responses.

**Architecture:** A focused platform acquisition operation uses existing ledger and outbound HTTP ports; pure module selectors receive projected HTML. Existing actor/delivery controllers own acceptance, diagnostics and drain. One cohesive task covers oracle, adapters, both callers and actual-dependency tests.

**Tech Stack:** TypeScript, TypeORM, ioredis, node-fetch, node-html-parser, tinycolor2, Vitest; runtime Node24.20/pnpm12.9.1, parent root contracts Node26.4.0.

**Spec:** `docs/superpowers/specs/2026-11-10-instance-metadata-design.md`

## Global Constraints

- Fixed source `8e07cf085adf7009583d234a208e30436f020e26`; base `a57e1e456ea448335a8a3a3c37e333302ff4bebe`; final parent selector controls scope.
- Preserve historical corpus/receipt bytes, async Meta timing limitation, ledger caches and first-registration difference. No new migration/entity/API/queue/settings/framework.
- No subagents, Git mutations, external sends, Docker/install, secrets/settings/.config/.env/security reads, old backend/frontend or managed upstream edits.
- Parent brokers dependency/network needs; writer diagnoses EPERM once. Parent GO precedes product; frozen receipt precedes evidence claims. Product/test changes after freeze require a new revision.
- SPDX on new eligible files; quiet lint from package roots, formatting and diff checks before final tests. No CHANGELOG edit; retain partial posting and five gap categories.

## Review Focus

1. Pending or rejected increment/responding update must not prevent metadata starting or make a successful response wait; test both callers and drain.
2. Locked contender refreshes TTL without unlocking; force deletes another lock; expired owner can delete replacement lock. Test source races, not stronger semantics.
3. Cached freshness at 24h−1 / exactly24h / future timestamp and independent completion clock; assert actual ledger cache behavior.
4. Malformed selected NodeInfo link, invalid color, empty metadata strings and invalid icon URL do not select invented fallbacks or suppress independent fields; compare actual source.
5. All HTTP fetches failing still updates timestamp; DB/cache/unlock errors preserve source swallowing/escape boundaries and caller diagnostics; verify real failures and shutdown order.

### Task 1: Complete current-caller instance metadata acquisition

**Files:**
- Create `packages/backend-next/src/modules/federation/instance-metadata.ts`: pure link/field/update selection and flat types; expose through `modules/federation/public.ts`.
- Create `packages/backend-next/src/platform/instance-metadata.ts`: HTML projection and Redis/HTTP acquisition, with explicit clock/failure reporting.
- Modify `src/modules/federation/instance.ts`, `src/platform/instance-ledger.ts`: freshness facts and metadata patch mapping/cache refresh.
- Modify `src/application/outbound-http.ts`, `src/platform/outbound-http/client.ts`: getHtml contract/implementation.
- Modify `src/composition/actor-instance-registration.ts`, `src/modules/federation/deliver-job.ts`, `src/composition/deliver-job.ts`, `src/platform/connect-resources.ts`: independent launch, diagnostics and existing drain wiring.
- Parent-broker dependency changes: `packages/backend-next/package.json`, `pnpm-lock.yaml` for source tinycolor2/types.
- Create `test/unit/federation/instance-metadata.test.ts`; extend actor/delivery and outbound unit fixtures only as required by the new ports.
- Create `test/integration/instance-metadata.test.ts`, `test/processes/instance-metadata.test.ts`; extend `test/helpers/remote-peer.ts` or add a dedicated TLS fixture for actual HTTPS fake transport and process-compatible CA trust; public caller tests use real repositories/Redis/HTTP and built children.
- Create `docs/superpowers/compatibility/instance-metadata/{source-probe.mjs,observations.json,runtime-evidence.json,README.md}` and `scripts/instance-metadata-{evidence.mjs,contract.test.mjs}`; adapt existing current-consumer resolver through an additive chain, preserving all historical evidence.
- Update bounded federation/outbound contracts and inventory/ROADMAP references only where actual scope changes; do not claim parent issue completion.

**Interfaces:**
- `InstanceFacts.infoUpdatedAtMs: number | null`; existing facts unchanged otherwise. `InstancePatch` gains `infoUpdatedAtMs?: number` and source metadata columns as unvalidated `unknown` at the acquisition boundary; adapter casts to Entity input without silent filtering.
- `InstanceMetadataTarget = { id: string; host: string }`; `HtmlMetadata = { links: { rel?: string; href?: string }[]; themeColor?: string; name?: string; description?: string; ogDescription?: string }`.
- `selectNodeInfoUrl(wellknown: unknown): string` throws for unusable links; `metadataName(info: unknown, html: HtmlMetadata | null, manifest: unknown): unknown`, `metadataDescription(...)`, `metadataColor(...): string | null`, `metadataIcon(host: string, html, manifest): string | null`, `metadataFavicon(host: string, html): string | null`; source invalid input may throw, each derivation is caught independently by acquisition.
- `metadataPatch(info: unknown, derived: { name: unknown; description: unknown; themeColor: string | null; icon: string | null; favicon: string | null }, nowMs: number): InstancePatch`.
- `OutboundHttp.getHtml(url: string, accept?: string, headers?: Record<string,string>, allowLocalAddress?: boolean): Promise<string>`.
- `createInstanceMetadata({ redis, http, ledger, clock, reportFailure }): (instance: InstanceMetadataTarget, force?: boolean) => Promise<void>`; ledger uses current `fetchOrRegisterInstance` / `updateInstance`, clock `() => number`, report `(error: unknown, context: {host:string}) => void`.
- Actor controller adds required `fetchMetadata(instance: InstanceMetadataTarget): Promise<void>`; register returns target. Delivery processor adds same required port and tracks it separately through existing pending set. Required test fixture ports must fail on unexpected behavior where applicable.

- [x] **Step 1: Source oracle and behavioral RED.** Write literal-hash-guarded pinned real-method probe with explicit doubles and observations for the five review classes, precedence/version/errors/force. Write caller test asserting metadata starts while increment is held and still starts after rejection, then executes/drains independent metadata; delivery equivalent holds responding update. Run `pnpm --filter backend-next test test/unit/federation/actor-instance-registration.test.ts test/unit/federation/deliver-job.test.ts`; capture expected missing metadata behavior before production changes, not a compile/import failure. Source command: `node docs/superpowers/compatibility/instance-metadata/source-probe.mjs --upstream /tmp/tiramiss-relay171-upstream` (broker if unavailable).
- [x] **Step 2: Implement interfaces and source operation.** Implement the exact interfaces above, source lock/try/finally and freshness/completion clock boundaries. Add getHtml with 5000ms/10MiB and source dependency through broker. Update both existing controllers/composition; ensure actor launches increment and metadata independently even for sync throws and drains both. Delivery success uses source nextTick scheduling; metadata is gated on the existing instance and current stats at that callback, success-only, independent of responding update. Read fresh Meta at callback and explicitly retain its async snapshot limitation. Share each caller ledger with metadata. No extra controller, placeholder chart or future caller.
- [x] **Step 3: Prove behavior.** Consume independent observations directly in unit comparisons. Real integration asserts persisted metadata, warm Redis/memory cache, concurrent SET GET/TTL, force/unconditional-delete, all fetches fail timestamp, failed DB write/unlock and actor create/duplicate plus success/failure/stats-disabled delivery paths. Built process tests hold actual metadata remote response, observe successful public response/job completion, SIGTERM acceptance stop, held child, release, persisted metadata and clean exit for HTTP and worker. getHtml tests cover headers, non-2xx, body deadline and size with existing fake transport. Run focused units, `pnpm --filter backend-next... build` and `pnpm --filter backend-next... typecheck`.
- [x] **Step 4: Freeze and parent validation.** Format all new/changed files including root scripts; package quiet ESLint, SPDX, locale safety and `git diff --check`. Write `/tmp/tiramiss-s1-r4-validation-request.json` revision1 `FROZEN_READY` with exact command array `{id,command,artifact,log}`, SHA256 of all product/test/config/dependency inputs (excluding built/node_modules), and product subset. Request source probe, integration, process and full unit JSON/log artifacts; enumerate root Node26 commands after runtime evidence. Wait in ≤30s polls for parent receipt. Any product/test changes require revision increment and new request.
- [ ] **Step 5: Evidence and handoff.** Bind actual receipt command/date/count/log/input hashes, provenance and preserved failures in compact additive evidence/docs; current-consumer renewals accept only measured identity chains. Run parent Node26 explicit root list via request as needed; never future-assert outcomes. Read shipping skill, write `/tmp/tiramiss-s1-r4-implementation.md` and parent-specified SDD report, then `/tmp/tiramiss-s1-r4-ready.json` `DONE` with changed paths and SHA256 of every public changed file. No commit; parent performs reviews/CodeRabbit/publish.

Self-review: all source requirements and each Review Focus case belong to this one deliverable; exact interfaces match across adapters/callers. Parent handoff uses plan-go file, not an approval menu.
