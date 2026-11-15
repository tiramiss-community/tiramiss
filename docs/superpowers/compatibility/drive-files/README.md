# Drive file reads and common packing (#279)

Fixed upstream: `8e07cf085adf7009583d234a208e30436f020e26`. Base: #278 merged at `1adb04b0cf4d6efdb2537891df4ca2261359f1f6`. Parent #188 and overall #114 remain open.

The ordinary HTTP application provides `drive/files/show`, `find`, `find-by-hash`, `check-existence` and `admin/drive/show-file`. Actor authorization precedes endpoint input validation. Show accepts owner/moderator access and original/webpublic/thumbnail URLs; ID wins when present, including when another anyOf branch validated the input. Exact name/folder and hash/existence searches are always actor-scoped. Missing rows preserve endpoint-specific error UUIDs. TypeORM failures and failed detail preloads remain internal errors rather than missing rows, empty lists or false existence.

A shared pure renderer now serves these APIs and the existing note attachment wrapper. Self output keeps raw properties and original URL; public output strips orientation and rotates dimensions. Nullable/many output retains userId without withUser; single pack hides it. Detail/UserLite materials must exist before rendering. The adapter deduplicates requested folder IDs/ancestors and users, reads folder/file counts and remote emoji URLs, then reuses the existing folder and UserLite projections. Admin output uses persisted fields and hides request headers for moderator owners, including conditional roles; expired assignments do not confer that privilege. None of the five APIs mutates files or publishes events.

The pinned comparison consists of 71 endpoint-handler cases, 52 pure pack cases and 12 file-name cases. `source-probe.mjs` verifies exact Git blob bytes, extracts literal source endpoint schemas/handlers, pack/packNullable/packMany, folder pack, MIME predicate, ID parser and URL/video methods, and records observations. Repository filtering/failures, moderator identity and UserLite identity are explicit doubles. `files-source.test.ts` compares all135 observations against the new implementation; it does not execute an upstream full server.

`drive-files-source-http.test.ts` binds the71 handler inputs to real listening HTTP and migrated PostgreSQL with actual native tokens and Role records. Source handlers are observed after the shared API gate: ordinary admin inputs correctly stop at the real gate403. Successful responses compare the full file/folder projection and UserLite identity, whose source helper is a declared double. `drive-files.test.ts` adds11 actual HTTP/PG tests of complete local UserLite fields, all three URL columns, self/raw information, admin/conditional/expired owner redaction, native/scoped authorization, missing errors, exact searches, no file writes and database/preload failures. The actual PG failure uses a temporary table rename in the isolated test DB; user/folder query fault injection is separate. Existing note-show contributes26 regression tests; note/files contributes11 pure tests.

The source comparison found two earlier note projection mismatches: an empty persisted video thumbnail falls back to the configured generator, and an empty configured generator still produces the upstream relative thumbnail URL. Both have failed-source-case → passing-source-case evidence in the new52 pack cases. Non-video empty thumbnail strings retain the source nullish behavior.

## Reproduce

Use Node26.4.0/pnpm12.9.1 as pinned by the repository. This run uses dedicated Compose project `backend-next-279`, PostgreSQL55279 and Redis56279. Other sessions' projects and `misskey-infra` are untouched.

```sh
BACKEND_NEXT_TEST_DB_PORT=55279 BACKEND_NEXT_TEST_REDIS_PORT=56279 docker compose -p backend-next-279 -f packages/backend-next/compose.test.yml up -d --wait postgres redis
UPSTREAM_ROOT=/path/to/fixed-upstream node docs/superpowers/compatibility/drive-files/source-probe.mjs --check
pnpm --filter backend-next test test/unit/drive/files-source.test.ts test/unit/drive/files.test.ts test/unit/drive/file-read.test.ts test/unit/note/files.test.ts
BACKEND_NEXT_TEST_DB_PORT=55279 BACKEND_NEXT_TEST_REDIS_PORT=56279 pnpm --filter backend-next test:integration test/integration/drive-files.test.ts test/integration/drive-files-source-http.test.ts test/integration/note-show.test.ts
pnpm --filter backend-next... build
pnpm --filter backend-next... typecheck
pnpm --filter backend-next test
pnpm --filter backend-upstream sync:check
node --test scripts/*-contract*.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base 1adb04b0
```

At this implementation pass, near units165/4 and full units4522/121 passed; actual HTTP/PG108/3 passed. Existing migration setup emits pg's concurrent-query deprecation warning. Exact run results and hashes are recorded separately; prior published receipts are not renewed.

A sealed finite predecessor restores exactly the pre-279 HTTP composition, composition route test and note attachment wrapper for historical evidence readers, after hashing all three current inputs on every projection. Existing folder and preview predecessor maps retain their exact shapes, receipts and counters. The six dedicated contract tests reject changed current bytes, forged preimages and changes after a successful read. No Git, subprocess, wildcard exemption or cached validation is used by this reader.

## Limits

- Shared ApiCallService/config differences already assigned to #178/#138, and Meta cache freshness assigned to #317, are not declared solved here. No upstream full-server/PG process parity claim is made.
- The broad DriveFile service inventory remains partial because usage accounting, avatar URL mode and ID-list helper consumers belong to other work. The combined DriveFile/Folder bulk row remains partial for the independent Folder packMany/hint paths; the file adapter supports deduplicated preload and pure packing of supplied file sets.
- No Entity/migration or legacy API metadata changed; misskey-js regeneration is unnecessary for this mirrored implementation. File storage/delivery, update/delete and Drive subscription remain separate #188 work. CHANGELOG was not edited.

CHANGELOG candidate: backend-nextでDriveファイルの所有者向け照会・検索と管理者向け詳細照会を提供。
