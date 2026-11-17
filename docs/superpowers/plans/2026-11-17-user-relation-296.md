# users/relation (#296) implementation plan

Fixed source: 8e07cf085adf7009583d234a208e30436f020e26. Parent #182 permits relation reads before updates; #114 remains incomplete.

1. Extract literal getRelation/getRelations and endpoint callback as a source oracle; keep full persisted following fields, array return and Map deduplication.
2. Add failing normal-entry HTTP/PG tests for single, multiple, duplicate, unknown, empty and reversed viewers; include scopes, suspension, invalid input and DB failure.
3. Introduce relation DTO/material reader and pure conversion under modules/user-relation/public.ts, TypeORM adapter and ordinary HTTP composition. Detailed user #180 can read the same material without calling this endpoint. No writes or cache.
4. Compare real PG repositories against literal pinned methods, build/typecheck, nearby tests, changed-file lint, SPDX and locale safety. Update only relation inventory row and finite hash follow-up required by the route expectation.
5. Commit reviewable implementation and evidence; controller owns independent review, push/PR and CI/Web review.
