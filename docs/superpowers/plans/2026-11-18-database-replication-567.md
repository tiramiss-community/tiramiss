# Database replication #567 implementation plan

**Goal:** Connect the existing upstream `dbReplications` and `dbSlaves` YAML keys to runtime PostgreSQL routing. PR #630 already implements timeout, int8 and nullish conditions on base `1613804464`; preserve those results.

**Architecture:** Normalize enabled slaves into database configuration, construct TypeORM replication only in `createDataSource`, and keep migration sources on the primary. Fixed upstream `8e07cf085adf7009583d234a208e30436f020e26` factory remains the independent oracle. Query cache and slow-query diagnostics remain in #567.

- [x] Add failing config/runtime option tests, including disabled and empty replicas and primary-only migration options.
- [x] Implement config normalization and runtime replication, without HTTP routing or upstream managed-file changes.
- [x] Add a dedicated physical PostgreSQL standby fixture. Compare Repository/QueryBuilder read, write and transaction routing using both the pinned factory and the normal YAML → loadConfig → connectResources entry.
- [x] Run nearby unit/integration tests, build/typecheck and shipping checks. Record scope and reproducible results separately from historical PR #630 measurements.
- [ ] Commit, obtain independent review from the parent, then prepare the authorized PR. Do not merge or close #567.
