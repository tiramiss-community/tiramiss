# Instance metadata for current S1 callers

Date: 2026-11-10. Selected bounded #215 stage 5 / #216 getHtml slice per `/tmp/tiramiss-s1-r4-selection.md`. Base `a57e1e456ea448335a8a3a3c37e333302ff4bebe`, fixed source `8e07cf085adf7009583d234a208e30436f020e26` (read-only `/tmp/tiramiss-relay171-upstream`). Inputs: GOALS, ROADMAP, #114/#176/#195/#215/#216, federation-base/outbound-http contracts and the two independent r4 scout reports.

## Intent and scope

Populate existing Instance metadata after public remote actor creation/canonical-duplicate recovery and successful delivery. Preserve existing eligibility, original actor URI authority, asynchronous Meta timing limitation and ledger registration conflict difference. Metadata starts after registration independently of pending/rejected usersCount increment; successful delivery starts it independently of responding-state update in the scheduled success callback. Its statistics gate is read at that callback, with any asynchronous Meta limit stated explicitly. Posting/delivery responses do not wait. Diagnose and drain every started operation before Redis, outbound HTTP and DB release.

No inbox/admin route, media/emoji, chart, broad cache synchronization, migration, entity change, durable queue, extra operational setting, future framework or fake completion. #176/#127/#195/#215 remain incomplete; `notes/create:partial` and `postingComplete:false`. The metadata gap is reduced only for these current callers; other acquisition paths and all five gap categories remain.

## Approaches and controller choice

Chosen by implementer under delegated technical judgment: one source-backed metadata operation, pure selection helpers, HTML projection at the platform boundary, existing instance ledger for persistence/cache, existing actor/delivery pending sets for lifecycle. Both callers share their own ledger instance with acquisition. No second controller is necessary: each caller already owns acceptance and draining. This keeps acquisition scheduling separate from usersCount/responding writes without introducing another lifecycle owner.

An awaited inline fetch would delay successful posting/delivery and violate source boundaries. A dedicated queue/controller framework adds persistence or a redundant pending owner without a present consumer. Duplicated caller implementations would drift on precedence and failures. These alternatives are rejected.

## Source semantics

Use real pinned FetchInstanceMetadataService methods, plus actual HttpRequestService.getHtml and caller boundaries as comparison inputs. Guard full source and extracted methods with literal SHA256; document all transport/repository/Redis/logger/clock doubles. Keep historical source95/corpora/receipts byte-for-byte. New observations and current-byte consumer renewals are additive and must bind actual measured inputs/results.

Non-force lock: delete the legacy mutex without waiting, then `SET fetchInstanceMetadata:mutex:v2:<host> 1 EX 30 GET`; only previous `'1'` skips, refreshing its TTL and avoiding unlock. Acquisition errors escape. Inside try, use ledger fetchOrRegister (including its Redis30min/memory3min cache), then skip when `now - infoUpdatedAt < 86400000`. Force skips lock and freshness but still unconditionally deletes v2 in finally. Acquisition/update errors inside try are diagnosed and swallowed; unlock errors escape. Preserve expiry/force/unconditional-delete races, with tests rather than implicit strengthening. Clock is injected and read separately for freshness and final update.

NodeInfo discovery, homepage HTML and `/manifest.json` start concurrently, with independent rejection-to-null. NodeInfo selects schema 2.1, then 2.0, then 1.0, first link for each, with no fallback after selected-link failure. Derive favicon/icon/color/name/description independently; one malformed derivation must not suppress the others. Source precedence and truthy writes are authoritative: NodeInfo names/descriptions precede HTML then manifest; last matching HTML links win; manifest first icon precedes apple/icon HTML; exact rel=icon favicon precedes HEAD `/favicon.ico`; data PNG icon falls back to favicon; invalid highest-priority theme color does not fall through. Source uses tinycolor2 normalization. Do not sanitize unvalidated remote values into silently different behavior. Persist infoUpdatedAt even if every fetch fails; ledger update refreshes whole-row cache. Keep usersCount raw increment separate from cache refresh.

getHtml uses existing send protections/redirect handling, GET, `text/html, */*`, overriding caller headers, 5000ms including body and 10MiB; explicit allowLocalAddress defaults false. No content-type validation is added.

## Interfaces and validation

Exact interfaces/file ownership and five failure-focused cases are in the [plan](../plans/2026-11-10-instance-metadata-215.md). Validate pure/controller behavior and independent actual-source observations, then real PG/Redis/fake remote HTTP for both public callers and ordinary built HTTP/worker shutdown while metadata is held. Use actual fake HTTPS (HTTP-only peer cannot prove acquisition), assert populated fields and existing consumer output; timestamp alone is insufficient. Mock-only caller acceptance is insufficient. Existing asynchronous DB Meta reading versus source synchronous snapshot remains an unproven limit, including concurrent setting changes.

Parent owns dependency installation, infra/network broker, frozen integration/process/full-unit execution, final reviews/CodeRabbit/Git/publishing. Writer performs behavioral RED before production; format/quiet lint/diff checks precede final frozen request. Dependency additions (tinycolor2 plus types only if needed) go through parent; never hand-edit lockfile. No external sends, Git mutations, Docker/install, secrets/settings/.config/.env/security reads, old backend/frontend edits or managed upstream hand edits.
