# #305 notes pagination implementation

Goal: connect `/api/notes` and reusable ID/date cursor planning to the existing note reader, matching pinned upstream `8e07cf085adf7009583d234a208e30436f020e26`.

Approach: use an ORM-free pagination plan (exclusive bounds and direction), a narrow note-list snapshot reader implemented with QueryBuilder, and existing batch note rendering. Reusing a query builder in business code would violate the package boundary; importing old backend is prohibited. No generic query DSL or other list APIs are added. Scope and routine design decisions were delegated by the user through the delivery coordinator.

Review focus: mixed ID/date precedence; truthiness of zero dates; exclusive bounds and ascending since-only pages; guest UGC before limit; authenticated selection with upstream guest packing.

1. Add unit cases for the pagination plan (`src/modules/shared/pagination.ts`, `test/unit/shared/pagination.test.ts`): ID pair/single precedence, date pair/single, zero/null, exclusive bounds. Run red, then implement `planPagination(input, idFromDate): PaginationPlan`.
2. Add real HTTP/PG notes list tests (`test/integration/notes-list.test.ts`) against normal composition. Assert unavailable route red; implement `modules/note/list-notes.ts`, `platform/database/note-list.ts`, `http/notes-list-api.ts`; register in `composition/note-routes.ts`. Cover defaults, filters both ways, guest settings, rendering and input/auth errors. Business code receives plain facts only.
3. Extract pinned QueryService pagination and notes endpoint callback/schema into a source probe with recorded observations. Compare pagination and PG list selection against those observations; document extraction boundaries and existing renderer limits.
4. Run relevant unit/integration suites, build/typecheck, inventory/contracts checks and shipping safety. Update only #305 contract/audit rows and send shared-ledger changes to coordinator. Independent review is owned by coordinator.

Ruling: keep selected plain NoteFacts snapshots through graph loading, because the source selects full Note rows and concurrent deletion must not force a root reread. Snapshot and empty-page unit tests pass. The existing composition route list test requires the newly exposed `/api/notes` entry.

Ruling after independent review: preserve the first SELECT's joined root user and reply/renote snapshots inside a per-operation adapter reader. Keep source ID-loaded reference author precedence; three HTTP/PG barriers and the pinned UserEntityService ID-completion prefix exercise updates, deletion and a shared author. R2 records 15 stable inputs and unit4944/integration43/source13+18. R1 stays an explicitly superseded historical measurement.

Ruling for proof scope: the full #305 proof runs independently in the normal root contract glob. Historical leaves apply only exact pure byte transitions for five shared files. Nested successor validation was removed because it repeated metadata reads beyond the existing budget. The final finite transition introduces no IO; live read count remains31,463 under33,000, with every prior current/metadata/log rejection retained.

R3 ruling: retain root and joined reference users together, then let ID-loaded current authors override; if a distinct reference author disappears, keep the joined fallback. The fourth barrier failed before the one-line fix and passed after it. Independent finite source table was reviewed before freezing15 inputs; R3 fresh build/typecheck/unit4944/integration44/source13+18 all passed. The shared five predecessor inputs stayed byte-identical.
