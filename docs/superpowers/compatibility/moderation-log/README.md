# Existing Role/Note moderation-log proof (#546)

This reconciles `moderation-log-type:updateRole` and `moderation-log-type:deleteNote` for parent [#194](https://github.com/tiramiss-community/tiramiss/issues/194), against fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`. The [evidence index](evidence.json) binds the two callers, appender, named assertions and historical execution records. Both inventory rows remain `partial`: this is a finite evidence reconciliation, not whole-service compatibility or posting completion.

## Issuing sites and existing evidence

The source probe parses every fixed-source file containing either log type and finds exactly these two literal `log` calls. It executes the actual method bodies with repository/ID doubles. New adapters and the shared appender are also extracted from current source; the operation itself is not reimplemented.

| Contract | Fixed source | Existing assertions / observation |
| --- | --- | --- |
| `updateRole`: actor, `roleId`, saved `before`/`after`, ISO dates | `core/RoleService.ts:713`, `core/ModerationLogService.ts:26` | Role reference HTTP probe `partial policy replacement, audit snapshots, nullable fields and no-op timestamp`; `role-http` exact snapshots; `role-update` full snapshots and ID timestamp; added source-method comparison through `appendRoleUpdateAudit` and `appendModerationLog` |
| `updateRole`: failure and commit boundary | Same call, after save/reload/publication, omitted when moderator is absent | Source caller returns while insert is held. New implementation deliberately awaits audit in the Role transaction: actual CHECK failure rolls back both writes (`role-update`), HTTP 500 preserves warmed policies (`role-acceptance`), post-commit process death retains audit. This is the existing approved [Role difference](../../specs/2026-10-17-role-compatibility-contract.md#7-意図的な差異の期待値) |
| `deleteNote`: actor, note/author IDs, username, host, whole note JSON | `core/NoteDeleteService.ts:120` | `note-delete` strict equality against the whole stored row; historical C10 HTTP golden compares actor/type/author projection. Added source-method observation compares the entire finite JSON payload, including nested values and remote author host, through `appendNoteDeleteAudit` and the real shared appender body |
| `deleteNote`: failure and detached boundary | After successful DELETE and author lookup; absent deleter / author deletion emits no log | Source method observes DELETE and author lookup failures without audit, plus held-insert return. Existing unit tests start audit only after DELETE; PG DELETE rejection leaves no audit (`note-delete`), ordinary process test drains then checks audit count for success/rejection (`note-delete-integration`) |
| Shared JSON/ID/storage contract | `core/ModerationLogService.ts:26` | `moderation-log.test.ts` checks omitted info `{}`, JSONB date/undefined serialization, caller rollback and insert failure. The new source observation checks new ID callback receives `occurredAtMs`; source logger calls `IdService.gen()` without arguments |

Paths above are relative to `packages/backend/src` for fixed source, and `packages/backend-next/test/integration` unless identified otherwise. Exact file names and test titles are in the index.

## Execution provenance

No existing integration, acceptance or process suite was rerun for #546, as requested by the issue. Historical results remain historical:

- [PR #246 appender verification](../../plans/2026-11-08-moderation-log-appender-194.md#verification-record-2026-11-08), implementation `e03c4fbf2920c8dbec5e798df702265af986d579`: integration includes appender 4, acceptance 65 and selected process 10. These are original aggregate counts, not new #546 results.
- [Role reference and acceptance record](../role/README.md#固定本家との再比較2026-10-21): actual upstream HTTP/PG and its exact scope; the probe assertions are linked, not newly executed.
- [#272 measured record](../note/n7/posting-proof-272.json): runtime baseline `b4f28f6ceef458575f203c19d4ede37d7311468c`, integration and process measurement entries, `delete-audit` / `delete-fail` bindings and C10 observations. Its original hashes, receipts and counts are retained.

The index records current versus PR #246 byte hashes separately. `role-update.test.ts` gained later transaction-lifetime tests; `note-delete.test.ts` gained explicit C10 golden assertions. These changed files are not presented as PR #246's exact measured bytes. Current test declarations are references to evidence, not a fresh execution claim.

The only added execution is [source-observations.json](source-observations.json), produced on 2026-11-18 with Node v24.20.0. It uses TypeScript transpilation and literal source bodies with explicit doubles, not either full server or a PostgreSQL serializer. Existing real-PG tests supply the separate serialization/storage evidence.

## Known differences and unproved conditions

- ID time is the operation's `occurredAtMs` in the new callers, whereas upstream samples time when `log` invokes `IdService.gen()`. This is a retained difference explicitly recorded by [the appender plan](../../plans/2026-11-08-moderation-log-appender-194.md#kept-differences). No equality of timestamps across delayed deletion/update is claimed. The source observation checks callback arguments, not wall-clock latency or every ID format.
- Upstream reads the note author's username/host after DELETE. The new path captures author information while reading the note before DELETE. A controlled source double returning a renamed author demonstrates the differing projection; there is no real concurrent-rename/deletion measurement. Upstream author-lookup failure occurs after deletion; a new pre-delete lookup failure can prevent deletion. Deciding whether to change or retain this behavior belongs to **#194**, and remains unproved for compatibility. Stable-author finite payload equality does not settle that decision.
- Role's awaited transactional audit and post-commit notification order are the approved Role differences; source held-insert return must not become an assertion that new Role HTTP returns before audit.
- The finite note object is not every possible enriched Entity/relation shape from every internal caller. Upstream full-server whole-info comparison, author mutation races, detached insert rejection handling under every caller, moderation-log listing/packing/other types and posting overall remain outside this proof. #194 owns the remaining moderation boundaries; #176/#127 retain posting completion.

## Reproduce the added observation

From a checkout that contains the fixed upstream Git object and installed repository TypeScript:

```sh
node docs/superpowers/compatibility/moderation-log/source-probe.mjs > /tmp/moderation-log-source.json
cmp docs/superpowers/compatibility/moderation-log/source-observations.json /tmp/moderation-log-source.json
node --test scripts/moderation-log-contract-proof.test.mjs
node scripts/check-shipping.mjs --base 6af8cd5baa
```

If dependencies live in a separate installed checkout, set `SOURCE_PROBE_DEPENDENCY_ROOT` to that checkout for the first command. This only resolves the TypeScript compiler; all current implementation reads still use this checkout and all upstream reads use `git show <fixed SHA>:<path>`. Nothing is installed or rebuilt through a shared `node_modules` link. The contract test checks evidence drift and named assertions without requiring the upstream Git object.
