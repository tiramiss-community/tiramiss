# Actor alias / public key #323 — completed, pending merge

2026-11-14: implementation and reviewer fixes are measured at `43e72c7b6f1394fe6685eeca2ff368a6bd641d6f`, from pre-323 `f4bb7803a814a112b18286d4ca1b0cfb71e5787e`. #323's finite implementation/evidence is complete pending merge; next is #324. No merge, CI result or full upstream server equivalence is claimed.

AP-selected `GET /@:acct` parses saved local/remote accounts, excludes suspended rows and renders the existing local actor or redirects to the saved remote URI. `GET /users/:user/publickey` includes suspended local owners and renders the saved SPKI key without profile/tag/media reads. HTTP owns negotiation, CORS, Vary, cache, errors and redirect policy. Empty parameters enter AP hooks; decoded UTF-16 parameters over the router's 100-unit limit return 414 before lookup, including GET/HEAD and encoded boundaries. Existing ID actor behavior is retained.

The fixed upstream is `8e07cf085adf7009583d234a208e30436f020e26`. Literal source methods and real Fastify inject/accepts run with explicit repository, key acquisition and Person doubles. The measured source total is **162 route + 7 acct + 3 key = 172**. This checks source-method behavior, not full upstream HTTP/PG. Product tests independently use real HTTP/PG; repository predicates, key cache fill/legacy upgrade, Meta initialization, 414 zero SQL and stored failure cases are covered. Unconditional write freedom is not claimed. HTML, generic framework diagnostics, exact exception messages, global hooks and cache lifecycle equivalence remain outside this comparison.

## Recorded successful product measurements

The sealed [successor evidence](local-actor-alias-key-current-evidence.json) embeds the actual latest runtime receipt and the separate earlier regression receipt. Logs are `/tmp/tiramiss-s1-323-20261114/`; executable is `/tmp/tiramiss-s1-node26/bin/node` (26.4.0), pnpm 12.9.1. Commands below describe parent measurements, not new product runs in the evidence worker.

| Command (repository root unless stated) | Result | Log |
| --- | --- | --- |
| `pnpm --filter backend-upstream sync:check` | PASS | `sync.log` |
| `pnpm --filter backend-next... build` | PASS | `build-fixed.log` |
| `pnpm --filter backend-next... typecheck` | PASS | `typecheck-fixed.log` |
| `pnpm --filter backend-next test test/unit/federation test/unit/composition/http-app.test.ts` | 1927 PASS / 36 files | `unit-fixed.log` |
| `pnpm --filter backend-next test:integration actor-alias-key activitypub-actor` | real HTTP/PG 216 PASS / 2 files | `integration-fixed.log` |
| `node docs/superpowers/compatibility/remote-user/local-actor-alias-key-source-probe.mjs --check` | 172 source-method observations PASS | `source-fixed.log` |
| `node scripts/local-actor-alias-key-contract.test.mjs` | 5 PASS | `contract-fixed.log` |
| `node scripts/check-shipping.mjs` | changed product lint, SPDX, locale PASS | `shipping-fixed.log` |

The separately measured regression is **614 PASS / 6 files** at `ed83098e343983f3c3a24762f4edd2a125d83c99`: `pnpm --filter backend-next test:integration http-app remote-user webfinger local-featured-http local-follow-collections-http note-activity`, log `integration-regression.log`. It is not a 43e rerun. The 43e receipt binds current product/source/test bytes and successful run logs; ephemeral logs are checked when present, and their absence does not disable saved seals.

## Finite evidence and inventory

Exactly six old consumers cross the dated boundary: `composition/actor-http.ts`, `http/activitypub-actor-api.ts`, `modules/federation/local-actor.ts`, `modules/federation/public.ts`, `platform/database/local-actors.ts`, and `test/unit/composition/http-app.test.ts` under backend-next. The sealed static [predecessor snapshot](local-actor-alias-key-predecessor.json) was extracted from fixed pre-323 Git bytes. The reader checks live 43e bytes before supplying historical bytes to dated fields/images/WebFinger/featured/follow/tag/profile checks. Other consumers remain live; existing historical JSON, corpora, receipts and seals are unchanged. New files have no invented predecessor. Negative checks reject current drift, historical fixture/corpus/receipt corruption, false receipt or missing applicable suite. Product tests remain static/offline.

Only four inventory contracts and two audit rows change: `ap-render:renderKey`, `responsibility:misc-utils:36`, and ActivityPubServerService HTTP lines 737/785. The implementation pin is 43e; generated contracts follow source overrides. Backlog and parent classifications are preserved, including dated #272 classifications.

Evidence-worker reproduction (Node26, no DB or dependency installation):

```sh
for file in scripts/local-*.test.mjs scripts/remote-*.test.mjs scripts/backend-contract-inventory.test.mjs; do /tmp/tiramiss-s1-node26/bin/node "$file" || exit; done
/tmp/tiramiss-s1-node26/bin/node scripts/backend-contract-inventory.mjs --check
node scripts/check-spdx.mjs
```

Evidence-worker result: **288 structural tests PASS, 0 failed/0 skipped**, including 12 new successor checks; dated posting checker separately **32 PASS**. Inventory generation/check and exact four-contract/two-audit scope check PASS. Shipping: SPDX/locale PASS; lint SKIPPED because this phase changes no package ESLint targets. Product suites were not rerun in this worker.

Logs: `evidence-structural-final.log`, `evidence-inventory-check.log`, `evidence-shipping.log`. In this sandbox inventory's Git subprocess requires `--require /tmp/tiramiss-s1-323-20261114/evidence-stdio.cjs`, which sets child stdin to ignore while retaining real exit checks. It is an external environment adapter, not a repository change.

Parent integration subsequently connected the two remaining instance-registration/metadata contract readers to the same checked six-file projection. `node --test --test-concurrency=4 scripts/*.test.mjs` passed **all 438 root tests, with no failures or skips** (`all-root-tests-final.log`); inventory and final changed-file lint/SPDX/locale checks also passed. Independent final review reproduced the metadata reader omission before this correction; a separate completeness reviewer confirmed its correction and reran metadata 7 / registration 5 checks. Product bytes and the sealed 43e measurement remain unchanged.

## Retained history and remaining responsibilities

The initial writer's TCP attempt was blocked (EPERM); its limited unit/source runs did not establish live acceptance. Review subsequently corrected empty/overlength parameter handling, added 104 route observations and raw HTTP cases, and the parent produced the successful latest receipt above. Earlier failures/counts are not blended into current measurements. Historical slice receipts retain their original counts.

#176/#127/#195 remain OPEN; `notes/create:partial` / `postingComplete:false`, D7 64-depth/256-Note, approved PG notification storage and deferred strong ordering remain. Meta/cache freshness belongs to #217. Remote media/Notes/collections, inbox/Move and broader actor responsibilities remain with their existing owners and order.

CHANGELOG candidate (not edited): 新バックエンドで acct 別名による ActivityPub actor とローカル公開鍵の取得に対応。
