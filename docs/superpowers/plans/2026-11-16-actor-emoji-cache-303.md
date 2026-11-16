# Actor emoji cache implementation plan

> Execute inline with superpowers:executing-plans. Do not commit before coordinator review.

**Goal:** close the local/remote actor emoji cache gap in #303.
**Spec:** ../specs/2026-11-16-actor-emoji-cache-design.md
**Architecture:** a narrow resource-owned adapter supplies local tag facts and remote author URL material. Keep Note prefetch and other callers unchanged.
**Tech:** TypeScript, TypeORM, existing Redis, Vitest, Node26.4/pnpm12.9.1.

- [ ] Write source probe and failing unit tests for local layers/serialization/TTL and remote positive/negative TTL, strict expiry, import non-invalidation, GC/close.
- [ ] Run RED, implement `src/platform/actor-emoji-cache.ts`, verify GREEN.
- [ ] Inject local reader through actor-http/remote-users/local-actor-tags and remote author material through note-reader/composition, maintaining existing fixture defaults.
- [ ] Write/run real Redis/PG/listening HTTP tests for stale local tags/remote authors, DB unavailable warm hits, expiry/deletion and actual remote extraction.
- [ ] Verify process shutdown, build/typecheck and nearby suites, then freeze finite receipt/projection without historical rewrites.
- [ ] Run root contracts/shipping and give coordinator changed paths, receipts, counts and limitations.

Review focus: Date revival; negative cache vs prefetch; EX1800 physical keyPrefix; no immediate import invalidation; stop GC and drain pending reads before DB/Redis release.
