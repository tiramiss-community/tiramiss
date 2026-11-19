# Admin emoji reads (#537)

Parent #194 / plan #114. Base `c25f3ee979` and fixed upstream `8e07cf085adf7009583d234a208e30436f020e26`. Dependencies #304 (public emoji reads) and #305 (shared cursor planning) are available. This slice implements `admin/emoji/list`, `admin/emoji/list-remote` and `v2/admin/emoji/list` in ordinary HTTP composition. Emoji mutation, the rest of CustomEmojiService/EmojiEntityService, parent #194 and the overall backend remain incomplete.

The use case owns credential/current role-policy authorization before input validation. Root and administrators bypass `canManageCustomEmojis`; moderator status alone does not. Delegated callers require `read:admin:emoji`; suspension precedes policy and scope checks. It uses the existing role reader and policy evaluator. Repository access and plain-data response conversion are separate; v2 collects role materials once before conversion. Reads do not write emoji rows, audit logs or cache notifications.

Legacy local search preserves the fixed source's case-sensitive name/alias/category substring and colon-token matching, applying filtering after cursor bounds and returning up to `limit + 1` matches. Local input ignores the undeclared `host` property. Remote search escapes LIKE metacharacters, uses exact lowercased/punycode hosts (null means all remote), and forces descending ID order even for `sinceId`. Both use the existing shared cursor planner, including ID precedence over date cursors.

V2 searches words with OR within a field and AND between fields, escapes `%`, `_` and backslash, filters aliases by any matching element, and preserves local/remote/all host rules. Host text only applies to the remote host mode; `originalUrl` is accepted but ignored by the pinned callback. Date bounds cast updatedAt to DATE, booleans and role overlap match PostgreSQL. Both cursor IDs can coexist with opposite date bounds. All pinned sort keys and directions, page offsets, and count/allCount/allPages behavior are preserved, including nonzero count on an empty out-of-range page when total count does not exceed limit. Admin responses retain separate URLs and nullable fields, with existing role names ordered by displayOrder descending/ID ascending; missing roles disappear and duplicate role IDs remain duplicated. Invalid dates, negative page offsets, whitespace-only LIKE words and unavailable DB propagate ordinary internal errors.

`test/fixtures/admin-emojis/manifest.json` pins exact source snapshots. `admin-emoji-source.ts` compiles the literal source endpoint callbacks, QueryService cursor method, CustomEmojiService.fetchEmojis, UtilityService.toPuny, detailed/admin packers and the credential-to-scope gate fragment. The tests run those methods against real PostgreSQL and compare ordinary listening HTTP responses from the new composition. Source role/authentication facts and ID generation are explicit bindings. This is a finite source-method/DB comparison, not a booted full upstream HTTP application; global headers, complete token issuance, and unrelated service callers are not claimed.

`compatibility-predecessor.json` records only the two changed shared composition/snapshot files, with exact before/after hashes and byte patches. Its descriptor connects to the existing parallel-input projection. Prior receipts and broad historical ledger classifications are preserved. Only the three assigned API rows and responsibility `instance-moderation:45` change in the current inventory.

Reproduction from repo root, using the assigned dedicated project and ports:

```sh
BACKEND_NEXT_TEST_DB_PORT=55537 BACKEND_NEXT_TEST_REDIS_PORT=56537 BACKEND_NEXT_TEST_PUBSUB_REDIS_PORT=56538 docker compose -p backend-next-537 -f packages/backend-next/compose.test.yml up -d --wait postgres redis redis-pubsub
pnpm --filter backend-upstream build
pnpm --filter backend-next build
pnpm --filter backend-next typecheck
pnpm --filter backend-next test
BACKEND_NEXT_TEST_DB_PORT=55537 BACKEND_NEXT_TEST_REDIS_PORT=56537 pnpm --filter backend-next test:integration test/integration/admin-emojis.test.ts test/integration/public-emojis.test.ts
node --test scripts/admin-emojis-contract.test.mjs scripts/public-emojis-contract.test.mjs scripts/avatar-decorations-contract.test.mjs
node scripts/backend-contract-inventory.mjs --check
node scripts/check-shipping.mjs --base c25f3ee979
```

The initial RED was an ordinary HTTP assertion (404 instead of 200), followed by a passing registered-route case. The first comparison harness bound arrow callbacks incorrectly and used a 16-character delegated fixture token which the authenticator correctly interpreted as native; both fixture issues were repaired before successful comparison. An early full unit run caught a test-only overbroad text replacement in the existing avatar-decoration request; it was restored. Those failures are not successful compatibility evidence. The existing pg query-concurrency deprecation warning occurs in migration fixtures.

Local validation: build/typecheck/upstream sync and shipping PASS; full unit **5,586 passed / 168 files**, plus one pre-existing optional Page source replay skip; real dependency checks **147 passed / 2 files**, including **128 admin** and **19 public emoji** cases; nearest historical/source guards **25 passed**. The added current-input receipt guard is run separately afterward. `current-evidence.json` records exact current product/source hashes and actual log hashes after these runs, without claiming a repository-wide frozen-input audit. The full wildcard historical contract run is a separate broader check.
