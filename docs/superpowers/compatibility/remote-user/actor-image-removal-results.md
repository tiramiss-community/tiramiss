# Both-absent actor image removal (#195)

This slice repairs the `notes/create` remote-mention continuation after actor insertion or canonical duplicate recovery. It clears six persisted image fields only when both images are absent under pinned source rules. #176/#127/#195 remain partial; `notes/create:partial`, `postingComplete:false`.

## Source boundary and case map

Source pin: `8e07cf085adf7009583d234a208e30436f020e26`. The additive probe executes literal `ApPersonService.createPerson` and `resolveAvatarAndBanner`, with source loaded from Git objects (or full-byte Git blob verification in restricted environments). Method hashes are in `actor-image-removal-observations.json`. No historical corpus was changed.

| Corpus cases | Source behavior | New implementation coverage |
| --- | --- | --- |
| absent-0 through absent-5, each new/canonical and success/failure (24) | Missing fields, null, empty objects/arrays, null URL, array entries without truthy URL: six explicit nulls; no acquisition or policy lookup | Actor classification unit cases; normal and canonical continuation unit gates; persisted six-field HTTP/PG tests |
| mixed-0 / mixed-1 | One acquired image and media policy denied: empty patch suppresses both updates | Explicit exclusion; HTTP/PG retains all six fields for both mixed directions |
| mixed-2 | Direct empty URL is sent to acquisition; it is not absent | Classification and HTTP/PG exclusion |
| mixed-3 | Direct URL string with acquisition failure: absence on other side may still yield partial nulls | Excluded; classification and HTTP/PG retain all six fields in this slice |
| mixed-4 | Array selects first truthy URL, ignoring earlier empty URL | Classification exclusion; source acquisition/policy boundary only |

The source probe uses explicit doubles for transport, repositories/transactions, Drive acquisition, policy, instance/hashtag work, charts/cache and featured work. A gated repository update proves createPerson awaits it; unresolved hashtags prove caller nonwaiting. These observations are not full upstream HTTP/PG or Drive-policy parity.

## Runtime evidence and failure history

Actual new-backend tests use native-token HTTP, real PostgreSQL and isolated Redis (ports 55511/56411; configured Meili 57811). The canonical regression seeds valid Drive references and six nonnull image fields, observes an existing remote-authored Note before/after, asserts canonical mention persistence, all six nulls, retained Profile/key/stored tags and Drive rows. The targeted BEFORE UPDATE trigger rejects only the target actor's six-null clear, while another actor can be inserted and updated. The failure test preserves images/relations and mention, and checks a diagnostic. Deleted canonical rows prove update-by-ID semantics. Mixed inputs retain all six values.

- TDD RED: focused unit run, 12 failed / 256 passed; missing classification and image continuation/diagnostic were the expected failures (`/tmp/tiramiss-s1-r8-red.log`). GREEN: 268 passed.
- Restricted local integration: blocked by `connect EPERM 127.0.0.1:55511`; 115 skipped, no passing claim. Restricted source Git subprocess also failed; verified-files mode passed 29 cases with full-byte Git blob checks.
- Parent frozen r1: build/typecheck PASS, 268 unit PASS, 116 integration PASS, literal Git source `--check` 29 PASS. Parent receipt and command logs remain immutable in `/tmp/tiramiss-s1-r8-validation-*`.
- Formatting checks found unit whitespace and one duplicate blank line. r2 was declined in parent pre-execution (no runtime commands) because those fixes were still pending. All known formatting was fixed before final r3; changed-file ESLint and diff whitespace checks PASS.
- Final frozen r3: build/typecheck PASS, 268/268 unit PASS, 116/116 integration PASS (zero skipped), literal Git source `--check` 29 PASS. Receipt SHA256: `c6cce414c5b5dd7c695fd38548cef2cdfd13df577ac2c86a6081dbb5dbb663e8`. `actor-image-removal-runtime-evidence.json` binds its exact receipt/request and command/artifact hashes. No frozen input changed afterward.
- Baseline `pg` concurrent-query deprecation warning appears in integration logs. No new test failures were hidden or expectations weakened.

Full media acquisition, individually absent images under mixed policy, other callers/publication, featured, Move, inbox, chart and cache/event parity remain outside this slice. No process tests were requested: resource ownership and lifetime are unchanged. No schema, entity, API schema or locale changes.
