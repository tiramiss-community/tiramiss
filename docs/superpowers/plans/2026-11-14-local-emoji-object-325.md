# #325 local Emoji object GET

Scope: fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`, `GET /emojis/:emoji` and existing pure `renderApEmoji`. Exclude management, image serving, cache redesign and other AP endpoints. Parent #195/#176/#127 remain open and posting remains partial.

1. Observe ordinary composition returning 404 for a stored public local Emoji (red).
2. Add a narrow TypeORM exact-name/local-host reader, HTTP adapter and composition registration; reuse `ApEmojiFacts`, `renderApEmoji` and `apContext`. HTTP owns federation gate, headers/status and negotiation. Preserve source cache assignment before rendering.
3. Extract literal fixed-source methods and run them with real Fastify inject plus explicit repository doubles. Freeze a finite corpus for local/remote/localOnly/missing, negotiation, path/method/error/clock boundaries; consume observations from product tests. This is method comparison, not full upstream HTTP/PG equivalence.
4. Run ordinary listening HTTP with real migrated isolated PostgreSQL/Redis, verifying lookup predicates, fresh reads, data preservation, gates, headers and database failures. Run nearby actor/tag/outbox regressions, build/typecheck and proportional shipping checks.
5. Bind the measured inputs to logs and retain previous outbox/actor proof bytes through a finite predecessor reader. Update only the affected inventory rows and local handoff documents. Review, commit and open a templated PR closing #325; do not merge or update parent GitHub issues.

Environment: Node26; Compose `backend-next-parallel-325`, PostgreSQL56525, Redis57525. The upstream oracle uses the existing pinned upstream checkout and source dependency harness.
