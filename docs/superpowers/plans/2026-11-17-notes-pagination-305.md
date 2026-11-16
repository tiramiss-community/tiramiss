# #305 notes pagination implementation

Goal: connect `/api/notes` and reusable ID/date cursor planning to the existing note reader, matching pinned upstream `8e07cf085adf7009583d234a208e30436f020e26`.

Approach: use an ORM-free pagination plan (exclusive bounds and direction), a narrow note-list snapshot reader implemented with QueryBuilder, and existing batch note rendering. Reusing a query builder in business code would violate the package boundary; importing old backend is prohibited. No generic query DSL or other list APIs are added. Scope and routine design decisions were delegated by the user through the delivery coordinator.

Review focus: mixed ID/date precedence; truthiness of zero dates; exclusive bounds and ascending since-only pages; guest UGC before limit; authenticated selection with upstream guest packing.

1. Add unit cases for the pagination plan (`src/modules/shared/pagination.ts`, `test/unit/shared/pagination.test.ts`): ID pair/single precedence, date pair/single, zero/null, exclusive bounds. Run red, then implement `planPagination(input, idFromDate): PaginationPlan`.
2. Add real HTTP/PG notes list tests (`test/integration/notes-list.test.ts`) against normal composition. Assert unavailable route red; implement `modules/note/list-notes.ts`, `platform/database/note-list.ts`, `http/notes-list-api.ts`; register in `composition/note-routes.ts`. Cover defaults, filters both ways, guest settings, rendering and input/auth errors. Business code receives plain facts only.
3. Extract pinned QueryService pagination and notes endpoint callback/schema into a source probe with recorded observations. Compare pagination and PG list selection against those observations; document extraction boundaries and existing renderer limits.
4. Run relevant unit/integration suites, build/typecheck, inventory/contracts checks and shipping safety. Update only #305 contract/audit rows and send shared-ledger changes to coordinator. Independent review is owned by coordinator.

Ruling: keep selected plain NoteFacts snapshots through graph loading, because the source selects full Note rows and concurrent deletion must not force a root reread. Snapshot and empty-page unit tests pass. The existing composition route list test requires the newly exposed `/api/notes` entry.
