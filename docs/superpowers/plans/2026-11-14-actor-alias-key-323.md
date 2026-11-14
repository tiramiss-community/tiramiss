# Actor alias and public key #323 Implementation Plan

> Execute inline with writing-plans/executing-plans and TDD. The approved continuous-work request authorizes routine decisions; no commits or external mutations.

**Goal:** Publish saved actors by acct and local public keys with fixed-source behavior.
**Architecture:** Pure acct/key functions; readonly repository lookups; composition supplies keys, Meta and production conditions; HTTP owns negotiation, errors and redirects.
**Tech Stack:** Existing Hono, TypeORM, Vitest, Node 26 / pnpm 12.9.1.
**Spec:** Approved `/tmp/tiramiss-s1-323-20261114/plan.txt`, upstream/architecture/evidence scouts, independently checked against Git `8e07cf085adf7009583d234a208e30436f020e26`.

## Constraints and review focus

Start `f4bb7803a814a112b18286d4ca1b0cfb71e5787e`. Preserve existing ID actor behavior, other routes, #176/#127 OPEN, partial posting, D7 and PG decisions. No HTML, migrations, dependency upgrades, inventory edits or historical evidence rewrites. Dedicated PG 56473 / Redis 57473 only. Review single decoding, remote host case, suspended key visibility, production redirect guard and legacy key/cache writes.

## Task 1: Fixed-source fixture and RED

- [x] Add finite `local-actor-alias-key-{corpus,observations}.json`, literal Git-source probe and `scripts/local-actor-alias-key-contract.test.mjs`.
- [x] Add focused `actor-alias-key.test.ts`, acct/key pure tests; run missing-route success cases RED before production edits. Save writer logs.

## Task 2: Pure functions and route composition

- [x] Add federation `acct.ts` (`parseAcct`, `formatAcct`) and `local-key.ts` (`renderLocalKey(id, selfUrl, spki, postfix?)`); export via public.ts and extract actor embedded key with `#main-key`.
- [x] Extend database/local-actors.ts with acct lookup (username lower, exact remote host, non-suspended) and local key owner lookup (includes suspended).
- [x] Extend actor HTTP adapter and composition with both routes. Keep status/header decisions in HTTP; preserve ID route. Alias requires AP selection; key falls back to activity JSON. Validate raw encoding before hooks; apply CORS. Alias redirect guard uses actual Meta and NODE_ENV production conditions.
- [x] Run focused unit tests GREEN, build/typecheck.

## Task 3: Live checks and handoff

- [ ] Add listening HTTP/PG checks consuming finite observations, predicate/suspended coverage, no ordinary DML or remote work, plus separately observed legacy key/cache and missing Meta exceptions.
- [ ] Run focused integration, structural/composition regression, source replay/contract checks and shipping checks. Report frozen-source validator drift without modifying historical bindings.
- [ ] Write results with exact commands/counts/limits and the four parent-only metadata updates. Add intended new paths with `git add -N`; save binary HEAD diff to writer.patch.

## Execution ledger

Plan recorded before production edits. Existing isolated worktree HEAD verified. Approval/commit pauses in generic skills are superseded by the explicit continuous-work/no-commit request. Test and source measurements will be recorded in the results document.

Worker implementation and source/unit/type checks completed; live execution blocked by sandbox PG EPERM. Final counts, failure history, parent-only metadata and successor bindings: [results](../compatibility/remote-user/local-actor-alias-key-results.md). No commits. Reviewer dispatch unavailable (thread-store error); author self-review only.
